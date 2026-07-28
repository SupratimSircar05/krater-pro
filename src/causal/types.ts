export type CausalRuntime = "node" | "python";

/**
 * A process invocation is structured deliberately: the Causal Twin never
 * accepts a shell command string. The host-owned ProcessRunner is responsible
 * for resolving the runtime and enforcing process containment.
 */
export interface ProcessInvocation {
  runtime: CausalRuntime;
  entrypoint: string;
  args?: readonly string[];
  cwd?: string;
  environment?: Readonly<Record<string, string>>;
  timeoutMs?: number;
}

export interface ProcessRunnerRequest {
  runtime: CausalRuntime;
  entrypoint: string;
  args: readonly string[];
  cwd?: string;
  environment: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxOutputBytesPerStream: number;
}

export interface ProcessRunContext {
  planId: string;
  sequence: number;
  purpose: "baseline" | "intervention";
  experimentId?: string;
  signal?: AbortSignal;
}

export interface ProcessExecution {
  exitCode: number | null;
  signal?: string | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  durationMs?: number;
}

/**
 * ProcessRunner is the only execution authority used by this package. A
 * production implementation must enforce the request's timeout/output limits
 * and platform sandbox policy. The core independently truncates returned text
 * before it is persisted in a report.
 */
export interface ProcessRunner {
  run(
    request: ProcessRunnerRequest,
    context: ProcessRunContext,
  ): Promise<ProcessExecution>;
}

export interface CapturedText {
  text: string;
  receivedBytes: number;
  capturedBytes: number;
  truncated: boolean;
}

export interface SanitizedInvocation {
  runtime: CausalRuntime;
  entrypoint: string;
  args: readonly string[];
  cwd?: string;
  environmentKeys: readonly string[];
  timeoutMs: number;
}

export type CausalOutcomeKind =
  | "success"
  | "failure"
  | "timeout"
  | "terminated"
  | "unknown";

/**
 * `key` is the stable, semantic value used for replay and intervention
 * comparisons. Evaluators should exclude timestamps, durations, and random
 * identifiers from it.
 */
export interface CausalOutcome {
  key: string;
  kind: CausalOutcomeKind;
  summary: string;
}

export interface ProcessObservation {
  id: string;
  sequence: number;
  role: "baseline" | "intervention";
  experimentId?: string;
  invocation: SanitizedInvocation;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs?: number;
  stdout: CapturedText;
  stderr: CapturedText;
  outcome: CausalOutcome;
  /**
   * Hashes only the redacted, bounded observation and excludes duration.
   */
  digest: `sha256:${string}`;
}

export type OutcomeEvaluator = (
  observation: Omit<ProcessObservation, "id" | "outcome" | "digest">,
) => CausalOutcome;

export interface OutcomeExpectation {
  /**
   * Any one of these exact semantic outcome keys satisfies the expectation.
   */
  keys: readonly string[];
  description?: string;
}

export interface CausalHypothesis {
  id: string;
  statement: string;
  baselineExpectation: OutcomeExpectation;
}

export type InterventionKind =
  | "argument"
  | "environment"
  | "configuration"
  | "fixture"
  | "caller_defined";

export interface CausalIntervention {
  kind: InterventionKind;
  description: string;
  /**
   * Names only, never secret values. For example: ["FEATURE_MODE"].
   */
  changedInputs: readonly string[];
  /**
   * Caller attestation that the declared inputs are the only intentional
   * difference from the baseline snapshot.
   */
  isolated: boolean;
}

export interface HypothesisPrediction {
  hypothesisId: string;
  expected: OutcomeExpectation;
}

export interface CausalExperiment {
  id: string;
  title: string;
  intervention: CausalIntervention;
  invocation: ProcessInvocation;
  /**
   * Caller-supplied relative cost units. Values are compared only within this
   * plan, so no currency or wall-clock claim is implied.
   */
  estimatedCost: number;
  predictions: readonly HypothesisPrediction[];
}

export interface CausalPrivacyOptions {
  /**
   * Exact sensitive values to redact. They are used transiently and are never
   * copied into the returned report.
   */
  secrets?: readonly string[];
  redactPii?: boolean;
}

export interface CausalRunLimits {
  baselineReplays?: number;
  maxExperiments?: number;
  maxOutputBytesPerStream?: number;
  defaultTimeoutMs?: number;
}

export interface CausalTwinPlan {
  id: string;
  /**
   * Digest of the caller-prepared immutable workspace snapshot.
   */
  snapshotDigest: `sha256:${string}`;
  baseline: ProcessInvocation;
  hypotheses: readonly CausalHypothesis[];
  experiments: readonly CausalExperiment[];
  privacy?: CausalPrivacyOptions;
  limits?: CausalRunLimits;
}

export interface RankedExperiment {
  experimentId: string;
  rank: number;
  estimatedCost: number;
  distinguishingPairs: number;
}

export type CausalEvidenceLabel = "causal" | "observational";

export type CausalAssessmentReason =
  | "baseline_not_deterministic"
  | "baseline_did_not_match_prediction"
  | "intervention_did_not_match_prediction"
  | "prediction_did_not_require_change"
  | "outcome_did_not_change"
  | "intervention_not_isolated"
  | "predicted_controlled_change_observed";

export interface CausalAssessment {
  hypothesisId: string;
  experimentId: string;
  label: CausalEvidenceLabel;
  baselineMatched: boolean;
  interventionMatched: boolean;
  predictedChange: boolean;
  observedChange: boolean;
  interventionIsolated: boolean;
  reasons: readonly CausalAssessmentReason[];
}

export interface SanitizedIntervention {
  kind: InterventionKind;
  description: string;
  changedInputs: readonly string[];
  isolated: boolean;
  mechanism: "caller_supplied_process_invocation";
}

export interface CausalExperimentResult {
  experimentId: string;
  rank: number;
  title: string;
  intervention: SanitizedIntervention;
  observation: ProcessObservation;
  assessments: readonly CausalAssessment[];
}

export interface CausalDeterminism {
  established: boolean;
  replayCount: number;
  outcomeKeys: readonly string[];
  observationDigests: readonly `sha256:${string}`[];
}

export type CausalTwinVerdict =
  | "causal_evidence_established"
  | "ambiguous_causal_evidence"
  | "observational_only"
  | "baseline_not_deterministic"
  | "no_distinguishing_experiment";

export interface CausalTwinReport {
  schemaVersion: 1;
  planId: string;
  snapshotDigest: `sha256:${string}`;
  hypotheses: readonly {
    id: string;
    statement: string;
    baselineExpectation: OutcomeExpectation;
  }[];
  baseline: readonly ProcessObservation[];
  determinism: CausalDeterminism;
  rankedExperiments: readonly RankedExperiment[];
  experiments: readonly CausalExperimentResult[];
  causalHypothesisIds: readonly string[];
  verdict: CausalTwinVerdict;
  limitations: readonly string[];
}

export interface CausalRunOptions {
  signal?: AbortSignal;
}
