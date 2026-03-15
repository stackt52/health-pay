import type {
  ClaimForAnalysis,
  CptStats,
  ProviderRiskScore,
  RiskSignals,
} from "../types.js";

/**
 * Anomaly Detection Algorithm — Multi-Signal Risk Scorer
 *
 * Overview:
 *   Assigns a composite risk score (0–100) to a provider by analysing their claim
 *   history across four independent signals. Each signal contributes up to 25 points.
 *   The score is intentionally heuristic; no ML model is involved.
 *
 * Signals:
 *   1. Billing Velocity  (25 pts) — sudden spikes vs 83-day historical baseline
 *   2. Amount Distribution (25 pts) — over-billing relative to CPT code averages
 *   3. Procedure Clustering (25 pts) — mutually-incompatible CPT codes on one claim
 *   4. Temporal Patterns  (25 pts) — off-hours submissions & burst patterns
 *
 * Overall complexity: O(n log n) time (driven by temporal sort), O(n) space
 *
 * Data structures used:
 *   - Map<string, number>  for date→count grouping (O(1) lookup per day)
 *   - Set<string>          for incompatible pair lookup (O(1) per pair check)
 *   - Sorted array + two-pointer for burst detection (O(n log n) + O(n))
 */

// ─── Incompatible CPT pairs ────────────────────────────────────────────────────
//
// Canonical form: sorted codes joined by "|" so lookup is order-independent.
// These pairs represent clinically or administratively contradictory co-billings.
//
const INCOMPATIBLE_PAIRS: ReadonlySet<string> = new Set([
  "99213|99214", // Cannot bill two office-visit complexity levels on the same encounter
  "29881|73721", // Knee arthroscopy + MRI same-day (MRI is a pre-surgical diagnostic)
  "90837|99283", // Psychotherapy + emergency visit (disparate specialties, same encounter)
]);

function pairKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}

function hasIncompatibleCodes(cptCodes: string[]): boolean {
  for (let i = 0; i < cptCodes.length; i++) {
    for (let j = i + 1; j < cptCodes.length; j++) {
      if (INCOMPATIBLE_PAIRS.has(pairKey(cptCodes[i], cptCodes[j]))) {
        return true;
      }
    }
  }
  return false;
}

// ─── Statistical helpers ───────────────────────────────────────────────────────

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function stdDev(values: number[], mu: number): number {
  if (values.length < 2) return 0;
  const variance =
    values.reduce((s, v) => s + (v - mu) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

// ─── Signal 1: Billing Velocity ───────────────────────────────────────────────

/**
 * Compares the average daily claim volume for the last 7 days against an 83-day
 * historical baseline (days 8–90) using a z-score approach.
 *
 * z = (recentAvg − baselineMean) / baselineStdDev
 *
 * Score scales linearly: z=0 → 0 pts, z≥3 → 25 pts.
 * If baseline has zero variance (new/inactive provider), recent activity is scored
 * proportionally.
 *
 * Time complexity: O(n) to bucket claims, O(90) = O(1) to compute stats
 */
function computeVelocityScore(claims: ClaimForAnalysis[], now: Date): number {
  const MAX = 25;
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - 90);

  const dailyCounts = new Map<string, number>();
  for (const c of claims) {
    if (c.submittedAt < cutoff) continue;
    const day = c.submittedAt.toISOString().slice(0, 10);
    dailyCounts.set(day, (dailyCounts.get(day) ?? 0) + 1);
  }

  if (dailyCounts.size === 0) return 0;

  const recentCounts: number[] = [];
  const baselineCounts: number[] = [];

  for (let d = 1; d <= 90; d++) {
    const date = new Date(now);
    date.setDate(date.getDate() - d);
    const key = date.toISOString().slice(0, 10);
    const count = dailyCounts.get(key) ?? 0;
    if (d <= 7) recentCounts.push(count);
    else baselineCounts.push(count);
  }

  const recentAvg = mean(recentCounts);
  const baselineMean = mean(baselineCounts);
  const baselineStd = stdDev(baselineCounts, baselineMean);

  if (baselineStd === 0) {
    // Provider has flat (or no) history; any recent spike is scored conservatively
    return clamp(recentAvg * 2, 0, MAX);
  }

  const z = (recentAvg - baselineMean) / baselineStd;
  return clamp((z / 3) * MAX, 0, MAX);
}

// ─── Signal 2: Amount Distribution ────────────────────────────────────────────

/**
 * Measures the rate at which the provider bills more than 3× the average for any
 * CPT code in the 30-day rolling window.
 *
 * overBilledRate = flaggedClaims / totalRecentClaims
 * Score = clamp(overBilledRate × 50, 0, 25)
 *
 * Time complexity: O(n × k) where k = average CPT codes per claim
 */
function computeAmountScore(
  claims: ClaimForAnalysis[],
  cptStats: Map<string, CptStats>,
  now: Date,
): number {
  const MAX = 25;
  const windowStart = new Date(now);
  windowStart.setDate(windowStart.getDate() - 30);

  const recent = claims.filter((c) => c.submittedAt >= windowStart);
  if (recent.length === 0) return 0;

  let overBilledCount = 0;
  for (const claim of recent) {
    const flagged = claim.cptCodes.some((code) => {
      const stats = cptStats.get(code);
      return stats !== undefined && claim.billedAmount > stats.avgBilledAmount * 3;
    });
    if (flagged) overBilledCount++;
  }

  return clamp((overBilledCount / recent.length) * 50, 0, MAX);
}

// ─── Signal 3: Procedure Clustering ───────────────────────────────────────────

/**
 * Detects claims that contain mutually-incompatible CPT code combinations.
 * Uses a precomputed Set of canonical pair keys for O(1) per-pair lookup.
 *
 * clusteringRate = incompatibleClaims / totalClaims
 * Score = clamp(clusteringRate × 50, 0, 25)
 *
 * Time complexity: O(n × k²) where k = CPT codes per claim (typically k ≤ 5)
 */
function computeClusteringScore(claims: ClaimForAnalysis[]): number {
  const MAX = 25;
  if (claims.length === 0) return 0;

  const incompatibleCount = claims.filter((c) =>
    hasIncompatibleCodes(c.cptCodes),
  ).length;

  return clamp((incompatibleCount / claims.length) * 50, 0, MAX);
}

// ─── Signal 4: Temporal Patterns ──────────────────────────────────────────────

/**
 * Combines two sub-signals:
 *
 *   Off-hours (max 12.5 pts):
 *     Claims submitted between 22:00–05:59 UTC.
 *     offHoursRate = offHoursClaims / totalClaims
 *     Score = clamp(offHoursRate × 25, 0, 12.5)
 *
 *   Burst detection (max 12.5 pts):
 *     Maximum number of claims in any sliding 1-hour window, found via
 *     two-pointer on a sorted timestamp array.
 *     Score kicks in when maxInWindow > BURST_THRESHOLD (5 claims).
 *
 * Time complexity: O(n log n) for sort + O(n) for two-pointer = O(n log n)
 * Space complexity: O(n) for the sorted copy
 */
function computeTemporalScore(claims: ClaimForAnalysis[]): number {
  const MAX = 25;
  if (claims.length === 0) return 0;

  // Off-hours sub-score
  const offHours = claims.filter((c) => {
    const h = c.submittedAt.getUTCHours();
    return h >= 22 || h < 6;
  });
  const offHoursScore = clamp(
    (offHours.length / claims.length) * MAX,
    0,
    MAX / 2,
  );

  // Burst detection: two-pointer on sorted timestamps
  const sorted = [...claims].sort(
    (a, b) => a.submittedAt.getTime() - b.submittedAt.getTime(),
  );
  const ONE_HOUR_MS = 60 * 60 * 1000;
  const BURST_THRESHOLD = 5;
  let maxInWindow = 1;
  let left = 0;

  for (let right = 0; right < sorted.length; right++) {
    while (
      sorted[right].submittedAt.getTime() -
      sorted[left].submittedAt.getTime() >
      ONE_HOUR_MS
    ) {
      left++;
    }
    maxInWindow = Math.max(maxInWindow, right - left + 1);
  }

  const burstScore =
    maxInWindow > BURST_THRESHOLD ?
      clamp(
        ((maxInWindow - BURST_THRESHOLD) / BURST_THRESHOLD) * (MAX / 2),
        0,
        MAX / 2,
      ) :
      0;

  return offHoursScore + burstScore;
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Computes a composite fraud risk score (0–100) for a provider.
 *
 * @param providerId  - The provider being scored
 * @param claims      - Full claim history to analyse (no Firestore Timestamps)
 * @param cptStats    - Map of CPT code → average billed amount across all providers
 * @param now         - Reference time (injectable for deterministic testing)
 */
export function computeRiskScore(
  providerId: string,
  claims: ClaimForAnalysis[],
  cptStats: Map<string, CptStats>,
  now: Date = new Date(),
): ProviderRiskScore {
  const signals: RiskSignals = {
    velocityScore: Math.round(computeVelocityScore(claims, now)),
    amountScore: Math.round(computeAmountScore(claims, cptStats, now)),
    clusteringScore: Math.round(computeClusteringScore(claims)),
    temporalScore: Math.round(computeTemporalScore(claims)),
  };

  const rawScore =
    signals.velocityScore +
    signals.amountScore +
    signals.clusteringScore +
    signals.temporalScore;

  return {
    providerId,
    score: clamp(rawScore, 0, 100),
    signals,
    computedAt: now.toISOString(),
    claimsAnalyzed: claims.length,
  };
}
