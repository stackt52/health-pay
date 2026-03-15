// ─── Domain enums ──────────────────────────────────────────────────────────────

export type ClaimStatus =
  | "SUBMITTED"
  | "VALIDATED"
  | "ADJUDICATED"
  | "PATIENT_BILLED"
  | "PAID"
  | "DENIED"
  | "FLAGGED";

export type LicenseStatus = "active" | "expired" | "suspended";

export type CptCategory =
  | "office_visit"
  | "specialist"
  | "emergency"
  | "procedure"
  | "imaging"
  | "therapy";

// ─── Domain shapes ─────────────────────────────────────────────────────────────

export interface Provider {
  id: string;
  name: string;
  licenseStatus: LicenseStatus;
  licenseExpiry: string; // ISO 8601
  createdAt: string; // ISO 8601
}

export interface Patient {
  id: string;
  name: string;
  planId: string;
  createdAt: string; // ISO 8601
}

export interface Copay {
  officeVisit: number;
  specialist: number;
  emergency: number;
}

export interface InsurancePlan {
  id: string;
  name: string;
  annualDeductible: number;
  deductibleMet: number;
  copay: Copay;
  coinsuranceRate: number;
  outOfPocketMax: number;
  coveredCptCodes: string[];
}

export interface CptCode {
  code: string;
  description: string;
  avgBilledAmount: number;
  category: CptCategory;
  incompatibleWith: string[];
}

export interface Claim {
  id: string;
  providerId: string;
  patientId: string;
  cptCodes: string[];
  billedAmount: number;
  status: ClaimStatus;
  submittedAt: string; // ISO 8601
  validatedAt?: string;
  adjudicatedAt?: string;
  patientBilledAt?: string;
  paidAt?: string;
  denialReason?: string;
  flagReason?: string;
  insurerAmount?: number;
  patientResponsibility?: number;
  deductibleApplied?: number;
  copayApplied?: number;
  coinsuranceApplied?: number;
  amountPaid?: number;
  riskScore?: number;
  correlationId: string;
}

export interface Payment {
  id: string;
  claimId: string;
  patientId: string;
  amount: number;
  status: "pending" | "processed" | "refunded";
  idempotencyKey: string;
  processedAt: string; // ISO 8601
  correlationId: string;
}

// ─── API request shapes ────────────────────────────────────────────────────────

export interface SubmitClaimRequest {
  providerId: string;
  patientId: string;
  cptCodes: string[];
  billedAmount: number;
  idempotencyKey?: string;
}

export interface ProcessPaymentRequest {
  amount: number;
  idempotencyKey: string;
}

// ─── Rules engine ──────────────────────────────────────────────────────────────

export interface AdjudicationResult {
  insurerAmount: number;
  patientResponsibility: number;
  deductibleApplied: number;
  copayApplied: number;
  coinsuranceApplied: number;
}

export interface RuleContext {
  provider: Provider;
  patient: Patient;
  plan: InsurancePlan;
  cptCodeData: Record<string, CptCode>;
  existingClaims: Claim[];
}

export type RuleAction = "CONTINUE" | "REJECT" | "DENY" | "FLAG" | "ADJUST";

export interface RuleResult {
  ruleName: string;
  passed: boolean;
  action: RuleAction;
  errorCode?: string;
  message?: string;
  adjustments?: Partial<AdjudicationResult>;
}

export interface RulesEngineResult {
  ruleResults: RuleResult[];
  finalAction: RuleAction;
  adjustments: Partial<AdjudicationResult>;
  errorCode?: string;
  message?: string;
}

// ─── Anomaly detection ─────────────────────────────────────────────────────────

/** Simplified claim shape used by the anomaly engine */
export interface ClaimForAnalysis {
  id: string;
  providerId: string;
  patientId: string;
  cptCodes: string[];
  billedAmount: number;
  submittedAt: Date;
}

export interface CptStats {
  code: string;
  avgBilledAmount: number;
}

export interface RiskSignals {
  velocityScore: number;
  amountScore: number;
  clusteringScore: number;
  temporalScore: number;
}

export interface ProviderRiskScore {
  providerId: string;
  score: number;
  signals: RiskSignals;
  computedAt: string;
  claimsAnalyzed: number;
}

// ─── Application error ─────────────────────────────────────────────────────────

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}
