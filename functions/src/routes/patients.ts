import {Router} from "express";
import type {Request, Response, NextFunction} from "express";
import {Timestamp} from "firebase-admin/firestore";
import {db} from "../db.js";
import {AppError, type Patient} from "../types.js";

const router = Router();

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

// ─── POST /api/patients ───────────────────────────────────────────────────────

router.post(
  "/",
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const {name, planId} = req.body as { name?: string; planId?: string };

    if (!name || !planId) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "Missing required fields: name, planId",
      );
    }

    const planSnap =
      await db.collection("insurance_plans").doc(planId).get();
    if (!planSnap.exists) {
      throw new AppError(
        404,
        "PLAN_NOT_FOUND",
        `Insurance plan ${planId} not found`,
      );
    }

    const now = Timestamp.now();
    const patientRef = db.collection("patients").doc();
    const patient: Patient = {
      id: patientRef.id,
      name,
      planId,
      createdAt: now,
    };

    await patientRef.set(patient);
    res.status(201).json(patient);
  }),
);

// ─── GET /api/patients ────────────────────────────────────────────────────────

router.get(
  "/",
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const {planId} = req.query as { planId?: string };

    let query: FirebaseFirestore.Query = db.collection("patients");
    if (planId) {
      query = query.where("planId", "==", planId);
    }

    const snap = await query.get();
    const patients = snap.docs.map((d) => ({id: d.id, ...d.data()}));
    res.json({patients, total: patients.length});
  }),
);

// ─── GET /api/patients/:id ────────────────────────────────────────────────────

router.get(
  "/:id",
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const patientId = String(req.params["id"]);
    const snap = await db.collection("patients").doc(patientId).get();
    if (!snap.exists) {
      throw new AppError(
        404,
        "PATIENT_NOT_FOUND",
        `Patient ${patientId} not found`,
      );
    }
    res.json({id: snap.id, ...snap.data()});
  }),
);

// ─── PUT /api/patients/:id ────────────────────────────────────────────────────

router.put(
  "/:id",
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const patientId = String(req.params["id"]);
    const {name, planId} = req.body as { name?: string; planId?: string };

    const snap = await db.collection("patients").doc(patientId).get();
    if (!snap.exists) {
      throw new AppError(
        404,
        "PATIENT_NOT_FOUND",
        `Patient ${patientId} not found`,
      );
    }

    if (planId) {
      const planSnap = await db.collection("insurance_plans").doc(planId).get();
      if (!planSnap.exists) {
        throw new AppError(
          404,
          "PLAN_NOT_FOUND",
          `Insurance plan ${planId} not found`,
        );
      }
    }

    const updates: Partial<Pick<Patient, "name" | "planId">> = {};
    if (name !== undefined) updates.name = name;
    if (planId !== undefined) updates.planId = planId;

    if (Object.keys(updates).length === 0) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "No updatable fields provided. Accepted: name, planId",
      );
    }

    await db.collection("patients").doc(patientId).update(updates);
    const updated = await db.collection("patients").doc(patientId).get();
    res.json({id: updated.id, ...updated.data()});
  }),
);

// ─── DELETE /api/patients/:id ─────────────────────────────────────────────────

router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const patientId = String(req.params["id"]);
    const snap = await db.collection("patients").doc(patientId).get();
    if (!snap.exists) {
      throw new AppError(
        404,
        "PATIENT_NOT_FOUND",
        `Patient ${patientId} not found`,
      );
    }
    await db.collection("patients").doc(patientId).delete();
    res.status(204).send();
  }),
);

export default router;
export {router as patientsRouter};
