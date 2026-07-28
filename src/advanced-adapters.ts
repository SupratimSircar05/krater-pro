import {
  CausalTwinExecutionError,
  CausalTwinValidationError,
  runCausalTwin,
  type CausalTwinPlan,
  type CausalTwinReport,
  type ProcessExecution,
  type ProcessRunContext,
  type ProcessRunner,
  type ProcessRunnerRequest,
} from "./causal/index.js";
import {
  evaluateReliabilityPromotion,
  reliabilityMetrics,
  type AbstentionResult,
  type ReliabilityCandidateKind,
  type ReliabilityCaseResult,
  type ReliabilityEvaluation,
  type ReliabilityEvaluationRole,
  type ReliabilityMetrics,
  type ReliabilityPromotionDecision,
  type ReliabilityPromotionInput,
} from "./intelligence/index.js";
import { redactForPersistence } from "./proofgraph/index.js";

export class AdvancedAdapterInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdvancedAdapterInputError";
  }
}

export interface RecordedCausalReplayInput {
  plan: CausalTwinPlan;
  /**
   * Recorded process outcomes in the exact order requested by the causal core:
   * baseline replays first, followed by ranked interventions.
   *
   * This adapter deliberately does not execute a process. Live execution
   * requires a verified native sandbox adapter that is not yet implemented.
   */
  executions: readonly ProcessExecution[];
}

export interface RecordedCausalReplayResult {
  schemaVersion: 1;
  mode: "recorded_execution_replay";
  executedProcesses: false;
  consumedExecutions: number;
  report: CausalTwinReport;
  limitations: readonly string[];
}

export interface ReliabilityReplayResult {
  schemaVersion: 1;
  mode: "sealed_result_replay";
  executedBenchmarks: false;
  evaluation: {
    evaluationId: string;
    suiteId: string;
    datasetDigest: string;
    role: ReliabilityEvaluationRole;
    configurationDigest: string;
    caseCount: number;
  };
  metrics: ReliabilityMetrics;
  limitations: readonly string[];
}

export interface ReliabilityCalibrationResult {
  schemaVersion: 1;
  mode: "promotion_gate_evaluation";
  persistedPromotion: false;
  decision: ReliabilityPromotionDecision;
  limitations: readonly string[];
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AdvancedAdapterInputError(`${field} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AdvancedAdapterInputError(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new AdvancedAdapterInputError(`${field} must be a boolean.`);
  }
  return value;
}

function optionalNonNegativeNumber(
  value: unknown,
  field: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new AdvancedAdapterInputError(
      `${field} must be a finite non-negative number.`,
    );
  }
  return value;
}

function commonSecretRedaction(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret.length > 0) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted
    .replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 [REDACTED]")
    .replace(
      /(\b(?:api[_-]?key|password|secret|token|authorization)\b\s*[:=]\s*)\S+/gi,
      "$1[REDACTED]",
    )
    .replace(/\b(?:sk|pk|kr)[_-][A-Za-z0-9_-]{16,}\b/g, "[REDACTED]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 512);
}

function declaredSecrets(plan: unknown): readonly string[] {
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) return [];
  const privacy = (plan as Record<string, unknown>).privacy;
  if (typeof privacy !== "object" || privacy === null || Array.isArray(privacy)) {
    return [];
  }
  const secrets = (privacy as Record<string, unknown>).secrets;
  if (!Array.isArray(secrets)) return [];
  return secrets.filter((item): item is string => typeof item === "string");
}

function normalizeExecution(
  value: unknown,
  index: number,
): ProcessExecution {
  const input = record(value, `executions[${index}]`);
  const exitCode = input.exitCode;
  if (
    exitCode !== null &&
    (typeof exitCode !== "number" ||
      !Number.isInteger(exitCode) ||
      exitCode < 0)
  ) {
    throw new AdvancedAdapterInputError(
      `executions[${index}].exitCode must be null or a non-negative integer.`,
    );
  }
  if (typeof input.stdout !== "string" || typeof input.stderr !== "string") {
    throw new AdvancedAdapterInputError(
      `executions[${index}] must include string stdout and stderr values.`,
    );
  }
  if (
    input.signal !== undefined &&
    input.signal !== null &&
    typeof input.signal !== "string"
  ) {
    throw new AdvancedAdapterInputError(
      `executions[${index}].signal must be a string or null.`,
    );
  }
  if (input.timedOut !== undefined && typeof input.timedOut !== "boolean") {
    throw new AdvancedAdapterInputError(
      `executions[${index}].timedOut must be a boolean.`,
    );
  }
  const durationMs = optionalNonNegativeNumber(
    input.durationMs,
    `executions[${index}].durationMs`,
  );
  return {
    exitCode,
    stdout: input.stdout,
    stderr: input.stderr,
    ...(input.signal !== undefined
      ? { signal: input.signal as string | null }
      : {}),
    ...(input.timedOut !== undefined
      ? { timedOut: input.timedOut as boolean }
      : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

class RecordedProcessRunner implements ProcessRunner {
  consumed = 0;

  constructor(private readonly executions: readonly ProcessExecution[]) {}

  async run(
    _request: ProcessRunnerRequest,
    _context: ProcessRunContext,
  ): Promise<ProcessExecution> {
    const result = this.executions[this.consumed];
    if (!result) {
      throw new AdvancedAdapterInputError(
        `Recorded causal execution ${this.consumed + 1} is required but missing.`,
      );
    }
    this.consumed += 1;
    return { ...result };
  }
}

/**
 * Replays the causal analysis against caller-recorded process outcomes.
 *
 * It never spawns Node.js or Python. That boundary is intentional until the
 * cross-platform supervisor has a verified native containment adapter.
 */
export async function replayRecordedCausalTwin(
  value: unknown,
): Promise<RecordedCausalReplayResult> {
  const input = record(value, "causal replay input");
  const plan = record(input.plan, "plan") as unknown as CausalTwinPlan;
  if (!Array.isArray(input.executions) || input.executions.length === 0) {
    throw new AdvancedAdapterInputError(
      "Causal replay requires recorded executions. Live process execution is unavailable without a verified native sandbox adapter.",
    );
  }
  const executions = input.executions.map(normalizeExecution);
  const runner = new RecordedProcessRunner(executions);
  try {
    const report = await runCausalTwin(plan, runner);
    if (runner.consumed !== executions.length) {
      throw new AdvancedAdapterInputError(
        `Causal replay consumed ${runner.consumed} recorded execution(s), but ${executions.length} were supplied. Remove unrelated outcomes so the replay is exact.`,
      );
    }
    return redactForPersistence({
      schemaVersion: 1,
      mode: "recorded_execution_replay",
      executedProcesses: false,
      consumedExecutions: runner.consumed,
      report,
      limitations: [
        "No process was executed by this adapter; the caller supplied every recorded outcome.",
        "The causal core trusts the caller-supplied workspace snapshot digest.",
        "Use live causal execution only after a verified native sandbox adapter is available.",
      ],
    } satisfies RecordedCausalReplayResult);
  } catch (error) {
    if (error instanceof AdvancedAdapterInputError) throw error;
    const safe = commonSecretRedaction(
      error instanceof Error ? error.message : "unknown causal replay error",
      declaredSecrets(plan),
    );
    if (
      error instanceof CausalTwinValidationError ||
      error instanceof CausalTwinExecutionError
    ) {
      throw new AdvancedAdapterInputError(safe);
    }
    throw new AdvancedAdapterInputError(
      `Causal plan or recorded executions are invalid: ${safe}`,
    );
  }
}

const EVALUATION_ROLES = new Set<ReliabilityEvaluationRole>([
  "rule_generation",
  "private_holdout",
]);
const ABSTENTION_RESULTS = new Set<AbstentionResult>([
  "correct",
  "incorrect",
  "not_applicable",
]);
const CANDIDATE_KINDS = new Set<ReliabilityCandidateKind>([
  "router",
  "skill",
  "prompt",
  "policy",
]);

function parseReliabilityCase(
  value: unknown,
  index: number,
): ReliabilityCaseResult {
  const input = record(value, `cases[${index}]`);
  const abstention = nonEmptyString(
    input.abstention,
    `cases[${index}].abstention`,
  ) as AbstentionResult;
  if (!ABSTENTION_RESULTS.has(abstention)) {
    throw new AdvancedAdapterInputError(
      `cases[${index}].abstention must be correct, incorrect, or not_applicable.`,
    );
  }
  if (
    typeof input.securityFailures !== "number" ||
    !Number.isInteger(input.securityFailures) ||
    input.securityFailures < 0
  ) {
    throw new AdvancedAdapterInputError(
      `cases[${index}].securityFailures must be a non-negative integer.`,
    );
  }
  return {
    caseId: nonEmptyString(input.caseId, `cases[${index}].caseId`),
    taskClass: nonEmptyString(input.taskClass, `cases[${index}].taskClass`),
    resolved: booleanValue(input.resolved, `cases[${index}].resolved`),
    securityFailures: input.securityFailures,
    abstention,
    ...(optionalNonNegativeNumber(input.costUsd, `cases[${index}].costUsd`) !==
    undefined
      ? { costUsd: input.costUsd as number }
      : {}),
    ...(optionalNonNegativeNumber(
      input.latencyMs,
      `cases[${index}].latencyMs`,
    ) !== undefined
      ? { latencyMs: input.latencyMs as number }
      : {}),
  };
}

export function parseReliabilityEvaluation(
  value: unknown,
  field = "evaluation",
): ReliabilityEvaluation {
  const input = record(value, field);
  const role = nonEmptyString(input.role, `${field}.role`) as ReliabilityEvaluationRole;
  if (!EVALUATION_ROLES.has(role)) {
    throw new AdvancedAdapterInputError(
      `${field}.role must be rule_generation or private_holdout.`,
    );
  }
  if (!Array.isArray(input.cases) || input.cases.length === 0) {
    throw new AdvancedAdapterInputError(
      `${field}.cases must contain at least one recorded case result.`,
    );
  }
  const cases = input.cases.map(parseReliabilityCase);
  const ids = new Set<string>();
  for (const result of cases) {
    if (ids.has(result.caseId)) {
      throw new AdvancedAdapterInputError(
        `${field}.cases repeats a case ID.`,
      );
    }
    ids.add(result.caseId);
  }
  const sealed = booleanValue(input.sealed, `${field}.sealed`);
  if (!sealed) {
    throw new AdvancedAdapterInputError(
      `${field} must be sealed before the Private Reliability Lab will score it.`,
    );
  }
  return {
    evaluationId: nonEmptyString(input.evaluationId, `${field}.evaluationId`),
    suiteId: nonEmptyString(input.suiteId, `${field}.suiteId`),
    datasetDigest: nonEmptyString(
      input.datasetDigest,
      `${field}.datasetDigest`,
    ),
    role,
    configurationDigest: nonEmptyString(
      input.configurationDigest,
      `${field}.configurationDigest`,
    ),
    sealed,
    cases,
  };
}

export function replayReliabilityEvaluation(
  value: unknown,
): ReliabilityReplayResult {
  const envelope = record(value, "reliability replay input");
  const evaluation = parseReliabilityEvaluation(envelope.evaluation);
  return redactForPersistence({
    schemaVersion: 1,
    mode: "sealed_result_replay",
    executedBenchmarks: false,
    evaluation: {
      evaluationId: evaluation.evaluationId,
      suiteId: evaluation.suiteId,
      datasetDigest: evaluation.datasetDigest,
      role: evaluation.role,
      configurationDigest: evaluation.configurationDigest,
      caseCount: evaluation.cases.length,
    },
    metrics: reliabilityMetrics(evaluation),
    limitations: [
      "This adapter scores sealed recorded results; it does not execute benchmark fixtures.",
      "Dataset and configuration digests are caller attestations at this interface.",
    ],
  } satisfies ReliabilityReplayResult);
}

export function parseReliabilityPromotionInput(
  value: unknown,
): ReliabilityPromotionInput {
  const input = record(value, "reliability calibration input");
  const candidateKind = nonEmptyString(
    input.candidateKind,
    "candidateKind",
  ) as ReliabilityCandidateKind;
  if (!CANDIDATE_KINDS.has(candidateKind)) {
    throw new AdvancedAdapterInputError(
      "candidateKind must be router, skill, prompt, or policy.",
    );
  }
  const minimumImprovementPoints =
    input.minimumImprovementPoints === undefined
      ? undefined
      : optionalNonNegativeNumber(
          input.minimumImprovementPoints,
          "minimumImprovementPoints",
        );
  return {
    candidateId: nonEmptyString(input.candidateId, "candidateId"),
    candidateKind,
    ruleGeneration: parseReliabilityEvaluation(
      input.ruleGeneration,
      "ruleGeneration",
    ),
    baselineHoldout: parseReliabilityEvaluation(
      input.baselineHoldout,
      "baselineHoldout",
    ),
    candidateHoldout: parseReliabilityEvaluation(
      input.candidateHoldout,
      "candidateHoldout",
    ),
    ...(minimumImprovementPoints !== undefined
      ? { minimumImprovementPoints }
      : {}),
  };
}

export function calibrateReliabilityCandidate(
  value: unknown,
): ReliabilityCalibrationResult {
  const input = parseReliabilityPromotionInput(value);
  let decision: ReliabilityPromotionDecision;
  try {
    decision = evaluateReliabilityPromotion(input);
  } catch (error) {
    throw new AdvancedAdapterInputError(
      error instanceof Error
        ? error.message
        : "Reliability calibration input is invalid.",
    );
  }
  return redactForPersistence({
    schemaVersion: 1,
    mode: "promotion_gate_evaluation",
    persistedPromotion: false,
    decision,
    limitations: [
      "This endpoint evaluates the promotion gate only; it never changes router, skill, prompt, or policy state.",
      "Benchmark execution and holdout sealing happen outside this adapter.",
    ],
  } satisfies ReliabilityCalibrationResult);
}
