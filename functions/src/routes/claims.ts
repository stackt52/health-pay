import {Router} from "express";
import type {Request, Response, NextFunction} from "express";
import * as logger from "firebase-functions/logger";
import {supabase} from "../db.js";
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
  type Copay,
  type LicenseStatus,
  type CptCategory,
} from "../types.js";
import {createDefaultRulesEngine} from "../engines/rules.js";
import {calculateAdjudication} from "../engines/adjudication.js";
import {computeRiskScore} from "../engines/anomaly.js";

const router = Router();

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

const VALID_CLAIM_STATUSES = new Set<ClaimStatus>([
  "SUBMITTED", "VALIDATED", "ADJUDICATED", "PATIENT_BILLED", "PAID", "DENIED", "FLAGGED",
]);

// ─── Row mappers ──────────────────────────────────────────────────────────────

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
function mapPatient(row: Record<string, any>): Patient {
  return {
    id: row["id"] as string,
    name: row["name"] as string,
    planId: row["plan_id"] as string,
    createdAt: row["created_at"] as string,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapPlan(row: Record<string, any>): InsurancePlan {
  return {
    id: row["id"] as string,
    name: row["name"] as string,
    annualDeductible: Number(row["annual_deductible"]),
    deductibleMet: Number(row["deductible_met"]),
    copay: row["copay"] as Copay,
    coinsuranceRate: Number(row["coinsurance_rate"]),
    outOfPocketMax: Number(row["out_of_pocket_max"]),
    coveredCptCodes: row["covered_cpt_codes"] as string[],
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapCptCode(row: Record<string, any>): CptCode {
  return {
    code: row["code"] as string,
    description: row["description"] as string,
    avgBilledAmount: Number(row["avg_billed_amount"]),
    category: row["category"] as CptCategory,
    incompatibleWith: row["incompatible_with"] as string[],
  };
}

// ─── POST /api/claims — Submit a claim ────────────────────────────────────────

router.post(
  "/",
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const correlationId = req.correlationId;
    const raw = req.body as Record<string, unknown>;

    // ── Input validation ────────────────────────────────────────────────────
    const missing: string[] = [];
    if (!raw["providerId"]) missing.push("providerId");
    if (!raw["patientId"]) missing.push("patientId");
    if (!Array.isArray(raw["cptCodes"]) || (raw["cptCodes"] as unknown[]).length === 0) missing.push("cptCodes");
    if (raw["billedAmount"] == null) missing.push("billedAmount");

    if (missing.length > 0) {
      throw new AppError(400, "VALIDATION_ERROR", `Missing required fields: ${missing.join(", ")}`);
    }

    if (typeof raw["billedAmount"] !== "number" || isNaN(raw["billedAmount"])) {
      throw new AppError(400, "VALIDATION_ERROR", "billedAmount must be a number");
    }

    if (raw["billedAmount"] <= 0) {
      throw new AppError(400, "VALIDATION_ERROR", "billedAmount must be a positive number");
    }

    const cptCodesRaw = raw["cptCodes"] as unknown[];
    const invalidCptCodes = cptCodesRaw.filter(
      (c) => typeof c !== "string" || (c as string).trim() === "",
    );
    if (invalidCptCodes.length > 0) {
      throw new AppError(400, "VALIDATION_ERROR", "cptCodes must be an array of non-empty strings");
    }

    const body = raw as unknown as SubmitClaimRequest;

    // Idempotency — if we have seen this key before, return the existing claim
    if (body.idempotencyKey) {
      const {data: existing} = await supabase
        .from("claims")
        .select("*")
        .eq("correlation_id", body.idempotencyKey)
        .limit(1);

      if (existing && existing.length > 0) {
        const claim = mapClaim(existing[0]);
        res.status(200).json({claimId: claim.id, ...claim, idempotent: true});
        return;
      }
    }

    // Fetch provider and patient in parallel
    const [providerResult, patientResult] = await Promise.all([
      supabase.from("providers").select("*").eq("id", body.providerId).single(),
      supabase.from("patients").select("*").eq("id", body.patientId).single(),
    ]);

    if (providerResult.error || !providerResult.data) {
      throw new AppError(404, "PROVIDER_NOT_FOUND", `Provider ${body.providerId} not found`);
    }
    if (patientResult.error || !patientResult.data) {
      throw new AppError(404, "PATIENT_NOT_FOUND", `Patient ${body.patientId} not found`);
    }

    const provider = mapProvider(providerResult.data);
    const patient = mapPatient(patientResult.data);

    const {data: planRow, error: planErr} = await supabase
      .from("insurance_plans")
      .select("*")
      .eq("id", patient.planId)
      .single();

    if (planErr || !planRow) {
      throw new AppError(404, "PLAN_NOT_FOUND", `Insurance plan ${patient.planId} not found`);
    }
    const plan = mapPlan(planRow);

    // Fetch CPT code metadata
    const {data: cptRows} = await supabase
      .from("cpt_codes")
      .select("*")
      .in("code", body.cptCodes);

    const cptCodeData: Record<string, CptCode> = {};
    for (const row of cptRows ?? []) {
      const cpt = mapCptCode(row);
      cptCodeData[cpt.code] = cpt;
    }

    // Fetch last-24h claims for duplicate check
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const {data: recentRows} = await supabase
      .from("claims")
      .select("*")
      .eq("provider_id", body.providerId)
      .eq("patient_id", body.patientId)
      .gte("submitted_at", oneDayAgo.toISOString());

    const existingClaims = (recentRows ?? []).map(mapClaim);

    // ── Rules engine ────────────────────────────────────────────────────────
    const engine = createDefaultRulesEngine();
    let engineResult;
    try {
      engineResult = await engine.evaluate(body, {
        provider,
        patient,
        plan,
        cptCodeData,
        existingClaims,
      });
    } catch (err) {
      logger.error("Rules engine failure", {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        providerId: body.providerId,
        patientId: body.patientId,
        correlationId,
      });
      throw new AppError(
        500,
        "RULES_ENGINE_ERROR",
        "Failed to evaluate claim rules. Please try again.",
        {providerId: body.providerId, patientId: body.patientId},
      );
    }

    let claimStatus: ClaimStatus;
    let denialReason: string | undefined;
    let flagReason: string | undefined;

    if (engineResult.finalAction === "REJECT" || engineResult.finalAction === "DENY") {
      claimStatus = "DENIED";
      denialReason = `${engineResult.errorCode}: ${engineResult.message}`;
    } else if (engineResult.finalAction === "FLAG") {
      claimStatus = "FLAGGED";
      flagReason = `${engineResult.errorCode}: ${engineResult.message}`;
    } else {
      claimStatus = "PATIENT_BILLED";
    }

    // ── Adjudication ────────────────────────────────────────────────────────
    let adjudication = null;
    if (claimStatus === "PATIENT_BILLED") {
      try {
        adjudication = calculateAdjudication(body.billedAmount, body.cptCodes, plan, cptCodeData);
      } catch (err) {
        logger.error("Adjudication failure", {
          error: err instanceof Error ? err.message : String(err),
          providerId: body.providerId,
          billedAmount: body.billedAmount,
          correlationId,
        });
        throw new AppError(
          500,
          "ADJUDICATION_ERROR",
          "Failed to calculate patient responsibility. Please try again.",
          {billedAmount: body.billedAmount},
        );
      }
    }

    // ── Risk scoring (non-fatal) ─────────────────────────────────────────────
    const allForAnalysis: ClaimForAnalysis[] = existingClaims.map((c) => ({
      id: c.id,
      providerId: c.providerId,
      patientId: c.patientId,
      cptCodes: c.cptCodes,
      billedAmount: c.billedAmount,
      submittedAt: new Date(c.submittedAt),
    }));
    const cptStatsMap = new Map<string, CptStats>(
      Object.entries(cptCodeData).map(([code, data]) => [
        code,
        {code, avgBilledAmount: data.avgBilledAmount},
      ]),
    );
    let riskResult;
    try {
      riskResult = computeRiskScore(body.providerId, allForAnalysis, cptStatsMap);
    } catch (err) {
      logger.warn("Risk scoring failure — defaulting to score 0", {
        error: err instanceof Error ? err.message : String(err),
        providerId: body.providerId,
        correlationId,
      });
      riskResult = {
        score: 0,
        signals: {velocityScore: 0, amountScore: 0, clusteringScore: 0, temporalScore: 0},
      };
    }

    // ── Persist claim ────────────────────────────────────────────────────────
    const now = new Date().toISOString();
    const claimDoc: Record<string, unknown> = {
      provider_id: body.providerId,
      patient_id: body.patientId,
      cpt_codes: body.cptCodes,
      billed_amount: body.billedAmount,
      status: claimStatus,
      submitted_at: now,
      amount_paid: 0,
      risk_score: riskResult.score,
      correlation_id: body.idempotencyKey ?? correlationId,
    };

    if (denialReason) claimDoc["denial_reason"] = denialReason;
    if (flagReason) claimDoc["flag_reason"] = flagReason;

    if (adjudication) {
      claimDoc["insurer_amount"] = adjudication.insurerAmount;
      claimDoc["patient_responsibility"] = adjudication.patientResponsibility;
      claimDoc["deductible_applied"] = adjudication.deductibleApplied;
      claimDoc["copay_applied"] = adjudication.copayApplied;
      claimDoc["coinsurance_applied"] = adjudication.coinsuranceApplied;
      claimDoc["validated_at"] = now;
      claimDoc["adjudicated_at"] = now;
      claimDoc["patient_billed_at"] = now;
    }

    const {data: claimRow, error: claimErr} = await supabase
      .from("claims")
      .insert(claimDoc)
      .select()
      .single();

    if (claimErr || !claimRow) {
      logger.error("Failed to write claim to Supabase", {
        error: claimErr?.message,
        providerId: body.providerId,
        patientId: body.patientId,
        correlationId,
      });
      throw new AppError(
        500,
        "CLAIM_WRITE_FAILED",
        "Failed to persist claim. Please retry with your idempotency key.",
      );
    }

    const claimId = claimRow["id"] as string;

    // ── Audit log (non-fatal) ────────────────────────────────────────────────
    supabase
      .from("audit_log")
      .insert({
        type: "CLAIM_SUBMITTED",
        claim_id: claimId,
        provider_id: body.providerId,
        patient_id: body.patientId,
        final_action: engineResult.finalAction,
        rule_results: engineResult.ruleResults,
        correlation_id: correlationId,
        timestamp: now,
      })
      .then(
        () => undefined,
        (err: unknown) => {
          logger.warn("Audit log write failed — claim already persisted", {
            claimId,
            error: err instanceof Error ? err.message : String(err),
            correlationId,
          });
        },
      );

    logger.info("Claim processed", {claimId, status: claimStatus, riskScore: riskResult.score, correlationId});

    const httpStatus =
      claimStatus === "DENIED" ? 422 : claimStatus === "FLAGGED" ? 202 : 201;

    res.status(httpStatus).json({
      claimId,
      status: claimStatus,
      riskScore: riskResult.score,
      riskSignals: riskResult.signals,
      ruleResults: engineResult.ruleResults,
      ...(adjudication ? {adjudication} : {}),
      ...(denialReason ? {denialReason} : {}),
      ...(flagReason ? {flagReason} : {}),
      correlationId,
    });
  }),
);

// ─── GET /api/claims/:id — Get claim by ID ────────────────────────────────────

router.get(
  "/:id",
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const claimId = String(req.params["id"]);
    const {data: row, error} = await supabase
      .from("claims")
      .select("*")
      .eq("id", claimId)
      .single();

    if (error || !row) {
      throw new AppError(404, "CLAIM_NOT_FOUND", `Claim ${claimId} not found`);
    }

    const claim = mapClaim(row);
    res.json({claimId: claim.id, ...claim});
  }),
);

// ─── GET /api/claims — List claims with filtering & cursor pagination ─────────

router.get(
  "/",
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const {providerId, patientId, status, from, to, cursor, limit} =
      req.query as Record<string, string | undefined>;

    const parsedLimit = parseInt(limit ?? "20", 10);
    if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      throw new AppError(400, "VALIDATION_ERROR", "limit must be an integer between 1 and 100");
    }

    if (status !== undefined && !VALID_CLAIM_STATUSES.has(status as ClaimStatus)) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        `status must be one of: ${[...VALID_CLAIM_STATUSES].join(", ")}`,
      );
    }

    if (from !== undefined && isNaN(new Date(from).getTime())) {
      throw new AppError(400, "VALIDATION_ERROR", "from must be a valid ISO 8601 date");
    }

    if (to !== undefined && isNaN(new Date(to).getTime())) {
      throw new AppError(400, "VALIDATION_ERROR", "to must be a valid ISO 8601 date");
    }

    const pageSize = parsedLimit;

    let query = supabase
      .from("claims")
      .select("*")
      .order("submitted_at", {ascending: false})
      .limit(pageSize + 1);

    if (providerId) query = query.eq("provider_id", providerId);
    if (patientId) query = query.eq("patient_id", patientId);
    if (status) query = query.eq("status", status);
    if (from) query = query.gte("submitted_at", new Date(from).toISOString());
    if (to) query = query.lte("submitted_at", new Date(to).toISOString());

    // Cursor pagination: look up the cursor claim's submitted_at and page after it
    if (cursor) {
      const {data: cursorRow} = await supabase
        .from("claims")
        .select("submitted_at")
        .eq("id", cursor)
        .single();

      if (cursorRow) {
        query = query.lt("submitted_at", cursorRow["submitted_at"] as string);
      }
    }

    const {data: rows, error} = await query;
    if (error) {
      logger.error("Failed to list claims", {error: error.message});
      throw new AppError(500, "CLAIMS_FETCH_FAILED", "Failed to fetch claims");
    }

    const docs = (rows ?? []).slice(0, pageSize);
    const hasMore = (rows ?? []).length > pageSize;
    const nextCursor = hasMore ? docs[docs.length - 1]["id"] as string : null;

    res.json({
      claims: docs.map((r) => {
        const c = mapClaim(r);
        return {claimId: c.id, ...c};
      }),
      pagination: {pageSize, hasMore, nextCursor},
    });
  }),
);

// ─── POST /api/claims/:id/payments — Process a payment ───────────────────────

router.post(
  "/:id/payments",
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const correlationId = req.correlationId;
    const claimId = String(req.params["id"]);
    const rawPayment = req.body as Record<string, unknown>;

    // ── Input validation ────────────────────────────────────────────────────
    if (rawPayment["amount"] == null) {
      throw new AppError(400, "VALIDATION_ERROR", "amount is required");
    }
    if (typeof rawPayment["amount"] !== "number" || isNaN(rawPayment["amount"])) {
      throw new AppError(400, "VALIDATION_ERROR", "amount must be a number");
    }
    if (rawPayment["amount"] <= 0) {
      throw new AppError(400, "VALIDATION_ERROR", "amount must be a positive number");
    }
    if (
      !rawPayment["idempotencyKey"] ||
      typeof rawPayment["idempotencyKey"] !== "string" ||
      rawPayment["idempotencyKey"].trim() === ""
    ) {
      throw new AppError(400, "VALIDATION_ERROR", "idempotencyKey is required and must be a non-empty string");
    }

    const amount = rawPayment["amount"] as number;
    const idempotencyKey = rawPayment["idempotencyKey"] as string;

    // Idempotency check
    const {data: existingPayments} = await supabase
      .from("payments")
      .select("*")
      .eq("idempotency_key", idempotencyKey)
      .limit(1);

    if (existingPayments && existingPayments.length > 0) {
      const row = existingPayments[0];
      res.status(200).json({
        paymentId: row["id"],
        claimId: row["claim_id"],
        patientId: row["patient_id"],
        amount: Number(row["amount"]),
        status: row["status"],
        idempotencyKey: row["idempotency_key"],
        processedAt: row["processed_at"],
        correlationId: row["correlation_id"],
        idempotent: true,
      });
      return;
    }

    const {data: claimRow, error: claimErr} = await supabase
      .from("claims")
      .select("*")
      .eq("id", claimId)
      .single();

    if (claimErr || !claimRow) {
      throw new AppError(404, "CLAIM_NOT_FOUND", `Claim ${claimId} not found`);
    }

    const claim = mapClaim(claimRow);

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
      logger.warn("Overpayment detected", {claimId, amount, remaining, correlationId});
    }

    const now = new Date().toISOString();
    const {data: paymentRow, error: paymentErr} = await supabase
      .from("payments")
      .insert({
        claim_id: claimId,
        patient_id: claim.patientId,
        amount,
        status: "processed",
        idempotency_key: idempotencyKey,
        processed_at: now,
        correlation_id: correlationId,
      })
      .select()
      .single();

    if (paymentErr || !paymentRow) {
      logger.error("Failed to write payment to Supabase", {
        error: paymentErr?.message,
        claimId,
        amount,
        correlationId,
      });
      throw new AppError(
        500,
        "PAYMENT_WRITE_FAILED",
        "Failed to persist payment. Please retry with your idempotency key.",
      );
    }

    const paymentId = paymentRow["id"] as string;

    // Update claim — move to PAID if fully settled
    const newAmountPaid = alreadyPaid + amount;
    const newStatus: ClaimStatus =
      newAmountPaid >= patientResponsibility - 0.01 ? "PAID" : "PATIENT_BILLED";

    const claimUpdate: Record<string, unknown> = {amount_paid: newAmountPaid};
    if (newStatus === "PAID") {
      claimUpdate["status"] = "PAID";
      claimUpdate["paid_at"] = now;
    }

    const {error: updateErr} = await supabase
      .from("claims")
      .update(claimUpdate)
      .eq("id", claimId);

    if (updateErr) {
      logger.error("Failed to update claim status after payment", {
        error: updateErr.message,
        claimId,
        paymentId,
        newStatus,
        correlationId,
      });
      throw new AppError(
        500,
        "CLAIM_UPDATE_FAILED",
        "Payment was recorded but claim status could not be updated. Please contact support.",
        {paymentId, claimId},
      );
    }

    // ── Audit log (non-fatal) ────────────────────────────────────────────────
    supabase
      .from("audit_log")
      .insert({
        type: "PAYMENT_PROCESSED",
        claim_id: claimId,
        payment_id: paymentId,
        amount,
        overpayment: amount > remaining,
        correlation_id: correlationId,
        timestamp: now,
      })
      .then(
        () => undefined,
        (err: unknown) => {
          logger.warn("Audit log write failed — payment already persisted", {
            paymentId,
            claimId,
            error: err instanceof Error ? err.message : String(err),
            correlationId,
          });
        },
      );

    logger.info("Payment processed", {paymentId, claimId, amount, newClaimStatus: newStatus, correlationId});

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

    const {data: claimRow, error: claimErr} = await supabase
      .from("claims")
      .select("id")
      .eq("id", claimId)
      .single();

    if (claimErr || !claimRow) {
      throw new AppError(404, "CLAIM_NOT_FOUND", `Claim ${claimId} not found`);
    }

    const {data: rows, error} = await supabase
      .from("payments")
      .select("*")
      .eq("claim_id", claimId)
      .order("processed_at", {ascending: false});

    if (error) {
      logger.error("Failed to list payments", {error: error.message, claimId});
      throw new AppError(500, "PAYMENTS_FETCH_FAILED", "Failed to fetch payments");
    }

    res.json({
      claimId,
      payments: (rows ?? []).map((r) => ({
        paymentId: r["id"],
        claimId: r["claim_id"],
        patientId: r["patient_id"],
        amount: Number(r["amount"]),
        status: r["status"],
        idempotencyKey: r["idempotency_key"],
        processedAt: r["processed_at"],
        correlationId: r["correlation_id"],
      })),
    });
  }),
);

export default router;
export {router as claimsRouter};
