# HealthPay — Design Document

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Rules Engine Design](#2-rules-engine-design)
3. [Adjudication Engine](#3-adjudication-engine)
4. [Anomaly Detection Algorithm](#4-anomaly-detection-algorithm)
5. [Claim State Machine](#5-claim-state-machine)
6. [Data Layer](#6-data-layer)
7. [API Design & Standards](#7-api-design--standards)
8. [Trade-offs & Compromises](#8-trade-offs--compromises)
9. [What I Would Improve With More Time](#9-what-i-would-improve-with-more-time)
10. [Likes and Dislikes](#10-likes-and-dislikes)
11. [How to Run](#11-how-to-run)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  Firebase Hosting                                           │
│  public/index.html — Swagger UI (OpenAPI 3.0 spec)         │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP
┌──────────────────────────▼──────────────────────────────────┐
│  Firebase Cloud Functions  (us-central1)                    │
│  Node.js 24 · TypeScript · Express.js                       │
│                                                             │
│  middleware.ts                                              │
│    correlationMiddleware → requestLogger → routes           │
│                                                  ↓          │
│  routes/                                                    │
│    claims.ts · providers.ts · patients.ts                   │
│    insurancePlans.ts · seed.ts                              │
│                                                  ↓          │
│  engines/                                                   │
│    rules.ts · adjudication.ts · anomaly.ts                  │
│    stateMachine.ts                                          │
└──────────────────────────┬──────────────────────────────────┘
                           │ Supabase JS (service-role)
┌──────────────────────────▼──────────────────────────────────┐
│  Supabase — PostgreSQL 17  (eu-west-1)                      │
│  providers · patients · insurance_plans · cpt_codes         │
│  claims · payments · audit_log                              │
└─────────────────────────────────────────────────────────────┘
```

The backend is a single Firebase Cloud Function (`api`) that mounts an Express application. All business logic lives in four engine modules that are pure TypeScript with no external I/O — they receive data, compute a result, and return it. Routes own all database interaction and orchestrate the engines. This separation means every engine is unit-testable without a database or HTTP server.

**Why Firebase Functions + Supabase rather than a dedicated server?**

Firebase Functions removes all infrastructure concern — no server provisioning, no scaling configuration beyond `maxInstances`. Supabase provides a production PostgreSQL instance with zero ops overhead, which was the right call given the relational nature of the data (insurance plan joins, FK constraints, indexed claim queries). A NoSQL store would have forced denormalisation that doesn't fit the domain.

---

## 2. Rules Engine Design

**Pattern: Chain of Responsibility + Strategy**

Each business rule is a self-contained class implementing the `ClaimRule` interface:

```typescript
interface ClaimRule {
  readonly name: string;
  evaluate(claim: SubmitClaimRequest, context: RuleContext): Promise<RuleResult>;
}
```

Rules are composed into a pipeline by `RulesEngine`, which invokes them in registration order. The critical design decision is the **two-tier failure model**:

| Action | Effect | Example rule |
|---|---|---|
| `REJECT` / `DENY` | Hard failure — chain stops immediately | `ProviderLicenseRule`, `DuplicateClaimRule` |
| `FLAG` | Soft failure — recorded, chain continues | `AmountCeilingRule` |
| `ADJUST` | Annotation — chain continues, adjudication reads it | `DeductibleCheckRule` |
| `CONTINUE` | Pass — no effect | Any passing rule |

**Why Chain of Responsibility over a flat if/else or switch?**

The alternative — a `validateClaim()` function with a series of if/else blocks — conflates rule definition with pipeline control. Every new rule requires modifying that function. The Chain of Responsibility means adding a rule is:

1. Implement `ClaimRule`
2. Add one line to `createDefaultRulesEngine()`

No existing code is touched. This satisfies the Open/Closed Principle directly.

**Why not a rules DSL or JSON-driven rules?**

A data-driven DSL (e.g. rules stored in the database) would add the right value at scale when non-engineers need to author rules without a deployment. That is premature here — the rules are well-defined in the spec, the team writing them is technical, and a DSL would add a parser/interpreter layer with no current benefit. The abstraction boundary (the `ClaimRule` interface) means migrating to a DSL later would only require changing the rule *implementations*, not the engine.

**Rules evaluated in order (and why order matters):**

1. `ProviderLicenseRule` — cheapest check, uses in-memory data, rejects fastest
2. `DuplicateClaimRule` — also in-memory, prevents redundant downstream work
3. `PlanCoverageRule` — denies before adjudication runs
4. `AmountCeilingRule` — soft flag, must run after hard-reject rules
5. `DeductibleCheckRule` — annotation for adjudication, always runs last

---

## 3. Adjudication Engine

The engine implements a standard insurance payment waterfall as a pure function:

```
billedAmount
  − copay                   → patient pays first
  − deductible (if unmet)   → remainder applied to annual deductible
  × coinsuranceRate         → patient pays their share of remainder
  capped at outOfPocketMax  → total patient responsibility ceiling
```

**Key design decision:** `calculateAdjudication()` is a pure function. It takes amounts and a plan, returns a result. It does not read from or write to the database. This makes it trivially testable and reusable — the same function is called both during claim submission and could be called for what-if simulations without side effects.

**Copay resolution:** The plan stores three copay tiers (`officeVisit`, `specialist`, `emergency`). The `resolveCopay()` helper maps CPT category to the correct tier. If a claim has multiple CPT codes, the first recognised category wins — this is the standard insurance convention (primary procedure determines visit type).

**Out-of-pocket cap:** The cap accounts for the patient's already-met deductible (`plan.deductibleMet`) against the plan maximum. Any patient responsibility exceeding the remaining capacity shifts back to the insurer.

---

## 4. Anomaly Detection Algorithm

### Approach

The algorithm produces a composite risk score (0–100) by combining four independent, equally-weighted signals (0–25 pts each). The design is intentionally heuristic — no ML model, no training data required. Each signal is a pure function of the claim history array and a reference time, making every signal independently testable and the composite score fully explainable.

### Signal 1: Billing Velocity (0–25 pts)

**Goal:** Detect sudden spikes in claim volume relative to the provider's historical baseline.

**Method:** Z-score comparison of recent (last 7 days) average daily volume against the 83-day historical baseline (days 8–90).

```
z = (recentAvg − baselineMean) / baselineStdDev
score = clamp((z / 3) × 25, 0, 25)
```

A z-score of 3 (three standard deviations above baseline) maps to the maximum 25 points. Scores below 0 are clamped to 0 — a provider submitting fewer claims than baseline is not suspicious.

**Edge case handled:** When `baselineStdDev === 0` (new provider or one who submits exactly the same volume every day), dividing by zero is avoided by scoring proportionally to the raw recent average instead.

**Data structures:** `Map<string, number>` for day-key → claim-count bucketing. O(1) per insertion and lookup.

**Complexity:** O(n) to bucket claims + O(90) = O(1) to compute statistics over the fixed 90-day window → **O(n) overall**.

---

### Signal 2: Amount Distribution (0–25 pts)

**Goal:** Detect systematic over-billing relative to the expected price range for each CPT code.

**Method:** For each claim in the last 30 days, check whether the billed amount exceeds 3× the CPT average. Score is proportional to the over-billing rate.

```
overBilledRate = flaggedClaims / totalRecentClaims
score = clamp(overBilledRate × 50, 0, 25)
```

The multiplier of 50 means a 50% over-billing rate maps to the maximum (25 pts). A provider who occasionally over-bills does not score highly; systematic over-billing does.

**Data structures:** `Map<string, CptStats>` passed in from the caller (pre-built from the `cpt_codes` table) — O(1) per CPT lookup.

**Complexity:** O(n × k) where k = average number of CPT codes per claim. In practice k ≤ 5, so this is effectively **O(n)**.

---

### Signal 3: Procedure Clustering (0–25 pts)

**Goal:** Detect claims that include mutually-incompatible CPT code combinations — procedures that cannot clinically or administratively co-occur on the same encounter.

**Method:** For each claim, check all pairs of CPT codes against a precomputed set of known incompatible pairs.

```
clusteringRate = incompatibleClaims / totalClaims
score = clamp(clusteringRate × 50, 0, 25)
```

**Incompatible pairs implemented:**
- `99213|99214` — Cannot bill two office-visit complexity levels for the same encounter
- `29881|73721` — Knee arthroscopy + same-day MRI (MRI is a pre-surgical diagnostic, not a concurrent procedure)
- `90837|99283` — Psychotherapy + emergency visit (disparate specialties billed as a single encounter)

**Key data structure decision:** Pairs are stored as a `ReadonlySet<string>` of canonical keys (`"99213|99214"` — always sorted). Sorting both codes before lookup makes the check order-independent in O(k log k) per claim, and Set membership is O(1). The alternative — a nested Map or adjacency list — offers no lookup advantage and is harder to maintain.

**Complexity:** O(n × k²) where k = CPT codes per claim. With k bounded at ~5, the inner loop is at most 10 pair checks per claim → effectively **O(n)**.

---

### Signal 4: Temporal Patterns (0–25 pts)

**Goal:** Detect two independent temporal anomalies: systematic off-hours submissions, and burst submission patterns.

**Sub-signal A — Off-hours rate (0–12.5 pts):**
Claims submitted between 22:00–05:59 UTC are considered off-hours. Rate above 50% earns the maximum 12.5 points.

**Sub-signal B — Burst detection (0–12.5 pts):**
A sliding 1-hour window finds the maximum number of claims submitted within any single hour. If this exceeds 5 (the `BURST_THRESHOLD`), points are awarded proportionally.

**Algorithm for burst detection:** Sort timestamps, then use a **two-pointer** approach:
- `right` advances through every claim
- `left` advances to maintain the invariant: `timestamps[right] − timestamps[left] ≤ 1 hour`
- `right − left + 1` is the window size at each step

This finds the maximum burst window in O(n) after the O(n log n) sort, compared to the O(n²) naive nested-loop approach.

**Data structures:** Sorted copy of the claims array (preserving the original). Two integer pointers. No auxiliary data structures needed beyond the sort.

**Complexity:** O(n log n) for sort + O(n) for two-pointer = **O(n log n) overall**. This dominates the composite score computation.

---

### Composite Score

```typescript
score = velocityScore + amountScore + clusteringScore + temporalScore
      = clamp(score, 0, 100)
```

Each signal is independently rounded to the nearest integer before summing. Score thresholds:

| Range | Risk level |
|---|---|
| 0–20 | Low |
| 21–50 | Moderate |
| 51–75 | High |
| 76–100 | Critical |

**Why equally-weighted signals?**

Unequal weighting requires calibration data — historical records of confirmed fraudulent providers to tune weights against. Without that data, differential weighting is arbitrary and unjustifiable. Equal weights are honest about the current information state and avoid baking in false precision. A production system would gather labelled data over time and train a logistic regression or gradient boosting model over these same four feature signals.

---

## 5. Claim State Machine

The claim lifecycle is modelled as an **explicit transition table** rather than a set of guard clauses scattered through the route handlers:

```
SUBMITTED → VALIDATED → ADJUDICATED → PATIENT_BILLED → PAID
                     ↘ FLAGGED ↗ (manual review; can return to VALIDATED)
         ↘ DENIED (from any non-terminal state)
```

**Implementation:** `Map<ClaimStatus, ReadonlySet<ClaimStatus>>` — a lookup table of valid `from → to` pairs. `assertTransition()` throws an `AppError(409, "INVALID_STATE_TRANSITION")` with `validTransitions` in the error details, so API consumers know exactly what they can do next.

**Why an explicit table rather than guard clauses?**

Guard clauses distributed across handlers mean the full transition graph only exists implicitly in the reader's head. The table is the single source of truth — readable in one glance, testable via `test.each`, and immune to partial refactors that accidentally permit a new transition in one handler but not another.

**Terminal states** (`PAID`, `DENIED`) map to empty `Set`s. Any attempt to transition out of them fails at the table lookup — no special-case code needed.

---

## 6. Data Layer

### Schema Design

PostgreSQL was chosen over a document store because the domain is inherently relational:
- Every claim has a FK to a provider, patient, and implicitly a plan
- Insurance plan copay is a structured object (JSONB) — relational except for this one embedded value type
- Aggregate queries (provider dashboard — total revenue, claim counts by status) are trivial SQL, painful NoSQL

**Key decisions:**

- **PKs are `TEXT`** (not `SERIAL` or `UUID` typed column). This allows the seed data to use meaningful human-readable IDs (`PLAN_GOLD_001`, `PROV_NORMAL_001`) while auto-generating UUIDs in production via `DEFAULT gen_random_uuid()::TEXT`.

- **`copay` is JSONB.** The three copay tiers (`officeVisit`, `specialist`, `emergency`) are a fixed, small, always-read-together value. JSONB avoids a separate `plan_copay` table with no query benefit.

- **`cpt_codes` is a reference table**, not hard-coded in application logic. This means new CPT codes can be added via the seed endpoint without a code change.

- **`covered_cpt_codes` is `TEXT[]`.** PostgreSQL array columns support `@>` (contains) operators. Checking plan coverage is a single indexed query rather than a join table.

- **Enums** (`claim_status`, `license_status`, `cpt_category`, `payment_status`) are PostgreSQL native enums. This enforces valid values at the database level independent of application-layer validation — defence in depth.

### Indexes

All foreign key columns are indexed. Additional indexes:
- `claims(provider_id)`, `claims(patient_id)`, `claims(status)` — support list filtering
- `claims(submitted_at DESC)` — supports cursor-based pagination
- `payments(claim_id)`, `payments(idempotency_key)` — support payment lookup and dedup

### Migrations

The schema was applied via a single versioned migration through the Supabase MCP tool. In a production workflow this would be a numbered migration file in a `supabase/migrations/` directory, run via `supabase db push` in CI, not applied manually.

### Seed Data

The seed endpoint (`POST /api/seed`) creates:
- 6 CPT codes matching the assessment reference data
- 2 insurance plans (Gold and Silver tiers)
- 3 providers: `PROV_NORMAL_001` (active license), `PROV_ANOMALOUS_001` (high-risk billing history), `PROV_EXPIRED_001` (expired license)
- 3 patients
- ~200 sample claims distributed across providers, including patterns that trigger all four anomaly signals for the anomalous provider

The seed operation uses `upsert` with `onConflict` on the primary key, making it safe to run multiple times.

---

## 7. API Design & Standards

### Error Handling

All anticipated failures throw `AppError(statusCode, errorCode, message, details?)`. A central `errorHandler` middleware catches all errors — both `AppError` and unexpected errors. The contract:

- `AppError` → structured `{ error: { code, message, correlationId, details? } }` at the correct HTTP status
- Unknown errors → `500` with a generic message; internal details and stack traces are **never** sent to clients

### Correlation IDs

Every request is assigned a correlation ID via `correlationMiddleware`. If the caller provides `x-correlation-id` in the request header, that value is used (enabling end-to-end tracing from client through function logs). Otherwise a UUID is generated. The ID is:
- Attached to `req.correlationId`
- Echoed in the `x-correlation-id` response header
- Included in every log entry
- Included in every error response body

### Structured Logging

All logging uses `firebase-functions/logger`, which emits JSON to Cloud Logging. Log levels are used intentionally:
- `info` — normal request events
- `warn` — application errors (`AppError`), non-fatal degradations (audit log failure, risk score failure)
- `error` — unhandled exceptions

Sensitive data (payment amounts beyond what's necessary, patient identifiers in unstructured strings) is never logged.

### Idempotency

Two idempotency mechanisms:
1. **Claim submission** — optional `idempotencyKey` field. If a claim with that key already exists, the original claim is returned with `200` rather than creating a duplicate.
2. **Payment processing** — required `idempotencyKey`. A unique constraint on `payments(idempotency_key)` enforces deduplication at the database level. A retry returns the original payment record.

### Pagination

List endpoints use **cursor-based pagination** (not offset). The cursor is the `submitted_at` timestamp of the last item on the previous page. The query uses `WHERE submitted_at < cursor_value ORDER BY submitted_at DESC LIMIT n`. This is stable under concurrent inserts — offset pagination would return duplicate or skipped records when new claims are inserted between pages.

---

## 8. Trade-offs & Compromises

**No integration tests.** Unit tests cover all three engine modules thoroughly, but there are no HTTP-level integration tests hitting the live API. The primary blocker is that the emulator connects to the live Supabase project — running integration tests would require either a dedicated test database or seeded state that is cleaned up after each run. With more time, I would set up a Supabase branch (their branching feature supports this) per test run and tear it down after.

**No Docker Compose.** The deliverables request a Docker Compose setup. Firebase Functions requires the Firebase Emulator, which is a Node.js process rather than a Docker image. Supabase is a hosted service. There is no local database to run in a container. The `npm run serve` command in `functions/` is the equivalent local dev setup. A `docker-compose.yml` could be added to containerise the Node process itself, but it would add complexity without the benefit of local database isolation.

**`deductibleMet` is stored on the plan.** In a real system, a patient's deductible progress would be computed from the `claims` table (sum of `deductible_applied` for the current policy year). Storing it as a static field on the plan means it gets stale after any claim is processed. The seed data provides a starting value; production would need a background job or trigger to keep it current, or the adjudication engine would need to derive it from claim history at runtime.

**Risk scoring is on-demand.** The `POST /api/providers/:id/risk-score` endpoint computes the score synchronously at request time. At volume, this could be expensive (fetching all provider claims). The production architecture would compute scores asynchronously — a background job or a triggered Cloud Function on each new claim — and cache the result.

**No authentication.** The API has no auth layer. Every endpoint is publicly callable. Production would require JWT validation (Firebase Auth or a dedicated IdP) with role-based access control: providers can only see their own claims, admins can see all.

**Partial payment tracking is simplified.** The `payments` table records individual payment events against a claim. The claim's `amountPaid` is updated on each payment. However, the system does not currently enforce that total payments cannot exceed `patientResponsibility` — an overpayment is accepted and flagged implicitly by the claim status remaining `PATIENT_BILLED`. A production system would reject payments that would cause the total to exceed the billed patient amount, and handle refund events explicitly.

---

## 9. What I Would Improve With More Time

1. **Derived deductible progress.** Compute `deductibleMet` as a SQL aggregate over the current policy year's claims rather than storing it statically. This ensures correctness across concurrent claim submissions.

2. **Async risk scoring with caching.** Trigger risk score computation as a background task after each claim submission. Cache the result in a `provider_risk_scores` table. The `POST /risk-score` endpoint becomes a cache read with optional force-recompute.

3. **Integration test suite.** Supabase database branching makes per-test-run isolation practical. Each test suite would create a branch, seed it, run HTTP tests against the emulator, then delete the branch.

4. **Calibrated anomaly scoring.** Once labelled fraud data is available (confirmed anomalous providers), train a logistic regression model over the four signal features to produce calibrated probability scores. The existing four pure functions become the feature extraction layer with no change to their interface.

5. **Expand incompatible CPT pairs.** The current set of three pairs is illustrative. The AMA publishes comprehensive CPT bundling and mutually-exclusive code lists (the CCI edit tables). Ingesting those would make the clustering signal production-grade.

6. **Rate limiting and circuit breakers.** The API has no rate limiting. At the network edge (Firebase Hosting or an API Gateway), rate limiting per provider ID would prevent both abuse and accidental runaway clients. A circuit breaker around the Supabase client would prevent cascading failures when the database is degraded.

7. **Audit log as an event stream.** The current `audit_log` table is append-only but polled. A production system would publish events to a message queue (Pub/Sub) and drive downstream consumers — fraud review systems, billing reconciliation, patient notifications — from the event stream rather than direct DB queries.

---

## 10. Likes and Dislikes

**What I liked about the problem:** The domain is genuinely interesting. Medical billing has real algorithmic depth — the payment waterfall has edge cases (OOP cap interaction with deductible), the anomaly detection requires thinking about statistical baselines, and the state machine has non-obvious transitions (FLAGGED → VALIDATED for the review cycle). It's a richer problem than typical CRUD assessments.

**What I liked about the solution:** The engine modules came out clean. The `ClaimRule` interface is a tight abstraction that makes the rules engine both readable and extensible. The anomaly engine's four pure functions feel like the right decomposition — each signal is independently legible and testable.

**What I disliked about the problem:** The `deductibleMet` field in the reference plan schema is a design trap. Storing running totals as mutable fields on a parent entity is an anti-pattern in any financial system — it creates race conditions and makes historical queries impossible. I worked around it but it required a deliberate decision.

**What I disliked about the solution:** The row mappers (snake_case DB columns → camelCase TypeScript types) are duplicated inline across five route files. A single `mappers.ts` module would be cleaner and eliminate the risk of an inconsistent mapping in one file. I kept them inline to avoid creating abstraction for its own sake, but it's the part of the codebase I'd refactor first.

---

## 11. How to Run

### Prerequisites

- Node.js v24+
- Firebase CLI: `npm install -g firebase-tools`
- Firebase account with access to the `health-pay-api` project
- Supabase service-role key for project `usckapopbgbqhibvkwqv`

### Setup

```bash
# 1. Clone and install
git clone <repo-url>
cd health-pay
npm install          # frontend deps
cd functions && npm install && cd ..

# 2. Configure environment
cp functions/.env.example functions/.env
# Edit functions/.env and set SUPABASE_SERVICE_ROLE_KEY

# 3. Build functions
cd functions && npm run build && cd ..

# 4. Start the Firebase emulator
cd functions && npm run serve
# API available at: http://localhost:5001/health-pay-api/us-central1/api/api/

# 5. Seed the database (first run only)
curl -X POST http://localhost:5001/health-pay-api/us-central1/api/api/seed

# 6. Run unit tests
cd functions && npm test
```

### Key API calls to verify the full workflow

```bash
BASE=http://localhost:5001/health-pay-api/us-central1/api/api

# Submit a normal claim (returns PATIENT_BILLED)
curl -X POST $BASE/claims \
  -H "Content-Type: application/json" \
  -d '{"providerId":"PROV_NORMAL_001","patientId":"PAT_001","cptCodes":["99213"],"billedAmount":150}'

# Submit a claim from an expired-license provider (returns DENIED)
curl -X POST $BASE/claims \
  -H "Content-Type: application/json" \
  -d '{"providerId":"PROV_EXPIRED_001","patientId":"PAT_001","cptCodes":["99213"],"billedAmount":150}'

# Compute anomaly risk score for the anomalous provider (should be high)
curl -X POST $BASE/providers/PROV_ANOMALOUS_001/risk-score

# View provider dashboard
curl $BASE/providers/PROV_NORMAL_001/dashboard
```

### Deploy to production

```bash
firebase deploy --only functions   # runs lint + build automatically
firebase deploy --only hosting     # deploys Swagger UI
firebase deploy                    # deploys both
```

### Environment variables

See `functions/.env.example` for all required and optional variables.
