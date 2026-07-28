import { createStableRecordId } from "./stable-id.js";
import type {
  AssuranceLevel,
  OutcomeBudget,
  OutcomeContract,
  OutcomeContractInput,
  OutcomeTriggers,
} from "./types.js";

export const DEFAULT_OUTCOME_BUDGETS: Readonly<
  Record<AssuranceLevel, Readonly<OutcomeBudget>>
> = {
  fast: {
    maxCostUsd: 0.25,
    maxTokens: 40_000,
    maxDurationMs: 5 * 60_000,
    maxToolSteps: 12,
  },
  standard: {
    maxCostUsd: 2,
    maxTokens: 200_000,
    maxDurationMs: 30 * 60_000,
    maxToolSteps: 50,
  },
  high: {
    maxCostUsd: 10,
    maxTokens: 1_000_000,
    maxDurationMs: 2 * 60 * 60_000,
    maxToolSteps: 200,
  },
};

const ASSURANCE_CHECKS: Readonly<Record<AssuranceLevel, readonly string[]>> = {
  fast: ["workspace_digest", "targeted_check"],
  standard: [
    "workspace_digest",
    "targeted_check",
    "typecheck",
    "tests",
    "secret_scan",
    "conflict_check",
  ],
  high: [
    "workspace_digest",
    "targeted_check",
    "typecheck",
    "tests",
    "secret_scan",
    "conflict_check",
    "independent_verifier",
    "mutation_or_property_check",
    "security_check",
    "rollback_check",
  ],
};

const DEFAULT_NEGATIVE_GUARANTEES = [
  "do_not_expose_secrets",
  "do_not_overwrite_concurrent_edits",
  "do_not_claim_unverified_success",
] as const;

const DEFAULT_TRIGGERS: OutcomeTriggers = {
  clarification: [
    "material interpretations require different implementations",
    "a missing decision would make rework likely",
  ],
  abstention: [
    "the requested change is already satisfied",
    "safe necessity cannot be established",
  ],
  jury: [
    "verification contradicts the primary patch",
    "high-risk viable designs have materially different outcomes",
  ],
};

function uniqueNonEmpty(values: readonly string[], label: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) throw new Error(`${label} must not contain an empty value.`);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  if (!result.length) throw new Error(`${label} must contain at least one value.`);
  return result;
}

function positiveFinite(value: number, label: string, integer = false): number {
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`${label} must be a positive${integer ? " integer" : ""}.`);
  }
  return value;
}

function normalizedBudget(
  assurance: AssuranceLevel,
  override: Partial<OutcomeBudget> | undefined,
): OutcomeBudget {
  const budget = { ...DEFAULT_OUTCOME_BUDGETS[assurance], ...override };
  return {
    maxCostUsd: positiveFinite(budget.maxCostUsd, "Maximum cost"),
    maxTokens: positiveFinite(budget.maxTokens, "Maximum tokens", true),
    maxDurationMs: positiveFinite(budget.maxDurationMs, "Maximum duration", true),
    maxToolSteps: positiveFinite(budget.maxToolSteps, "Maximum tool steps", true),
  };
}

function normalizedTriggers(override: Partial<OutcomeTriggers> | undefined): OutcomeTriggers {
  return {
    clarification: uniqueNonEmpty(
      override?.clarification ?? DEFAULT_TRIGGERS.clarification,
      "Clarification triggers",
    ),
    abstention: uniqueNonEmpty(
      override?.abstention ?? DEFAULT_TRIGGERS.abstention,
      "Abstention triggers",
    ),
    jury: uniqueNonEmpty(
      override?.jury ?? DEFAULT_TRIGGERS.jury,
      "Jury triggers",
    ),
  };
}

export function buildOutcomeContract(input: OutcomeContractInput): OutcomeContract {
  const request = input.request.trim();
  if (!request) throw new Error("Outcome contract request must not be empty.");
  const assurance = input.assurance ?? "standard";
  if (!(assurance in DEFAULT_OUTCOME_BUDGETS)) {
    throw new Error(`Unsupported assurance level: ${String(assurance)}.`);
  }
  const budget = normalizedBudget(assurance, input.budget);
  const requiredChecks = uniqueNonEmpty(
    input.requiredChecks ?? ASSURANCE_CHECKS[assurance],
    "Required checks",
  );
  const negativeGuarantees = uniqueNonEmpty(
    input.negativeGuarantees ?? DEFAULT_NEGATIVE_GUARANTEES,
    "Negative guarantees",
  );
  const triggers = normalizedTriggers(input.triggers);
  const explicitModel = input.explicitModel?.trim() || undefined;
  const id = createStableRecordId("contract", [
    request,
    assurance,
    JSON.stringify(budget),
    JSON.stringify(requiredChecks),
    JSON.stringify(negativeGuarantees),
    JSON.stringify(triggers),
    explicitModel ?? "",
  ]);

  return {
    id,
    request,
    assurance,
    budget: Object.freeze(budget),
    requiredChecks: Object.freeze(requiredChecks),
    negativeGuarantees: Object.freeze(negativeGuarantees),
    triggers: Object.freeze({
      clarification: Object.freeze([...triggers.clarification]),
      abstention: Object.freeze([...triggers.abstention]),
      jury: Object.freeze([...triggers.jury]),
    }),
    ...(explicitModel ? { explicitModel } : {}),
  };
}
