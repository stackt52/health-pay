import {
  ProviderLicenseRule,
  DuplicateClaimRule,
  PlanCoverageRule,
  AmountCeilingRule,
  DeductibleCheckRule,
  createDefaultRulesEngine,
} from "../engines/rules";
import type {
  SubmitClaimRequest,
  RuleContext,
  Provider,
  Patient,
  InsurancePlan,
  CptCode,
  Claim,
} from "../types";

// ─── Helpers ───────────────────────────────────────────────────────────────────

const FUTURE = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
const NOW = new Date().toISOString();

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "PROV_001",
    name: "Dr. Test",
    licenseStatus: "active",
    licenseExpiry: FUTURE,
    createdAt: NOW,
    ...overrides,
  };
}

function makePlan(overrides: Partial<InsurancePlan> = {}): InsurancePlan {
  return {
    id: "PLAN_GOLD_001",
    name: "Gold Plan",
    annualDeductible: 1500,
    deductibleMet: 800,
    copay: {officeVisit: 30, specialist: 50, emergency: 250},
    coinsuranceRate: 0.2,
    outOfPocketMax: 6000,
    coveredCptCodes: ["99213", "99214", "99283", "90837", "73721", "29881"],
    ...overrides,
  };
}

function makePatient(overrides: Partial<Patient> = {}): Patient {
  return {
    id: "PAT_001",
    name: "John Smith",
    planId: "PLAN_GOLD_001",
    createdAt: NOW,
    ...overrides,
  };
}

const DEFAULT_CPT_DATA: Record<string, CptCode> = {
  "99213": {
    code: "99213",
    description: "Office visit",
    avgBilledAmount: 150,
    category: "office_visit",
    incompatibleWith: ["99214"],
  },
  "99214": {
    code: "99214",
    description: "Detailed office visit",
    avgBilledAmount: 250,
    category: "office_visit",
    incompatibleWith: ["99213"],
  },
  "99999": {
    code: "99999",
    description: "Uncovered procedure",
    avgBilledAmount: 100,
    category: "procedure",
    incompatibleWith: [],
  },
};

function makeContext(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    provider: makeProvider(),
    patient: makePatient(),
    plan: makePlan(),
    cptCodeData: DEFAULT_CPT_DATA,
    existingClaims: [],
    ...overrides,
  };
}

function makeClaimRequest(
  overrides: Partial<SubmitClaimRequest> = {},
): SubmitClaimRequest {
  return {
    providerId: "PROV_001",
    patientId: "PAT_001",
    cptCodes: ["99213"],
    billedAmount: 150,
    ...overrides,
  };
}

// ─── ProviderLicenseRule ───────────────────────────────────────────────────────

describe("ProviderLicenseRule", () => {
  const rule = new ProviderLicenseRule();

  it("passes for a provider with an active, unexpired license", async () => {
    const result = await rule.evaluate(makeClaimRequest(), makeContext());
    expect(result.passed).toBe(true);
    expect(result.action).toBe("CONTINUE");
  });

  it("rejects a claim from a provider with status 'expired'", async () => {
    const context = makeContext({
      provider: makeProvider({licenseStatus: "expired"}),
    });
    const result = await rule.evaluate(makeClaimRequest(), context);
    expect(result.passed).toBe(false);
    expect(result.action).toBe("REJECT");
    expect(result.errorCode).toBe("INVALID_PROVIDER");
  });

  it("rejects a claim from a provider with status 'suspended'", async () => {
    const context = makeContext({
      provider: makeProvider({licenseStatus: "suspended"}),
    });
    const result = await rule.evaluate(makeClaimRequest(), context);
    expect(result.passed).toBe(false);
    expect(result.action).toBe("REJECT");
    expect(result.errorCode).toBe("INVALID_PROVIDER");
  });

  it("rejects when licenseExpiry date is in the past", async () => {
    const context = makeContext({
      provider: makeProvider({licenseStatus: "active", licenseExpiry: PAST}),
    });
    const result = await rule.evaluate(makeClaimRequest(), context);
    expect(result.passed).toBe(false);
    expect(result.action).toBe("REJECT");
    expect(result.errorCode).toBe("INVALID_PROVIDER");
  });
});

// ─── DuplicateClaimRule ────────────────────────────────────────────────────────

describe("DuplicateClaimRule", () => {
  const rule = new DuplicateClaimRule();

  it("passes when there are no existing claims", async () => {
    const result = await rule.evaluate(makeClaimRequest(), makeContext());
    expect(result.passed).toBe(true);
  });

  it("rejects when a matching claim was submitted within 24 hours", async () => {
    const recent: Claim = {
      id: "CLM_001",
      providerId: "PROV_001",
      patientId: "PAT_001",
      cptCodes: ["99213"],
      billedAmount: 150,
      status: "PATIENT_BILLED",
      submittedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2h ago
      correlationId: "test",
    };
    const context = makeContext({existingClaims: [recent]});
    const result = await rule.evaluate(makeClaimRequest(), context);

    expect(result.passed).toBe(false);
    expect(result.action).toBe("REJECT");
    expect(result.errorCode).toBe("DUPLICATE_CLAIM");
  });

  it("passes when a matching claim is older than 24 hours", async () => {
    const old: Claim = {
      id: "CLM_002",
      providerId: "PROV_001",
      patientId: "PAT_001",
      cptCodes: ["99213"],
      billedAmount: 150,
      status: "PATIENT_BILLED",
      submittedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), // 25h ago
      correlationId: "test",
    };
    const context = makeContext({existingClaims: [old]});
    const result = await rule.evaluate(makeClaimRequest(), context);

    expect(result.passed).toBe(true);
  });

  it("passes when same provider/patient but different CPT codes", async () => {
    const different: Claim = {
      id: "CLM_003",
      providerId: "PROV_001",
      patientId: "PAT_001",
      cptCodes: ["99214"], // different code
      billedAmount: 250,
      status: "PATIENT_BILLED",
      submittedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      correlationId: "test",
    };
    const context = makeContext({existingClaims: [different]});
    const result = await rule.evaluate(
      makeClaimRequest({cptCodes: ["99213"]}),
      context,
    );

    expect(result.passed).toBe(true);
  });
});

// ─── PlanCoverageRule ──────────────────────────────────────────────────────────

describe("PlanCoverageRule", () => {
  const rule = new PlanCoverageRule();

  it("passes when all CPT codes are covered by the plan", async () => {
    const result = await rule.evaluate(
      makeClaimRequest({cptCodes: ["99213", "99214"]}),
      makeContext(),
    );
    expect(result.passed).toBe(true);
  });

  it("denies a claim with an uncovered CPT code", async () => {
    const plan = makePlan({coveredCptCodes: ["99213"]});
    const context = makeContext({plan});
    const result = await rule.evaluate(
      makeClaimRequest({cptCodes: ["99213", "99999"]}),
      context,
    );

    expect(result.passed).toBe(false);
    expect(result.action).toBe("DENY");
    expect(result.errorCode).toBe("NOT_COVERED");
    expect(result.message).toContain("99999");
  });
});

// ─── AmountCeilingRule ─────────────────────────────────────────────────────────

describe("AmountCeilingRule", () => {
  const rule = new AmountCeilingRule(3);

  it("passes when billed amount is within 3× the CPT average", async () => {
    const result = await rule.evaluate(
      makeClaimRequest({cptCodes: ["99213"], billedAmount: 449}), // 2.99× $150 = $449
      makeContext(),
    );
    expect(result.passed).toBe(true);
  });

  it("flags when billed amount exceeds 3× the CPT average", async () => {
    const result = await rule.evaluate(
      makeClaimRequest({cptCodes: ["99213"], billedAmount: 451}), // 3.01× $150
      makeContext(),
    );
    expect(result.passed).toBe(false);
    expect(result.action).toBe("FLAG");
    expect(result.errorCode).toBe("AMOUNT_CEILING_EXCEEDED");
  });

  it("passes when no CPT data is available (unknown code)", async () => {
    const result = await rule.evaluate(
      makeClaimRequest({cptCodes: ["00000"], billedAmount: 9999}),
      makeContext({cptCodeData: {}}),
    );
    expect(result.passed).toBe(true);
  });
});

// ─── DeductibleCheckRule ───────────────────────────────────────────────────────

describe("DeductibleCheckRule", () => {
  const rule = new DeductibleCheckRule();

  it("returns CONTINUE when the deductible is fully met", async () => {
    const context = makeContext({
      plan: makePlan({annualDeductible: 1500, deductibleMet: 1500}),
    });
    const result = await rule.evaluate(makeClaimRequest(), context);

    expect(result.passed).toBe(true);
    expect(result.action).toBe("CONTINUE");
  });

  it("returns ADJUST with message when deductible is partially unmet", async () => {
    const context = makeContext({
      plan: makePlan({annualDeductible: 1500, deductibleMet: 800}),
    });
    const result = await rule.evaluate(makeClaimRequest(), context);

    expect(result.passed).toBe(true);
    expect(result.action).toBe("ADJUST");
    expect(result.message).toContain("$700.00 remaining");
  });
});

// ─── RulesEngine integration ───────────────────────────────────────────────────

describe("createDefaultRulesEngine", () => {
  it("denies a claim from an expired-license provider", async () => {
    const engine = createDefaultRulesEngine();
    const context = makeContext({
      provider: makeProvider({licenseStatus: "expired"}),
    });
    const result = await engine.evaluate(makeClaimRequest(), context);
    expect(result.finalAction).toBe("REJECT");
    expect(result.errorCode).toBe("INVALID_PROVIDER");
  });

  it("returns PATIENT_BILLED action for a valid claim", async () => {
    const engine = createDefaultRulesEngine();
    const result = await engine.evaluate(makeClaimRequest(), makeContext());
    expect(["CONTINUE", "ADJUST"]).toContain(result.finalAction);
  });
});
