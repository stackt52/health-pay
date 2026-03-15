import { computeRiskScore } from "../engines/anomaly";
import type { ClaimForAnalysis, CptStats } from "../types";

// ─── Helpers ───────────────────────────────────────────────────────────────────

const PROVIDER_ID = "PROV_TEST";

function makeClaim(
  overrides: Partial<ClaimForAnalysis> & { submittedAt: Date },
): ClaimForAnalysis {
  return {
    id: Math.random().toString(36).slice(2),
    providerId: PROVIDER_ID,
    patientId: "PAT_001",
    cptCodes: ["99213"],
    billedAmount: 150,
    ...overrides,
  };
}

function daysAgo(n: number, hour = 10): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setUTCHours(hour, 0, 0, 0);
  return d;
}

const DEFAULT_CPT_STATS: Map<string, CptStats> = new Map([
  ["99213", { code: "99213", avgBilledAmount: 150 }],
  ["99214", { code: "99214", avgBilledAmount: 250 }],
  ["99283", { code: "99283", avgBilledAmount: 800 }],
  ["90837", { code: "90837", avgBilledAmount: 200 }],
  ["73721", { code: "73721", avgBilledAmount: 1200 }],
  ["29881", { code: "29881", avgBilledAmount: 4500 }],
]);

// ─── Velocity signal ───────────────────────────────────────────────────────────

describe("Anomaly Detection — Billing Velocity", () => {
  it("assigns a low velocity score when claim volume is consistent with baseline", () => {
    // Baseline: 2 claims/day for days 8–60
    const normalClaims: ClaimForAnalysis[] = [];
    for (let d = 60; d >= 8; d--) {
      normalClaims.push(makeClaim({ submittedAt: daysAgo(d) }));
      normalClaims.push(makeClaim({ submittedAt: daysAgo(d) }));
    }
    // Recent (last 7 days): still 2/day — matches baseline
    for (let d = 6; d >= 0; d--) {
      normalClaims.push(makeClaim({ submittedAt: daysAgo(d) }));
      normalClaims.push(makeClaim({ submittedAt: daysAgo(d) }));
    }

    const result = computeRiskScore(PROVIDER_ID, normalClaims, DEFAULT_CPT_STATS);

    expect(result.signals.velocityScore).toBeLessThanOrEqual(5);
    expect(result.score).toBeLessThan(30);
  });

  it("assigns a high velocity score when claim volume spikes far above baseline", () => {
    // Baseline: 2 claims/day for days 8–60
    const spikeClaims: ClaimForAnalysis[] = [];
    for (let d = 60; d >= 8; d--) {
      spikeClaims.push(makeClaim({ submittedAt: daysAgo(d) }));
      spikeClaims.push(makeClaim({ submittedAt: daysAgo(d) }));
    }
    // Recent: 15 claims/day — 7.5× baseline (>3 standard deviations above mean)
    for (let d = 6; d >= 0; d--) {
      for (let i = 0; i < 15; i++) {
        spikeClaims.push(makeClaim({ submittedAt: daysAgo(d) }));
      }
    }

    const result = computeRiskScore(PROVIDER_ID, spikeClaims, DEFAULT_CPT_STATS);

    expect(result.signals.velocityScore).toBeGreaterThanOrEqual(20);
  });
});

// ─── Amount distribution signal ────────────────────────────────────────────────

describe("Anomaly Detection — Amount Distribution", () => {
  it("assigns zero amount score when all billings are near average", () => {
    const normalClaims: ClaimForAnalysis[] = [];
    for (let d = 30; d >= 0; d--) {
      normalClaims.push(
        makeClaim({ submittedAt: daysAgo(d), billedAmount: 155 }), // ~1× avg
      );
    }

    const result = computeRiskScore(PROVIDER_ID, normalClaims, DEFAULT_CPT_STATS);
    expect(result.signals.amountScore).toBe(0);
  });

  it("assigns a high amount score when most claims exceed 3× the CPT average", () => {
    const overBilledClaims: ClaimForAnalysis[] = [];
    for (let d = 25; d >= 0; d--) {
      overBilledClaims.push(
        makeClaim({
          submittedAt: daysAgo(d),
          billedAmount: 600, // 4× the $150 avg for 99213
        }),
      );
    }

    const result = computeRiskScore(
      PROVIDER_ID,
      overBilledClaims,
      DEFAULT_CPT_STATS,
    );

    expect(result.signals.amountScore).toBeGreaterThanOrEqual(20);
  });
});

// ─── Procedure clustering signal ───────────────────────────────────────────────

describe("Anomaly Detection — Procedure Clustering", () => {
  it("assigns zero clustering score for claims with compatible CPT codes", () => {
    const normalClaims: ClaimForAnalysis[] = [
      makeClaim({ submittedAt: daysAgo(5), cptCodes: ["99213"] }),
      makeClaim({ submittedAt: daysAgo(4), cptCodes: ["90837"] }),
      makeClaim({ submittedAt: daysAgo(3), cptCodes: ["73721"] }),
    ];

    const result = computeRiskScore(PROVIDER_ID, normalClaims, DEFAULT_CPT_STATS);
    expect(result.signals.clusteringScore).toBe(0);
  });

  it("identifies claims with mutually-incompatible CPT codes (99213 + 99214)", () => {
    // Billing two office-visit levels on the same encounter
    const incompatibleClaims: ClaimForAnalysis[] = [];
    for (let i = 0; i < 10; i++) {
      incompatibleClaims.push(
        makeClaim({
          submittedAt: daysAgo(i),
          cptCodes: ["99213", "99214"],
        }),
      );
    }

    const result = computeRiskScore(
      PROVIDER_ID,
      incompatibleClaims,
      DEFAULT_CPT_STATS,
    );

    expect(result.signals.clusteringScore).toBeGreaterThanOrEqual(20);
  });

  it("identifies arthroscopy + MRI on the same day (73721 + 29881)", () => {
    const surgeryAndScan: ClaimForAnalysis[] = Array.from(
      { length: 8 },
      (_, i) =>
        makeClaim({
          submittedAt: daysAgo(i),
          cptCodes: ["73721", "29881"],
          billedAmount: 5000,
        }),
    );

    const result = computeRiskScore(PROVIDER_ID, surgeryAndScan, DEFAULT_CPT_STATS);
    expect(result.signals.clusteringScore).toBeGreaterThanOrEqual(20);
  });
});

// ─── Temporal pattern signal ───────────────────────────────────────────────────

describe("Anomaly Detection — Temporal Patterns", () => {
  it("assigns zero temporal score for business-hours claims with no bursts", () => {
    const businessHoursClaims: ClaimForAnalysis[] = [];
    for (let d = 30; d >= 1; d--) {
      businessHoursClaims.push(
        makeClaim({ submittedAt: daysAgo(d, 14) }), // 14:00 UTC
      );
    }

    const result = computeRiskScore(
      PROVIDER_ID,
      businessHoursClaims,
      DEFAULT_CPT_STATS,
    );

    expect(result.signals.temporalScore).toBe(0);
  });

  it("assigns a high temporal score for a burst of claims within one hour", () => {
    const now = new Date();
    // 20 claims all within the same 30-minute window
    const burstClaims: ClaimForAnalysis[] = Array.from({ length: 20 }, (_, i) =>
      makeClaim({
        submittedAt: new Date(now.getTime() - i * 90 * 1000), // 90s apart
      }),
    );

    const result = computeRiskScore(PROVIDER_ID, burstClaims, DEFAULT_CPT_STATS);
    expect(result.signals.temporalScore).toBeGreaterThanOrEqual(10);
  });

  it("assigns a high temporal score for predominantly off-hours submissions", () => {
    const offHoursClaims: ClaimForAnalysis[] = [];
    for (let d = 20; d >= 1; d--) {
      // 23:00 UTC — off hours
      offHoursClaims.push(makeClaim({ submittedAt: daysAgo(d, 23) }));
    }

    const result = computeRiskScore(
      PROVIDER_ID,
      offHoursClaims,
      DEFAULT_CPT_STATS,
    );

    expect(result.signals.temporalScore).toBeGreaterThanOrEqual(10);
  });
});

// ─── Composite score ───────────────────────────────────────────────────────────

describe("Anomaly Detection — Composite Score", () => {
  it("returns a score of 0 for a provider with no claims", () => {
    const result = computeRiskScore(PROVIDER_ID, [], DEFAULT_CPT_STATS);
    expect(result.score).toBe(0);
    expect(result.claimsAnalyzed).toBe(0);
  });

  it("returns a score within [0, 100]", () => {
    const extremeClaims = Array.from({ length: 50 }, (_, i) =>
      makeClaim({
        submittedAt: daysAgo(i % 7, 23),
        cptCodes: ["99213", "99214"],
        billedAmount: 9999,
      }),
    );

    const result = computeRiskScore(PROVIDER_ID, extremeClaims, DEFAULT_CPT_STATS);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it("includes providerId and computation metadata in the result", () => {
    const result = computeRiskScore(
      PROVIDER_ID,
      [makeClaim({ submittedAt: daysAgo(1) })],
      DEFAULT_CPT_STATS,
    );

    expect(result.providerId).toBe(PROVIDER_ID);
    expect(result.computedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.claimsAnalyzed).toBe(1);
    expect(result.signals).toHaveProperty("velocityScore");
    expect(result.signals).toHaveProperty("amountScore");
    expect(result.signals).toHaveProperty("clusteringScore");
    expect(result.signals).toHaveProperty("temporalScore");
  });
});
