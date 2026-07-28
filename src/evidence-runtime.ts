import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { buildOutcomeContract, createIntentId } from "./intent/index.js";
import {
  ProofGraphStore,
  createChangePassport,
  createEvidenceCapsule,
  weakestEvidenceGrade,
  type ActionRecord,
  type AssuranceLevel,
  type ChangePassport,
  type ClaimRecord,
  type EvidenceCapsule,
  type EvidenceGrade,
  type EvidenceKind,
  type EvidenceRecord,
  type IntentNode,
  type JsonValue,
  type TaskContract,
  type TaskAssumption,
  type TaskInterpretation,
  type TaskProjection,
  type TaskState,
} from "./proofgraph/index.js";
import type { AgentEvent, JsonObject } from "./types.js";

const TERMINAL_STATES = new Set<TaskState>([
  "complete",
  "abstained",
  "blocked",
  "accepted_with_gaps",
  "cancelled",
]);

const ORDERED_ACTIVE_STATES: TaskState[] = [
  "intake",
  "discovery",
  "clarification",
  "reproduction",
  "staging",
  "verification",
  "review",
  "publication",
  "complete",
];

const EVIDENCE_WEIGHT: Record<EvidenceGrade, number> = {
  not_established: 0,
  observed: 1,
  tested: 2,
  stress_tested: 3,
  formally_verified: 4,
};

type GateEvent = Extract<AgentEvent, { type: "action_gate" }>;
type ToolEvent = Extract<AgentEvent, { type: "tool" }>;

export interface EvidenceTaskOptions {
  cwd: string;
  projectId: string;
  request: string;
  model?: string;
  assurance?: AssuranceLevel;
  taskId?: string;
  maxCostUsd?: number;
  maxTokens?: number;
  maxTimeMs?: number;
  maxToolSteps?: number;
  now?: () => Date;
}

export interface EvidenceTaskSummary {
  id: string;
  projectId: string;
  request: string;
  state: TaskState;
  assurance: AssuranceLevel;
  createdAt: string;
  updatedAt: string;
  verdict: TaskState;
  evidenceGrade: EvidenceGrade;
}

export interface EvidenceTaskDetail {
  task: EvidenceTaskSummary;
  contract: {
    interpretations: TaskInterpretation[];
    assumptions: string[];
    acceptanceCriteria: string[];
    nonGoals: string[];
    maxCostUsd?: number;
    maxTimeMs?: number;
  };
  intents: Array<{
    id: string;
    kind: string;
    text: string;
    status: string;
  }>;
  evidence: Array<
    EvidenceRecord & {
      ok: boolean;
    }
  >;
  claims: Array<{
    id: string;
    statement: string;
    grade: EvidenceGrade;
    status: string;
    evidenceIds: string[];
  }>;
  actions: ActionRecord[];
  gaps: string[];
  eventCount: number;
  passportDigest?: string;
  capsuleDigest?: string;
}

export interface FinishEvidenceTaskOptions {
  baseWorkspaceDigest?: string;
  finalWorkspaceDigest?: string;
  additionalGaps?: readonly string[];
}

export interface RecordAmbiguityPreflightOptions {
  assumptions: readonly TaskAssumption[];
  interpretations: readonly TaskInterpretation[];
  clarification?: {
    id: string;
    question: string;
    interpretations: readonly string[];
    score: number;
  };
}

export interface EvidencePublicationReadiness {
  taskId: string;
  state: TaskState;
  gaps: string[];
  requiresGapAcceptance: boolean;
  canPublish: boolean;
}

export interface FinalizeEvidencePublicationOptions {
  acceptGaps?: boolean;
  baseWorkspaceDigest?: string;
  finalWorkspaceDigest?: string;
  transactionId?: string;
}

export interface RecordEvidenceRollbackOptions {
  transactionId: string;
  wasPublished: boolean;
  baseWorkspaceDigest?: string;
  finalWorkspaceDigest?: string;
}

export interface CancelEvidenceTaskOptions {
  reason?: string;
  discardedProofPatch?: {
    transactionId: string;
    baseWorkspaceDigest?: string;
    finalWorkspaceDigest?: string;
    changedPaths?: readonly string[];
  };
}

const PUBLICATION_PENDING_GAP =
  "Transactional publication is pending explicit user acceptance.";

function stableId(prefix: string, ...parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return `${prefix}:${hash.digest("hex").slice(0, 24)}`;
}

function asJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}

function capabilityForTool(name: string): string {
  if (name === "write_file" || name === "replace_in_file") {
    return "workspace.stage";
  }
  if (name === "run_command") return "process.execute";
  if (name === "load_skill" || name === "list_skills") return "skill.read";
  if (name.startsWith("git_")) return "git.read";
  if (name === "record_action_gate") return "intent.classify";
  return "workspace.read";
}

function sideEffectsForTool(event: ToolEvent): ActionRecord["sideEffects"] {
  if (event.name === "write_file" || event.name === "replace_in_file") {
    return [
      {
        kind: "staged_file_change",
        target: String(event.args.path ?? "(unknown path)"),
        reversible: true,
        recovery: "Discard the ProofPatch transaction.",
      },
    ];
  }
  if (event.name === "run_command") {
    return [
      {
        kind: "process",
        target: String(event.args.command ?? "(unknown command)"),
        reversible: false,
        recovery: "Terminate the bounded process; filesystem effects remain staged.",
      },
    ];
  }
  return [];
}

function verificationKind(command: string): EvidenceKind | undefined {
  if (/\b(secret|credential)[-_ ]?(scan|guard)\b|guard:secrets/i.test(command)) {
    return "security";
  }
  if (/\b(tsc|typecheck|mypy|pyright|ruff|eslint|lint|clippy|checkstyle)\b/i.test(command)) {
    return "static_analysis";
  }
  if (/\b(test|vitest|jest|pytest|go test|cargo test|mvn test|gradle test)\b/i.test(command)) {
    return "test";
  }
  if (/\b(build|compile)\b/i.test(command)) return "differential";
  return undefined;
}

function requiredCheckSatisfied(
  check: string,
  evidence: readonly EvidenceRecord[],
  hasWorkspaceDigests: boolean,
): boolean {
  if (check === "workspace_digest") return hasWorkspaceDigests;
  if (check === "targeted_check") {
    return evidence.some(
      (item) =>
        !item.stale &&
        ["test", "static_analysis", "security", "differential"].includes(item.kind),
    );
  }
  if (check === "tests") {
    return evidence.some((item) => item.kind === "test" && item.grade !== "observed");
  }
  if (check === "typecheck") {
    return evidence.some(
      (item) => item.kind === "static_analysis" && item.grade !== "observed",
    );
  }
  if (check === "secret_scan") {
    return evidence.some(
      (item) => item.kind === "security" && item.grade !== "observed",
    );
  }
  if (check === "conflict_check") return hasWorkspaceDigests;
  if (check === "independent_verifier") {
    return evidence.some((item) => item.origin === "blind_verifier" && !item.stale);
  }
  if (check === "mutation_or_property_check") {
    return evidence.some(
      (item) =>
        (item.kind === "mutation" || item.kind === "property") &&
        item.grade !== "observed",
    );
  }
  if (check === "security_check") {
    return evidence.some(
      (item) => item.kind === "security" && item.grade !== "observed",
    );
  }
  if (check === "rollback_check") {
    return evidence.some(
      (item) => item.kind === "property" && /rollback/i.test(item.summary),
    );
  }
  return false;
}

function projectEvidenceGrade(projection: TaskProjection): EvidenceGrade {
  const current = projection.evidence
    .filter((item) => !item.stale)
    .map((item) => item.grade);
  if (!current.length) return "not_established";
  return current.reduce((strongest, grade) =>
    EVIDENCE_WEIGHT[grade] > EVIDENCE_WEIGHT[strongest] ? grade : strongest,
  );
}

function projectionCreatedAt(projection: TaskProjection): string {
  return projection.stateHistory[0]?.occurredAt ?? projection.contract.createdAt;
}

function projectionUpdatedAt(projection: TaskProjection): string {
  return (
    projection.stateHistory.at(-1)?.occurredAt ??
    projection.passport?.generatedAt ??
    projection.capsule?.generatedAt ??
    projection.contract.createdAt
  );
}

export function taskSummary(
  projection: TaskProjection,
  projectId: string,
): EvidenceTaskSummary {
  return {
    id: projection.taskId,
    projectId,
    request: projection.contract.request,
    state: projection.state,
    assurance: projection.contract.assurance,
    createdAt: projectionCreatedAt(projection),
    updatedAt: projectionUpdatedAt(projection),
    verdict: projection.state,
    evidenceGrade: projectEvidenceGrade(projection),
  };
}

export function taskDetail(
  projection: TaskProjection,
  projectId: string,
  eventCount: number,
): EvidenceTaskDetail {
  return {
    task: taskSummary(projection, projectId),
    contract: {
      interpretations: projection.contract.interpretations.map(
        (interpretation) => ({ ...interpretation }),
      ),
      assumptions: projection.contract.assumptions.map(
        (assumption) => assumption.statement,
      ),
      acceptanceCriteria: projection.contract.acceptanceCriteria.map(
        (criterion) => criterion.statement,
      ),
      nonGoals: projection.contract.nonGoals,
      ...(projection.contract.budget.maxCostUsd === undefined
        ? {}
        : { maxCostUsd: projection.contract.budget.maxCostUsd }),
      ...(projection.contract.budget.maxTimeMs === undefined
        ? {}
        : { maxTimeMs: projection.contract.budget.maxTimeMs }),
    },
    intents: projection.intents.map((intent) => ({
      id: intent.id,
      kind: intent.kind,
      text: intent.statement,
      status: intent.status,
    })),
    evidence: projection.evidence.map((evidence) => ({
      ...evidence,
      ok: evidence.contradictsClaimIds.length === 0 && !evidence.stale,
    })),
    claims: projection.claims.map((claim) => ({
      id: claim.id,
      statement: claim.statement,
      grade: claim.grade,
      status: claim.status,
      evidenceIds: claim.supportingEvidenceIds,
    })),
    actions: projection.actions,
    gaps: projection.capsule?.gaps ?? [],
    eventCount,
    ...(projection.passport
      ? { passportDigest: projection.passport.digest }
      : {}),
    ...(projection.capsule ? { capsuleDigest: projection.capsule.digest } : {}),
  };
}

export class EvidenceTask {
  readonly taskId: string;
  readonly projectId: string;
  contract: TaskContract;
  readonly requirementIntent: IntentNode;

  private state: TaskState = "intake";
  private queue: Promise<void> = Promise.resolve();
  private queueError?: unknown;
  private readonly actions = new Map<string, ActionRecord>();
  private readonly evidence = new Map<string, EvidenceRecord>();
  private readonly claims = new Map<string, ClaimRecord>();
  private readonly approvals = new Set<string>();
  private readonly changedPaths = new Set<string>();
  private readonly startedAt: number;
  private readonly now: () => Date;
  private gate?: GateEvent;
  private promptTokens = 0;
  private completionTokens = 0;
  private cachedTokens = 0;
  private successfulEdits = 0;
  private failedActions = 0;

  private constructor(
    readonly store: ProofGraphStore,
    options: EvidenceTaskOptions,
    contract: TaskContract,
    requirementIntent: IntentNode,
  ) {
    this.taskId = contract.taskId;
    this.projectId = options.projectId;
    this.contract = contract;
    this.requirementIntent = requirementIntent;
    this.startedAt = Date.now();
    this.now = options.now ?? (() => new Date());
  }

  static async start(options: EvidenceTaskOptions): Promise<EvidenceTask> {
    const request = options.request.trim();
    if (!request) throw new Error("Evidence task request must not be empty.");
    const taskId = options.taskId?.trim() || randomUUID();
    const assurance = options.assurance ?? "standard";
    const quote = buildOutcomeContract({
      request,
      assurance,
      ...(options.model ? { explicitModel: options.model } : {}),
      budget: {
        ...(options.maxCostUsd === undefined
          ? {}
          : { maxCostUsd: options.maxCostUsd }),
        ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
        ...(options.maxTimeMs === undefined
          ? {}
          : { maxDurationMs: options.maxTimeMs }),
        ...(options.maxToolSteps === undefined
          ? {}
          : { maxToolSteps: options.maxToolSteps }),
      },
    });
    const createdAt = (options.now ?? (() => new Date()))().toISOString();
    const contract: TaskContract = {
      schemaVersion: 1,
      id: quote.id,
      taskId,
      request,
      interpretations: [
        {
          id: stableId("interpretation", taskId, request),
          description: request,
          selected: true,
        },
      ],
      assumptions: [],
      acceptanceCriteria: [
        {
          id: stableId("criterion", taskId, request),
          statement: request,
          required: true,
        },
      ],
      nonGoals: [],
      assurance,
      budget: {
        maxCostUsd: quote.budget.maxCostUsd,
        maxTokens: quote.budget.maxTokens,
        maxTimeMs: quote.budget.maxDurationMs,
        maxToolSteps: quote.budget.maxToolSteps,
      },
      allowedCapabilities: [
        "workspace.read",
        "workspace.stage",
        "process.execute.approved",
        "git.read",
        "skill.read",
      ],
      requiredChecks: [...quote.requiredChecks],
      negativeGuarantees: [...quote.negativeGuarantees],
      createdAt,
    };
    const requirementIntent: IntentNode = {
      id: createIntentId("requirement", request, taskId),
      taskId,
      kind: "requirement",
      statement: request,
      status: "active",
      links: [],
      createdAt,
      updatedAt: createdAt,
    };
    const store = await ProofGraphStore.open({
      root: join(options.cwd, ".krater", "proofgraph"),
    });
    const task = new EvidenceTask(store, options, contract, requirementIntent);
    await store.append({
      taskId,
      kind: "task.created",
      payload: { contract },
      occurredAt: createdAt,
    });
    await store.append({
      taskId,
      kind: "intent.recorded",
      payload: { intent: requirementIntent },
      occurredAt: createdAt,
    });
    await task.transition("discovery", "Bounded repository discovery started.");
    return task;
  }

  get currentState(): TaskState {
    return this.state;
  }

  get actionGate(): GateEvent | undefined {
    return this.gate ? { ...this.gate } : undefined;
  }

  async recordAmbiguityPreflight(
    options: RecordAmbiguityPreflightOptions,
  ): Promise<void> {
    await this.flush();
    if (TERMINAL_STATES.has(this.state)) {
      throw new Error(`Evidence task ${this.taskId} is already ${this.state}.`);
    }
    const assumptions = new Map(
      this.contract.assumptions.map((assumption) => [assumption.id, assumption]),
    );
    for (const assumption of options.assumptions) {
      assumptions.set(assumption.id, { ...assumption });
    }
    this.contract = {
      ...this.contract,
      assumptions: [...assumptions.values()],
      interpretations:
        options.interpretations.length > 0
          ? options.interpretations.map((interpretation) => ({
              ...interpretation,
            }))
          : this.contract.interpretations,
    };
    const occurredAt = this.now().toISOString();
    await this.store.append({
      taskId: this.taskId,
      kind: "contract.set",
      payload: { contract: this.contract },
      occurredAt,
    });
    for (const assumption of options.assumptions) {
      const intent: IntentNode = {
        id: stableId("intent", this.taskId, "assumption", assumption.id),
        taskId: this.taskId,
        kind: "assumption",
        statement: assumption.statement,
        status: "active",
        links: [],
        owner:
          assumption.source === "user"
            ? "user"
            : assumption.source === "repository"
              ? "repository"
              : "krater",
        createdAt: occurredAt,
        updatedAt: occurredAt,
      };
      await this.store.append({
        taskId: this.taskId,
        kind: "intent.recorded",
        payload: { intent },
        occurredAt,
      });
    }
    if (options.clarification && this.state === "discovery") {
      await this.transition(
        "clarification",
        `Clarification ${options.clarification.id} is required: ${options.clarification.question}`,
      );
    } else if (!options.clarification && this.state === "clarification") {
      await this.transition(
        "reproduction",
        "The highest-value clarification was answered and recorded.",
      );
    }
  }

  private enqueue(operation: () => Promise<void>): void {
    this.queue = this.queue
      .then(operation)
      .catch((error) => {
        this.queueError ??= error;
      });
  }

  async flush(): Promise<void> {
    await this.queue;
    if (this.queueError) throw this.queueError;
  }

  private async transition(to: TaskState, reason: string): Promise<void> {
    if (this.state === to) return;
    if (TERMINAL_STATES.has(this.state)) {
      throw new Error(`Evidence task ${this.taskId} is already ${this.state}.`);
    }
    const from = this.state;
    await this.store.append({
      taskId: this.taskId,
      kind: "task.state.changed",
      payload: { from, to, reason },
      occurredAt: this.now().toISOString(),
    });
    this.state = to;
  }

  private async advanceTo(to: TaskState, reason: string): Promise<void> {
    const fromIndex = ORDERED_ACTIVE_STATES.indexOf(this.state);
    const toIndex = ORDERED_ACTIVE_STATES.indexOf(to);
    if (fromIndex < 0 || toIndex < 0 || toIndex < fromIndex) {
      throw new Error(`Cannot advance evidence task from ${this.state} to ${to}.`);
    }
    for (let index = fromIndex + 1; index <= toIndex; index += 1) {
      const next = ORDERED_ACTIVE_STATES[index]!;
      await this.transition(
        next,
        next === to
          ? reason
          : next === "clarification"
            ? "Repository discovery found no blocking clarification before reproduction."
            : `Advanced through required ${next} phase.`,
      );
    }
  }

  accept(event: AgentEvent): void {
    this.enqueue(async () => {
      if (TERMINAL_STATES.has(this.state)) return;
      if (event.type === "tool") {
        const now = this.now().toISOString();
        const action: ActionRecord = {
          id: event.id,
          taskId: this.taskId,
          name: event.name,
          capability: capabilityForTool(event.name),
          provenance: {
            source: "generated",
            trust: "untrusted",
            sensitivity: "proprietary",
          },
          input: asJsonValue(event.args),
          sideEffects: sideEffectsForTool(event),
          status: "running",
          startedAt: now,
        };
        this.actions.set(event.id, action);
        await this.store.append({
          taskId: this.taskId,
          kind: "action.recorded",
          payload: { action },
          occurredAt: now,
        });
        if (event.name === "run_command" && this.state === "discovery") {
          await this.advanceTo(
            "reproduction",
            "A bounded command was selected to reproduce or verify behavior.",
          );
        }
        if (
          (event.name === "write_file" || event.name === "replace_in_file") &&
          this.state === "reproduction"
        ) {
          await this.transition(
            "staging",
            "A gate-authorized file mutation entered the isolated staging phase.",
          );
        }
        return;
      }

      if (event.type === "approval") {
        this.approvals.add(
          `${event.tool}:${event.toolCallId}:${event.id}`,
        );
        return;
      }

      if (event.type === "action_gate") {
        this.gate = { ...event };
        const claimId = stableId("claim", this.taskId, "action-gate");
        const evidenceId = stableId(
          "evidence",
          this.taskId,
          "action-gate",
          ...event.evidenceRefs,
        );
        const evidence: EvidenceRecord = {
          id: evidenceId,
          taskId: this.taskId,
          kind: "reproduction",
          grade: "observed",
          origin: "tool",
          summary: event.reasons.join(" "),
          supportsClaimIds: [claimId],
          contradictsClaimIds: [],
          artifactDigests: [],
          stale: false,
          observedAt: this.now().toISOString(),
        };
        const claim: ClaimRecord = {
          id: claimId,
          taskId: this.taskId,
          statement: `Action Gate outcome: ${event.outcome}`,
          grade: "observed",
          status: "supported",
          supportingEvidenceIds: [evidenceId],
          contradictingEvidenceIds: [],
          createdAt: this.now().toISOString(),
        };
        this.evidence.set(evidence.id, evidence);
        this.claims.set(claim.id, claim);
        await this.store.append({
          taskId: this.taskId,
          kind: "evidence.recorded",
          payload: { evidence },
        });
        await this.store.append({
          taskId: this.taskId,
          kind: "claim.recorded",
          payload: { claim },
        });
        if (event.shouldStageCode && this.state === "discovery") {
          await this.advanceTo(
            "reproduction",
            "The Action Gate established that a code change is justified.",
          );
        }
        return;
      }

      if (event.type === "tool_result") {
        const prior = this.actions.get(event.id);
        if (!prior) return;
        const action: ActionRecord = {
          ...prior,
          output: asJsonValue(event.output),
          status: event.ok ? "succeeded" : "failed",
          completedAt: this.now().toISOString(),
        };
        this.actions.set(event.id, action);
        if (!event.ok) this.failedActions += 1;
        if (
          event.ok &&
          (event.name === "write_file" || event.name === "replace_in_file")
        ) {
          this.successfulEdits += 1;
          const path =
            typeof (prior.input as Record<string, unknown>).path === "string"
              ? String((prior.input as Record<string, unknown>).path)
              : "(unknown path)";
          this.changedPaths.add(path);
        }
        await this.store.append({
          taskId: this.taskId,
          kind: "action.recorded",
          payload: { action },
        });

        if (event.name === "run_command") {
          const input = prior.input as Record<string, unknown>;
          const command =
            typeof input.command === "string" ? input.command : "(unknown command)";
          const kind = verificationKind(command);
          if (kind) {
            const evidence: EvidenceRecord = {
              id: stableId("evidence", this.taskId, event.id, command),
              taskId: this.taskId,
              kind,
              grade: event.ok ? "tested" : "observed",
              origin: "agent_author",
              summary: event.ok
                ? `Command succeeded: ${command}`
                : `Command failed: ${command}`,
              supportsClaimIds: [],
              contradictsClaimIds: [],
              command,
              tool: "process",
              artifactDigests: [],
              stale: false,
              observedAt: this.now().toISOString(),
            };
            this.evidence.set(evidence.id, evidence);
            await this.store.append({
              taskId: this.taskId,
              kind: "evidence.recorded",
              payload: { evidence },
            });
          }
        }
        return;
      }

      if (event.type === "usage") {
        this.promptTokens += event.promptTokens ?? 0;
        this.completionTokens += event.completionTokens ?? 0;
        this.cachedTokens += event.cachedTokens ?? 0;
      }
    });
  }

  private currentGaps(
    baseWorkspaceDigest?: string,
    finalWorkspaceDigest?: string,
    additional: readonly string[] = [],
  ): string[] {
    const evidence = [...this.evidence.values()];
    const hasDigests = Boolean(baseWorkspaceDigest && finalWorkspaceDigest);
    const missingChecks = this.contract.requiredChecks.filter(
      (check) => !requiredCheckSatisfied(check, evidence, hasDigests),
    );
    return [
      ...missingChecks.map((check) => `Required check not established: ${check}`),
      ...(this.failedActions > 0
        ? [`${this.failedActions} tool action(s) failed or were denied.`]
        : []),
      ...additional,
    ].filter((value, index, values) => values.indexOf(value) === index);
  }

  private async writeCapsuleAndPassport(
    state: TaskState,
    gaps: string[],
    baseWorkspaceDigest?: string,
    finalWorkspaceDigest?: string,
  ): Promise<{ capsule: EvidenceCapsule; passport: ChangePassport }> {
    const generatedAt = this.now().toISOString();
    const capsule = createEvidenceCapsule({
      schemaVersion: 1,
      taskId: this.taskId,
      contract: this.contract,
      state,
      ...(baseWorkspaceDigest ? { baseWorkspaceDigest } : {}),
      ...(finalWorkspaceDigest ? { finalWorkspaceDigest } : {}),
      changedBehavior:
        this.successfulEdits > 0
          ? ["A staged patch was produced; behavior claims require the recorded checks."]
          : [],
      negativeGuarantees: [...this.contract.negativeGuarantees],
      evidence: [...this.evidence.values()],
      claims: [...this.claims.values()],
      gaps,
      approvals: [...this.approvals],
      cost: {
        promptTokens: this.promptTokens,
        completionTokens: this.completionTokens,
        cachedTokens: this.cachedTokens,
        elapsedMs: Math.max(0, Date.now() - this.startedAt),
      },
      generatedAt,
    });
    const passport = createChangePassport(capsule, {
      title: this.contract.request.slice(0, 120),
      summary:
        state === "review"
          ? "Patch and evidence are ready for review; publication has not occurred."
          : `Task finished with verdict ${state}.`,
      intentIds: [this.requirementIntent.id],
      changedPaths: [...this.changedPaths].sort(),
      provenance: [
        {
          source: "user",
          trust: "authoritative",
          sensitivity: "proprietary",
        },
        {
          source: "repository",
          trust: "untrusted",
          sensitivity: "proprietary",
        },
        {
          source: "generated",
          trust: "untrusted",
          sensitivity: "proprietary",
        },
      ],
      generatedAt,
    });
    await this.store.append({
      taskId: this.taskId,
      kind: "capsule.generated",
      payload: { capsule },
      occurredAt: generatedAt,
    });
    await this.store.append({
      taskId: this.taskId,
      kind: "passport.generated",
      payload: { passport },
      occurredAt: generatedAt,
    });
    return { capsule, passport };
  }

  async finish(
    options: FinishEvidenceTaskOptions = {},
  ): Promise<TaskProjection> {
    await this.flush();
    if (TERMINAL_STATES.has(this.state)) return this.store.task(this.taskId);

    if (!this.gate) {
      const gaps = [
        "Action/Abstention Gate was not established from repository evidence.",
        ...(options.additionalGaps ?? []),
      ];
      await this.transition("blocked", gaps[0]);
      await this.writeCapsuleAndPassport(
        "blocked",
        gaps,
        options.baseWorkspaceDigest,
        options.finalWorkspaceDigest,
      );
      return this.store.task(this.taskId);
    }

    if (!this.gate.shouldStageCode) {
      const state: TaskState =
        this.gate.outcome === "cannot_establish_safely"
          ? "blocked"
          : "abstained";
      const gaps =
        state === "blocked"
          ? [
              ...this.gate.reasons,
              ...(options.additionalGaps ?? []),
            ]
          : [...(options.additionalGaps ?? [])];
      await this.transition(state, this.gate.reasons.join(" "));
      await this.writeCapsuleAndPassport(
        state,
        gaps,
        options.baseWorkspaceDigest,
        options.finalWorkspaceDigest,
      );
      return this.store.task(this.taskId);
    }

    if (this.successfulEdits === 0) {
      const gaps = [
        "The Action Gate required a code change, but no publishable edit succeeded.",
        ...(options.additionalGaps ?? []),
      ];
      await this.transition("blocked", gaps[0]);
      await this.writeCapsuleAndPassport(
        "blocked",
        gaps,
        options.baseWorkspaceDigest,
        options.finalWorkspaceDigest,
      );
      return this.store.task(this.taskId);
    }

    if (
      options.baseWorkspaceDigest &&
      options.finalWorkspaceDigest &&
      options.baseWorkspaceDigest === options.finalWorkspaceDigest
    ) {
      const gaps = [
        "The Action Gate required a code change, but the staged workspace has no material source difference.",
        ...(options.additionalGaps ?? []),
      ];
      await this.transition("blocked", gaps[0]);
      await this.writeCapsuleAndPassport(
        "blocked",
        gaps,
        options.baseWorkspaceDigest,
        options.finalWorkspaceDigest,
      );
      return this.store.task(this.taskId);
    }

    if (this.state === "reproduction") {
      await this.advanceTo(
        "staging",
        "The staged patch contains successful publishable edits.",
      );
    }
    if (this.state === "staging") {
      await this.advanceTo(
        "verification",
        "Patch staging finished and recorded checks were evaluated.",
      );
    }
    if (this.state === "verification") {
      await this.advanceTo(
        "review",
        "Patch, evidence, and known gaps are ready for human review.",
      );
    }
    const gaps = this.currentGaps(
      options.baseWorkspaceDigest,
      options.finalWorkspaceDigest,
      [
        PUBLICATION_PENDING_GAP,
        ...(options.additionalGaps ?? []),
      ],
    );
    await this.writeCapsuleAndPassport(
      "review",
      gaps,
      options.baseWorkspaceDigest,
      options.finalWorkspaceDigest,
    );
    return this.store.task(this.taskId);
  }

  async markPublished(options: {
    acceptGaps?: boolean;
    baseWorkspaceDigest?: string;
    finalWorkspaceDigest?: string;
  } = {}): Promise<TaskProjection> {
    await this.flush();
    if (this.state !== "review") {
      throw new Error(`Only a reviewed task can be published; current state is ${this.state}.`);
    }
    const gaps = this.currentGaps(
      options.baseWorkspaceDigest,
      options.finalWorkspaceDigest,
    );
    if (gaps.length && !options.acceptGaps) {
      throw new Error(
        `Publication is blocked by ${gaps.length} evidence gap(s). Explicitly accept gaps to continue.`,
      );
    }
    if (gaps.length) {
      await this.transition(
        "accepted_with_gaps",
        "The user explicitly accepted the documented evidence gaps.",
      );
      await this.writeCapsuleAndPassport(
        "accepted_with_gaps",
        gaps,
        options.baseWorkspaceDigest,
        options.finalWorkspaceDigest,
      );
      return this.store.task(this.taskId);
    }
    await this.transition("publication", "Atomic ProofPatch publication succeeded.");
    await this.transition("complete", "All required evidence and publication checks passed.");
    await this.writeCapsuleAndPassport(
      "complete",
      [],
      options.baseWorkspaceDigest,
      options.finalWorkspaceDigest,
    );
    return this.store.task(this.taskId);
  }

  async fail(message: string): Promise<TaskProjection> {
    await this.flush();
    if (!TERMINAL_STATES.has(this.state)) {
      await this.transition("blocked", message);
      await this.writeCapsuleAndPassport("blocked", [message]);
    }
    return this.store.task(this.taskId);
  }

  async cancel(reason = "Task cancelled by the user."): Promise<TaskProjection> {
    await this.flush();
    if (!TERMINAL_STATES.has(this.state)) {
      await this.transition("cancelled", reason);
      await this.writeCapsuleAndPassport("cancelled", [reason]);
    }
    return this.store.task(this.taskId);
  }
}

export async function openEvidenceStore(cwd: string): Promise<ProofGraphStore> {
  return ProofGraphStore.open({ root: join(cwd, ".krater", "proofgraph") });
}

export async function listEvidenceTasks(
  cwd: string,
  projectId: string,
): Promise<EvidenceTaskSummary[]> {
  const store = await openEvidenceStore(cwd);
  const tasks = await store.tasks();
  return [...tasks.values()]
    .map((projection) => taskSummary(projection, projectId))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function readEvidenceTask(
  cwd: string,
  projectId: string,
  taskId: string,
): Promise<EvidenceTaskDetail> {
  const store = await openEvidenceStore(cwd);
  const replay = await store.replay();
  if (replay.tailCorruption) {
    throw new Error(
      `ProofGraph tail is corrupt at line ${replay.tailCorruption.lineNumber}.`,
    );
  }
  const projection = await store.task(taskId);
  const eventCount = replay.events.filter((event) => event.taskId === taskId).length;
  return taskDetail(projection, projectId, eventCount);
}

function publicationGaps(projection: TaskProjection): string[] {
  return (projection.capsule?.gaps ?? []).filter(
    (gap) => gap !== PUBLICATION_PENDING_GAP,
  );
}

function hasCurrentPublicationReceipt(
  projection: TaskProjection,
  baseWorkspaceDigest: string,
  finalWorkspaceDigest: string,
): boolean {
  return projection.evidence.some(
    (evidence) =>
      evidence.tool === "ProofPatch" &&
      /atomically published/i.test(evidence.summary) &&
      !evidence.stale &&
      evidence.artifactDigests.includes(baseWorkspaceDigest) &&
      evidence.artifactDigests.includes(finalWorkspaceDigest),
  );
}

function publicationFinalizationComplete(
  projection: TaskProjection,
): boolean {
  const capsule = projection.capsule;
  const passport = projection.passport;
  const baseWorkspaceDigest = capsule?.baseWorkspaceDigest;
  const finalWorkspaceDigest = capsule?.finalWorkspaceDigest;
  return Boolean(
    (projection.state === "complete" ||
      projection.state === "accepted_with_gaps") &&
      capsule &&
      passport &&
      capsule.state === projection.state &&
      passport.verdict === projection.state &&
      passport.capsuleDigest === capsule.digest &&
      !capsule.gaps.includes(PUBLICATION_PENDING_GAP) &&
      baseWorkspaceDigest &&
      finalWorkspaceDigest &&
      hasCurrentPublicationReceipt(
        projection,
        baseWorkspaceDigest,
        finalWorkspaceDigest,
      ),
  );
}

export async function evidencePublicationReadiness(
  cwd: string,
  taskId: string,
): Promise<EvidencePublicationReadiness> {
  const projection = await (await openEvidenceStore(cwd)).task(taskId);
  const gaps = publicationGaps(projection);
  return {
    taskId,
    state: projection.state,
    gaps,
    requiresGapAcceptance:
      gaps.length > 0 && projection.state !== "accepted_with_gaps",
    // `publication` is a durable recovery state: ProofPatch may already have
    // changed the workspace while capsule/passport finalization was interrupted.
    canPublish:
      projection.state === "review" ||
      projection.state === "publication" ||
      ((projection.state === "complete" ||
        projection.state === "accepted_with_gaps") &&
        !publicationFinalizationComplete(projection)),
  };
}

/**
 * Finalize durable task evidence only after ProofPatch reports a successful
 * atomic publication. This function never mutates source files.
 */
export async function finalizeEvidencePublication(
  cwd: string,
  taskId: string,
  options: FinalizeEvidencePublicationOptions = {},
): Promise<TaskProjection> {
  const store = await openEvidenceStore(cwd);
  let projection = await store.task(taskId);
  if (
    ![
      "review",
      "publication",
      "complete",
      "accepted_with_gaps",
    ].includes(projection.state)
  ) {
    throw new Error(
      `Only a reviewed ProofPatch can be finalized; current state is ${projection.state}.`,
    );
  }
  if (!projection.capsule || !projection.passport) {
    throw new Error("Reviewed task has no evidence capsule and Change Passport.");
  }

  const gaps = publicationGaps(projection);
  const gapsWereAlreadyAccepted = projection.state === "accepted_with_gaps";
  if (gaps.length && !options.acceptGaps && !gapsWereAlreadyAccepted) {
    throw new Error(
      `Publication is blocked by ${gaps.length} evidence gap(s). Explicitly accept gaps to continue.`,
    );
  }
  const baseWorkspaceDigest =
    options.baseWorkspaceDigest ?? projection.capsule.baseWorkspaceDigest;
  const finalWorkspaceDigest =
    options.finalWorkspaceDigest ?? projection.capsule.finalWorkspaceDigest;
  if (!baseWorkspaceDigest || !finalWorkspaceDigest) {
    throw new Error(
      "ProofPatch publication cannot be finalized without base and final workspace digests.",
    );
  }

  const fullyFinalized =
    (projection.state === "complete" ||
      projection.state === "accepted_with_gaps") &&
    projection.capsule.state === projection.state &&
    projection.passport.verdict === projection.state &&
    projection.passport.capsuleDigest === projection.capsule.digest &&
    !projection.capsule.gaps.includes(PUBLICATION_PENDING_GAP) &&
    hasCurrentPublicationReceipt(
      projection,
      baseWorkspaceDigest,
      finalWorkspaceDigest,
    );
  if (fullyFinalized) return projection;

  const observedAt = new Date().toISOString();
  const receiptEvidence: EvidenceRecord = {
    id: stableId(
      "evidence",
      taskId,
      "proofpatch-publication",
      options.transactionId ?? "",
      baseWorkspaceDigest,
      finalWorkspaceDigest,
    ),
    taskId,
    kind: "property",
    grade: "tested",
    origin: "tool",
    summary:
      "ProofPatch atomically published the reviewed transaction after unchanged-base digest checks.",
    supportsClaimIds: [],
    contradictsClaimIds: [],
    tool: "ProofPatch",
    artifactDigests: [baseWorkspaceDigest, finalWorkspaceDigest],
    stale: false,
    observedAt,
  };
  if (
    !hasCurrentPublicationReceipt(
      projection,
      baseWorkspaceDigest,
      finalWorkspaceDigest,
    )
  ) {
    await store.append({
      taskId,
      kind: "evidence.recorded",
      payload: { evidence: receiptEvidence },
      occurredAt: observedAt,
    });
    projection = await store.task(taskId);
  }

  if (projection.state === "review") {
    if (gaps.length) {
      await store.append({
        taskId,
        kind: "task.state.changed",
        payload: {
          from: "review",
          to: "accepted_with_gaps",
          reason:
            "The user explicitly accepted the documented evidence gaps after atomic publication.",
        },
        occurredAt: observedAt,
      });
    } else {
      await store.append({
        taskId,
        kind: "task.state.changed",
        payload: {
          from: "review",
          to: "publication",
          reason: "Atomic ProofPatch publication succeeded.",
        },
        occurredAt: observedAt,
      });
    }
    projection = await store.task(taskId);
  }
  if (projection.state === "publication") {
    await store.append({
      taskId,
      kind: "task.state.changed",
      payload: {
        from: "publication",
        to: "complete",
        reason: "All required evidence and publication checks passed.",
      },
      occurredAt: new Date().toISOString(),
    });
  }

  projection = await store.task(taskId);
  const state = projection.state;
  const priorCapsule = projection.capsule!;
  const evidence = projection.evidence;
  const approvals = [
    ...priorCapsule.approvals,
    ...(gaps.length ? ["human:accepted_documented_evidence_gaps"] : []),
  ].filter((value, index, values) => values.indexOf(value) === index);
  const generatedAt = new Date().toISOString();
  const capsule = createEvidenceCapsule({
    schemaVersion: 1,
    taskId,
    contract: projection.contract,
    state,
    baseWorkspaceDigest,
    finalWorkspaceDigest,
    changedBehavior: priorCapsule.changedBehavior,
    negativeGuarantees: priorCapsule.negativeGuarantees,
    evidence,
    claims: projection.claims,
    gaps,
    approvals,
    cost: priorCapsule.cost,
    generatedAt,
  });
  const passport = createChangePassport(capsule, {
    title: projection.passport!.title,
    summary:
      state === "complete"
        ? "The reviewed patch was atomically published with all required evidence established."
        : "The reviewed patch was atomically published after explicit acceptance of documented gaps.",
    intentIds: projection.passport!.intentIds,
    changedPaths: projection.passport!.changedPaths,
    provenance: projection.passport!.provenance,
    generatedAt,
  });
  await store.append({
    taskId,
    kind: "capsule.generated",
    payload: { capsule },
    occurredAt: generatedAt,
  });
  await store.append({
    taskId,
    kind: "passport.generated",
    payload: { passport },
    occurredAt: generatedAt,
  });
  return store.task(taskId);
}

/**
 * Record an explicit user cancellation after any staged ProofPatch has already
 * been discarded. This function never changes source files.
 *
 * Retrying after a crash is safe: a `cancelled` state with an incomplete
 * capsule/passport is repaired, while a fully recorded cancellation is
 * returned unchanged.
 */
export async function cancelEvidenceTask(
  cwd: string,
  taskId: string,
  options: CancelEvidenceTaskOptions = {},
): Promise<TaskProjection> {
  const store = await openEvidenceStore(cwd);
  let projection = await store.task(taskId);
  const reason = (
    options.reason?.trim() || "Task cancelled explicitly by the user."
  ).slice(0, 1_000);

  if (
    projection.state === "cancelled" &&
    projection.capsule?.state === "cancelled" &&
    projection.passport?.verdict === "cancelled" &&
    projection.passport.capsuleDigest === projection.capsule.digest
  ) {
    return projection;
  }
  if (projection.state === "publication") {
    throw new Error(
      "Task publication has started; cancellation is unavailable. Complete or roll back the ProofPatch explicitly.",
    );
  }
  if (
    ["complete", "abstained", "blocked", "accepted_with_gaps"].includes(
      projection.state,
    )
  ) {
    throw new Error(
      `Task is already ${projection.state} and cannot be cancelled.`,
    );
  }
  if (projection.state !== "cancelled") {
    await store.append({
      taskId,
      kind: "task.state.changed",
      payload: {
        from: projection.state,
        to: "cancelled",
        reason,
      },
    });
    projection = await store.task(taskId);
  }

  const discarded = options.discardedProofPatch;
  const observedAt = new Date().toISOString();
  if (discarded) {
    const discardEvidence: EvidenceRecord = {
      id: stableId(
        "evidence",
        taskId,
        "proofpatch-cancel-discard",
        discarded.transactionId,
      ),
      taskId,
      kind: "property",
      grade: "tested",
      origin: "tool",
      summary: `Staged ProofPatch transaction ${discarded.transactionId} was discarded before task cancellation.`,
      supportsClaimIds: [],
      contradictsClaimIds: [],
      tool: "ProofPatch",
      artifactDigests: [
        discarded.baseWorkspaceDigest,
        discarded.finalWorkspaceDigest,
      ].filter((value): value is string => Boolean(value)),
      stale: false,
      observedAt,
    };
    if (!projection.evidence.some((item) => item.id === discardEvidence.id)) {
      await store.append({
        taskId,
        kind: "evidence.recorded",
        payload: { evidence: discardEvidence },
        occurredAt: observedAt,
      });
      projection = await store.task(taskId);
    }
  }

  const priorCapsule = projection.capsule;
  const priorPassport = projection.passport;
  const baseWorkspaceDigest =
    discarded?.baseWorkspaceDigest ?? priorCapsule?.baseWorkspaceDigest;
  const finalWorkspaceDigest =
    discarded?.finalWorkspaceDigest ?? priorCapsule?.finalWorkspaceDigest;
  const cancellationGap = discarded
    ? "The staged ProofPatch was discarded; no task change was published."
    : "The task was cancelled before publication.";
  const gaps = [
    ...(priorCapsule?.gaps ?? []).filter(
      (gap) => gap !== PUBLICATION_PENDING_GAP,
    ),
    reason,
    cancellationGap,
  ].filter((value, index, values) => values.indexOf(value) === index);
  const generatedAt = new Date().toISOString();
  const capsule = createEvidenceCapsule({
    schemaVersion: 1,
    taskId,
    contract: projection.contract,
    state: "cancelled",
    ...(baseWorkspaceDigest ? { baseWorkspaceDigest } : {}),
    ...(finalWorkspaceDigest ? { finalWorkspaceDigest } : {}),
    changedBehavior: [],
    negativeGuarantees:
      priorCapsule?.negativeGuarantees ??
      [...projection.contract.negativeGuarantees],
    evidence: projection.evidence,
    claims: projection.claims,
    gaps,
    approvals: [
      ...(priorCapsule?.approvals ?? []),
      "human:requested_task_cancellation",
    ].filter((value, index, values) => values.indexOf(value) === index),
    cost:
      priorCapsule?.cost ?? {
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        elapsedMs: 0,
      },
    generatedAt,
  });
  const passport = createChangePassport(capsule, {
    title: priorPassport?.title ?? projection.contract.request.slice(0, 120),
    summary: discarded
      ? "The user cancelled the task after its staged ProofPatch was safely discarded."
      : "The user cancelled the task before any ProofPatch publication.",
    intentIds:
      priorPassport?.intentIds ?? projection.intents.map((intent) => intent.id),
    changedPaths: [
      ...(priorPassport?.changedPaths ?? []),
      ...(discarded?.changedPaths ?? []),
    ]
      .filter((value, index, values) => values.indexOf(value) === index)
      .sort(),
    provenance:
      priorPassport?.provenance ?? [
        {
          source: "user",
          trust: "authoritative",
          sensitivity: "proprietary",
        },
        {
          source: "repository",
          trust: "untrusted",
          sensitivity: "proprietary",
        },
      ],
    generatedAt,
  });
  await store.append({
    taskId,
    kind: "capsule.generated",
    payload: { capsule },
    occurredAt: generatedAt,
  });
  await store.append({
    taskId,
    kind: "passport.generated",
    payload: { passport },
    occurredAt: generatedAt,
  });
  return store.task(taskId);
}

/**
 * Record a completed ProofPatch rollback in the append-only graph. A rollback
 * after publication preserves the historical task verdict while marking its
 * publication evidence stale and making the current workspace gap explicit.
 */
export async function recordEvidenceRollback(
  cwd: string,
  taskId: string,
  options: RecordEvidenceRollbackOptions,
): Promise<TaskProjection> {
  const store = await openEvidenceStore(cwd);
  let projection = await store.task(taskId);
  if (!projection.capsule || !projection.passport) {
    throw new Error("Task has no evidence capsule and Change Passport to update.");
  }
  if (
    ![
      "review",
      "publication",
      "complete",
      "accepted_with_gaps",
      "cancelled",
    ].includes(
      projection.state,
    )
  ) {
    throw new Error(
      `ProofPatch rollback cannot be attached while task state is ${projection.state}.`,
    );
  }
  if (
    projection.state === "cancelled" &&
    projection.evidence.some(
      (item) =>
        item.tool === "ProofPatch" &&
        item.summary.includes(options.transactionId) &&
        /rolled back|discarded/i.test(item.summary),
    )
  ) {
    return projection;
  }

  const observedAt = new Date().toISOString();
  if (options.wasPublished) {
    for (const evidence of projection.evidence) {
      if (
        evidence.tool === "ProofPatch" &&
        /atomically published/i.test(evidence.summary) &&
        !evidence.stale
      ) {
        await store.append({
          taskId,
          kind: "evidence.recorded",
          payload: {
            evidence: {
              ...evidence,
              stale: true,
            },
          },
          occurredAt: observedAt,
        });
      }
    }
  }

  const baseWorkspaceDigest =
    options.baseWorkspaceDigest ?? projection.capsule.baseWorkspaceDigest;
  const finalWorkspaceDigest =
    options.finalWorkspaceDigest ?? projection.capsule.finalWorkspaceDigest;
  const rollbackEvidence: EvidenceRecord = {
    id: stableId(
      "evidence",
      taskId,
      "proofpatch-rollback",
      options.transactionId,
    ),
    taskId,
    kind: "property",
    grade: "tested",
    origin: "tool",
    summary: options.wasPublished
      ? `ProofPatch transaction ${options.transactionId} was rolled back after post-image conflict checks.`
      : `Staged ProofPatch transaction ${options.transactionId} was discarded before publication.`,
    supportsClaimIds: [],
    contradictsClaimIds: [],
    tool: "ProofPatch",
    artifactDigests: [baseWorkspaceDigest, finalWorkspaceDigest].filter(
      (value): value is string => Boolean(value),
    ),
    stale: false,
    observedAt,
  };
  if (!projection.evidence.some((item) => item.id === rollbackEvidence.id)) {
    await store.append({
      taskId,
      kind: "evidence.recorded",
      payload: { evidence: rollbackEvidence },
      occurredAt: observedAt,
    });
  }
  if (projection.state === "review" || projection.state === "publication") {
    const from = projection.state;
    await store.append({
      taskId,
      kind: "task.state.changed",
      payload: {
        from,
        to: "cancelled",
        reason:
          from === "publication"
            ? "The user rolled back the ProofPatch while evidence finalization was pending."
            : "The user discarded the staged ProofPatch before publication.",
      },
      occurredAt: observedAt,
    });
  }
  projection = await store.task(taskId);

  const rollbackGap = options.wasPublished
    ? "The published ProofPatch was subsequently rolled back; its changed behavior is no longer present in the workspace."
    : "The staged ProofPatch was discarded before publication.";
  const gaps = [
    ...(projection.capsule?.gaps ?? []).filter(
      (gap) => gap !== PUBLICATION_PENDING_GAP,
    ),
    rollbackGap,
  ].filter((value, index, values) => values.indexOf(value) === index);
  const generatedAt = new Date().toISOString();
  const priorCapsule = projection.capsule!;
  const capsule = createEvidenceCapsule({
    schemaVersion: 1,
    taskId,
    contract: projection.contract,
    state: projection.state,
    ...(baseWorkspaceDigest ? { baseWorkspaceDigest } : {}),
    ...(finalWorkspaceDigest ? { finalWorkspaceDigest } : {}),
    changedBehavior: options.wasPublished ? [] : priorCapsule.changedBehavior,
    negativeGuarantees: priorCapsule.negativeGuarantees,
    evidence: projection.evidence,
    claims: projection.claims,
    gaps,
    approvals: [
      ...priorCapsule.approvals,
      "human:requested_proofpatch_rollback",
    ].filter((value, index, values) => values.indexOf(value) === index),
    cost: priorCapsule.cost,
    generatedAt,
  });
  const passport = createChangePassport(capsule, {
    title: projection.passport!.title,
    summary: options.wasPublished
      ? "The previously published ProofPatch was safely rolled back; the passport retains the historical verdict and marks publication evidence stale."
      : "The reviewed ProofPatch was discarded before publication.",
    intentIds: projection.passport!.intentIds,
    changedPaths: projection.passport!.changedPaths,
    provenance: projection.passport!.provenance,
    generatedAt,
  });
  await store.append({
    taskId,
    kind: "capsule.generated",
    payload: { capsule },
    occurredAt: generatedAt,
  });
  await store.append({
    taskId,
    kind: "passport.generated",
    payload: { passport },
    occurredAt: generatedAt,
  });
  return store.task(taskId);
}

export function renderPassportMarkdown(
  projection: TaskProjection,
): string {
  const passport = projection.passport;
  const capsule = projection.capsule;
  if (!passport || !capsule) {
    throw new Error("This task does not have a generated Change Passport.");
  }
  const list = (values: readonly string[], empty: string) =>
    values.length ? values.map((value) => `- ${value}`).join("\n") : `- ${empty}`;
  return [
    `# Krater Pro Change Passport`,
    "",
    `## ${passport.title}`,
    "",
    passport.summary,
    "",
    `- Task: \`${passport.taskId}\``,
    `- Verdict: \`${passport.verdict}\``,
    `- Assurance: \`${passport.assurance}\``,
    `- Weakest evidence: \`${passport.weakestEvidenceGrade}\``,
    `- Capsule digest: \`${passport.capsuleDigest}\``,
    `- Passport digest: \`${passport.digest}\``,
    "",
    "## Changed paths",
    "",
    list(passport.changedPaths, "No source paths changed."),
    "",
    "## Evidence",
    "",
    ...(capsule.evidence.length
      ? capsule.evidence.flatMap((evidence) => [
          `### ${evidence.summary}`,
          "",
          `- Kind: \`${evidence.kind}\``,
          `- Grade: \`${evidence.grade}\``,
          `- Origin: \`${evidence.origin}\``,
          `- Stale: \`${evidence.stale}\``,
          "",
        ])
      : ["- No verification evidence was established.", ""]),
    "## Known gaps",
    "",
    list(passport.gaps, "None recorded."),
    "",
    "## Negative guarantees",
    "",
    list(capsule.negativeGuarantees, "None recorded."),
    "",
    "> Verify the JSON capsule and passport digests with `krater proof verify`.",
    "",
  ].join("\n");
}

export function projectionWeakestGrade(
  projection: TaskProjection,
): EvidenceGrade {
  return weakestEvidenceGrade(
    projection.evidence.filter((item) => !item.stale).map((item) => item.grade),
  );
}
