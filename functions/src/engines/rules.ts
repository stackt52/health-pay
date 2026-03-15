import type {
  SubmitClaimRequest,
  RuleContext,
  RuleResult,
  RulesEngineResult,
  AdjudicationResult,
} from "../types.js";
import { type RuleAction } from "../types.js";

/**
 * Rules Engine — Chain of Responsibility + Strategy Pattern
 *
 * Design rationale:
 *   Each business rule is a self-contained strategy object implementing ClaimRule.
 *   Rules are composed into a pipeline by the RulesEngine, which invokes them in
 *   registration order. Hard-failure actions (REJECT / DENY) short-circuit the chain;
 *   soft actions (FLAG / ADJUST) annotate the result and allow remaining rules to run.
 *
 *   Adding a new rule never requires modifying existing code — simply implement
 *   ClaimRule and register it via createDefaultRulesEngine() or a custom RulesEngine.
 */

// ─── Rule contract ─────────────────────────────────────────────────────────────

export interface ClaimRule {
  readonly name: string;
  evaluate(
    claim: SubmitClaimRequest,
    context: RuleContext,
  ): Promise<RuleResult>;
}

// ─── Concrete rules ────────────────────────────────────────────────────────────

/**
 * Rule: ProviderLicenseRule
 * Rejects claims from providers whose license is expired or suspended.
 * Action: REJECT → claim status DENIED
 */
export class ProviderLicenseRule implements ClaimRule {
  readonly name = "ProviderLicenseRule";

  async evaluate(
    _claim: SubmitClaimRequest,
    context: RuleContext,
  ): Promise<RuleResult> {
    const { provider } = context;

    if (
      provider.licenseStatus === "expired" ||
      provider.licenseStatus === "suspended"
    ) {
      return {
        ruleName: this.name,
        passed: false,
        action: "REJECT",
        errorCode: "INVALID_PROVIDER",
        message: `Provider license is ${provider.licenseStatus}`,
      };
    }

    if (provider.licenseExpiry.toDate() < new Date()) {
      return {
        ruleName: this.name,
        passed: false,
        action: "REJECT",
        errorCode: "INVALID_PROVIDER",
        message: "Provider license has expired",
      };
    }

    return { ruleName: this.name, passed: true, action: "CONTINUE" };
  }
}

/**
 * Rule: DuplicateClaimRule
 * Rejects a claim if the same provider, patient, and overlapping CPT code(s)
 * appear in an existing claim within the last 24 hours.
 * Action: REJECT → claim status DENIED
 */
export class DuplicateClaimRule implements ClaimRule {
  readonly name = "DuplicateClaimRule";

  async evaluate(
    claim: SubmitClaimRequest,
    context: RuleContext,
  ): Promise<RuleResult> {
    const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const incomingCodes = new Set(claim.cptCodes);

    const duplicate = context.existingClaims.find((existing) => {
      if (existing.submittedAt.toDate() < windowStart) return false;
      if (existing.providerId !== claim.providerId) return false;
      if (existing.patientId !== claim.patientId) return false;
      return existing.cptCodes.some((code) => incomingCodes.has(code));
    });

    if (duplicate) {
      return {
        ruleName: this.name,
        passed: false,
        action: "REJECT",
        errorCode: "DUPLICATE_CLAIM",
        message: `Duplicate: same provider, patient, and CPT code(s) submitted within 24 hours (existing claim: ${duplicate.id})`,
      };
    }

    return { ruleName: this.name, passed: true, action: "CONTINUE" };
  }
}

/**
 * Rule: PlanCoverageRule
 * Denies the claim if any CPT code is not covered by the patient's insurance plan.
 * Action: DENY → claim status DENIED
 */
export class PlanCoverageRule implements ClaimRule {
  readonly name = "PlanCoverageRule";

  async evaluate(
    claim: SubmitClaimRequest,
    context: RuleContext,
  ): Promise<RuleResult> {
    const covered = new Set(context.plan.coveredCptCodes);
    const uncovered = claim.cptCodes.filter((code) => !covered.has(code));

    if (uncovered.length > 0) {
      return {
        ruleName: this.name,
        passed: false,
        action: "DENY",
        errorCode: "NOT_COVERED",
        message: `CPT code(s) not covered by plan ${context.plan.id}: ${uncovered.join(", ")}`,
      };
    }

    return { ruleName: this.name, passed: true, action: "CONTINUE" };
  }
}

/**
 * Rule: AmountCeilingRule
 * Flags a claim for manual review if the billed amount exceeds the configurable
 * multiplier × the average for any included CPT code. Defaults to 3×.
 * Action: FLAG → claim status FLAGGED
 */
export class AmountCeilingRule implements ClaimRule {
  readonly name = "AmountCeilingRule";

  constructor(private readonly ceilingMultiplier = 3) {}

  async evaluate(
    claim: SubmitClaimRequest,
    context: RuleContext,
  ): Promise<RuleResult> {
    for (const code of claim.cptCodes) {
      const cpt = context.cptCodeData[code];
      if (!cpt) continue;

      const ceiling = cpt.avgBilledAmount * this.ceilingMultiplier;
      if (claim.billedAmount > ceiling) {
        return {
          ruleName: this.name,
          passed: false,
          action: "FLAG",
          errorCode: "AMOUNT_CEILING_EXCEEDED",
          message: `Billed amount $${claim.billedAmount} exceeds ${this.ceilingMultiplier}× the $${cpt.avgBilledAmount} average for CPT ${code}`,
        };
      }
    }

    return { ruleName: this.name, passed: true, action: "CONTINUE" };
  }
}

/**
 * Rule: DeductibleCheckRule
 * Signals the adjudication engine to account for unmet annual deductible when
 * calculating patient responsibility. Does not block processing.
 * Action: ADJUST (non-blocking) or CONTINUE when deductible is fully met
 */
export class DeductibleCheckRule implements ClaimRule {
  readonly name = "DeductibleCheckRule";

  async evaluate(
    _claim: SubmitClaimRequest,
    context: RuleContext,
  ): Promise<RuleResult> {
    const remaining = context.plan.annualDeductible - context.plan.deductibleMet;

    if (remaining <= 0) {
      return { ruleName: this.name, passed: true, action: "CONTINUE" };
    }

    return {
      ruleName: this.name,
      passed: true,
      action: "ADJUST",
      message: `Patient has $${remaining.toFixed(2)} remaining on their $${context.plan.annualDeductible} annual deductible`,
    };
  }
}

// ─── Rules engine (chain of responsibility) ────────────────────────────────────

export class RulesEngine {
  constructor(private readonly rules: ClaimRule[]) {}

  async evaluate(
    claim: SubmitClaimRequest,
    context: RuleContext,
  ): Promise<RulesEngineResult> {
    const ruleResults: RuleResult[] = [];
    let finalAction: RuleAction = "CONTINUE";
    const adjustments: Partial<AdjudicationResult> = {};
    let errorCode: string | undefined;
    let message: string | undefined;

    for (const rule of this.rules) {
      const result = await rule.evaluate(claim, context);
      ruleResults.push(result);

      if (result.action === "REJECT" || result.action === "DENY") {
        // Hard failure — stop the chain immediately
        finalAction = result.action;
        errorCode = result.errorCode;
        message = result.message;
        break;
      }

      if (result.action === "FLAG") {
        // Soft failure — record the flag but continue evaluating remaining rules
        // (REJECT/DENY would have broken out of the loop already)
        finalAction = "FLAG";
        errorCode = result.errorCode;
        message = result.message;
      }

      if (result.action === "ADJUST" && result.adjustments) {
        Object.assign(adjustments, result.adjustments);
      }
    }

    return { ruleResults, finalAction, adjustments, errorCode, message };
  }
}

export function createDefaultRulesEngine(): RulesEngine {
  return new RulesEngine([
    new ProviderLicenseRule(),
    new DuplicateClaimRule(),
    new PlanCoverageRule(),
    new AmountCeilingRule(),
    new DeductibleCheckRule(),
  ]);
}
