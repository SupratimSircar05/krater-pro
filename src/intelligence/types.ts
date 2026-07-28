export const INTELLIGENCE_EVIDENCE_GRADES = [
  "not_established",
  "observed",
  "tested",
  "stress_tested",
  "formally_verified",
] as const;

export type IntelligenceEvidenceGrade =
  (typeof INTELLIGENCE_EVIDENCE_GRADES)[number];

export type IntelligenceAssurance = "fast" | "standard" | "high";

export type JuryTrigger =
  | "high_risk"
  | "high_ambiguity"
  | "verification_contradiction"
  | "material_design_divergence"
  | "poor_router_calibration";

export interface JuryTriggerContext {
  risk: number;
  ambiguity: number;
  verificationContradiction?: boolean;
  materiallyDifferentDesigns?: boolean;
  routerConfidence?: number;
  routerCalibrationError?: number;
  routerCalibrationSamples?: number;
}

export interface JuryPolicy {
  riskThreshold: number;
  ambiguityThreshold: number;
  routerConfidenceFloor: number;
  routerCalibrationErrorThreshold: number;
  minimumCalibrationSamples: number;
  minimumCandidates: number;
  maximumCandidates: number;
  maximumCostMultiplier: number;
  maximumAbsoluteCostUsd?: number;
  evidenceFloor: Readonly<Record<IntelligenceAssurance, IntelligenceEvidenceGrade>>;
}

export interface JuryTriggerAssessment {
  shouldConvene: boolean;
  triggers: readonly JuryTrigger[];
  reasons: readonly string[];
}

export interface JuryCandidatePlan {
  id: string;
  modelId: string;
  promptDigest: string;
  estimatedCostUsd: number;
}

export type JuryPlanStatus =
  | "not_triggered"
  | "planned"
  | "blocked_budget"
  | "insufficient_independence";

export interface JuryPlan {
  status: JuryPlanStatus;
  triggers: readonly JuryTrigger[];
  candidateIds: readonly string[];
  estimatedCostUsd: number;
  costLimitUsd: number;
  reasons: readonly string[];
}

export interface JuryCheck {
  id: string;
  passed: boolean;
  required?: boolean;
  evidenceRefs?: readonly string[];
}

export interface JuryCandidate {
  id: string;
  modelId: string;
  promptDigest: string;
  patchDigest: string;
  evidenceGrade: IntelligenceEvidenceGrade;
  verificationVerdict: "passed" | "failed" | "inconclusive";
  checks: readonly JuryCheck[];
  evidenceRefs: readonly string[];
  contradictionRefs?: readonly string[];
  securityFailures?: number;
  actualCostUsd: number;
  voteCount?: number;
}

export interface JuryDissent {
  candidateId: string;
  evidenceGrade: IntelligenceEvidenceGrade;
  reasons: readonly string[];
  evidenceRefs: readonly string[];
}

export type JuryDecisionStatus =
  | "not_triggered"
  | "selected"
  | "abstained"
  | "blocked_budget"
  | "insufficient_independence";

export interface JuryDecision {
  status: JuryDecisionStatus;
  triggers: readonly JuryTrigger[];
  selectedCandidateId?: string;
  evidenceFloor: IntelligenceEvidenceGrade;
  totalCostUsd: number;
  costLimitUsd: number;
  reasons: readonly string[];
  dissent: readonly JuryDissent[];
  ignoredVoteCounts: Readonly<Record<string, number>>;
}

export interface JuryDecisionInput {
  trigger: JuryTriggerAssessment;
  assurance: IntelligenceAssurance;
  primaryAgentCostUsd: number;
  candidates: readonly JuryCandidate[];
  policy?: PartialJuryPolicy;
}

export type PartialJuryPolicy = Partial<
  Omit<JuryPolicy, "evidenceFloor">
> & {
  evidenceFloor?: Partial<
    Record<IntelligenceAssurance, IntelligenceEvidenceGrade>
  >;
};

export type IntentTouchEffect =
  | "fulfills"
  | "modifies"
  | "contradicts"
  | "retires";

export interface IntentTouch {
  id: string;
  effect: IntentTouchEffect;
  fingerprint?: string;
}

export type SymbolTouchOperation =
  | "read"
  | "write"
  | "delete"
  | "signature_change";

export interface SymbolTouch {
  id: string;
  operation: SymbolTouchOperation;
  contractDigest?: string;
}

export type SchemaTouchOperation = "read" | "add" | "alter" | "drop";

export interface SchemaTouch {
  id: string;
  operation: SchemaTouchOperation;
  shapeDigest?: string;
}

export interface MigrationTouch {
  id: string;
  resource: string;
  order: number;
  fromVersion?: string;
  toVersion?: string;
  effectDigest?: string;
  dependsOn?: readonly string[];
}

export type InvariantTouchEffect =
  | "preserves"
  | "strengthens"
  | "weakens"
  | "violates";

export interface InvariantTouch {
  id: string;
  effect: InvariantTouchEffect;
  fingerprint?: string;
}

export interface SemanticPatch {
  id: string;
  dependencies?: readonly string[];
  intents?: readonly IntentTouch[];
  symbols?: readonly SymbolTouch[];
  schemas?: readonly SchemaTouch[];
  migrations?: readonly MigrationTouch[];
  invariants?: readonly InvariantTouch[];
}

export type SemanticConflictCategory =
  | "duplicate_patch"
  | "missing_dependency"
  | "dependency_cycle"
  | "intent"
  | "symbol"
  | "schema"
  | "migration"
  | "invariant";

export interface SemanticConflict {
  id: string;
  category: SemanticConflictCategory;
  severity: "blocking" | "warning";
  patchIds: readonly string[];
  target: string;
  reason: string;
  recommendation:
    | "serialize"
    | "reorder"
    | "add_dependency"
    | "human_decision";
}

export interface SemanticMergeForecast {
  safeToCombine: boolean;
  orderedPatchIds: readonly string[];
  conflicts: readonly SemanticConflict[];
  blockingConflictCount: number;
  warningCount: number;
  riskScore: number;
}

export type ReliabilityEvaluationRole =
  | "rule_generation"
  | "private_holdout";

export type AbstentionResult = "correct" | "incorrect" | "not_applicable";

export interface ReliabilityCaseResult {
  caseId: string;
  taskClass: string;
  resolved: boolean;
  securityFailures: number;
  abstention: AbstentionResult;
  costUsd?: number;
  latencyMs?: number;
}

export interface ReliabilityEvaluation {
  evaluationId: string;
  suiteId: string;
  datasetDigest: string;
  role: ReliabilityEvaluationRole;
  configurationDigest: string;
  sealed: boolean;
  cases: readonly ReliabilityCaseResult[];
}

export type ReliabilityCandidateKind =
  | "router"
  | "skill"
  | "prompt"
  | "policy";

export interface ReliabilityPromotionInput {
  candidateId: string;
  candidateKind: ReliabilityCandidateKind;
  ruleGeneration: ReliabilityEvaluation;
  baselineHoldout: ReliabilityEvaluation;
  candidateHoldout: ReliabilityEvaluation;
  minimumImprovementPoints?: number;
}

export interface ReliabilityMetrics {
  caseCount: number;
  resolvedCount: number;
  resolutionRate: number;
  securityFailures: number;
  abstentionErrors: number;
  averageCostUsd?: number;
  averageLatencyMs?: number;
  byTaskClass: Readonly<
    Record<
      string,
      {
        caseCount: number;
        resolvedCount: number;
        resolutionRate: number;
      }
    >
  >;
}

export type ReliabilityPromotionReasonCode =
  | "invalid_evaluation"
  | "holdout_not_private_or_sealed"
  | "holdout_mismatch"
  | "holdout_contamination"
  | "insufficient_improvement"
  | "security_regression"
  | "abstention_regression";

export interface ReliabilityPromotionReason {
  code: ReliabilityPromotionReasonCode;
  message: string;
  caseIds?: readonly string[];
}

export interface ReliabilityPromotionDecision {
  promote: boolean;
  candidateId: string;
  candidateKind: ReliabilityCandidateKind;
  minimumImprovementPoints: number;
  improvementPoints: number;
  baseline: ReliabilityMetrics;
  candidate: ReliabilityMetrics;
  reasons: readonly ReliabilityPromotionReason[];
}
