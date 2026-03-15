import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { v4 as uuidv4 } from "uuid";
import { db } from "../db.js";
import {
  AppError,
  type SubmitClaimRequest,
  type Claim,
  type InsurancePlan,
  type Patient,
  type Provider,
  type CptCode,
  type ClaimStatus,
  type ClaimForAnalysis,
  type CptStats,
} from "../types.js";
import { createDefaultRulesEngine } from "../engines/rules.js";
import { calculateAdjudication } from "../engines/adjudication.js";
import { computeRiskScore } from "../engines/anomaly.js";

const router = Router();

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

// ─── POST /api/claims — Submit a claim ────────────────────────────────────────

router.post(
  "/",
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const correlationId = req.correlationId;
    const body = req.body as SubmitClaimRequest;

    if (
      !body.providerId ||
      !body.patientId ||
      !Array.isArray(body.cptCodes) ||
      body.cptCodes.length === 0 ||
      body.billedAmount == null
    ) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "Missing required fields: providerId, patientId, cptCodes, billedAmount",
      );
    }

    if (body.billedAmount <= 0) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "billedAmount must be a positive number",
      );
    }

    // Idempotency — if we have seen this key before, return the existing claim
    if (body.idempotencyKey) {
      const existing = await db
        .collection("claims")
        .where("correlationId", "==", body.idempotencyKey)
        .limit(1)
        .get();
      if (!existing.empty) {
        const doc = existing.docs[0];
        res.status(200).json({ claimId: doc.id, ...doc.data(), idempotent: true });
        return;
      }
    }

    // Fetch provider, patient in parallel
    const [providerSnap, patientSnap] = await Promise.all([
      db.collection("providers").doc(body.providerId).get(),
      db.collection("patients").doc(body.patientId).get(),
    ]);

    if (!providerSnap.exists) {
      throw new AppError(
        404,
        "PROVIDER_NOT_FOUND",
        `Provider ${body.providerId} not found`,
      );
    }
    if (!patientSnap.exists) {
      throw new AppError(
        404,
        "PATIENT_NOT_FOUND",
        `Patient ${body.patientId} not found`,
      );
    }

    const provider = { id: providerSnap.id, ...providerSnap.data() } as Provider;
    const patient = { id: patientSnap.id, ...patientSnap.data() } as Patient;

    const planSnap = await db
      .collection("insurance_plans")
      .doc(patient.planId)
      .get();
    if (!planSnap.exists) {
      throw new AppError(
        404,
        "PLAN_NOT_FOUND",
        `Insurance plan ${patient.planId} not found`,
      );
    }
    const plan = { id: planSnap.id, ...planSnap.data() } as InsurancePlan;

    // Fetch CPT code metadata
    const cptSnaps = await Promise.all(
      body.cptCodes.map((code) =>
        db.collection("cpt_codes").doc(code).get(),
      ),
    );
    const cptCodeData: Record<string, CptCode> = {};
    for (const snap of cptSnaps) {
      if (snap.exists) {
        cptCodeData[snap.id] = { code: snap.id, ...snap.data() } as CptCode;
      }
    }

    // Fetch last-24h claims for duplicate check
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentSnap = await db
      .collection("claims")
      .where("providerId", "==", body.providerId)
      .where("patientId", "==", body.patientId)
      .where("submittedAt", ">=", Timestamp.fromDate(oneDayAgo))
      .get();
    const existingClaims = recentSnap.docs.map(
      (d) => ({ id: d.id, ...d.data() }) as Claim,
    );

    // Run the rules engine
    const engine = createDefaultRulesEngine();
    const engineResult = await engine.evaluate(body, {
      provider,
      patient,
      plan,
      cptCodeData,
      existingClaims,
    });

    let claimStatus: ClaimStatus;
    let denialReason: string | undefined;
    let flagReason: string | undefined;

    if (
      engineResult.finalAction === "REJECT" ||
      engineResult.finalAction === "DENY"
    ) {
      claimStatus = "DENIED";
      denialReason = `${engineResult.errorCode}: ${engineResult.message}`;
    } else if (engineResult.finalAction === "FLAG") {
      claimStatus = "FLAGGED";
      flagReason = `${engineResult.errorCode}: ${engineResult.message}`;
    } else {
      claimStatus = "PATIENT_BILLED";
    }

    // Calculate adjudication only for claims that will be processed
    let adjudication = null;
    if (claimStatus === "PATIENT_BILLED") {
      adjudication = calculateAdjudication(
        body.billedAmount,
        body.cptCodes,
        plan,
        cptCodeData,
      );
    }

    // Compute provider risk score from historical + this new claim
    const allForAnalysis: ClaimForAnalysis[] = existingClaims.map((c) => ({
      id: c.id,
      providerId: c.providerId,
      patientId: c.patientId,
      cptCodes: c.cptCodes,
      billedAmount: c.billedAmount,
      submittedAt: c.submittedAt.toDate(),
    }));
    const cptStatsMap = new Map<string, CptStats>(
      Object.entries(cptCodeData).map(([code, data]) => [
        code,
        { code, avgBilledAmount: data.avgBilledAmount },
      ]),
    );
    const riskResult = computeRiskScore(
      body.providerId,
      allForAnalysis,
      cptStatsMap,
    );

    const now = FieldValue.serverTimestamp();
    const claimDoc: Record<string, unknown> = {
      providerId: body.providerId,
      patientId: body.patientId,
      cptCodes: body.cptCodes,
      billedAmount: body.billedAmount,
      status: claimStatus,
      submittedAt: now,
      amountPaid: 0,
      riskScore: riskResult.score,
      correlationId: body.idempotencyKey ?? correlationId,
    };

    if (denialReason) claimDoc["denialReason"] = denialReason;
    if (flagReason) claimDoc["flagReason"] = flagReason;

    if (adjudication) {
      Object.assign(claimDoc, adjudication, {
        validatedAt: now,
        adjudicatedAt: now,
        patientBilledAt: now,
      });
    }

    const claimRef = await db.collection("claims").add(claimDoc);

    await db.collection("audit_log").add({
      type: "CLAIM_SUBMITTED",
      claimId: claimRef.id,
      providerId: body.providerId,
      patientId: body.patientId,
      finalAction: engineResult.finalAction,
      ruleResults: engineResult.ruleResults,
      correlationId,
      timestamp: now,
    });

    logger.info("Claim processed", {
      claimId: claimRef.id,
      status: claimStatus,
      riskScore: riskResult.score,
      correlationId,
    });

    const httpStatus =
      claimStatus === "DENIED"
        ? 422
        : claimStatus === "FLAGGED"
          ? 202
          : 201;

    res.status(httpStatus).json({
      claimId: claimRef.id,
      status: claimStatus,
      riskScore: riskResult.score,
      riskSignals: riskResult.signals,
      ruleResults: engineResult.ruleResults,
      ...(adjudication ? { adjudication } : {}),
      ...(denialReason ? { denialReason } : {}),
      ...(flagReason ? { flagReason } : {}),
      correlationId,
    });
  }),
);

// ─── GET /api/claims/:id — Get claim by ID ────────────────────────────────────

router.get(
  "/:id",
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const snap = await db.collection("claims").doc(String(req.params["id"])).get();
    if (!snap.exists) {
      throw new AppError(404, "CLAIM_NOT_FOUND", `Claim ${String(req.params["id"])} not found`);
    }
    res.json({ claimId: snap.id, ...snap.data() });
  }),
);

// ─── GET /api/claims — List claims with filtering & cursor pagination ─────────

router.get(
  "/",
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const { providerId, patientId, status, from, to, cursor, limit } =
      req.query as Record<string, string | undefined>;

    const pageSize = Math.min(parseInt(limit ?? "20", 10), 100);
    let query = db
      .collection("claims")
      .orderBy("submittedAt", "desc")
      .limit(pageSize + 1); // fetch one extra to detect next page

    if (providerId) query = query.where("providerId", "==", providerId);
    if (patientId) query = query.where("patientId", "==", patientId);
    if (status) query = query.where("status", "==", status);
    if (from) {
      query = query.where(
        "submittedAt",
        ">=",
        Timestamp.fromDate(new Date(from)),
      );
    }
    if (to) {
      query = query.where(
        "submittedAt",
        "<=",
        Timestamp.fromDate(new Date(to)),
      );
    }

    // Apply cursor for pagination
    if (cursor) {
      const cursorDoc = await db.collection("claims").doc(cursor).get();
      if (cursorDoc.exists) {
        query = query.startAfter(cursorDoc);
      }
    }

    const snap = await query.get();
    const docs = snap.docs.slice(0, pageSize);
    const hasMore = snap.docs.length > pageSize;
    const nextCursor = hasMore ? docs[docs.length - 1].id : null;

    res.json({
      claims: docs.map((d) => ({ claimId: d.id, ...d.data() })),
      pagination: {
        pageSize,
        hasMore,
        nextCursor,
      },
    });
  }),
);

// ─── POST /api/claims/:id/payments — Process a payment ───────────────────────

router.post(
  "/:id/payments",
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const correlationId = req.correlationId;
    const claimId = String(req.params["id"]);
    const { amount, idempotencyKey } = req.body as {
      amount: number;
      idempotencyKey: string;
    };

    if (amount == null || amount <= 0) {
      throw new AppError(400, "VALIDATION_ERROR", "amount must be positive");
    }
    if (!idempotencyKey) {
      throw new AppError(400, "VALIDATION_ERROR", "idempotencyKey is required");
    }

    // Idempotency check
    const existingPayment = await db
      .collection("payments")
      .where("idempotencyKey", "==", idempotencyKey)
      .limit(1)
      .get();
    if (!existingPayment.empty) {
      const doc = existingPayment.docs[0];
      res.status(200).json({ paymentId: doc.id, ...doc.data(), idempotent: true });
      return;
    }

    const claimSnap = await db.collection("claims").doc(claimId).get();
    if (!claimSnap.exists) {
      throw new AppError(404, "CLAIM_NOT_FOUND", `Claim ${claimId} not found`);
    }

    const claim = { id: claimSnap.id, ...claimSnap.data() } as Claim;

    if (claim.status !== "PATIENT_BILLED") {
      throw new AppError(
        409,
        "INVALID_CLAIM_STATE",
        `Cannot accept payment for a claim with status ${claim.status}. Expected PATIENT_BILLED`,
      );
    }

    const patientResponsibility = claim.patientResponsibility ?? 0;
    const alreadyPaid = claim.amountPaid ?? 0;
    const remaining = patientResponsibility - alreadyPaid;

    if (amount > remaining + 0.01) {
      // Allow tiny float tolerance
      logger.warn("Overpayment detected", {
        claimId,
        amount,
        remaining,
        correlationId,
      });
    }

    const paymentData = {
      claimId,
      patientId: claim.patientId,
      amount,
      status: "processed",
      idempotencyKey,
      processedAt: FieldValue.serverTimestamp(),
      correlationId,
    };

    const paymentRef = await db.collection("payments").add(paymentData);

    // Update claim — move to PAID if fully settled
    const newAmountPaid = alreadyPaid + amount;
    const newStatus: ClaimStatus =
      newAmountPaid >= patientResponsibility - 0.01 ? "PAID" : "PATIENT_BILLED";

    const claimUpdate: Record<string, unknown> = { amountPaid: newAmountPaid };
    if (newStatus === "PAID") {
      claimUpdate["status"] = "PAID";
      claimUpdate["paidAt"] = FieldValue.serverTimestamp();
    }

    await db.collection("claims").doc(claimId).update(claimUpdate);

    await db.collection("audit_log").add({
      type: "PAYMENT_PROCESSED",
      claimId,
      paymentId: paymentRef.id,
      amount,
      overpayment: amount > remaining,
      correlationId,
      timestamp: FieldValue.serverTimestamp(),
    });

    logger.info("Payment processed", {
      paymentId: paymentRef.id,
      claimId,
      amount,
      newClaimStatus: newStatus,
      correlationId,
    });

    const paymentId = paymentRef.id;
    res.status(201).json({
      paymentId,
      claimId,
      amount,
      status: "processed",
      claimStatus: newStatus,
      amountPaid: newAmountPaid,
      remaining: Math.max(0, patientResponsibility - newAmountPaid),
      overpayment: Math.max(0, amount - remaining),
      correlationId,
    });
  }),
);

// ─── GET /api/claims/:id/payments — List payments for a claim ────────────────

router.get(
  "/:id/payments",
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const claimId = String(req.params["id"]);

    const claimSnap = await db.collection("claims").doc(claimId).get();
    if (!claimSnap.exists) {
      throw new AppError(404, "CLAIM_NOT_FOUND", `Claim ${claimId} not found`);
    }

    const snap = await db
      .collection("payments")
      .where("claimId", "==", claimId)
      .orderBy("processedAt", "desc")
      .get();

    res.json({
      claimId,
      payments: snap.docs.map((d) => ({ paymentId: d.id, ...d.data() })),
    });
  }),
);

export default router;

// Named export for use in app.ts
export { router as claimsRouter };

// Helper used by seed route
export { uuidv4 };
