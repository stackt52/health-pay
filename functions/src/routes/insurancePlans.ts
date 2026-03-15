import {Router} from "express";
import type {Request, Response, NextFunction} from "express";
import {db} from "../db.js";
import {AppError, type Copay, type InsurancePlan} from "../types.js";

const router = Router();

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

interface PlanBody {
  name?: string;
  annualDeductible?: number;
  deductibleMet?: number;
  copay?: Copay;
  coinsuranceRate?: number;
  outOfPocketMax?: number;
  coveredCptCodes?: string[];
}

function validateCopay(copay: unknown): copay is Copay {
  if (typeof copay !== "object" || copay === null) return false;
  const c = copay as Record<string, unknown>;
  return (
    typeof c["officeVisit"] === "number" &&
    typeof c["specialist"] === "number" &&
    typeof c["emergency"] === "number"
  );
}

// ─── POST /api/insurance-plans ────────────────────────────────────────────────

router.post(
  "/",
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const {
      name,
      annualDeductible,
      deductibleMet,
      copay,
      coinsuranceRate,
      outOfPocketMax,
      coveredCptCodes,
    } = req.body as PlanBody;

    if (
      !name ||
      annualDeductible === undefined ||
      deductibleMet === undefined ||
      !copay ||
      coinsuranceRate === undefined ||
      outOfPocketMax === undefined ||
      !coveredCptCodes
    ) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "Missing required fields: name, annualDeductible, deductibleMet, copay, coinsuranceRate, outOfPocketMax, coveredCptCodes",
      );
    }

    if (!validateCopay(copay)) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "copay must include officeVisit, specialist, and emergency as numbers",
      );
    }

    if (!Array.isArray(coveredCptCodes) || coveredCptCodes.length === 0) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "coveredCptCodes must be a non-empty array of CPT code strings",
      );
    }

    const planRef = db.collection("insurance_plans").doc();
    const plan: InsurancePlan = {
      id: planRef.id,
      name,
      annualDeductible,
      deductibleMet,
      copay,
      coinsuranceRate,
      outOfPocketMax,
      coveredCptCodes,
    };

    await planRef.set(plan);
    res.status(201).json(plan);
  }),
);

// ─── GET /api/insurance-plans ─────────────────────────────────────────────────

router.get(
  "/",
  asyncHandler(async (_req: Request, res: Response): Promise<void> => {
    const snap = await db.collection("insurance_plans").get();
    const plans = snap.docs.map((d) => ({id: d.id, ...d.data()}));
    res.json({plans, total: plans.length});
  }),
);

// ─── GET /api/insurance-plans/:id ────────────────────────────────────────────

router.get(
  "/:id",
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const planId = String(req.params["id"]);
    const snap = await db.collection("insurance_plans").doc(planId).get();
    if (!snap.exists) {
      throw new AppError(
        404,
        "PLAN_NOT_FOUND",
        `Insurance plan ${planId} not found`,
      );
    }
    res.json({id: snap.id, ...snap.data()});
  }),
);

// ─── PUT /api/insurance-plans/:id ────────────────────────────────────────────

router.put(
  "/:id",
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const planId = String(req.params["id"]);
    const {
      name,
      annualDeductible,
      deductibleMet,
      copay,
      coinsuranceRate,
      outOfPocketMax,
      coveredCptCodes,
    } = req.body as PlanBody;

    const snap = await db.collection("insurance_plans").doc(planId).get();
    if (!snap.exists) {
      throw new AppError(
        404,
        "PLAN_NOT_FOUND",
        `Insurance plan ${planId} not found`,
      );
    }

    if (copay !== undefined && !validateCopay(copay)) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "copay must include officeVisit, specialist, and emergency as numbers",
      );
    }

    if (
      coveredCptCodes !== undefined &&
      (!Array.isArray(coveredCptCodes) || coveredCptCodes.length === 0)
    ) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "coveredCptCodes must be a non-empty array of CPT code strings",
      );
    }

    const updates: Partial<InsurancePlan> = {};
    if (name !== undefined) updates.name = name;
    if (annualDeductible !== undefined) updates.annualDeductible = annualDeductible;
    if (deductibleMet !== undefined) updates.deductibleMet = deductibleMet;
    if (copay !== undefined) updates.copay = copay;
    if (coinsuranceRate !== undefined) updates.coinsuranceRate = coinsuranceRate;
    if (outOfPocketMax !== undefined) updates.outOfPocketMax = outOfPocketMax;
    if (coveredCptCodes !== undefined) updates.coveredCptCodes = coveredCptCodes;

    if (Object.keys(updates).length === 0) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "No updatable fields provided. Accepted: name, annualDeductible, deductibleMet, copay, coinsuranceRate, outOfPocketMax, coveredCptCodes",
      );
    }

    await db.collection("insurance_plans").doc(planId).update(updates);
    const updated = await db.collection("insurance_plans").doc(planId).get();
    res.json({id: updated.id, ...updated.data()});
  }),
);

// ─── DELETE /api/insurance-plans/:id ─────────────────────────────────────────

router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const planId = String(req.params["id"]);
    const snap = await db.collection("insurance_plans").doc(planId).get();
    if (!snap.exists) {
      throw new AppError(
        404,
        "PLAN_NOT_FOUND",
        `Insurance plan ${planId} not found`,
      );
    }
    await db.collection("insurance_plans").doc(planId).delete();
    res.status(204).send();
  }),
);

export default router;
export {router as insurancePlansRouter};
