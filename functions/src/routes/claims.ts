import {Router} from "express";
import type {Request, Response, NextFunction} from "express";
import {FieldValue, Timestamp} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {db} from "../db.js";
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
  "SUBMITTED",
  "VALIDATED",
  "ADJUDICATED",
  "PATIENT_BILLED",
  "PAID",
  "DENIED",
  "FLAGGED",
]);

// ─── POST /api/claims — Submit a claim ────────────────────────────────────────

router.post(
  "/",
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const correlationId = req.correlationId;
    // Validate from raw body before casting so runtime types are checked correctly
    const raw = req.body as Record<string, unknown>;

    // ── Input validation ────────────────────────────────────────────────────
    const missing: string[] = [];
    if (!raw["providerId"]) missing.push("providerId");
    if (!raw["patientId"]) missing.push("patientId");
    if (!Array.isArray(raw["cptCodes"]) || (raw["cptCodes"] as unknown[]).length === 0) missing.push("cptCodes");
    if (raw["billedAmount"] == null) missing.push("billedAmount");

    if (missing.length > 0) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        `Missing required fields: ${missing.join(", ")}`,
      );
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
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "cptCodes must be an array of non-empty strings",
      );
    }

    const body = raw as unknown as SubmitClaimRequest;

    // Idempotency — if we have seen this key before, return the existing claim
    if (body.idempotencyKey) {
      const existing = await db
        .collection("claims")
        .where("correlationId", "==", body.idempotencyKey)
        .limit(1)
        .get();
      if (!existing.empty) {
        const doc = existing.docs[0];
        res.status(200).json({claimId: doc.id, ...doc.data(), idempotent: true});
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

    const provider = {id: providerSnap.id, ...providerSnap.data()} as Provider;
    const patient = {id: patientSnap.id, ...patientSnap.data()} as Patient;

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
    const plan = {id: planSnap.id, ...planSnap.data()} as InsurancePlan;

    // Fetch CPT code metadata
    const cptSnaps = await Promise.all(
      body.cptCodes.map((code) =>
        db.collection("cpt_codes").doc(code).get(),
      ),
    );
    const cptCodeData: Record<string, CptCode> = {};
    for (const snap of cptSnaps) {
      if (snap.exists) {
        cptCodeData[snap.id] = {code: snap.id, ...snap.data()} as CptCode;
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
      (d) => ({id: d.id, ...d.data()}) as Claim,
    );

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

    // ── Adjudication ────────────────────────────────────────────────────────
    let adjudication = null;
    if (claimStatus === "PATIENT_BILLED") {
      try {
        adjudication = calculateAdjudication(
          body.billedAmount,
          body.cptCodes,
          plan,
          cptCodeData,
        );
      } catch (err) {
        logger.error("Adjudication failure", {
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
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

    // ── Risk scoring (non-fatal — defaults to 0 on failure) ─────────────────
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

    let claimRef;
    try {
      claimRef = await db.collection("claims").add(claimDoc);
    } catch (err) {
      logger.error("Failed to write claim to Firestore", {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
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

    // ── Audit log (non-fatal) ────────────────────────────────────────────────
    db.collection("audit_log")
      .add({
        type: "CLAIM_SUBMITTED",
        claimId: claimRef.id,
        providerId: body.providerId,
        patientId: body.patientId,
        finalAction: engineResult.finalAction,
        ruleResults: engineResult.ruleResults,
        correlationId,
        timestamp: now,
      })
      .catch((err: unknown) => {
        logger.warn("Audit log write failed — claim already persisted", {
          claimId: claimRef.id,
          error: err instanceof Error ? err.message : String(err),
          correlationId,
        });
      });

    logger.info("Claim processed", {
      claimId: claimRef.id,
      status: claimStatus,
      riskScore: riskResult.score,
      correlationId,
    });

    const httpStatus =
      claimStatus === "DENIED" ?
        422 :
        claimStatus === "FLAGGED" ?
          202 :
          201;

    res.status(httpStatus).json({
      claimId: claimRef.id,
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
    const snap = await db.collection("claims").doc(String(req.params["id"])).get();
    if (!snap.exists) {
      throw new AppError(404, "CLAIM_NOT_FOUND", `Claim ${String(req.params["id"])} not found`);
    }
    res.json({claimId: snap.id, ...snap.data()});
  }),
);

// ─── GET /api/claims — List claims with filtering & cursor pagination ─────────

router.get(
  "/",
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const {providerId, patientId, status, from, to, cursor, limit} =
      req.query as Record<string, string | undefined>;

    // ── Query param validation ───────────────────────────────────────────────
    const parsedLimit = parseInt(limit ?? "20", 10);
    if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "limit must be an integer between 1 and 100",
      );
    }

    if (status !== undefined && !VALID_CLAIM_STATUSES.has(status as ClaimStatus)) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        `status must be one of: ${[...VALID_CLAIM_STATUSES].join(", ")}`,
      );
    }

    if (from !== undefined) {
      const d = new Date(from);
      if (isNaN(d.getTime())) {
        throw new AppError(400, "VALIDATION_ERROR", "from must be a valid ISO 8601 date");
      }
    }

    if (to !== undefined) {
      const d = new Date(to);
      if (isNaN(d.getTime())) {
        throw new AppError(400, "VALIDATION_ERROR", "to must be a valid ISO 8601 date");
      }
    }

    const pageSize = parsedLimit;
    let query = db
      .collection("claims")
      .orderBy("submittedAt", "desc")
      .limit(pageSize + 1); // fetch one extra to detect the next page

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
      claims: docs.map((d) => ({claimId: d.id, ...d.data()})),
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
    const existingPayment = await db
      .collection("payments")
      .where("idempotencyKey", "==", idempotencyKey)
      .limit(1)
      .get();
    if (!existingPayment.empty) {
      const doc = existingPayment.docs[0];
      res.status(200).json({paymentId: doc.id, ...doc.data(), idempotent: true});
      return;
    }

    const claimSnap = await db.collection("claims").doc(claimId).get();
    if (!claimSnap.exists) {
      throw new AppError(404, "CLAIM_NOT_FOUND", `Claim ${claimId} not found`);
    }

    const claim = {id: claimSnap.id, ...claimSnap.data()} as Claim;

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

    let paymentRef;
    try {
      paymentRef = await db.collection("payments").add(paymentData);
    } catch (err) {
      logger.error("Failed to write payment to Firestore", {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
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

    // Update claim — move to PAID if fully settled
    const newAmountPaid = alreadyPaid + amount;
    const newStatus: ClaimStatus =
      newAmountPaid >= patientResponsibility - 0.01 ? "PAID" : "PATIENT_BILLED";

    const claimUpdate: Record<string, unknown> = {amountPaid: newAmountPaid};
    if (newStatus === "PAID") {
      claimUpdate["status"] = "PAID";
      claimUpdate["paidAt"] = FieldValue.serverTimestamp();
    }

    try {
      await db.collection("claims").doc(claimId).update(claimUpdate);
    } catch (err) {
      logger.error("Failed to update claim status after payment", {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        claimId,
        paymentId: paymentRef.id,
        newStatus,
        correlationId,
      });
      throw new AppError(
        500,
        "CLAIM_UPDATE_FAILED",
        "Payment was recorded but claim status could not be updated. Please contact support.",
        {paymentId: paymentRef.id, claimId},
      );
    }

    // ── Audit log (non-fatal) ────────────────────────────────────────────────
    db.collection("audit_log")
      .add({
        type: "PAYMENT_PROCESSED",
        claimId,
        paymentId: paymentRef.id,
        amount,
        overpayment: amount > remaining,
        correlationId,
        timestamp: FieldValue.serverTimestamp(),
      })
      .catch((err: unknown) => {
        logger.warn("Audit log write failed — payment already persisted", {
          paymentId: paymentRef.id,
          claimId,
          error: err instanceof Error ? err.message : String(err),
          correlationId,
        });
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
      payments: snap.docs.map((d) => ({paymentId: d.id, ...d.data()})),
    });
  }),
);

export default router;
export {router as claimsRouter};
