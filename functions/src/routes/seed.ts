import {Router} from "express";
import type {Request, Response, NextFunction} from "express";
import * as logger from "firebase-functions/logger";
import {supabase} from "../db.js";

const router = Router();

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
}

/**
 * POST /api/seed
 *
 * Idempotent for reference data (CPT codes, plans, providers, patients).
 * Creates sample claims for both normal and anomalous providers.
 */
router.post(
  "/",
  asyncHandler(async (_req: Request, res: Response): Promise<void> => {
    // ─── CPT Codes ────────────────────────────────────────────────────────────
    const cptCodes = [
      {code: "99213", description: "Office visit, established patient", avg_billed_amount: 150, category: "office_visit", incompatible_with: ["99214"]},
      {code: "99214", description: "Office visit, detailed exam", avg_billed_amount: 250, category: "office_visit", incompatible_with: ["99213"]},
      {code: "99283", description: "Emergency dept visit, moderate", avg_billed_amount: 800, category: "emergency", incompatible_with: ["90837"]},
      {code: "90837", description: "Psychotherapy, 60 min", avg_billed_amount: 200, category: "therapy", incompatible_with: ["99283"]},
      {code: "73721", description: "MRI lower extremity", avg_billed_amount: 1200, category: "imaging", incompatible_with: ["29881"]},
      {code: "29881", description: "Knee arthroscopy", avg_billed_amount: 4500, category: "procedure", incompatible_with: ["73721"]},
    ];

    const {error: cptErr} = await supabase
      .from("cpt_codes")
      .upsert(cptCodes, {onConflict: "code"});
    if (cptErr) {
      logger.error("Failed to upsert CPT codes", {error: cptErr.message});
      throw new Error("Seed failed at cpt_codes");
    }

    // ─── Insurance Plans ──────────────────────────────────────────────────────
    const plans = [
      {
        id: "PLAN_GOLD_001",
        name: "HealthPay Gold",
        annual_deductible: 1500,
        deductible_met: 800,
        copay: {officeVisit: 30, specialist: 50, emergency: 250},
        coinsurance_rate: 0.2,
        out_of_pocket_max: 6000,
        covered_cpt_codes: ["99213", "99214", "99283", "90837", "73721", "29881"],
      },
      {
        id: "PLAN_BRONZE_001",
        name: "HealthPay Bronze",
        annual_deductible: 5000,
        deductible_met: 200,
        copay: {officeVisit: 75, specialist: 100, emergency: 500},
        coinsurance_rate: 0.4,
        out_of_pocket_max: 8000,
        covered_cpt_codes: ["99213", "99214", "99283"],
      },
    ];

    const {error: plansErr} = await supabase
      .from("insurance_plans")
      .upsert(plans, {onConflict: "id"});
    if (plansErr) {
      logger.error("Failed to upsert insurance plans", {error: plansErr.message});
      throw new Error("Seed failed at insurance_plans");
    }

    // ─── Providers ────────────────────────────────────────────────────────────
    const futureExpiry = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const pastExpiry = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const providers = [
      {id: "PROV_NORMAL_001", name: "Dr. Alice Chen", license_status: "active", license_expiry: futureExpiry},
      {id: "PROV_ANOMALOUS_001", name: "Dr. Bob Fraud", license_status: "active", license_expiry: futureExpiry},
      {id: "PROV_EXPIRED_001", name: "Dr. Carol Lapsed", license_status: "expired", license_expiry: pastExpiry},
    ];

    const {error: provErr} = await supabase
      .from("providers")
      .upsert(providers, {onConflict: "id"});
    if (provErr) {
      logger.error("Failed to upsert providers", {error: provErr.message});
      throw new Error("Seed failed at providers");
    }

    // ─── Patients ─────────────────────────────────────────────────────────────
    const patients = [
      {id: "PAT_001", name: "John Smith", plan_id: "PLAN_GOLD_001"},
      {id: "PAT_002", name: "Jane Doe", plan_id: "PLAN_GOLD_001"},
      {id: "PAT_003", name: "Bob Johnson", plan_id: "PLAN_BRONZE_001"},
    ];

    const {error: patErr} = await supabase
      .from("patients")
      .upsert(patients, {onConflict: "id"});
    if (patErr) {
      logger.error("Failed to upsert patients", {error: patErr.message});
      throw new Error("Seed failed at patients");
    }

    // ─── Historical claims — normal provider (25 claims over 60 days) ─────────
    const normalClaimsData = [
      {daysAgo: 60, patientId: "PAT_001", cptCodes: ["99213"], billedAmount: 145},
      {daysAgo: 58, patientId: "PAT_002", cptCodes: ["99214"], billedAmount: 240},
      {daysAgo: 55, patientId: "PAT_001", cptCodes: ["99213"], billedAmount: 150},
      {daysAgo: 53, patientId: "PAT_003", cptCodes: ["99213"], billedAmount: 155},
      {daysAgo: 51, patientId: "PAT_002", cptCodes: ["90837"], billedAmount: 195},
      {daysAgo: 48, patientId: "PAT_001", cptCodes: ["99214"], billedAmount: 245},
      {daysAgo: 46, patientId: "PAT_003", cptCodes: ["99213"], billedAmount: 150},
      {daysAgo: 44, patientId: "PAT_002", cptCodes: ["90837"], billedAmount: 200},
      {daysAgo: 41, patientId: "PAT_001", cptCodes: ["99213"], billedAmount: 148},
      {daysAgo: 39, patientId: "PAT_003", cptCodes: ["99214"], billedAmount: 255},
      {daysAgo: 36, patientId: "PAT_002", cptCodes: ["99213"], billedAmount: 150},
      {daysAgo: 34, patientId: "PAT_001", cptCodes: ["90837"], billedAmount: 200},
      {daysAgo: 32, patientId: "PAT_003", cptCodes: ["99213"], billedAmount: 145},
      {daysAgo: 29, patientId: "PAT_002", cptCodes: ["99214"], billedAmount: 250},
      {daysAgo: 27, patientId: "PAT_001", cptCodes: ["73721"], billedAmount: 1180},
      {daysAgo: 24, patientId: "PAT_003", cptCodes: ["99213"], billedAmount: 152},
      {daysAgo: 22, patientId: "PAT_002", cptCodes: ["90837"], billedAmount: 198},
      {daysAgo: 20, patientId: "PAT_001", cptCodes: ["29881"], billedAmount: 4400},
      {daysAgo: 18, patientId: "PAT_003", cptCodes: ["99214"], billedAmount: 248},
      {daysAgo: 15, patientId: "PAT_002", cptCodes: ["99213"], billedAmount: 150},
      {daysAgo: 6, patientId: "PAT_001", cptCodes: ["99213"], billedAmount: 150},
      {daysAgo: 5, patientId: "PAT_003", cptCodes: ["99214"], billedAmount: 245},
      {daysAgo: 4, patientId: "PAT_002", cptCodes: ["90837"], billedAmount: 200},
      {daysAgo: 3, patientId: "PAT_001", cptCodes: ["99213"], billedAmount: 150},
      {daysAgo: 2, patientId: "PAT_003", cptCodes: ["99213"], billedAmount: 148},
    ];

    const normalClaims = normalClaimsData.map((c) => {
      const ts = daysAgo(c.daysAgo);
      return {
        provider_id: "PROV_NORMAL_001",
        patient_id: c.patientId,
        cpt_codes: c.cptCodes,
        billed_amount: c.billedAmount,
        status: "PATIENT_BILLED",
        submitted_at: ts,
        validated_at: ts,
        adjudicated_at: ts,
        patient_billed_at: ts,
        insurer_amount: c.billedAmount * 0.7,
        patient_responsibility: c.billedAmount * 0.3,
        deductible_applied: 0,
        copay_applied: 30,
        coinsurance_applied: c.billedAmount * 0.2,
        amount_paid: 0,
        risk_score: 5,
        correlation_id: `seed-normal-${Math.random().toString(36).slice(2)}`,
      };
    });

    const {error: normalClaimsErr} = await supabase.from("claims").insert(normalClaims);
    if (normalClaimsErr) {
      logger.error("Failed to insert normal claims", {error: normalClaimsErr.message});
      throw new Error("Seed failed at normal claims");
    }

    // ─── Historical claims — anomalous provider ────────────────────────────────
    const anomalousClaims: Array<{
      submitted_at: string;
      patient_id: string;
      cpt_codes: string[];
      billed_amount: number;
    }> = [];

    // Baseline: 2 claims/day for days 8–40
    for (let d = 40; d >= 8; d--) {
      anomalousClaims.push({submitted_at: daysAgo(d), patient_id: "PAT_001", cpt_codes: ["99213"], billed_amount: 150});
      anomalousClaims.push({submitted_at: daysAgo(d), patient_id: "PAT_002", cpt_codes: ["99214"], billed_amount: 250});
    }

    // Last 7 days: spike to 15 claims/day + anomalies
    for (let d = 6; d >= 0; d--) {
      for (let i = 0; i < 8; i++) {
        anomalousClaims.push({submitted_at: daysAgo(d), patient_id: i % 2 === 0 ? "PAT_001" : "PAT_002", cpt_codes: ["99213"], billed_amount: 150});
      }
      anomalousClaims.push({submitted_at: daysAgo(d), patient_id: "PAT_003", cpt_codes: ["99213"], billed_amount: 900});
      anomalousClaims.push({submitted_at: daysAgo(d), patient_id: "PAT_001", cpt_codes: ["73721", "29881"], billed_amount: 5000});
      anomalousClaims.push({submitted_at: hoursAgo(d * 24 + 1), patient_id: "PAT_002", cpt_codes: ["99213"], billed_amount: 150});
      anomalousClaims.push({submitted_at: hoursAgo(d * 24 + 1), patient_id: "PAT_003", cpt_codes: ["99213"], billed_amount: 150});
      anomalousClaims.push({submitted_at: hoursAgo(d * 24 + 1), patient_id: "PAT_001", cpt_codes: ["99214"], billed_amount: 250});
    }

    const anomalousClaimDocs = anomalousClaims.map((c) => ({
      provider_id: "PROV_ANOMALOUS_001",
      patient_id: c.patient_id,
      cpt_codes: c.cpt_codes,
      billed_amount: c.billed_amount,
      status: "PATIENT_BILLED",
      submitted_at: c.submitted_at,
      validated_at: c.submitted_at,
      adjudicated_at: c.submitted_at,
      patient_billed_at: c.submitted_at,
      insurer_amount: c.billed_amount * 0.7,
      patient_responsibility: c.billed_amount * 0.3,
      deductible_applied: 0,
      copay_applied: 30,
      coinsurance_applied: c.billed_amount * 0.2,
      amount_paid: 0,
      risk_score: 0,
      correlation_id: `seed-anomalous-${Math.random().toString(36).slice(2)}`,
    }));

    // Insert in chunks of 400
    const CHUNK = 400;
    for (let i = 0; i < anomalousClaimDocs.length; i += CHUNK) {
      const chunk = anomalousClaimDocs.slice(i, i + CHUNK);
      const {error: chunkErr} = await supabase.from("claims").insert(chunk);
      if (chunkErr) {
        logger.error("Failed to insert anomalous claims chunk", {error: chunkErr.message, offset: i});
        throw new Error("Seed failed at anomalous claims");
      }
    }

    res.status(201).json({
      message: "Seed data created successfully",
      created: {
        cptCodes: cptCodes.length,
        insurancePlans: 2,
        providers: 3,
        patients: 3,
        normalClaims: normalClaimsData.length,
        anomalousClaims: anomalousClaims.length,
      },
      testScenarios: {
        normalProvider: "PROV_NORMAL_001 — low risk score expected (~5–15)",
        anomalousProvider: "PROV_ANOMALOUS_001 — high risk score expected (>70), try POST /api/providers/PROV_ANOMALOUS_001/risk-score",
        expiredProvider: "PROV_EXPIRED_001 — claims rejected with INVALID_PROVIDER",
      },
    });
  }),
);

export default router;
export {router as seedRouter};
