import {Router} from "express";
import type {Request, Response, NextFunction} from "express";
import * as logger from "firebase-functions/logger";
import {supabase} from "../db.js";
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

    const {data: row, error} = await supabase
      .from("insurance_plans")
      .insert({
        name,
        annual_deductible: annualDeductible,
        deductible_met: deductibleMet,
        copay,
        coinsurance_rate: coinsuranceRate,
        out_of_pocket_max: outOfPocketMax,
        covered_cpt_codes: coveredCptCodes,
      })
      .select()
      .single();

    if (error || !row) {
      logger.error("Failed to create insurance plan", {error: error?.message});
      throw new AppError(500, "PLAN_CREATE_FAILED", "Failed to create insurance plan");
    }

    res.status(201).json(mapPlan(row));
  }),
);

// ─── GET /api/insurance-plans ─────────────────────────────────────────────────

router.get(
  "/",
  asyncHandler(async (_req: Request, res: Response): Promise<void> => {
    const {data: rows, error} = await supabase.from("insurance_plans").select("*");
    if (error) {
      logger.error("Failed to list insurance plans", {error: error.message});
      throw new AppError(500, "PLANS_FETCH_FAILED", "Failed to fetch insurance plans");
    }
    const plans = (rows ?? []).map(mapPlan);
    res.json({plans, total: plans.length});
  }),
);

// ─── GET /api/insurance-plans/:id ────────────────────────────────────────────

router.get(
  "/:id",
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const planId = String(req.params["id"]);
    const {data: row, error} = await supabase
      .from("insurance_plans")
      .select("*")
      .eq("id", planId)
      .single();

    if (error || !row) {
      throw new AppError(404, "PLAN_NOT_FOUND", `Insurance plan ${planId} not found`);
    }

    res.json(mapPlan(row));
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

    const {data: existing, error: fetchError} = await supabase
      .from("insurance_plans")
      .select("id")
      .eq("id", planId)
      .single();

    if (fetchError || !existing) {
      throw new AppError(404, "PLAN_NOT_FOUND", `Insurance plan ${planId} not found`);
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

    const updates: Record<string, unknown> = {};
    if (name !== undefined) updates["name"] = name;
    if (annualDeductible !== undefined) updates["annual_deductible"] = annualDeductible;
    if (deductibleMet !== undefined) updates["deductible_met"] = deductibleMet;
    if (copay !== undefined) updates["copay"] = copay;
    if (coinsuranceRate !== undefined) updates["coinsurance_rate"] = coinsuranceRate;
    if (outOfPocketMax !== undefined) updates["out_of_pocket_max"] = outOfPocketMax;
    if (coveredCptCodes !== undefined) updates["covered_cpt_codes"] = coveredCptCodes;

    if (Object.keys(updates).length === 0) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "No updatable fields provided. Accepted: name, annualDeductible, deductibleMet, copay, coinsuranceRate, outOfPocketMax, coveredCptCodes",
      );
    }

    const {data: row, error} = await supabase
      .from("insurance_plans")
      .update(updates)
      .eq("id", planId)
      .select()
      .single();

    if (error || !row) {
      logger.error("Failed to update insurance plan", {error: error?.message});
      throw new AppError(500, "PLAN_UPDATE_FAILED", "Failed to update insurance plan");
    }

    res.json(mapPlan(row));
  }),
);

// ─── DELETE /api/insurance-plans/:id ─────────────────────────────────────────

router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const planId = String(req.params["id"]);

    const {data: existing, error: fetchError} = await supabase
      .from("insurance_plans")
      .select("id")
      .eq("id", planId)
      .single();

    if (fetchError || !existing) {
      throw new AppError(404, "PLAN_NOT_FOUND", `Insurance plan ${planId} not found`);
    }

    const {error} = await supabase.from("insurance_plans").delete().eq("id", planId);
    if (error) {
      logger.error("Failed to delete insurance plan", {error: error.message});
      throw new AppError(500, "PLAN_DELETE_FAILED", "Failed to delete insurance plan");
    }

    res.status(204).send();
  }),
);

export default router;
export {router as insurancePlansRouter};
