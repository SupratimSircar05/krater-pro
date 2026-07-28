export const ASSURANCE_LEVELS = ["fast", "standard", "high"] as const;

export type AssuranceLevel = (typeof ASSURANCE_LEVELS)[number];

export interface OutcomeBudget {
  maxCostUsd: number;
  maxTokens: number;
  maxDurationMs: number;
  maxToolSteps: number;
}

export interface OutcomeTriggers {
  clarification: readonly string[];
  abstention: readonly string[];
  jury: readonly string[];
}

export interface OutcomeContract {
  id: string;
  request: string;
  assurance: AssuranceLevel;
  budget: Readonly<OutcomeBudget>;
  requiredChecks: readonly string[];
  negativeGuarantees: readonly string[];
  triggers: Readonly<OutcomeTriggers>;
  explicitModel?: string;
}

export interface OutcomeContractInput {
  request: string;
  assurance?: AssuranceLevel;
  budget?: Partial<OutcomeBudget>;
  requiredChecks?: readonly string[];
  negativeGuarantees?: readonly string[];
  triggers?: Partial<OutcomeTriggers>;
  explicitModel?: string;
}

export type ActionGateOutcome =
  | "change_required"
  | "partial_fix_requires_change"
  | "configuration_documentation_or_user_action"
  | "already_satisfied_no_change"
  | "cannot_establish_safely";

export interface ActionGateInput {
  discoveryComplete: boolean;
  safeToProceed: boolean;
  evidenceState: "sufficient" | "insufficient" | "conflicting";
  observedState:
    | "absent_or_broken"
    | "partially_satisfied"
    | "satisfied"
    | "unknown";
  resolution:
    | "code_change"
    | "configuration"
    | "documentation"
    | "user_action"
    | "none"
    | "unknown";
  evidenceRefs?: readonly string[];
}

export interface ActionGateDecision {
  outcome: ActionGateOutcome;
  shouldStageCode: boolean;
  reasons: readonly string[];
  evidenceRefs: readonly string[];
}

export interface AmbiguityCandidate {
  id?: string;
  question: string;
  interpretations: readonly string[];
  implementationFingerprints?: readonly string[];
  impact: number;
  risk: number;
  irreversibility: number;
  questionCost: number;
}

export interface RankedAmbiguity extends Omit<AmbiguityCandidate, "id"> {
  id: string;
  score: number;
  converges: boolean;
}

export type IntentKind =
  | "requirement"
  | "invariant"
  | "decision"
  | "assumption"
  | "non_goal"
  | "retirement";

export interface IntentRetirement {
  reason: string;
  retiredAt: string;
  replacementIntentId?: string;
  ownerDecisionId?: string;
}

export interface IntentNode {
  id: string;
  kind: IntentKind;
  statement: string;
  status: "active" | "retired";
  owner?: string;
  retirement?: IntentRetirement;
}

export type IntentTargetKind =
  | "intent"
  | "symbol"
  | "file"
  | "test"
  | "schema"
  | "evidence"
  | "patch"
  | "commit";

export type IntentRelation =
  | "fulfills"
  | "covers"
  | "constrains"
  | "depends_on"
  | "contradicts"
  | "retires";

export interface IntentLink {
  id?: string;
  fromIntentId: string;
  target: {
    kind: IntentTargetKind;
    id: string;
  };
  relation: IntentRelation;
  state?: "current" | "stale";
}

export interface IntentGraph {
  nodes: readonly IntentNode[];
  links: readonly IntentLink[];
}

export type IntentGraphIssueCode =
  | "duplicate_intent_id"
  | "duplicate_link_id"
  | "missing_source_intent"
  | "missing_target"
  | "missing_link"
  | "stale_link"
  | "contradiction"
  | "invalid_retirement";

export interface IntentGraphIssue {
  code: IntentGraphIssueCode;
  severity: "error" | "warning";
  message: string;
  intentId?: string;
  linkId?: string;
}

export interface IntentGraphValidation {
  valid: boolean;
  issues: readonly IntentGraphIssue[];
  fulfilledIntentIds: readonly string[];
  contradictedIntentIds: readonly string[];
  uncoveredIntentIds: readonly string[];
  staleIntentIds: readonly string[];
  retiredIntentIds: readonly string[];
}
