import type { ClaimStatus } from "../types.js";
import { AppError } from "../types.js";

/**
 * Explicit state transition table for the claims lifecycle.
 *
 * Valid paths:
 *   SUBMITTED → VALIDATED → ADJUDICATED → PATIENT_BILLED → PAID
 *   Any state → DENIED (hard rejection)
 *   VALIDATED → FLAGGED (manual review required)
 *   FLAGGED → VALIDATED (cleared by reviewer)
 *
 * Terminal states: PAID, DENIED
 */
const VALID_TRANSITIONS = new Map<ClaimStatus, ReadonlySet<ClaimStatus>>([
  ["SUBMITTED", new Set<ClaimStatus>(["VALIDATED", "DENIED", "FLAGGED"])],
  ["VALIDATED", new Set<ClaimStatus>(["ADJUDICATED", "DENIED", "FLAGGED"])],
  ["ADJUDICATED", new Set<ClaimStatus>(["PATIENT_BILLED", "DENIED"])],
  ["PATIENT_BILLED", new Set<ClaimStatus>(["PAID", "DENIED"])],
  ["PAID", new Set<ClaimStatus>()],
  ["DENIED", new Set<ClaimStatus>()],
  ["FLAGGED", new Set<ClaimStatus>(["VALIDATED", "DENIED"])],
]);

export function canTransition(from: ClaimStatus, to: ClaimStatus): boolean {
  return VALID_TRANSITIONS.get(from)?.has(to) ?? false;
}

export function assertTransition(from: ClaimStatus, to: ClaimStatus): void {
  if (!canTransition(from, to)) {
    throw new AppError(
      409,
      "INVALID_STATE_TRANSITION",
      `Cannot transition claim from ${from} to ${to}`,
      { from, to, validTransitions: getValidTransitions(from) },
    );
  }
}

export function getValidTransitions(from: ClaimStatus): ClaimStatus[] {
  return Array.from(VALID_TRANSITIONS.get(from) ?? []);
}
