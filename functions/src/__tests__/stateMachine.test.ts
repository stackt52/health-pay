import {
  canTransition,
  assertTransition,
  getValidTransitions,
} from "../engines/stateMachine";
import { AppError } from "../types";
import type { ClaimStatus } from "../types";

// ─── canTransition ─────────────────────────────────────────────────────────────

describe("canTransition — valid paths", () => {
  const validPaths: Array<[ClaimStatus, ClaimStatus]> = [
    ["SUBMITTED", "VALIDATED"],
    ["SUBMITTED", "DENIED"],
    ["SUBMITTED", "FLAGGED"],
    ["VALIDATED", "ADJUDICATED"],
    ["VALIDATED", "DENIED"],
    ["VALIDATED", "FLAGGED"],
    ["ADJUDICATED", "PATIENT_BILLED"],
    ["ADJUDICATED", "DENIED"],
    ["PATIENT_BILLED", "PAID"],
    ["PATIENT_BILLED", "DENIED"],
    ["FLAGGED", "VALIDATED"],
    ["FLAGGED", "DENIED"],
  ];

  test.each(validPaths)(
    "%s → %s should be allowed",
    (from, to) => {
      expect(canTransition(from, to)).toBe(true);
    },
  );
});

describe("canTransition — invalid paths", () => {
  const invalidPaths: Array<[ClaimStatus, ClaimStatus]> = [
    ["PAID", "SUBMITTED"],       // Terminal state cannot restart
    ["PAID", "DENIED"],          // Terminal state has no outbound transitions
    ["DENIED", "SUBMITTED"],     // Terminal state
    ["DENIED", "VALIDATED"],     // Terminal state
    ["SUBMITTED", "PAID"],       // Must follow the full lifecycle
    ["SUBMITTED", "PATIENT_BILLED"], // Skips intermediate steps
    ["PATIENT_BILLED", "SUBMITTED"], // Cannot go backwards
    ["ADJUDICATED", "SUBMITTED"], // Cannot go backwards
  ];

  test.each(invalidPaths)(
    "%s → %s should be rejected",
    (from, to) => {
      expect(canTransition(from, to)).toBe(false);
    },
  );
});

// ─── assertTransition ─────────────────────────────────────────────────────────

describe("assertTransition", () => {
  it("does not throw for valid transitions", () => {
    expect(() => assertTransition("SUBMITTED", "VALIDATED")).not.toThrow();
    expect(() => assertTransition("VALIDATED", "ADJUDICATED")).not.toThrow();
    expect(() => assertTransition("PATIENT_BILLED", "PAID")).not.toThrow();
  });

  it("throws AppError with INVALID_STATE_TRANSITION for illegal transitions", () => {
    expect(() => assertTransition("PAID", "SUBMITTED")).toThrow(AppError);
  });

  it("thrown error has the correct code and HTTP status 409", () => {
    try {
      assertTransition("PAID", "VALIDATED");
      fail("Expected assertTransition to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const appErr = err as AppError;
      expect(appErr.code).toBe("INVALID_STATE_TRANSITION");
      expect(appErr.statusCode).toBe(409);
    }
  });

  it("error message includes both states", () => {
    try {
      assertTransition("PATIENT_BILLED", "SUBMITTED");
    } catch (err) {
      expect((err as Error).message).toContain("PATIENT_BILLED");
      expect((err as Error).message).toContain("SUBMITTED");
    }
  });
});

// ─── getValidTransitions ───────────────────────────────────────────────────────

describe("getValidTransitions", () => {
  it("returns empty array for terminal state PAID", () => {
    expect(getValidTransitions("PAID")).toHaveLength(0);
  });

  it("returns empty array for terminal state DENIED", () => {
    expect(getValidTransitions("DENIED")).toHaveLength(0);
  });

  it("returns correct next states for SUBMITTED", () => {
    const transitions = getValidTransitions("SUBMITTED");
    expect(transitions).toContain("VALIDATED");
    expect(transitions).toContain("DENIED");
  });

  it("returns correct next states for PATIENT_BILLED", () => {
    const transitions = getValidTransitions("PATIENT_BILLED");
    expect(transitions).toContain("PAID");
    expect(transitions).toContain("DENIED");
    expect(transitions).not.toContain("SUBMITTED");
  });

  it("FLAGGED can be cleared back to VALIDATED or hard-denied", () => {
    const transitions = getValidTransitions("FLAGGED");
    expect(transitions).toContain("VALIDATED");
    expect(transitions).toContain("DENIED");
  });
});

// ─── Full lifecycle ────────────────────────────────────────────────────────────

describe("Full claim lifecycle", () => {
  it("follows the happy path: SUBMITTED → VALIDATED → ADJUDICATED → PATIENT_BILLED → PAID", () => {
    const path: ClaimStatus[] = [
      "SUBMITTED",
      "VALIDATED",
      "ADJUDICATED",
      "PATIENT_BILLED",
      "PAID",
    ];

    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i], path[i + 1])).toBe(true);
    }
  });

  it("follows the denial path from any non-terminal state", () => {
    const deniableStates: ClaimStatus[] = [
      "SUBMITTED",
      "VALIDATED",
      "ADJUDICATED",
      "PATIENT_BILLED",
      "FLAGGED",
    ];

    for (const state of deniableStates) {
      expect(canTransition(state, "DENIED")).toBe(true);
    }
  });
});
