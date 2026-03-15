import {Router} from "express";
import type {Request, Response, NextFunction} from "express";
import * as logger from "firebase-functions/logger";
import {supabase} from "../db.js";
import {AppError, type Patient} from "../types.js";

const router = Router();

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
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

// ─── POST /api/patients ───────────────────────────────────────────────────────

router.post(
  "/",
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const {name, planId} = req.body as {name?: string; planId?: string};

    if (!name || !planId) {
      throw new AppError(400, "VALIDATION_ERROR", "Missing required fields: name, planId");
    }

    const {data: plan, error: planErr} = await supabase
      .from("insurance_plans")
      .select("id")
      .eq("id", planId)
      .single();

    if (planErr || !plan) {
      throw new AppError(404, "PLAN_NOT_FOUND", `Insurance plan ${planId} not found`);
    }

    const {data: row, error} = await supabase
      .from("patients")
      .insert({name, plan_id: planId})
      .select()
      .single();

    if (error || !row) {
      logger.error("Failed to create patient", {error: error?.message});
      throw new AppError(500, "PATIENT_CREATE_FAILED", "Failed to create patient");
    }

    res.status(201).json(mapPatient(row));
  }),
);

// ─── GET /api/patients ────────────────────────────────────────────────────────

router.get(
  "/",
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const {planId} = req.query as {planId?: string};

    let query = supabase.from("patients").select("*");
    if (planId) {
      query = query.eq("plan_id", planId);
    }

    const {data: rows, error} = await query;
    if (error) {
      logger.error("Failed to list patients", {error: error.message});
      throw new AppError(500, "PATIENTS_FETCH_FAILED", "Failed to fetch patients");
    }

    const patients = (rows ?? []).map(mapPatient);
    res.json({patients, total: patients.length});
  }),
);

// ─── GET /api/patients/:id ────────────────────────────────────────────────────

router.get(
  "/:id",
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const patientId = String(req.params["id"]);
    const {data: row, error} = await supabase
      .from("patients")
      .select("*")
      .eq("id", patientId)
      .single();

    if (error || !row) {
      throw new AppError(404, "PATIENT_NOT_FOUND", `Patient ${patientId} not found`);
    }

    res.json(mapPatient(row));
  }),
);

// ─── PUT /api/patients/:id ────────────────────────────────────────────────────

router.put(
  "/:id",
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const patientId = String(req.params["id"]);
    const {name, planId} = req.body as {name?: string; planId?: string};

    const {data: existing, error: fetchError} = await supabase
      .from("patients")
      .select("id")
      .eq("id", patientId)
      .single();

    if (fetchError || !existing) {
      throw new AppError(404, "PATIENT_NOT_FOUND", `Patient ${patientId} not found`);
    }

    if (planId) {
      const {data: plan, error: planErr} = await supabase
        .from("insurance_plans")
        .select("id")
        .eq("id", planId)
        .single();

      if (planErr || !plan) {
        throw new AppError(404, "PLAN_NOT_FOUND", `Insurance plan ${planId} not found`);
      }
    }

    const updates: Record<string, unknown> = {};
    if (name !== undefined) updates["name"] = name;
    if (planId !== undefined) updates["plan_id"] = planId;

    if (Object.keys(updates).length === 0) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "No updatable fields provided. Accepted: name, planId",
      );
    }

    const {data: row, error} = await supabase
      .from("patients")
      .update(updates)
      .eq("id", patientId)
      .select()
      .single();

    if (error || !row) {
      logger.error("Failed to update patient", {error: error?.message});
      throw new AppError(500, "PATIENT_UPDATE_FAILED", "Failed to update patient");
    }

    res.json(mapPatient(row));
  }),
);

// ─── DELETE /api/patients/:id ─────────────────────────────────────────────────

router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const patientId = String(req.params["id"]);

    const {data: existing, error: fetchError} = await supabase
      .from("patients")
      .select("id")
      .eq("id", patientId)
      .single();

    if (fetchError || !existing) {
      throw new AppError(404, "PATIENT_NOT_FOUND", `Patient ${patientId} not found`);
    }

    const {error} = await supabase.from("patients").delete().eq("id", patientId);
    if (error) {
      logger.error("Failed to delete patient", {error: error.message});
      throw new AppError(500, "PATIENT_DELETE_FAILED", "Failed to delete patient");
    }

    res.status(204).send();
  }),
);

export default router;
export {router as patientsRouter};
