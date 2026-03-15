import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { Timestamp } from "firebase-admin/firestore";
import { db } from "../db.js";
import {
  AppError,
  type Claim,
  type ClaimStatus,
  type ClaimForAnalysis,
  type CptCode,
  type CptStats,
} from "../types.js";
import { computeRiskScore } from "../engines/anomaly.js";

const router = Router();

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

// ─── GET /api/providers/:id/dashboard ─────────────────────────────────────────

router.get(
  "/:id/dashboard",
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const providerId = String(req.params["id"]);

    const providerSnap = await db
      .collection("providers")
      .doc(providerId)
      .get();
    if (!providerSnap.exists) {
      throw new AppError(
        404,
        "PROVIDER_NOT_FOUND",
        `Provider ${providerId} not found`,
      );
    }

    const claimsSnap = await db
      .collection("claims")
      .where("providerId", "==", providerId)
      .get();

    const claims = claimsSnap.docs.map(
      (d) => ({ id: d.id, ...d.data() }) as Claim,
    );

    // Summary by status
    const byStatus: Record<string, number> = {};
    const statusOrder: ClaimStatus[] = [
      "SUBMITTED",
      "VALIDATED",
      "ADJUDICATED",
      "PATIENT_BILLED",
      "PAID",
      "DENIED",
      "FLAGGED",
    ];
    for (const s of statusOrder) byStatus[s] = 0;
    for (const c of claims) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;

    // Total revenue (sum of insurerAmount for adjudicated/billed/paid claims)
    const revenueStatuses = new Set<ClaimStatus>([
      "ADJUDICATED",
      "PATIENT_BILLED",
      "PAID",
    ]);
    const totalRevenue = claims
      .filter((c) => revenueStatuses.has(c.status))
      .reduce((sum, c) => sum + (c.insurerAmount ?? 0), 0);

    // Average processing time (SUBMITTED → PATIENT_BILLED) in minutes
    const processedClaims = claims.filter(
      (c) =>
        c.patientBilledAt !== undefined &&
        c.submittedAt !== undefined,
    );
    let avgProcessingTimeMinutes = 0;
    if (processedClaims.length > 0) {
      const totalMs = processedClaims.reduce((sum, c) => {
        const submitted = c.submittedAt.toDate().getTime();
        const billed = c.patientBilledAt!.toDate().getTime();
        return sum + (billed - submitted);
      }, 0);
      avgProcessingTimeMinutes =
        totalMs / processedClaims.length / (60 * 1000);
    }

    // Flagged claim rate
    const flaggedCount = claims.filter(
      (c) => c.status === "FLAGGED" || (c.riskScore ?? 0) >= 70,
    ).length;
    const flaggedClaimRate =
      claims.length > 0 ? flaggedCount / claims.length : 0;

    // Latest risk score
    const latestRiskScore =
      claims.length > 0
        ? Math.max(...claims.map((c) => c.riskScore ?? 0))
        : 0;

    res.json({
      providerId,
      provider: providerSnap.data(),
      summary: {
        totalClaims: claims.length,
        byStatus,
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        avgProcessingTimeMinutes: Math.round(avgProcessingTimeMinutes * 10) / 10,
        flaggedClaimRate: Math.round(flaggedClaimRate * 1000) / 1000,
        latestRiskScore,
      },
    });
  }),
);

// ─── POST /api/providers/:id/risk-score — Compute anomaly risk score ──────────

router.post(
  "/:id/risk-score",
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const providerId = String(req.params["id"]);
    const { windowDays = 90 } = req.body as { windowDays?: number };

    const providerSnap = await db
      .collection("providers")
      .doc(providerId)
      .get();
    if (!providerSnap.exists) {
      throw new AppError(
        404,
        "PROVIDER_NOT_FOUND",
        `Provider ${providerId} not found`,
      );
    }

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - windowDays);

    const claimsSnap = await db
      .collection("claims")
      .where("providerId", "==", providerId)
      .where("submittedAt", ">=", Timestamp.fromDate(cutoff))
      .get();

    const claims: ClaimForAnalysis[] = claimsSnap.docs.map((d) => {
      const data = d.data() as Claim;
      return {
        id: d.id,
        providerId: data.providerId,
        patientId: data.patientId,
        cptCodes: data.cptCodes,
        billedAmount: data.billedAmount,
        submittedAt: data.submittedAt.toDate(),
      };
    });

    // Fetch CPT stats for all codes seen in these claims
    const allCodes = [...new Set(claims.flatMap((c) => c.cptCodes))];
    const cptSnaps = await Promise.all(
      allCodes.map((code) => db.collection("cpt_codes").doc(code).get()),
    );
    const cptStatsMap = new Map<string, CptStats>();
    for (const snap of cptSnaps) {
      if (snap.exists) {
        const data = snap.data() as CptCode;
        cptStatsMap.set(snap.id, {
          code: snap.id,
          avgBilledAmount: data.avgBilledAmount,
        });
      }
    }

    const result = computeRiskScore(providerId, claims, cptStatsMap);
    res.json(result);
  }),
);

export default router;
export { router as providersRouter };
