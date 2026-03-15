# HealthPay — Firebase Cloud Functions

This directory contains the entire backend for the HealthPay platform: a TypeScript + Express.js application deployed as a single Firebase Cloud Function (`api`). It handles claim adjudication, provider risk scoring, CRUD management for providers, patients, and insurance plans, and patient payment processing.

---

## Tech Stack

| Technology | Role | Version |
|-----------|------|---------|
| TypeScript | Language | 5.x |
| Node.js | Runtime | 24 |
| Express.js | HTTP framework | 4.x |
| Supabase JS | Database client (PostgreSQL) | 2.x |
| Firebase Functions | Cloud Function wrapper | 7.x |
| `uuid` | Correlation ID generation | 11.x |
| `cors` | CORS middleware | 2.x |
| Jest + ts-jest | Unit testing | 29.x |

---

## Directory Structure

```
functions/
├── src/
│   ├── index.ts              # Cloud Function entrypoint — exports the `api` function
│   ├── app.ts                # Express app factory — mounts all routers and middleware
│   ├── db.ts                 # Supabase client init, exports `supabase`
│   ├── middleware.ts         # correlationMiddleware, requestLogger, errorHandler
│   ├── types.ts              # All domain interfaces, enums, and AppError class
│   │
│   ├── routes/
│   │   ├── claims.ts         # Claims submission, listing, retrieval, payments
│   │   ├── providers.ts      # Provider CRUD, dashboard stats, anomaly risk score
│   │   ├── patients.ts       # Patient CRUD
│   │   ├── insurancePlans.ts # Insurance plan CRUD
│   │   └── seed.ts           # Idempotent reference data seeder
│   │
│   ├── engines/
│   │   ├── rules.ts          # Chain-of-Responsibility rules pipeline
│   │   ├── adjudication.ts   # Copay/deductible/coinsurance payment waterfall
│   │   ├── anomaly.ts        # Four-signal provider risk scoring (0–100)
│   │   └── stateMachine.ts   # Claim lifecycle state machine
│   │
│   └── __tests__/
│       ├── rules.test.ts
│       ├── anomaly.test.ts
│       └── stateMachine.test.ts
│
├── lib/                      # Compiled JavaScript output (git-ignored)
├── package.json
├── tsconfig.json
└── tsconfig.dev.json
```

---

## NPM Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript to `lib/` |
| `npm run build:watch` | Watch mode — recompile on save |
| `npm run lint` | Run ESLint across all `.ts` and `.js` files |
| `npm test` | Run Jest unit tests |
| `npm run serve` | Build + start Firebase Emulator (Functions only) |
| `npm run shell` | Build + open Firebase Functions interactive shell |
| `npm run deploy` | Deploy functions to Firebase (requires CLI auth) |
| `npm run logs` | Tail live Cloud Function logs |

---

## Getting Started

### 1. Install dependencies

```bash
cd functions
npm install
```

### 2. Build

```bash
npm run build
```

### 3. Configure Supabase credentials

Create a `functions/.env` file (gitignored):

```bash
SUPABASE_URL=https://usckapopbgbqhibvkwqv.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>
```

Get the key from the [Supabase dashboard](https://supabase.com/dashboard) under **Settings → API → service_role**.

### 4. Start the emulator

```bash
npm run serve
# Functions available at:
# http://localhost:5001/health-pay-api/us-central1/api/api/<route>
```

> The emulator connects to the **live Supabase project**. There is no local database emulator.

### 5. Seed the database

```bash
curl -X POST \
  http://localhost:5001/health-pay-api/us-central1/api/api/seed
```

Creates: 6 CPT codes, 2 insurance plans, 3 providers (normal, anomalous, expired), 3 patients, ~200 sample claims. Reference data (plans, providers, patients) is upserted — safe to run multiple times.

---

## Routes

### Claims — `routes/claims.ts`

| Method | Path | Status codes |
|--------|------|-------------|
| `POST` | `/api/claims` | 201 (billed), 202 (flagged), 422 (denied), 400, 404, 500 |
| `GET` | `/api/claims` | 200, 400, 500 |
| `GET` | `/api/claims/:id` | 200, 404, 500 |
| `POST` | `/api/claims/:id/payments` | 201, 400, 404, 409, 500 |
| `GET` | `/api/claims/:id/payments` | 200, 404, 500 |

**Claim submission pipeline:**
1. Input validation (types, required fields, positive amounts)
2. Idempotency check (returns existing claim if `idempotencyKey` matched)
3. Fetch provider, patient, plan (parallel)
4. Fetch CPT code metadata
5. Fetch last-24h claims for duplicate detection
6. Rules engine evaluation
7. Adjudication (insurer vs patient split) — skipped for DENIED claims
8. Risk score computation — non-fatal, defaults to 0 on engine failure
9. Persist claim to Supabase
10. Write audit log entry — non-fatal, never blocks the response

### Providers — `routes/providers.ts`

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/providers` | Create provider |
| `GET` | `/api/providers` | List providers (filter: `?licenseStatus=`) |
| `GET` | `/api/providers/:id` | Get provider by ID |
| `PUT` | `/api/providers/:id` | Update provider fields |
| `DELETE` | `/api/providers/:id` | Delete provider |
| `GET` | `/api/providers/:id/dashboard` | Aggregated claim stats + revenue |
| `POST` | `/api/providers/:id/risk-score` | On-demand anomaly score computation |

### Patients — `routes/patients.ts`

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/patients` | Create patient (validates `planId` exists) |
| `GET` | `/api/patients` | List patients (filter: `?planId=`) |
| `GET` | `/api/patients/:id` | Get patient by ID |
| `PUT` | `/api/patients/:id` | Update patient fields |
| `DELETE` | `/api/patients/:id` | Delete patient |

### Insurance Plans — `routes/insurancePlans.ts`

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/insurance-plans` | Create plan |
| `GET` | `/api/insurance-plans` | List all plans |
| `GET` | `/api/insurance-plans/:id` | Get plan by ID |
| `PUT` | `/api/insurance-plans/:id` | Update plan fields |
| `DELETE` | `/api/insurance-plans/:id` | Delete plan |

### Seed — `routes/seed.ts`

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/seed` | Idempotent data seeder — safe to call repeatedly |

---

## Business Logic Engines

### Rules Engine — `engines/rules.ts`

Architecture: **Chain of Responsibility**. Rules are evaluated in order; a hard failure short-circuits the chain.

| Rule | Trigger | Effect |
|------|---------|--------|
| `ProviderLicenseRule` | License `expired` or `suspended` | REJECT → claim DENIED |
| `DuplicateClaimRule` | Same provider + patient + CPT codes within 24h | REJECT → claim DENIED |
| `PlanCoverageRule` | CPT code not in patient's plan `coveredCptCodes` | DENY → claim DENIED |
| `AmountCeilingRule` | Billed amount > 3× CPT `avgBilledAmount` | FLAG → claim FLAGGED |
| `DeductibleCheckRule` | Unmet annual deductible | ADJUST (non-blocking) |

### Adjudication Engine — `engines/adjudication.ts`

Payment waterfall applied to claims that reach `PATIENT_BILLED`:
1. **Copay** — fixed amount based on primary CPT category (office_visit / specialist / emergency)
2. **Deductible** — remaining balance applied to unmet annual deductible
3. **Coinsurance** — patient pays `coinsuranceRate` of remaining post-deductible amount
4. **Out-of-pocket cap** — patient total capped at `outOfPocketMax`

All amounts rounded to the nearest cent.

### Anomaly Engine — `engines/anomaly.ts`

Produces a composite **risk score (0–100)** from four independent signals (0–25 pts each):

| Signal | Method | Source window |
|--------|--------|--------------|
| **Velocity** | Z-score of last-7-day avg vs 83-day baseline | 90 days |
| **Amount** | Rate of claims billed > 3× CPT average | Last 30 days |
| **Clustering** | Rate of claims with incompatible CPT code pairs | All provided claims |
| **Temporal** | Off-hours rate (22:00–06:00 UTC) + burst detection (>5 claims/hr) | All provided claims |

Score thresholds: 0–20 low · 21–50 moderate · 51–75 high · 76–100 critical.

---

## Middleware — `middleware.ts`

### `correlationMiddleware`
Reads `x-correlation-id` from the request header or generates a new UUID. Attaches it to `req.correlationId` and echoes it in the `x-correlation-id` response header. Used for distributed tracing across logs.

### `requestLogger`
Logs every incoming request as structured JSON via `firebase-functions/logger`:
```json
{ "method": "POST", "path": "/api/claims", "correlationId": "..." }
```

### `errorHandler`
Central error handler (must be last middleware in the chain).

- **`AppError`** → logs `warn` with code, statusCode, message, details; responds with the structured error body and the correct HTTP status
- **Unknown errors** → logs `error` with message and stack trace; responds with `500 INTERNAL_ERROR` (never exposes internals to the client)

---

## Error Handling Architecture

Every route handler is wrapped in `asyncHandler`, which forwards rejected promises to `next()` (and therefore to `errorHandler`). Route handlers throw `AppError` for all anticipated failures:

```typescript
throw new AppError(statusCode, 'ERROR_CODE', 'Human-readable message', optionalDetails);
```

| Scenario | Code | Status |
|----------|------|--------|
| Missing / invalid request fields | `VALIDATION_ERROR` | 400 |
| Provider not found | `PROVIDER_NOT_FOUND` | 404 |
| Patient not found | `PATIENT_NOT_FOUND` | 404 |
| Claim not found | `CLAIM_NOT_FOUND` | 404 |
| Insurance plan not found | `PLAN_NOT_FOUND` | 404 |
| Claim not in PATIENT_BILLED state | `INVALID_CLAIM_STATE` | 409 |
| Rules engine threw unexpectedly | `RULES_ENGINE_ERROR` | 500 |
| Adjudication calculation failed | `ADJUDICATION_ERROR` | 500 |
| Supabase claim write failed | `CLAIM_WRITE_FAILED` | 500 |
| Supabase payment write failed | `PAYMENT_WRITE_FAILED` | 500 |
| Claim status update failed post-payment | `CLAIM_UPDATE_FAILED` | 500 |

**Non-fatal failures** (degraded gracefully, response still succeeds):
- Risk score computation failure → score defaults to `0`, warning logged
- Audit log write failure → warning logged, claim/payment already persisted

---

## Testing

```bash
npm test
```

| Test file | Coverage |
|-----------|----------|
| `rules.test.ts` | All 5 rule classes: pass/fail/adjust for each condition |
| `anomaly.test.ts` | All 4 risk signals: edge cases, zero-data, high-risk scenarios |
| `stateMachine.test.ts` | Valid and invalid state transitions for the claim lifecycle |

Tests use `jest` with `ts-jest` for TypeScript support. No emulator or database connection is required — all tests are pure unit tests against in-memory data.

---

## Deployment

```bash
# From this directory
npm run deploy

# Or from the root
firebase deploy --only functions
```

Firebase automatically runs `lint` and `build` as predeploy hooks (configured in `firebase.json`). A TypeScript error or lint failure aborts deployment.

---

## Configuration Notes

- **Max instances:** 10 — set globally in `index.ts` via `setGlobalOptions`. Adjust for higher throughput if needed.
- **Supabase client:** uses the service-role key, which bypasses Row-Level Security. All data access is server-side only — never expose the service-role key to clients.
- **Environment variables:** `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` must be present at runtime. For production Firebase Functions, set them via `firebase functions:secrets:set` or as environment variables in the Firebase console.
- **CORS:** enabled globally for all origins via the `cors` middleware in `app.ts`. Restrict this for production if the API should not be publicly callable from browsers.
- **`tsconfig.json`:** targets ES2022, outputs to `lib/`, uses module resolution `node16`.
