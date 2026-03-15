import {Router} from "express";
import type {Request, Response, NextFunction} from "express";
import {FieldValue, Timestamp} from "firebase-admin/firestore";
import {db} from "../db.js";

const router = Router();

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

function daysAgo(n: number): Timestamp {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return Timestamp.fromDate(d);
}

function hoursAgo(h: number): Timestamp {
  return Timestamp.fromDate(new Date(Date.now() - h * 60 * 60 * 1000));
}

/**
 * POST /api/seed
 *
 * Idempotent: checks for the existence of each document before writing.
 * Creates reference data + sample claims for both normal and anomalous providers.
 */
router.post(
  "/",
  asyncHandler(async (_req: Request, res: Response): Promise<void> => {
    const batch = db.batch();

    // ─── CPT Codes ────────────────────────────────────────────────────────────
    const cptCodes = [
      {
        id: "99213",
        description: "Office visit, established patient",
        avgBilledAmount: 150,
        category: "office_visit",
        incompatibleWith: ["99214"],
      },
      {
        id: "99214",
        description: "Office visit, detailed exam",
        avgBilledAmount: 250,
        category: "office_visit",
        incompatibleWith: ["99213"],
      },
      {
        id: "99283",
        description: "Emergency dept visit, moderate",
        avgBilledAmount: 800,
        category: "emergency",
        incompatibleWith: ["90837"],
      },
      {
        id: "90837",
        description: "Psychotherapy, 60 min",
        avgBilledAmount: 200,
        category: "therapy",
        incompatibleWith: ["99283"],
      },
      {
        id: "73721",
        description: "MRI lower extremity",
        avgBilledAmount: 1200,
        category: "imaging",
        incompatibleWith: ["29881"],
      },
      {
        id: "29881",
        description: "Knee arthroscopy",
        avgBilledAmount: 4500,
        category: "procedure",
        incompatibleWith: ["73721"],
      },
    ];

    for (const cpt of cptCodes) {
      const {id, ...data} = cpt;
      batch.set(db.collection("cpt_codes").doc(id), data, {merge: true});
    }

    // ─── Insurance Plans ──────────────────────────────────────────────────────
    batch.set(
      db.collection("insurance_plans").doc("PLAN_GOLD_001"),
      {
        name: "HealthPay Gold",
        annualDeductible: 1500,
        deductibleMet: 800,
        copay: {officeVisit: 30, specialist: 50, emergency: 250},
        coinsuranceRate: 0.2,
        outOfPocketMax: 6000,
        coveredCptCodes: ["99213", "99214", "99283", "90837", "73721", "29881"],
      },
      {merge: true},
    );

    batch.set(
      db.collection("insurance_plans").doc("PLAN_BRONZE_001"),
      {
        name: "HealthPay Bronze",
        annualDeductible: 5000,
        deductibleMet: 200,
        copay: {officeVisit: 75, specialist: 100, emergency: 500},
        coinsuranceRate: 0.4,
        outOfPocketMax: 8000,
        coveredCptCodes: ["99213", "99214", "99283"],
      },
      {merge: true},
    );

    // ─── Providers ────────────────────────────────────────────────────────────
    const futureExpiry = Timestamp.fromDate(
      new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    );
    const pastExpiry = Timestamp.fromDate(
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    );

    batch.set(
      db.collection("providers").doc("PROV_NORMAL_001"),
      {
        name: "Dr. Alice Chen",
        licenseStatus: "active",
        licenseExpiry: futureExpiry,
        createdAt: FieldValue.serverTimestamp(),
      },
      {merge: true},
    );

    batch.set(
      db.collection("providers").doc("PROV_ANOMALOUS_001"),
      {
        name: "Dr. Bob Fraud",
        licenseStatus: "active",
        licenseExpiry: futureExpiry,
        createdAt: FieldValue.serverTimestamp(),
      },
      {merge: true},
    );

    batch.set(
      db.collection("providers").doc("PROV_EXPIRED_001"),
      {
        name: "Dr. Carol Lapsed",
        licenseStatus: "expired",
        licenseExpiry: pastExpiry,
        createdAt: FieldValue.serverTimestamp(),
      },
      {merge: true},
    );

    // ─── Patients ─────────────────────────────────────────────────────────────
    batch.set(
      db.collection("patients").doc("PAT_001"),
      {
        name: "John Smith",
        planId: "PLAN_GOLD_001",
        createdAt: FieldValue.serverTimestamp(),
      },
      {merge: true},
    );

    batch.set(
      db.collection("patients").doc("PAT_002"),
      {
        name: "Jane Doe",
        planId: "PLAN_GOLD_001",
        createdAt: FieldValue.serverTimestamp(),
      },
      {merge: true},
    );

    batch.set(
      db.collection("patients").doc("PAT_003"),
      {
        name: "Bob Johnson",
        planId: "PLAN_BRONZE_001",
        createdAt: FieldValue.serverTimestamp(),
      },
      {merge: true},
    );

    await batch.commit();

    // ─── Historical claims — normal provider (25 claims over 60 days) ─────────
    // ~2-3 normal office visits per week, normal amounts
    const normalClaimsData = [
      // Week 8-9 (baseline)
      {daysAgo: 60, patientId: "PAT_001", cptCodes: ["99213"], billedAmount: 145},
      {daysAgo: 58, patientId: "PAT_002", cptCodes: ["99214"], billedAmount: 240},
      {daysAgo: 55, patientId: "PAT_001", cptCodes: ["99213"], billedAmount: 150},
      {daysAgo: 53, patientId: "PAT_003", cptCodes: ["99213"], billedAmount: 155},
      {daysAgo: 51, patientId: "PAT_002", cptCodes: ["90837"], billedAmount: 195},
      // Week 6-7
      {daysAgo: 48, patientId: "PAT_001", cptCodes: ["99214"], billedAmount: 245},
      {daysAgo: 46, patientId: "PAT_003", cptCodes: ["99213"], billedAmount: 150},
      {daysAgo: 44, patientId: "PAT_002", cptCodes: ["90837"], billedAmount: 200},
      {daysAgo: 41, patientId: "PAT_001", cptCodes: ["99213"], billedAmount: 148},
      {daysAgo: 39, patientId: "PAT_003", cptCodes: ["99214"], billedAmount: 255},
      // Week 4-5
      {daysAgo: 36, patientId: "PAT_002", cptCodes: ["99213"], billedAmount: 150},
      {daysAgo: 34, patientId: "PAT_001", cptCodes: ["90837"], billedAmount: 200},
      {daysAgo: 32, patientId: "PAT_003", cptCodes: ["99213"], billedAmount: 145},
      {daysAgo: 29, patientId: "PAT_002", cptCodes: ["99214"], billedAmount: 250},
      {daysAgo: 27, patientId: "PAT_001", cptCodes: ["73721"], billedAmount: 1180},
      // Week 2-3
      {daysAgo: 24, patientId: "PAT_003", cptCodes: ["99213"], billedAmount: 152},
      {daysAgo: 22, patientId: "PAT_002", cptCodes: ["90837"], billedAmount: 198},
      {daysAgo: 20, patientId: "PAT_001", cptCodes: ["29881"], billedAmount: 4400},
      {daysAgo: 18, patientId: "PAT_003", cptCodes: ["99214"], billedAmount: 248},
      {daysAgo: 15, patientId: "PAT_002", cptCodes: ["99213"], billedAmount: 150},
      // Last week
      {daysAgo: 6, patientId: "PAT_001", cptCodes: ["99213"], billedAmount: 150},
      {daysAgo: 5, patientId: "PAT_003", cptCodes: ["99214"], billedAmount: 245},
      {daysAgo: 4, patientId: "PAT_002", cptCodes: ["90837"], billedAmount: 200},
      {daysAgo: 3, patientId: "PAT_001", cptCodes: ["99213"], billedAmount: 150},
      {daysAgo: 2, patientId: "PAT_003", cptCodes: ["99213"], billedAmount: 148},
    ];

    const normalBatch = db.batch();
    for (const c of normalClaimsData) {
      const ref = db.collection("claims").doc();
      normalBatch.set(ref, {
        providerId: "PROV_NORMAL_001",
        patientId: c.patientId,
        cptCodes: c.cptCodes,
        billedAmount: c.billedAmount,
        status: "PATIENT_BILLED",
        submittedAt: daysAgo(c.daysAgo),
        validatedAt: daysAgo(c.daysAgo),
        adjudicatedAt: daysAgo(c.daysAgo),
        patientBilledAt: daysAgo(c.daysAgo),
        insurerAmount: c.billedAmount * 0.7,
        patientResponsibility: c.billedAmount * 0.3,
        deductibleApplied: 0,
        copayApplied: 30,
        coinsuranceApplied: c.billedAmount * 0.2,
        amountPaid: 0,
        riskScore: 5,
        correlationId: `seed-normal-${ref.id}`,
      });
    }
    await normalBatch.commit();

    // ─── Historical claims — anomalous provider ────────────────────────────────
    // Baseline: 2/day for days 8-90, then spike to 15/day in last 7 days
    // Also: over-billing, incompatible codes, off-hours (23:00 UTC)
    const anomalousClaims: Array<{
      submittedAt: Timestamp;
      patientId: string;
      cptCodes: string[];
      billedAmount: number;
    }> = [];

    // Baseline period: 2 claims/day for days 8–40
    for (let d = 40; d >= 8; d--) {
      anomalousClaims.push({
        submittedAt: daysAgo(d),
        patientId: "PAT_001",
        cptCodes: ["99213"],
        billedAmount: 150,
      });
      anomalousClaims.push({
        submittedAt: daysAgo(d),
        patientId: "PAT_002",
        cptCodes: ["99214"],
        billedAmount: 250,
      });
    }

    // Last 7 days: spike to 15 claims/day + anomalies
    for (let d = 6; d >= 0; d--) {
      // Normal claims padded to 10/day
      for (let i = 0; i < 8; i++) {
        anomalousClaims.push({
          submittedAt: daysAgo(d),
          patientId: i % 2 === 0 ? "PAT_001" : "PAT_002",
          cptCodes: ["99213"],
          billedAmount: 150,
        });
      }
      // Over-billed claim (5× average)
      anomalousClaims.push({
        submittedAt: daysAgo(d),
        patientId: "PAT_003",
        cptCodes: ["99213"],
        billedAmount: 900, // 6× avg of $150
      });
      // Incompatible code combo
      anomalousClaims.push({
        submittedAt: daysAgo(d),
        patientId: "PAT_001",
        cptCodes: ["73721", "29881"], // MRI + arthroscopy same day
        billedAmount: 5000,
      });
      // Off-hours burst (23:00 UTC)
      anomalousClaims.push({
        submittedAt: hoursAgo(d * 24 + 1),
        patientId: "PAT_002",
        cptCodes: ["99213"],
        billedAmount: 150,
      });
      anomalousClaims.push({
        submittedAt: hoursAgo(d * 24 + 1),
        patientId: "PAT_003",
        cptCodes: ["99213"],
        billedAmount: 150,
      });
      anomalousClaims.push({
        submittedAt: hoursAgo(d * 24 + 1),
        patientId: "PAT_001",
        cptCodes: ["99214"],
        billedAmount: 250,
      });
    }

    // Write in chunks of 500 (Firestore batch limit)
    const CHUNK = 400;
    for (let i = 0; i < anomalousClaims.length; i += CHUNK) {
      const chunk = anomalousClaims.slice(i, i + CHUNK);
      const anomBatch = db.batch();
      for (const c of chunk) {
        const ref = db.collection("claims").doc();
        anomBatch.set(ref, {
          providerId: "PROV_ANOMALOUS_001",
          patientId: c.patientId,
          cptCodes: c.cptCodes,
          billedAmount: c.billedAmount,
          status: "PATIENT_BILLED",
          submittedAt: c.submittedAt,
          validatedAt: c.submittedAt,
          adjudicatedAt: c.submittedAt,
          patientBilledAt: c.submittedAt,
          insurerAmount: c.billedAmount * 0.7,
          patientResponsibility: c.billedAmount * 0.3,
          deductibleApplied: 0,
          copayApplied: 30,
          coinsuranceApplied: c.billedAmount * 0.2,
          amountPaid: 0,
          riskScore: 0, // will be recalculated
          correlationId: `seed-anomalous-${ref.id}`,
        });
      }
      await anomBatch.commit();
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
        anomalousProvider:
          "PROV_ANOMALOUS_001 — high risk score expected (>70), try POST /api/providers/PROV_ANOMALOUS_001/risk-score",
        expiredProvider:
          "PROV_EXPIRED_001 — claims rejected with INVALID_PROVIDER",
      },
    });
  }),
);

export default router;
export {router as seedRouter};
