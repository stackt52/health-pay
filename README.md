# HealthPay — Claims Processing Engine

A full-stack medical insurance claims processing platform built on Firebase. The backend exposes a REST API that validates claims against business rules, calculates patient vs. insurer responsibility, detects anomalous billing patterns, and processes patient payments. The frontend serves an interactive API reference (Swagger UI) hosted via Firebase Hosting.

---

## Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Frontend | Next.js (App Router) | 16.x |
| UI | React | 19.x |
| Styling | Tailwind CSS | 4.x |
| Language | TypeScript | 5.x |
| Backend | Firebase Cloud Functions + Express.js | Functions 7.x |
| Runtime | Node.js | 24 |
| Database | Cloud Firestore | `nam5` region |
| Hosting | Firebase Hosting | — |
| API Docs | Swagger UI | 5.18.2 |

**Firebase project:** `health-pay-api`

---

## Project Structure

```
health-pay/
├── src/                        # Next.js frontend (App Router)
│   └── app/
│       ├── page.tsx            # Root page
│       ├── layout.tsx          # Root layout
│       └── globals.css         # Global styles
│
├── public/                     # Static assets served by Firebase Hosting
│   └── index.html              # Interactive API docs (Swagger UI + OpenAPI 3.0 spec)
│
├── functions/                  # Firebase Cloud Functions (backend API)
│   └── src/
│       ├── index.ts            # Cloud Function entrypoint
│       ├── app.ts              # Express app + route mounting
│       ├── db.ts               # Firestore client initialisation
│       ├── middleware.ts        # Correlation ID, request logger, error handler
│       ├── types.ts            # All domain types and AppError
│       ├── routes/
│       │   ├── claims.ts       # POST/GET /api/claims, payments
│       │   ├── providers.ts    # CRUD /api/providers + dashboard + risk-score
│       │   ├── patients.ts     # CRUD /api/patients
│       │   ├── insurancePlans.ts # CRUD /api/insurance-plans
│       │   └── seed.ts         # POST /api/seed (reference data)
│       └── engines/
│           ├── rules.ts        # Chain-of-Responsibility rules engine
│           ├── adjudication.ts # Copay / deductible / coinsurance waterfall
│           ├── anomaly.ts      # Four-signal provider risk scoring (0–100)
│           └── stateMachine.ts # Claim lifecycle state machine
│
├── firestore.rules             # Firestore security rules
├── firestore.indexes.json      # Composite index definitions
├── firebase.json               # Hosting, Functions, and Firestore config
└── CLAUDE.md                   # AI assistant project context
```

---

## Firestore Collections

| Collection | Description |
|-----------|-------------|
| `providers` | Healthcare providers with license status |
| `patients` | Patients linked to an insurance plan |
| `insurance_plans` | Plan deductibles, copays, coinsurance, covered CPT codes |
| `cpt_codes` | Procedure code metadata (avg amounts, incompatibility rules) |
| `claims` | Core claim documents with full adjudication breakdown |
| `payments` | Patient payments recorded against claims |
| `audit_log` | Immutable event log for claims and payments |

All Firestore access goes through the Firebase Admin SDK in Cloud Functions, which bypasses client-side security rules. Direct client access is denied.

---

## API Overview

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/claims` | Submit and adjudicate a claim |
| `GET` | `/api/claims` | List claims (filterable, cursor-paginated) |
| `GET` | `/api/claims/:id` | Get claim by ID |
| `POST` | `/api/claims/:id/payments` | Record a patient payment |
| `GET` | `/api/claims/:id/payments` | List payments for a claim |
| `POST/GET` | `/api/providers` | Create / list providers |
| `GET/PUT/DELETE` | `/api/providers/:id` | Get / update / delete provider |
| `GET` | `/api/providers/:id/dashboard` | Provider statistics |
| `POST` | `/api/providers/:id/risk-score` | Compute anomaly risk score |
| `POST/GET` | `/api/patients` | Create / list patients |
| `GET/PUT/DELETE` | `/api/patients/:id` | Get / update / delete patient |
| `POST/GET` | `/api/insurance-plans` | Create / list insurance plans |
| `GET/PUT/DELETE` | `/api/insurance-plans/:id` | Get / update / delete plan |
| `POST` | `/api/seed` | Populate Firestore with reference data and sample claims |
| `GET` | `/api/health` | Liveness check |

Full interactive documentation is available at the hosted URL (see `public/index.html`).

---

## Prerequisites

- **Node.js** v24+ — [nodejs.org](https://nodejs.org)
- **Firebase CLI** — `npm install -g firebase-tools`
- **Firebase account** with access to the `health-pay-api` project

Verify your setup:
```bash
node --version       # should print v24.x.x
firebase --version   # should print 13.x or later
firebase login       # authenticate with Google
firebase use health-pay-api   # select the project
```

---

## Local Development Setup

### 1. Clone and install

```bash
git clone <repository-url>
cd health-pay

# Frontend dependencies
npm install

# Backend dependencies
cd functions && npm install && cd ..
```

### 2. Run the frontend

```bash
npm run dev
# → http://localhost:3000
```

### 3. Run the backend (Firebase Emulator)

```bash
cd functions
npm run serve
# → Functions API: http://localhost:5001/health-pay-api/us-central1/api
```

> The emulator does **not** hit production Firestore. It uses an in-memory emulator database. Run `POST /api/seed` after starting to populate it with reference data.

### 4. Seed reference data

```bash
curl -X POST http://localhost:5001/health-pay-api/us-central1/api/api/seed
```

This creates CPT codes, insurance plans, 3 providers, 3 patients, and ~200 sample claims. The operation is idempotent — safe to run multiple times.

---

## Development Workflow

```bash
# Frontend
npm run dev          # Start Next.js dev server with hot reload
npm run build        # Production build
npm run lint         # ESLint

# Functions (from functions/)
npm run build        # Compile TypeScript → lib/
npm run build:watch  # Watch mode
npm run lint         # ESLint
npm test             # Jest unit tests
npm run serve        # Build + start Firebase emulator
npm run logs         # Tail live Cloud Function logs
```

### Pre-deploy checks

`firebase.json` runs `lint` and `build` automatically before every `firebase deploy --only functions`. A lint or type error will abort the deployment.

---

## Testing

```bash
cd functions
npm test
```

Tests live in `functions/src/__tests__/`:

| File | What it covers |
|------|---------------|
| `rules.test.ts` | All five rules engine cases (license, duplicate, coverage, ceiling, deductible) |
| `anomaly.test.ts` | All four risk signals (velocity, amount, clustering, temporal) |
| `stateMachine.test.ts` | Claim lifecycle state transitions |

---

## Deployment

Deploy everything in one command:

```bash
firebase deploy
```

Targeted deployments:

```bash
firebase deploy --only hosting    # Static frontend + API docs only
firebase deploy --only functions  # Cloud Functions only (runs lint + build first)
firebase deploy --only firestore  # Security rules and indexes only
```

> Deployment requires the Firebase CLI to be authenticated and the `health-pay-api` project selected (`firebase use health-pay-api`).

---

## Claim Lifecycle

```
SUBMITTED → VALIDATED → ADJUDICATED → PATIENT_BILLED → PAID
                    ↘ FLAGGED  (amount > 3× CPT average — manual review)
              ↘ DENIED   (license expired, duplicate, plan exclusion)
```

---

## Environment Notes

- **Firestore region:** `nam5` (US multi-region)
- **Cloud Functions region:** `us-central1`
- **Max instances:** 10 (cost control, set globally in `functions/src/index.ts`)
- **Firestore rules:** All direct client access is denied; only the Admin SDK (server-side) can read/write
