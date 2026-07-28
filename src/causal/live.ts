import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  computeWorkspaceSnapshotDigest,
} from "../staging-workspace.js";
import {
  LiveCausalProcessRunner,
  LiveCausalUnavailableError,
  LiveCausalValidationError,
  type LiveCausalExecutionSummary,
  type LiveCausalProcessRunnerOptions,
} from "./live-process-runner.js";
import {
  CausalTwinExecutionError,
  CausalTwinValidationError,
  runCausalTwin,
} from "./runner.js";
import { scrubCausalText } from "./privacy.js";
import type {
  CausalExperiment,
  CausalHypothesis,
  CausalIntervention,
  CausalPrivacyOptions,
  CausalRunLimits,
  CausalTwinPlan,
  CausalTwinReport,
  HypothesisPrediction,
  OutcomeExpectation,
  ProcessInvocation,
} from "./types.js";

const MAX_TEXT_BYTES = 4 * 1024;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_ITEMS = 256;
const INTERVENTION_KINDS = new Set<CausalIntervention["kind"]>([
  "argument",
  "environment",
  "configuration",
  "fixture",
  "caller_defined",
]);

export class LiveCausalExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveCausalExecutionError";
  }
}

export interface LiveCausalTwinResult {
  schemaVersion: 1;
  mode: "live_sandboxed_process_execution";
  executedProcesses: true;
  workspaceDigestVerified: true;
  execution: LiveCausalExecutionSummary;
  report: CausalTwinReport;
  limitations: readonly string[];
}

export interface RunLiveCausalTwinOptions {
  workspaceRoot: string;
  knownSecrets?: readonly string[];
  signal?: AbortSignal;
  runnerOptions?: Omit<
    LiveCausalProcessRunnerOptions,
    "workspaceRoot" | "knownSecrets"
  >;
}

function object(
  value: unknown,
  field: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LiveCausalValidationError(`${field} must be a JSON object.`);
  }
  const result = value as Record<string, unknown>;
  const unknown = Object.keys(result).filter(
    (key) => !allowedKeys.includes(key),
  );
  if (unknown.length > 0) {
    throw new LiveCausalValidationError(
      `${field} contains unsupported field ${unknown[0]}.`,
    );
  }
  return result;
}

function stringValue(
  value: unknown,
  field: string,
  maximumBytes = MAX_TEXT_BYTES,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw new LiveCausalValidationError(
      `${field} must be an exact non-empty string of at most ${maximumBytes} UTF-8 bytes.`,
    );
  }
  return value;
}

function stringArray(
  value: unknown,
  field: string,
  options: { minimum?: number; maximum?: number } = {},
): string[] {
  const minimum = options.minimum ?? 0;
  const maximum = options.maximum ?? MAX_ITEMS;
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > maximum
  ) {
    throw new LiveCausalValidationError(
      `${field} must contain ${minimum} to ${maximum} strings.`,
    );
  }
  const result = value.map((item, index) =>
    stringValue(item, `${field}[${index}]`, MAX_TEXT_BYTES),
  );
  if (new Set(result).size !== result.length) {
    throw new LiveCausalValidationError(`${field} must not contain duplicates.`);
  }
  return result;
}

function integer(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new LiveCausalValidationError(
      `${field} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function parseEnvironment(
  value: unknown,
  field: string,
): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LiveCausalValidationError(`${field} must be a JSON object.`);
  }
  const entries = Object.entries(value);
  if (entries.length > 128) {
    throw new LiveCausalValidationError(
      `${field} must contain at most 128 entries.`,
    );
  }
  return Object.fromEntries(
    entries.map(([name, item]) => [
      stringValue(name, `${field} key`, MAX_IDENTIFIER_BYTES),
      stringValue(item, `${field}.${name}`, 16 * 1024),
    ]),
  );
}

function parseInvocation(value: unknown, field: string): ProcessInvocation {
  const input = object(value, field, [
    "runtime",
    "entrypoint",
    "args",
    "cwd",
    "environment",
    "timeoutMs",
  ]);
  if (input.runtime !== "node" && input.runtime !== "python") {
    throw new LiveCausalValidationError(
      `${field}.runtime must be node or python.`,
    );
  }
  return {
    runtime: input.runtime,
    entrypoint: stringValue(
      input.entrypoint,
      `${field}.entrypoint`,
      MAX_TEXT_BYTES,
    ),
    ...(input.args === undefined
      ? {}
      : { args: stringArray(input.args, `${field}.args`) }),
    ...(input.cwd === undefined
      ? {}
      : { cwd: stringValue(input.cwd, `${field}.cwd`, MAX_TEXT_BYTES) }),
    ...(input.environment === undefined
      ? {}
      : { environment: parseEnvironment(input.environment, `${field}.environment`) }),
    ...(input.timeoutMs === undefined
      ? {}
      : {
          timeoutMs: integer(
            input.timeoutMs,
            `${field}.timeoutMs`,
            100,
            120_000,
          ),
        }),
  };
}

function parseExpectation(
  value: unknown,
  field: string,
): OutcomeExpectation {
  const input = object(value, field, ["keys", "description"]);
  return {
    keys: stringArray(input.keys, `${field}.keys`, {
      minimum: 1,
      maximum: 32,
    }),
    ...(input.description === undefined
      ? {}
      : {
          description: stringValue(
            input.description,
            `${field}.description`,
          ),
        }),
  };
}

function parseHypothesis(
  value: unknown,
  index: number,
): CausalHypothesis {
  const field = `plan.hypotheses[${index}]`;
  const input = object(value, field, [
    "id",
    "statement",
    "baselineExpectation",
  ]);
  return {
    id: stringValue(input.id, `${field}.id`, MAX_IDENTIFIER_BYTES),
    statement: stringValue(input.statement, `${field}.statement`),
    baselineExpectation: parseExpectation(
      input.baselineExpectation,
      `${field}.baselineExpectation`,
    ),
  };
}

function parseIntervention(
  value: unknown,
  field: string,
): CausalIntervention {
  const input = object(value, field, [
    "kind",
    "description",
    "changedInputs",
    "isolated",
  ]);
  if (
    typeof input.kind !== "string" ||
    !INTERVENTION_KINDS.has(input.kind as CausalIntervention["kind"])
  ) {
    throw new LiveCausalValidationError(
      `${field}.kind must be argument, environment, configuration, fixture, or caller_defined.`,
    );
  }
  if (typeof input.isolated !== "boolean") {
    throw new LiveCausalValidationError(`${field}.isolated must be a boolean.`);
  }
  return {
    kind: input.kind as CausalIntervention["kind"],
    description: stringValue(input.description, `${field}.description`),
    changedInputs: stringArray(input.changedInputs, `${field}.changedInputs`, {
      maximum: 128,
    }),
    isolated: input.isolated,
  };
}

function parsePrediction(
  value: unknown,
  field: string,
): HypothesisPrediction {
  const input = object(value, field, ["hypothesisId", "expected"]);
  return {
    hypothesisId: stringValue(
      input.hypothesisId,
      `${field}.hypothesisId`,
      MAX_IDENTIFIER_BYTES,
    ),
    expected: parseExpectation(input.expected, `${field}.expected`),
  };
}

function parseExperiment(
  value: unknown,
  index: number,
): CausalExperiment {
  const field = `plan.experiments[${index}]`;
  const input = object(value, field, [
    "id",
    "title",
    "intervention",
    "invocation",
    "estimatedCost",
    "predictions",
  ]);
  if (
    typeof input.estimatedCost !== "number" ||
    !Number.isFinite(input.estimatedCost) ||
    input.estimatedCost < 0
  ) {
    throw new LiveCausalValidationError(
      `${field}.estimatedCost must be a finite non-negative number.`,
    );
  }
  if (
    !Array.isArray(input.predictions) ||
    input.predictions.length === 0 ||
    input.predictions.length > MAX_ITEMS
  ) {
    throw new LiveCausalValidationError(
      `${field}.predictions must contain 1 to ${MAX_ITEMS} predictions.`,
    );
  }
  return {
    id: stringValue(input.id, `${field}.id`, MAX_IDENTIFIER_BYTES),
    title: stringValue(input.title, `${field}.title`),
    intervention: parseIntervention(
      input.intervention,
      `${field}.intervention`,
    ),
    invocation: parseInvocation(input.invocation, `${field}.invocation`),
    estimatedCost: input.estimatedCost,
    predictions: input.predictions.map((prediction, predictionIndex) =>
      parsePrediction(
        prediction,
        `${field}.predictions[${predictionIndex}]`,
      ),
    ),
  };
}

function parsePrivacy(value: unknown): CausalPrivacyOptions {
  const input = object(value, "plan.privacy", ["secrets", "redactPii"]);
  if (input.redactPii !== undefined && typeof input.redactPii !== "boolean") {
    throw new LiveCausalValidationError(
      "plan.privacy.redactPii must be a boolean.",
    );
  }
  return {
    ...(input.secrets === undefined
      ? {}
      : {
          secrets: stringArray(input.secrets, "plan.privacy.secrets", {
            maximum: 32,
          }),
        }),
    ...(input.redactPii === undefined
      ? {}
      : { redactPii: input.redactPii }),
  };
}

function parseLimits(value: unknown): CausalRunLimits {
  const input = object(value, "plan.limits", [
    "baselineReplays",
    "maxExperiments",
    "maxOutputBytesPerStream",
    "defaultTimeoutMs",
  ]);
  return {
    ...(input.baselineReplays === undefined
      ? {}
      : {
          baselineReplays: integer(
            input.baselineReplays,
            "plan.limits.baselineReplays",
            2,
            5,
          ),
        }),
    ...(input.maxExperiments === undefined
      ? {}
      : {
          maxExperiments: integer(
            input.maxExperiments,
            "plan.limits.maxExperiments",
            0,
            20,
          ),
        }),
    ...(input.maxOutputBytesPerStream === undefined
      ? {}
      : {
          maxOutputBytesPerStream: integer(
            input.maxOutputBytesPerStream,
            "plan.limits.maxOutputBytesPerStream",
            1,
            1024 * 1024,
          ),
        }),
    ...(input.defaultTimeoutMs === undefined
      ? {}
      : {
          defaultTimeoutMs: integer(
            input.defaultTimeoutMs,
            "plan.limits.defaultTimeoutMs",
            100,
            120_000,
          ),
        }),
  };
}

function invocationChanges(
  baseline: ProcessInvocation,
  intervention: ProcessInvocation,
): string[] {
  const changes = new Set<string>();
  if (baseline.runtime !== intervention.runtime) changes.add("runtime");
  if (baseline.entrypoint !== intervention.entrypoint) changes.add("entrypoint");
  if ((baseline.cwd ?? ".") !== (intervention.cwd ?? ".")) changes.add("cwd");
  if ((baseline.timeoutMs ?? null) !== (intervention.timeoutMs ?? null)) {
    changes.add("timeoutMs");
  }
  if (
    JSON.stringify(baseline.args ?? []) !==
    JSON.stringify(intervention.args ?? [])
  ) {
    changes.add("args");
  }
  const baselineEnvironment = baseline.environment ?? {};
  const interventionEnvironment = intervention.environment ?? {};
  for (const name of new Set([
    ...Object.keys(baselineEnvironment),
    ...Object.keys(interventionEnvironment),
  ])) {
    if (baselineEnvironment[name] !== interventionEnvironment[name]) {
      changes.add(name);
    }
  }
  return [...changes].sort();
}

function validateIsolation(plan: CausalTwinPlan): void {
  for (const experiment of plan.experiments) {
    if (!experiment.intervention.isolated) continue;
    const actual = invocationChanges(plan.baseline, experiment.invocation);
    const declared = [...experiment.intervention.changedInputs].sort();
    if (
      actual.length === 0 ||
      actual.length !== declared.length ||
      actual.some((value, index) => value !== declared[index])
    ) {
      throw new LiveCausalValidationError(
        `Experiment ${experiment.id} cannot be marked isolated: changedInputs must exactly name the actual invocation differences (${actual.join(", ") || "none"}).`,
      );
    }
  }
}

export function parseLiveCausalPlan(value: unknown): CausalTwinPlan {
  const envelope = object(value, "live causal input", ["plan"]);
  const input = object(envelope.plan, "plan", [
    "id",
    "snapshotDigest",
    "baseline",
    "hypotheses",
    "experiments",
    "privacy",
    "limits",
  ]);
  const snapshotDigest = stringValue(
    input.snapshotDigest,
    "plan.snapshotDigest",
    71,
  );
  if (!/^sha256:[a-f0-9]{64}$/.test(snapshotDigest)) {
    throw new LiveCausalValidationError(
      "plan.snapshotDigest must be a lowercase sha256 digest.",
    );
  }
  if (
    !Array.isArray(input.hypotheses) ||
    input.hypotheses.length < 2 ||
    input.hypotheses.length > MAX_ITEMS
  ) {
    throw new LiveCausalValidationError(
      `plan.hypotheses must contain 2 to ${MAX_ITEMS} hypotheses.`,
    );
  }
  if (
    !Array.isArray(input.experiments) ||
    input.experiments.length > MAX_ITEMS
  ) {
    throw new LiveCausalValidationError(
      `plan.experiments must contain 0 to ${MAX_ITEMS} experiments.`,
    );
  }
  const plan: CausalTwinPlan = {
    id: stringValue(input.id, "plan.id", MAX_IDENTIFIER_BYTES),
    snapshotDigest: snapshotDigest as `sha256:${string}`,
    baseline: parseInvocation(input.baseline, "plan.baseline"),
    hypotheses: input.hypotheses.map(parseHypothesis),
    experiments: input.experiments.map(parseExperiment),
    ...(input.privacy === undefined
      ? {}
      : { privacy: parsePrivacy(input.privacy) }),
    ...(input.limits === undefined ? {} : { limits: parseLimits(input.limits) }),
  };
  validateIsolation(plan);
  return plan;
}

function errorMessage(
  error: unknown,
  secrets: readonly string[],
): string {
  return scrubCausalText(
    error instanceof Error ? error.message : "Unknown live causal error.",
    { secrets, redactPii: true },
  )
    .replace(/[\r\n]+/g, " ")
    .slice(0, 512);
}

export async function runLiveCausalTwin(
  value: unknown,
  options: RunLiveCausalTwinOptions,
): Promise<LiveCausalTwinResult> {
  const plan = parseLiveCausalPlan(value);
  const secrets = [
    ...(options.knownSecrets ?? []),
    ...(plan.privacy?.secrets ?? []),
  ].filter(Boolean);
  try {
    const workspaceRoot = await realpath(resolve(options.workspaceRoot));
    const initialDigest = await computeWorkspaceSnapshotDigest(workspaceRoot);
    if (initialDigest !== plan.snapshotDigest) {
      throw new LiveCausalValidationError(
        "The causal plan snapshot digest does not match the selected workspace.",
      );
    }
    const runner = new LiveCausalProcessRunner({
      workspaceRoot,
      knownSecrets: secrets,
      ...options.runnerOptions,
    });
    await runner.validateInvocations([
      plan.baseline,
      ...plan.experiments.map((experiment) => experiment.invocation),
    ]);
    await runner.assertAvailable();
    const report = await runCausalTwin(
      {
        ...plan,
        privacy: {
          ...plan.privacy,
          secrets,
        },
      },
      runner,
      options.signal ? { signal: options.signal } : {},
    );
    const finalDigest = await computeWorkspaceSnapshotDigest(workspaceRoot);
    if (finalDigest !== initialDigest) {
      throw new LiveCausalExecutionError(
        "The selected workspace changed during live causal execution; its evidence was discarded.",
      );
    }
    return {
      schemaVersion: 1,
      mode: "live_sandboxed_process_execution",
      executedProcesses: true,
      workspaceDigestVerified: true,
      execution: runner.summary(),
      report,
      limitations: [
        "The caller supplies the process invocations, interventions, and outcome predictions.",
        "This path performs no runtime instrumentation, value injection, branch override, or function stubbing.",
        "Execution is limited to direct Node.js and Python entrypoints inside the selected workspace.",
        "Processes run read-only, without network access, only when the native containment adapter verifies every required control.",
        "A causal label covers only the configured process outcome and requires an isolated declared invocation change to alter that outcome as predicted.",
      ],
    };
  } catch (error) {
    if (
      error instanceof LiveCausalValidationError ||
      error instanceof LiveCausalUnavailableError ||
      error instanceof LiveCausalExecutionError
    ) {
      error.message = errorMessage(error, secrets);
      throw error;
    }
    const message = errorMessage(error, secrets);
    if (error instanceof CausalTwinValidationError) {
      throw new LiveCausalValidationError(message);
    }
    if (error instanceof CausalTwinExecutionError) {
      throw new LiveCausalExecutionError(message);
    }
    throw new LiveCausalExecutionError(
      `Live causal execution failed: ${message}`,
    );
  }
}
