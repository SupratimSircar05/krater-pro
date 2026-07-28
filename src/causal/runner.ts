import { causalDigest } from "./canonical.js";
import {
  captureCausalText,
  sanitizeInvocation,
  scrubCausalText,
} from "./privacy.js";
import { rankDistinguishingExperiments } from "./ranking.js";
import type {
  CausalAssessment,
  CausalAssessmentReason,
  CausalExperiment,
  CausalExperimentResult,
  CausalHypothesis,
  CausalOutcome,
  CausalRunLimits,
  CausalRunOptions,
  CausalTwinPlan,
  CausalTwinReport,
  CausalTwinVerdict,
  OutcomeEvaluator,
  OutcomeExpectation,
  ProcessExecution,
  ProcessInvocation,
  ProcessObservation,
  ProcessRunner,
  ProcessRunnerRequest,
  RankedExperiment,
} from "./types.js";

const DEFAULT_LIMITS = {
  baselineReplays: 2,
  maxExperiments: 1,
  maxOutputBytesPerStream: 64 * 1024,
  defaultTimeoutMs: 30_000,
} as const;

const MAX_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_OUTPUT_BYTES_PER_STREAM = 1024 * 1024;
const MAX_BASELINE_REPLAYS = 5;
const MAX_EXPERIMENTS = 20;

interface ResolvedLimits {
  baselineReplays: number;
  maxExperiments: number;
  maxOutputBytesPerStream: number;
  defaultTimeoutMs: number;
}

interface ObservationIdentity {
  planId: string;
  sequence: number;
  role: "baseline" | "intervention";
  experimentId?: string;
}

export class CausalTwinValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CausalTwinValidationError";
  }
}

export class CausalTwinExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CausalTwinExecutionError";
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) {
    throw new CausalTwinValidationError(`${field} must not be empty.`);
  }
}

function assertIntegerInRange(
  value: number,
  field: string,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new CausalTwinValidationError(
      `${field} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
}

function validateExpectation(
  expectation: OutcomeExpectation,
  field: string,
): void {
  if (expectation.keys.length === 0) {
    throw new CausalTwinValidationError(`${field} must contain an outcome key.`);
  }
  for (const key of expectation.keys) assertNonEmpty(key, `${field} key`);
  if (new Set(expectation.keys).size !== expectation.keys.length) {
    throw new CausalTwinValidationError(`${field} contains duplicate outcome keys.`);
  }
}

function validateInvocation(invocation: ProcessInvocation, field: string): void {
  if (invocation.runtime !== "node" && invocation.runtime !== "python") {
    throw new CausalTwinValidationError(
      `${field} runtime must be node or python.`,
    );
  }
  assertNonEmpty(invocation.entrypoint, `${field} entrypoint`);
  if ((invocation.args?.length ?? 0) > 256) {
    throw new CausalTwinValidationError(`${field} has too many arguments.`);
  }
  if (Object.keys(invocation.environment ?? {}).length > 128) {
    throw new CausalTwinValidationError(
      `${field} has too many environment entries.`,
    );
  }
  if (invocation.timeoutMs !== undefined) {
    assertIntegerInRange(
      invocation.timeoutMs,
      `${field} timeout`,
      1,
      MAX_TIMEOUT_MS,
    );
  }
}

function resolveLimits(limits: CausalRunLimits = {}): ResolvedLimits {
  const resolved = { ...DEFAULT_LIMITS, ...limits };
  assertIntegerInRange(
    resolved.baselineReplays,
    "baseline replay count",
    2,
    MAX_BASELINE_REPLAYS,
  );
  assertIntegerInRange(
    resolved.maxExperiments,
    "maximum experiments",
    0,
    MAX_EXPERIMENTS,
  );
  assertIntegerInRange(
    resolved.maxOutputBytesPerStream,
    "maximum output bytes per stream",
    1,
    MAX_OUTPUT_BYTES_PER_STREAM,
  );
  assertIntegerInRange(
    resolved.defaultTimeoutMs,
    "default timeout",
    1,
    MAX_TIMEOUT_MS,
  );
  return resolved;
}

function validatePlan(plan: CausalTwinPlan): ResolvedLimits {
  assertNonEmpty(plan.id, "plan id");
  if (!/^sha256:[a-f0-9]{64}$/.test(plan.snapshotDigest)) {
    throw new CausalTwinValidationError(
      "snapshot digest must be a lowercase sha256 digest.",
    );
  }
  validateInvocation(plan.baseline, "baseline");
  if (plan.hypotheses.length < 2) {
    throw new CausalTwinValidationError(
      "at least two competing hypotheses are required.",
    );
  }

  const hypothesisIds = new Set<string>();
  for (const hypothesis of plan.hypotheses) {
    assertNonEmpty(hypothesis.id, "hypothesis id");
    assertNonEmpty(hypothesis.statement, `hypothesis ${hypothesis.id} statement`);
    if (hypothesisIds.has(hypothesis.id)) {
      throw new CausalTwinValidationError("hypothesis ids must be unique.");
    }
    hypothesisIds.add(hypothesis.id);
    validateExpectation(
      hypothesis.baselineExpectation,
      `hypothesis ${hypothesis.id} baseline expectation`,
    );
  }

  const experimentIds = new Set<string>();
  for (const experiment of plan.experiments) {
    assertNonEmpty(experiment.id, "experiment id");
    assertNonEmpty(experiment.title, `experiment ${experiment.id} title`);
    assertNonEmpty(
      experiment.intervention.description,
      `experiment ${experiment.id} intervention description`,
    );
    if (experimentIds.has(experiment.id)) {
      throw new CausalTwinValidationError("experiment ids must be unique.");
    }
    experimentIds.add(experiment.id);
    if (
      !Number.isFinite(experiment.estimatedCost) ||
      experiment.estimatedCost < 0
    ) {
      throw new CausalTwinValidationError(
        `experiment ${experiment.id} estimated cost must be finite and non-negative.`,
      );
    }
    validateInvocation(experiment.invocation, `experiment ${experiment.id}`);

    const predictionIds = new Set<string>();
    for (const prediction of experiment.predictions) {
      if (!hypothesisIds.has(prediction.hypothesisId)) {
        throw new CausalTwinValidationError(
          `experiment ${experiment.id} predicts an unknown hypothesis.`,
        );
      }
      if (predictionIds.has(prediction.hypothesisId)) {
        throw new CausalTwinValidationError(
          `experiment ${experiment.id} repeats a hypothesis prediction.`,
        );
      }
      predictionIds.add(prediction.hypothesisId);
      validateExpectation(
        prediction.expected,
        `experiment ${experiment.id} prediction`,
      );
    }
  }

  return resolveLimits(plan.limits);
}

function normalizeOutcome(outcome: CausalOutcome): CausalOutcome {
  assertNonEmpty(outcome.key, "evaluated outcome key");
  assertNonEmpty(outcome.summary, "evaluated outcome summary");
  return {
    key: outcome.key.trim(),
    kind: outcome.kind,
    summary: outcome.summary.trim(),
  };
}

export const defaultOutcomeEvaluator: OutcomeEvaluator = (observation) => {
  if (observation.timedOut) {
    return { key: "timeout", kind: "timeout", summary: "Process timed out." };
  }
  if (observation.signal) {
    return {
      key: `signal:${observation.signal}`,
      kind: "terminated",
      summary: `Process terminated by ${observation.signal}.`,
    };
  }
  if (observation.exitCode === 0) {
    return { key: "success", kind: "success", summary: "Process succeeded." };
  }
  if (observation.exitCode !== null) {
    return {
      key: `exit:${observation.exitCode}`,
      kind: "failure",
      summary: `Process exited with code ${observation.exitCode}.`,
    };
  }
  return {
    key: "unknown",
    kind: "unknown",
    summary: "Process ended without an exit code or signal.",
  };
};

function validateExecution(execution: ProcessExecution): void {
  if (
    execution.exitCode !== null &&
    (!Number.isInteger(execution.exitCode) || execution.exitCode < 0)
  ) {
    throw new CausalTwinExecutionError(
      "Process runner returned an invalid exit code.",
    );
  }
  if (
    execution.durationMs !== undefined &&
    (!Number.isFinite(execution.durationMs) || execution.durationMs < 0)
  ) {
    throw new CausalTwinExecutionError(
      "Process runner returned an invalid duration.",
    );
  }
  if (
    typeof execution.stdout !== "string" ||
    typeof execution.stderr !== "string"
  ) {
    throw new CausalTwinExecutionError(
      "Process runner must return string stdout and stderr.",
    );
  }
}

function createRunnerRequest(
  invocation: ProcessInvocation,
  limits: ResolvedLimits,
): ProcessRunnerRequest {
  return {
    runtime: invocation.runtime,
    entrypoint: invocation.entrypoint,
    args: [...(invocation.args ?? [])],
    ...(invocation.cwd ? { cwd: invocation.cwd } : {}),
    environment: { ...(invocation.environment ?? {}) },
    timeoutMs: invocation.timeoutMs ?? limits.defaultTimeoutMs,
    maxOutputBytesPerStream: limits.maxOutputBytesPerStream,
  };
}

function expectationMatches(
  expectation: OutcomeExpectation,
  outcomeKey: string,
  scrub: (value: string) => string,
): boolean {
  return expectation.keys.some((key) => scrub(key) === outcomeKey);
}

function expectsGuaranteedChange(
  baseline: OutcomeExpectation,
  intervention: OutcomeExpectation,
  scrub: (value: string) => string,
): boolean {
  const baselineKeys = new Set(baseline.keys.map(scrub));
  return intervention.keys.every((key) => !baselineKeys.has(scrub(key)));
}

function assessHypothesis(
  hypothesis: CausalHypothesis,
  experiment: CausalExperiment,
  baselineOutcomeKey: string,
  interventionOutcomeKey: string,
  baselineDeterministic: boolean,
  scrub: (value: string) => string,
): CausalAssessment | undefined {
  const prediction = experiment.predictions.find(
    (candidate) => candidate.hypothesisId === hypothesis.id,
  );
  if (!prediction) return undefined;

  const baselineMatched = expectationMatches(
    hypothesis.baselineExpectation,
    baselineOutcomeKey,
    scrub,
  );
  const interventionMatched = expectationMatches(
    prediction.expected,
    interventionOutcomeKey,
    scrub,
  );
  const predictedChange = expectsGuaranteedChange(
    hypothesis.baselineExpectation,
    prediction.expected,
    scrub,
  );
  const observedChange = baselineOutcomeKey !== interventionOutcomeKey;
  const reasons: CausalAssessmentReason[] = [];

  if (!baselineDeterministic) reasons.push("baseline_not_deterministic");
  if (!baselineMatched) reasons.push("baseline_did_not_match_prediction");
  if (!interventionMatched) {
    reasons.push("intervention_did_not_match_prediction");
  }
  if (!predictedChange) reasons.push("prediction_did_not_require_change");
  if (!observedChange) reasons.push("outcome_did_not_change");
  if (!experiment.intervention.isolated) {
    reasons.push("intervention_not_isolated");
  }

  const label =
    baselineDeterministic &&
    baselineMatched &&
    interventionMatched &&
    predictedChange &&
    observedChange &&
    experiment.intervention.isolated
      ? "causal"
      : "observational";
  if (label === "causal") reasons.push("predicted_controlled_change_observed");

  return {
    hypothesisId: scrub(hypothesis.id),
    experimentId: scrub(experiment.id),
    label,
    baselineMatched,
    interventionMatched,
    predictedChange,
    observedChange,
    interventionIsolated: experiment.intervention.isolated,
    reasons,
  };
}

function reportVerdict(
  causalHypothesisIds: readonly string[],
  baselineDeterministic: boolean,
  rankedExperiments: readonly RankedExperiment[],
): CausalTwinVerdict {
  if (!baselineDeterministic) return "baseline_not_deterministic";
  if (rankedExperiments.length === 0) return "no_distinguishing_experiment";
  if (causalHypothesisIds.length === 0) return "observational_only";
  if (causalHypothesisIds.length === 1) {
    return "causal_evidence_established";
  }
  return "ambiguous_causal_evidence";
}

export class CausalTwinRunner {
  constructor(
    private readonly processRunner: ProcessRunner,
    private readonly evaluateOutcome: OutcomeEvaluator = defaultOutcomeEvaluator,
  ) {}

  async run(
    plan: CausalTwinPlan,
    options: CausalRunOptions = {},
  ): Promise<CausalTwinReport> {
    const limits = validatePlan(plan);
    const rankedExperiments = rankDistinguishingExperiments(
      plan.hypotheses,
      plan.experiments,
    );
    const experimentById = new Map(
      plan.experiments.map((experiment) => [experiment.id, experiment]),
    );
    const scrub = (value: string): string =>
      scrubCausalText(value, plan.privacy);
    const baseline: ProcessObservation[] = [];
    let sequence = 0;

    for (let index = 0; index < limits.baselineReplays; index += 1) {
      sequence += 1;
      baseline.push(
        await this.observe(
          plan,
          plan.baseline,
          limits,
          { planId: plan.id, sequence, role: "baseline" },
          options,
        ),
      );
    }

    const baselineOutcomeKeys = baseline.map(
      (observation) => observation.outcome.key,
    );
    const baselineDeterministic =
      new Set(baselineOutcomeKeys).size === 1;
    const experimentResults: CausalExperimentResult[] = [];

    if (baselineDeterministic) {
      for (const ranking of rankedExperiments.slice(0, limits.maxExperiments)) {
        const experiment = experimentById.get(ranking.experimentId);
        if (!experiment) {
          throw new CausalTwinValidationError(
            "Ranked experiment was not present in the validated plan.",
          );
        }
        sequence += 1;
        const observation = await this.observe(
          plan,
          experiment.invocation,
          limits,
          {
            planId: plan.id,
            sequence,
            role: "intervention",
            experimentId: experiment.id,
          },
          options,
        );
        const assessments = plan.hypotheses
          .map((hypothesis) =>
            assessHypothesis(
              hypothesis,
              experiment,
              baselineOutcomeKeys[0],
              observation.outcome.key,
              baselineDeterministic,
              scrub,
            ),
          )
          .filter(
            (assessment): assessment is CausalAssessment =>
              assessment !== undefined,
          );
        experimentResults.push({
          experimentId: scrub(experiment.id),
          rank: ranking.rank,
          title: scrubCausalText(experiment.title, plan.privacy),
          intervention: {
            kind: experiment.intervention.kind,
            description: scrubCausalText(
              experiment.intervention.description,
              plan.privacy,
            ),
            changedInputs: experiment.intervention.changedInputs.map((input) =>
              scrubCausalText(input, plan.privacy),
            ),
            isolated: experiment.intervention.isolated,
            mechanism: "caller_supplied_process_invocation",
          },
          observation,
          assessments,
        });
      }
    }

    const causalHypothesisIds = [
      ...new Set(
        experimentResults.flatMap((result) =>
          result.assessments
            .filter((assessment) => assessment.label === "causal")
            .map((assessment) => assessment.hypothesisId),
        ),
      ),
    ].sort();

    return {
      schemaVersion: 1,
      planId: scrubCausalText(plan.id, plan.privacy),
      snapshotDigest: plan.snapshotDigest,
      hypotheses: plan.hypotheses.map((hypothesis) => ({
        id: scrub(hypothesis.id),
        statement: scrub(hypothesis.statement),
        baselineExpectation: {
          keys: hypothesis.baselineExpectation.keys.map(scrub),
          ...(hypothesis.baselineExpectation.description
            ? {
                description: scrubCausalText(
                  hypothesis.baselineExpectation.description,
                  plan.privacy,
                ),
              }
            : {}),
        },
      })),
      baseline,
      determinism: {
        established: baselineDeterministic,
        replayCount: baseline.length,
        outcomeKeys: baselineOutcomeKeys,
        observationDigests: baseline.map((observation) => observation.digest),
      },
      rankedExperiments: rankedExperiments.map((ranking) => ({
        ...ranking,
        experimentId: scrub(ranking.experimentId),
      })),
      experiments: experimentResults,
      causalHypothesisIds: causalHypothesisIds.map(scrub),
      verdict: reportVerdict(
        causalHypothesisIds,
        baselineDeterministic,
        rankedExperiments,
      ),
      limitations: [
        "The workspace snapshot digest is supplied by the caller; this core does not create or verify the snapshot.",
        "This core does not inject runtime values, override branches, or stub functions. Every intervention is a caller-supplied Node.js or Python process invocation.",
        "A causal label establishes only that a declared, isolated intervention changed the configured semantic outcome as predicted.",
      ],
    };
  }

  private async observe(
    plan: CausalTwinPlan,
    invocation: ProcessInvocation,
    limits: ResolvedLimits,
    identity: ObservationIdentity,
    options: CausalRunOptions,
  ): Promise<ProcessObservation> {
    if (options.signal?.aborted) {
      throw new CausalTwinExecutionError("Causal run was aborted.");
    }
    const request = createRunnerRequest(invocation, limits);
    let execution: ProcessExecution;
    try {
      execution = await this.processRunner.run(request, {
        planId: identity.planId,
        sequence: identity.sequence,
        purpose:
          identity.role === "baseline" ? "baseline" : "intervention",
        ...(identity.experimentId
          ? { experimentId: identity.experimentId }
          : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      const rawMessage =
        error instanceof Error ? error.message : "unknown process runner error";
      const safeMessage = scrubCausalText(rawMessage, plan.privacy);
      throw new CausalTwinExecutionError(
        `Process runner failed during ${identity.role}: ${safeMessage}`,
      );
    }
    validateExecution(execution);

    const baseObservation = {
      sequence: identity.sequence,
      role: identity.role,
      ...(identity.experimentId
        ? { experimentId: identity.experimentId }
        : {}),
      invocation: sanitizeInvocation(
        invocation,
        plan.privacy,
        limits.defaultTimeoutMs,
      ),
      exitCode: execution.exitCode,
      signal: execution.signal ?? null,
      timedOut: execution.timedOut ?? false,
      ...(execution.durationMs !== undefined
        ? { durationMs: execution.durationMs }
        : {}),
      stdout: captureCausalText(
        execution.stdout,
        limits.maxOutputBytesPerStream,
        plan.privacy,
      ),
      stderr: captureCausalText(
        execution.stderr,
        limits.maxOutputBytesPerStream,
        plan.privacy,
      ),
    } satisfies Omit<ProcessObservation, "id" | "outcome" | "digest">;
    const evaluatedOutcome = normalizeOutcome(
      this.evaluateOutcome(baseObservation),
    );
    const outcome = {
      ...evaluatedOutcome,
      key: scrubCausalText(evaluatedOutcome.key, plan.privacy),
      summary: scrubCausalText(evaluatedOutcome.summary, plan.privacy),
    };
    const digest = causalDigest({
      invocation: baseObservation.invocation,
      exitCode: baseObservation.exitCode,
      signal: baseObservation.signal,
      timedOut: baseObservation.timedOut,
      stdout: baseObservation.stdout,
      stderr: baseObservation.stderr,
      outcome,
    });
    const id = causalDigest({
      planId: identity.planId,
      sequence: identity.sequence,
      role: identity.role,
      experimentId: identity.experimentId,
      digest,
    });

    return {
      id,
      ...baseObservation,
      ...(baseObservation.experimentId
        ? {
            experimentId: scrubCausalText(
              baseObservation.experimentId,
              plan.privacy,
            ),
          }
        : {}),
      outcome,
      digest,
    };
  }
}

export async function runCausalTwin(
  plan: CausalTwinPlan,
  processRunner: ProcessRunner,
  options: CausalRunOptions = {},
  evaluateOutcome: OutcomeEvaluator = defaultOutcomeEvaluator,
): Promise<CausalTwinReport> {
  return new CausalTwinRunner(processRunner, evaluateOutcome).run(plan, options);
}
