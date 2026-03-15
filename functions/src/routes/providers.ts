import {Router} from "express";
import type {Request, Response, NextFunction} from "express";
import * as logger from "firebase-functions/logger";
import {supabase} from "../db.js";
import {
  AppError,
  type Claim,
  type ClaimStatus,
  type ClaimForAnalysis,
  type CptStats,
  type LicenseStatus,
  type Provider,
} from "../types.js";
import {computeRiskScore} from "../engines/anomaly.js";

const router = Router();

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

const VALID_LICENSE_STATUSES: LicenseStatus[] = ["active", "expired", "suspended"];

// ─── Row mappers ──────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapProvider(row: Record<string, any>): Provider {
  return {
    id: row["id"] as string,
    name: row["name"] as string,
    licenseStatus: row["license_status"] as LicenseStatus,
    licenseExpiry: row["license_expiry"] as string,
    createdAt: row["created_at"] as string,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapClaim(row: Record<string, any>): Claim {
  return {
    id: row["id"] as string,
    providerId: row["provider_id"] as string,
    patientId: row["patient_id"] as string,
    cptCodes: row["cpt_codes"] as string[],
    billedAmount: Number(row["billed_amount"]),
    status: row["status"] as ClaimStatus,
    submittedAt: row["submitted_at"] as string,
    validatedAt: row["validated_at"] ?? undefined,
    adjudicatedAt: row["adjudicated_at"] ?? undefined,
    patientBilledAt: row["patient_billed_at"] ?? undefined,
    paidAt: row["paid_at"] ?? undefined,
    denialReason: row["denial_reason"] ?? undefined,
    flagReason: row["flag_reason"] ?? undefined,
    insurerAmount: row["insurer_amount"] != null ? Number(row["insurer_amount"]) : undefined,
    patientResponsibility: row["patient_responsibility"] != null ? Number(row["patient_responsibility"]) : undefined,
    deductibleApplied: row["deductible_applied"] != null ? Number(row["deductible_applied"]) : undefined,
    copayApplied: row["copay_applied"] != null ? Number(row["copay_applied"]) : undefined,
    coinsuranceApplied: row["coinsurance_applied"] != null ? Number(row["coinsurance_applied"]) : undefined,
    amountPaid: Number(row["amount_paid"] ?? 0),
    riskScore: Number(row["risk_score"] ?? 0),
    correlationId: row["correlation_id"] as string,
  };
}

// ─── POST /api/providers ──────────────────────────────────────────────────────

router.post(
  "/",
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const {name, licenseStatus, licenseExpiry} = req.body as {
      name?: string;
      licenseStatus?: string;
      licenseExpiry?: string;
    };

    if (!name || !licenseStatus || !licenseExpiry) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "Missing required fields: name, licenseStatus, licenseExpiry",
      );
    }

    if (!VALID_LICENSE_STATUSES.includes(licenseStatus as LicenseStatus)) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        `licenseStatus must be one of: ${VALID_LICENSE_STATUSES.join(", ")}`,
      );
    }

    const expiryDate = new Date(licenseExpiry);
    if (isNaN(expiryDate.getTime())) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "licenseExpiry must be a valid ISO 8601 date",
      );
    }

    const {data: row, error} = await supabase
      .from("providers")
      .insert({
        name,
        license_status: licenseStatus,
        license_expiry: expiryDate.toISOString(),
      })
      .select()
      .single();

    if (error) {
      logger.error("Failed to create provider", {error: error.message});
      throw new AppError(500, "PROVIDER_CREATE_FAILED", "Failed to create provider");
    }

    res.status(201).json(mapProvider(row));
  }),
);

// ─── GET /api/providers ───────────────────────────────────────────────────────

router.get(
  "/",
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const {licenseStatus} = req.query as {licenseStatus?: string};

    if (licenseStatus && !VALID_LICENSE_STATUSES.includes(licenseStatus as LicenseStatus)) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        `licenseStatus must be one of: ${VALID_LICENSE_STATUSES.join(", ")}`,
      );
    }

    let query = supabase.from("providers").select("*");
    if (licenseStatus) {
      query = query.eq("license_status", licenseStatus);
    }

    const {data: rows, error} = await query;
    if (error) {
      logger.error("Failed to list providers", {error: error.message});
      throw new AppError(500, "PROVIDERS_FETCH_FAILED", "Failed to fetch providers");
    }

    const providers = (rows ?? []).map(mapProvider);
    res.json({providers, total: providers.length});
  }),
);

// ─── GET /api/providers/:id ───────────────────────────────────────────────────

router.get(
  "/:id",
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const providerId = String(req.params["id"]);
    const {data: row, error} = await supabase
      .from("providers")
      .select("*")
      .eq("id", providerId)
      .single();

    if (error || !row) {
      throw new AppError(404, "PROVIDER_NOT_FOUND", `Provider ${providerId} not found`);
    }

    res.json(mapProvider(row));
  }),
);

// ─── PUT /api/providers/:id ───────────────────────────────────────────────────

router.put(
  "/:id",
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const providerId = String(req.params["id"]);
    const {name, licenseStatus, licenseExpiry} = req.body as {
      name?: string;
      licenseStatus?: string;
      licenseExpiry?: string;
    };

    const {data: existing, error: fetchError} = await supabase
      .from("providers")
      .select("id")
      .eq("id", providerId)
      .single();

    if (fetchError || !existing) {
      throw new AppError(404, "PROVIDER_NOT_FOUND", `Provider ${providerId} not found`);
    }

    if (
      licenseStatus !== undefined &&
      !VALID_LICENSE_STATUSES.includes(licenseStatus as LicenseStatus)
    ) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        `licenseStatus must be one of: ${VALID_LICENSE_STATUSES.join(", ")}`,
      );
    }

    const updates: Record<string, unknown> = {};
    if (name !== undefined) updates["name"] = name;
    if (licenseStatus !== undefined) updates["license_status"] = licenseStatus;
    if (licenseExpiry !== undefined) {
      const expiryDate = new Date(licenseExpiry);
      if (isNaN(expiryDate.getTime())) {
        throw new AppError(400, "VALIDATION_ERROR", "licenseExpiry must be a valid ISO 8601 date");
      }
      updates["license_expiry"] = expiryDate.toISOString();
    }

    if (Object.keys(updates).length === 0) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "No updatable fields provided. Accepted: name, licenseStatus, licenseExpiry",
      );
    }

    const {data: row, error} = await supabase
      .from("providers")
      .update(updates)
      .eq("id", providerId)
      .select()
      .single();

    if (error || !row) {
      logger.error("Failed to update provider", {error: error?.message});
      throw new AppError(500, "PROVIDER_UPDATE_FAILED", "Failed to update provider");
    }

    res.json(mapProvider(row));
  }),
);

// ─── DELETE /api/providers/:id ────────────────────────────────────────────────

router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const providerId = String(req.params["id"]);

    const {data: existing, error: fetchError} = await supabase
      .from("providers")
      .select("id")
      .eq("id", providerId)
      .single();

    if (fetchError || !existing) {
      throw new AppError(404, "PROVIDER_NOT_FOUND", `Provider ${providerId} not found`);
    }

    const {error} = await supabase.from("providers").delete().eq("id", providerId);
    if (error) {
      logger.error("Failed to delete provider", {error: error.message});
      throw new AppError(500, "PROVIDER_DELETE_FAILED", "Failed to delete provider");
    }

    res.status(204).send();
  }),
);

// ─── GET /api/providers/:id/dashboard ─────────────────────────────────────────

router.get(
  "/:id/dashboard",
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const providerId = String(req.params["id"]);

    const {data: providerRow, error: provErr} = await supabase
      .from("providers")
      .select("*")
      .eq("id", providerId)
      .single();

    if (provErr || !providerRow) {
      throw new AppError(404, "PROVIDER_NOT_FOUND", `Provider ${providerId} not found`);
    }

    const {data: claimRows} = await supabase
      .from("claims")
      .select("*")
      .eq("provider_id", providerId);

    const claims = (claimRows ?? []).map(mapClaim);

    // Summary by status
    const byStatus: Record<string, number> = {};
    const statusOrder: ClaimStatus[] = [
      "SUBMITTED", "VALIDATED", "ADJUDICATED", "PATIENT_BILLED", "PAID", "DENIED", "FLAGGED",
    ];
    for (const s of statusOrder) byStatus[s] = 0;
    for (const c of claims) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;

    // Total revenue
    const revenueStatuses = new Set<ClaimStatus>(["ADJUDICATED", "PATIENT_BILLED", "PAID"]);
    const totalRevenue = claims
      .filter((c) => revenueStatuses.has(c.status))
      .reduce((sum, c) => sum + (c.insurerAmount ?? 0), 0);

    // Average processing time (SUBMITTED → PATIENT_BILLED) in minutes
    const processedClaims = claims.filter(
      (c) => c.patientBilledAt !== undefined && c.submittedAt !== undefined,
    );
    let avgProcessingTimeMinutes = 0;
    if (processedClaims.length > 0) {
      const totalMs = processedClaims.reduce((sum, c) => {
        const submitted = new Date(c.submittedAt).getTime();
        const billed = c.patientBilledAt ? new Date(c.patientBilledAt).getTime() : undefined;
        return billed !== undefined ? sum + (billed - submitted) : sum;
      }, 0);
      avgProcessingTimeMinutes = totalMs / processedClaims.length / (60 * 1000);
    }

    // Flagged claim rate
    const flaggedCount = claims.filter(
      (c) => c.status === "FLAGGED" || (c.riskScore ?? 0) >= 70,
    ).length;
    const flaggedClaimRate = claims.length > 0 ? flaggedCount / claims.length : 0;

    // Latest risk score
    const latestRiskScore =
      claims.length > 0 ? Math.max(...claims.map((c) => c.riskScore ?? 0)) : 0;

    res.json({
      providerId,
      provider: mapProvider(providerRow),
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

// ─── POST /api/providers/:id/risk-score ───────────────────────────────────────

router.post(
  "/:id/risk-score",
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const providerId = String(req.params["id"]);
    const {windowDays = 90} = req.body as {windowDays?: number};

    const {data: providerRow, error: provErr} = await supabase
      .from("providers")
      .select("id")
      .eq("id", providerId)
      .single();

    if (provErr || !providerRow) {
      throw new AppError(404, "PROVIDER_NOT_FOUND", `Provider ${providerId} not found`);
    }

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - windowDays);

    const {data: claimRows} = await supabase
      .from("claims")
      .select("*")
      .eq("provider_id", providerId)
      .gte("submitted_at", cutoff.toISOString());

    const claims: ClaimForAnalysis[] = (claimRows ?? []).map((row) => ({
      id: row["id"] as string,
      providerId: row["provider_id"] as string,
      patientId: row["patient_id"] as string,
      cptCodes: row["cpt_codes"] as string[],
      billedAmount: Number(row["billed_amount"]),
      submittedAt: new Date(row["submitted_at"] as string),
    }));

    // Fetch CPT stats for all codes seen in these claims
    const allCodes = [...new Set(claims.flatMap((c) => c.cptCodes))];
    const cptStatsMap = new Map<string, CptStats>();

    if (allCodes.length > 0) {
      const {data: cptRows} = await supabase
        .from("cpt_codes")
        .select("code, avg_billed_amount")
        .in("code", allCodes);

      for (const row of cptRows ?? []) {
        cptStatsMap.set(row["code"] as string, {
          code: row["code"] as string,
          avgBilledAmount: Number(row["avg_billed_amount"]),
        });
      }
    }

    const result = computeRiskScore(providerId, claims, cptStatsMap);
    res.json(result);
  }),
);

export default router;
export {router as providersRouter};
