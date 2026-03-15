import type {InsurancePlan, AdjudicationResult, CptCode} from "../types.js";

/**
 * Determines the copay amount based on the primary CPT code category.
 * Iterates codes in order and returns the copay for the first recognised category.
 */
function resolveCopay(
  cptCodes: string[],
  plan: InsurancePlan,
  cptCodeData: Record<string, CptCode>,
): number {
  for (const code of cptCodes) {
    const cpt = cptCodeData[code];
    if (!cpt) continue;
    switch (cpt.category) {
    case "emergency":
      return plan.copay.emergency;
    case "office_visit":
      return plan.copay.officeVisit;
    case "specialist":
    case "procedure":
    case "imaging":
    case "therapy":
      return plan.copay.specialist;
    }
  }
  return plan.copay.officeVisit;
}

/**
 * Calculates the insurer vs patient responsibility split for a given claim.
 *
 * Payment waterfall:
 *   1. Patient pays the copay for the visit type
 *   2. Remaining balance applies toward any unmet annual deductible
 *   3. After deductible, coinsurance splits the remainder (patient pays coinsuranceRate %)
 *   4. Total patient responsibility is capped at out-of-pocket maximum
 *
 * All returned amounts are rounded to cents (2 decimal places).
 */
export function calculateAdjudication(
  billedAmount: number,
  cptCodes: string[],
  plan: InsurancePlan,
  cptCodeData: Record<string, CptCode>,
): AdjudicationResult {
  const copay = resolveCopay(cptCodes, plan, cptCodeData);
  const remainingDeductible = Math.max(
    0,
    plan.annualDeductible - plan.deductibleMet,
  );

  // Step 1: Patient pays copay
  const copayApplied = Math.min(copay, billedAmount);
  let patientOwes = copayApplied;
  let insurerOwes = billedAmount - copayApplied;

  // Step 2: Unmet deductible comes off the insurer portion
  const deductibleApplied = Math.min(remainingDeductible, insurerOwes);
  patientOwes += deductibleApplied;
  insurerOwes -= deductibleApplied;

  // Step 3: Coinsurance on the remainder
  const coinsuranceApplied = insurerOwes * plan.coinsuranceRate;
  patientOwes += coinsuranceApplied;
  insurerOwes -= coinsuranceApplied;

  // Step 4: Cap patient at out-of-pocket max (based on how much they've already spent)
  const alreadySpent = plan.deductibleMet;
  const remainingOopCapacity = Math.max(0, plan.outOfPocketMax - alreadySpent);
  if (patientOwes > remainingOopCapacity) {
    const excessToInsurer = patientOwes - remainingOopCapacity;
    patientOwes = remainingOopCapacity;
    insurerOwes += excessToInsurer;
  }

  const round = (n: number) => Math.round(n * 100) / 100;

  return {
    insurerAmount: round(insurerOwes),
    patientResponsibility: round(patientOwes),
    deductibleApplied: round(deductibleApplied),
    copayApplied: round(copayApplied),
    coinsuranceApplied: round(coinsuranceApplied),
  };
}
