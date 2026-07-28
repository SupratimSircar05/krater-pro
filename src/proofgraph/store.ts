import { constants } from "node:fs";
import {
  chmod,
  lstat,
  open,
  unlink,
} from "node:fs/promises";
import { join, parse, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  assertValidAgentDelegation,
  assertValidExternalEffectPlan,
  assertValidExternalEffectReceipt,
  assertValidPlanRevision,
  assertValidProductionObservation,
  assertValidProofLease,
  assertValidProofLeaseInvalidation,
} from "../autopilot/records.js";
import type { ProofObligation } from "../autopilot/types.js";
import { canonicalStringify, sha256Hex } from "./canonical.js";
import { ContentAddressedStore } from "./cas.js";
import {
  ensureProtectedDirectory,
  noFollowFlag,
  readPrivateFile,
  rejectSymlink,
  syncDirectory,
} from "./filesystem.js";
import {
  assertTaskStateTransition,
  rebuildAllTaskProjections,
  rebuildTaskProjection,
} from "./projection.js";
import { redactForPersistence } from "./redaction.js";
import type {
  AppendProofGraphEvent,
  ProofGraphEventKind,
  StoredProofGraphEvent,
  TaskProjection,
} from "./types.js";

const HASH = /^[a-f0-9]{64}$/;
const EVIDENCE_WEIGHT = {
  not_established: 0,
  observed: 1,
  tested: 2,
  stress_tested: 3,
  formally_verified: 4,
} as const;
const EVENT_KINDS = new Set<ProofGraphEventKind>([
  "task.created",
  "task.state.changed",
  "contract.set",
  "intent.recorded",
  "action.recorded",
  "evidence.recorded",
  "claim.recorded",
  "capsule.generated",
  "passport.generated",
  "autopilot.plan.revised",
  "autopilot.delegation.recorded",
  "autopilot.external_effect.planned",
  "autopilot.external_effect.receipt.recorded",
  "autopilot.proof_lease.issued",
  "autopilot.proof_lease.invalidated",
  "autopilot.production.observed",
]);

export type TailCorruptionKind =
  | "incomplete_line"
  | "invalid_json"
  | "invalid_event"
  | "sequence_mismatch"
  | "chain_mismatch"
  | "hash_mismatch";

export interface TailCorruption {
  kind: TailCorruptionKind;
  lineNumber: number;
  byteOffset: number;
  validBytes: number;
  reason: string;
}

export interface ReplayResult {
  events: StoredProofGraphEvent[];
  headHash: string | null;
  validBytes: number;
  tailCorruption?: TailCorruption;
}

export interface ProofGraphStoreOptions {
  root: string;
  lockTimeoutMs?: number;
  staleLockMs?: number;
}

export class ProofGraphCorruptionError extends Error {
  constructor(
    message: string,
    readonly lineNumber: number,
    readonly byteOffset: number,
  ) {
    super(message);
    this.name = "ProofGraphCorruptionError";
  }
}

export class ProofGraphTailCorruptionError extends Error {
  constructor(readonly corruption: TailCorruption) {
    super(
      `ProofGraph has a corrupt tail at line ${corruption.lineNumber}: ${corruption.reason}`,
    );
    this.name = "ProofGraphTailCorruptionError";
  }
}

interface UnsignedEvent {
  schemaVersion: 1;
  sequence: number;
  eventId: string;
  taskId: string;
  occurredAt: string;
  kind: ProofGraphEventKind;
  payload: unknown;
  previousHash: string | null;
}

function assertCurrentObligationEvidence(
  obligation: ProofObligation,
  projection: TaskProjection,
  leasedEvidenceIds?: ReadonlySet<string>,
): void {
  if (obligation.status === "waived") return;
  if (obligation.status !== "satisfied") {
    throw new TypeError(
      `Proof obligation is not cleared: ${obligation.id}`,
    );
  }
  const current = obligation.evidenceIds
    .map((evidenceId) =>
      projection.evidence.find((evidence) => evidence.id === evidenceId),
    )
    .filter(
      (evidence): evidence is NonNullable<typeof evidence> =>
        evidence !== undefined &&
        !evidence.stale &&
        (!leasedEvidenceIds || leasedEvidenceIds.has(evidence.id)),
    );
  if (current.length === 0) {
    throw new TypeError(
      `Proof obligation lacks current evidence: ${obligation.id}`,
    );
  }
  const strongest = current.reduce(
    (weight, evidence) => Math.max(weight, EVIDENCE_WEIGHT[evidence.grade]),
    0,
  );
  if (strongest < EVIDENCE_WEIGHT[obligation.minimumGrade]) {
    throw new TypeError(
      `Proof obligation does not meet grade ${obligation.minimumGrade}: ${obligation.id}`,
    );
  }
}

function validateAppendSemantics(
  events: readonly StoredProofGraphEvent[],
  input: AppendProofGraphEvent,
): void {
  const taskEvents = events.filter((event) => event.taskId === input.taskId);
  if (input.kind === "task.created") {
    if (taskEvents.length) {
      throw new Error(`ProofGraph task already exists: ${input.taskId}`);
    }
    if (input.payload.contract.taskId !== input.taskId) {
      throw new TypeError("Task contract ID must match the event task ID.");
    }
    return;
  }
  if (!taskEvents.some((event) => event.kind === "task.created")) {
    throw new Error(`ProofGraph task does not exist: ${input.taskId}`);
  }

  const current = rebuildTaskProjection(events, input.taskId);
  if (input.kind === "task.state.changed") {
    if (input.payload.from && input.payload.from !== current.state) {
      throw new Error(
        `Task state event expected ${input.payload.from}, current state is ${current.state}.`,
      );
    }
    assertTaskStateTransition(current.state, input.payload.to);
    return;
  }

  let recordTaskId: string;
  switch (input.kind) {
    case "contract.set":
      recordTaskId = input.payload.contract.taskId;
      break;
    case "intent.recorded":
      recordTaskId = input.payload.intent.taskId;
      break;
    case "action.recorded":
      recordTaskId = input.payload.action.taskId;
      break;
    case "evidence.recorded":
      recordTaskId = input.payload.evidence.taskId;
      break;
    case "claim.recorded":
      recordTaskId = input.payload.claim.taskId;
      break;
    case "capsule.generated":
      recordTaskId = input.payload.capsule.taskId;
      break;
    case "passport.generated":
      recordTaskId = input.payload.passport.taskId;
      break;
    case "autopilot.plan.revised":
      recordTaskId = input.payload.plan.taskId;
      assertValidPlanRevision(current.autopilot.currentPlan, input.payload.plan);
      for (const obligation of input.payload.plan.proofObligations) {
        if (obligation.status === "satisfied") {
          assertCurrentObligationEvidence(obligation, current);
        }
      }
      break;
    case "autopilot.delegation.recorded": {
      const delegation = input.payload.delegation;
      recordTaskId = delegation.taskId;
      assertValidAgentDelegation(delegation);
      const plan = current.autopilot.currentPlan;
      if (
        !plan ||
        delegation.planId !== plan.id ||
        delegation.planDigest !== plan.digest
      ) {
        throw new TypeError(
          "Agent delegation must reference the current task plan revision.",
        );
      }
      if (
        current.autopilot.delegations.some(
          (existing) => existing.id === delegation.id,
        )
      ) {
        throw new Error(`Agent delegation already exists: ${delegation.id}`);
      }
      const stepIds = new Set(plan.steps.map((step) => step.id));
      const missing = delegation.stepIds.find((stepId) => !stepIds.has(stepId));
      if (missing) {
        throw new TypeError(
          `Agent delegation references missing plan step: ${missing}`,
        );
      }
      const currentEvidenceIds = new Set(
        current.evidence
          .filter((evidence) => !evidence.stale)
          .map((evidence) => evidence.id),
      );
      const missingEvidence = delegation.resultEvidenceIds.find(
        (evidenceId) => !currentEvidenceIds.has(evidenceId),
      );
      if (missingEvidence) {
        throw new TypeError(
          `Agent delegation references missing or stale evidence: ${missingEvidence}`,
        );
      }
      break;
    }
    case "autopilot.external_effect.planned": {
      const effectPlan = input.payload.effectPlan;
      recordTaskId = effectPlan.taskId;
      assertValidExternalEffectPlan(effectPlan);
      const plan = current.autopilot.currentPlan;
      if (
        !plan ||
        effectPlan.planId !== plan.id ||
        effectPlan.planDigest !== plan.digest
      ) {
        throw new TypeError(
          "External effect must reference the current task plan revision.",
        );
      }
      if (
        current.autopilot.externalEffectPlans.some(
          (existing) => existing.id === effectPlan.id,
        )
      ) {
        throw new Error(`External effect plan already exists: ${effectPlan.id}`);
      }
      if (!plan.steps.some((step) => step.id === effectPlan.stepId)) {
        throw new TypeError(
          `External effect references missing plan step: ${effectPlan.stepId}`,
        );
      }
      const obligations = new Map(
        plan.proofObligations.map((obligation) => [obligation.id, obligation]),
      );
      for (const obligationId of effectPlan.preconditionProofObligationIds) {
        const obligation = obligations.get(obligationId);
        if (!obligation) {
          throw new TypeError(
            `External effect references missing proof obligation: ${obligationId}`,
          );
        }
        if (!["satisfied", "waived"].includes(obligation.status)) {
          throw new TypeError(
            `External effect proof obligation is not cleared: ${obligationId}`,
          );
        }
        assertCurrentObligationEvidence(obligation, current);
      }
      break;
    }
    case "autopilot.external_effect.receipt.recorded": {
      const receipt = input.payload.receipt;
      recordTaskId = receipt.taskId;
      assertValidExternalEffectReceipt(receipt);
      if (
        current.autopilot.externalEffectReceipts.some(
          (existing) => existing.id === receipt.id,
        )
      ) {
        throw new Error(`External effect receipt already exists: ${receipt.id}`);
      }
      const effectPlan = current.autopilot.externalEffectPlans.find(
        (candidate) => candidate.id === receipt.effectPlanId,
      );
      if (!effectPlan || effectPlan.digest !== receipt.effectPlanDigest) {
        throw new TypeError(
          "External effect receipt does not match a durable effect plan.",
        );
      }
      if (
        effectPlan.approvalRequired &&
        receipt.status !== "refused" &&
        !receipt.approvalReceiptDigest
      ) {
        throw new TypeError(
          "External effect receipt requires an exact approval receipt digest.",
        );
      }
      if (Date.parse(receipt.startedAt) > Date.parse(effectPlan.expiresAt)) {
        throw new TypeError(
          "External effect execution started after its plan expired.",
        );
      }
      const currentEvidenceIds = new Set(
        current.evidence
          .filter((evidence) => !evidence.stale)
          .map((evidence) => evidence.id),
      );
      const missingReceiptEvidence = [
        ...receipt.preflightEvidenceIds,
        ...receipt.resultEvidenceIds,
      ].find((evidenceId) => !currentEvidenceIds.has(evidenceId));
      if (missingReceiptEvidence) {
        throw new TypeError(
          `External effect receipt references missing or stale evidence: ${missingReceiptEvidence}`,
        );
      }
      const priorReceipts =
        current.autopilot.externalEffectReceipts.filter(
          (candidate) => candidate.effectPlanId === effectPlan.id,
        );
      if (receipt.status === "compensated") {
        if (
          !priorReceipts.some((candidate) =>
            ["succeeded", "partially_succeeded"].includes(candidate.status),
          )
        ) {
          throw new TypeError(
            "A compensation receipt requires a prior successful or partial effect.",
          );
        }
      } else if (
        priorReceipts.some((candidate) =>
          ["succeeded", "partially_succeeded", "compensated"].includes(
            candidate.status,
          ),
        )
      ) {
        throw new Error(
          "External effect plan already has a terminal mutating receipt.",
        );
      }
      break;
    }
    case "autopilot.proof_lease.issued": {
      const lease = input.payload.lease;
      recordTaskId = lease.taskId;
      assertValidProofLease(lease);
      if (
        current.autopilot.proofLeases.some(
          (existing) => existing.id === lease.id,
        )
      ) {
        throw new Error(`Proof lease already exists: ${lease.id}`);
      }
      const plan = current.autopilot.currentPlan;
      if (
        !plan ||
        lease.planId !== plan.id ||
        lease.planRevision !== plan.revision ||
        lease.planDigest !== plan.digest
      ) {
        throw new TypeError(
          "Proof lease must reference the current task plan revision.",
        );
      }
      const obligations = new Map(
        plan.proofObligations.map((obligation) => [obligation.id, obligation]),
      );
      const evidenceIds = new Set(current.evidence.map((evidence) => evidence.id));
      const leasedEvidenceIds = new Set(lease.evidenceIds);
      for (const obligationId of lease.proofObligationIds) {
        const obligation = obligations.get(obligationId);
        if (!obligation) {
          throw new TypeError(
            `Proof lease references missing proof obligation: ${obligationId}`,
          );
        }
        if (!["satisfied", "waived"].includes(obligation.status)) {
          throw new TypeError(
            `Proof lease obligation is not cleared: ${obligationId}`,
          );
        }
        assertCurrentObligationEvidence(
          obligation,
          current,
          leasedEvidenceIds,
        );
      }
      const missingEvidence = lease.evidenceIds.find(
        (evidenceId) =>
          !evidenceIds.has(evidenceId) ||
          current.evidence.find((evidence) => evidence.id === evidenceId)?.stale,
      );
      if (missingEvidence) {
        throw new TypeError(
          `Proof lease references missing evidence: ${missingEvidence}`,
        );
      }
      break;
    }
    case "autopilot.proof_lease.invalidated": {
      const invalidation = input.payload.invalidation;
      recordTaskId = invalidation.taskId;
      assertValidProofLeaseInvalidation(invalidation);
      if (
        current.autopilot.proofLeaseInvalidations.some(
          (existing) => existing.id === invalidation.id,
        )
      ) {
        throw new Error(
          `Proof lease invalidation already exists: ${invalidation.id}`,
        );
      }
      const lease = current.autopilot.proofLeases.find(
        (candidate) => candidate.id === invalidation.leaseId,
      );
      if (!lease || lease.digest !== invalidation.leaseDigest) {
        throw new TypeError(
          "Proof lease invalidation does not match a durable proof lease.",
        );
      }
      break;
    }
    case "autopilot.production.observed": {
      const observation = input.payload.observation;
      recordTaskId = observation.taskId;
      assertValidProductionObservation(observation);
      if (
        current.autopilot.productionObservations.some(
          (existing) => existing.id === observation.id,
        )
      ) {
        throw new Error(
          `Production observation already exists: ${observation.id}`,
        );
      }
      if (
        observation.effectReceiptDigest &&
        !current.autopilot.externalEffectReceipts.some(
          (receipt) => receipt.digest === observation.effectReceiptDigest,
        )
      ) {
        throw new TypeError(
          "Production observation references an unknown external effect receipt.",
        );
      }
      const evidenceIds = new Set(current.evidence.map((evidence) => evidence.id));
      const missingEvidence = observation.evidenceIds.find(
        (evidenceId) =>
          !evidenceIds.has(evidenceId) ||
          current.evidence.find((evidence) => evidence.id === evidenceId)?.stale,
      );
      if (missingEvidence) {
        throw new TypeError(
          `Production observation references missing evidence: ${missingEvidence}`,
        );
      }
      break;
    }
    default: {
      const neverInput: never = input;
      throw new TypeError(
        `Unsupported ProofGraph event: ${(neverInput as AppendProofGraphEvent).kind}`,
      );
    }
  }
  if (recordTaskId !== input.taskId) {
    throw new TypeError(`${input.kind} payload task ID must match the event task ID.`);
  }
}

function eventError(
  value: unknown,
  expectedSequence: number,
  expectedPreviousHash: string | null,
): { kind: TailCorruptionKind; reason: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "invalid_event", reason: "Event is not an object." };
  }
  const event = value as Record<string, unknown>;
  if (
    event.schemaVersion !== 1 ||
    typeof event.sequence !== "number" ||
    !Number.isSafeInteger(event.sequence) ||
    event.sequence < 1 ||
    typeof event.eventId !== "string" ||
    !event.eventId ||
    typeof event.taskId !== "string" ||
    !event.taskId ||
    typeof event.occurredAt !== "string" ||
    !Number.isFinite(Date.parse(event.occurredAt)) ||
    typeof event.kind !== "string" ||
    !EVENT_KINDS.has(event.kind as ProofGraphEventKind) ||
    !event.payload ||
    typeof event.payload !== "object" ||
    Array.isArray(event.payload) ||
    (event.previousHash !== null &&
      (typeof event.previousHash !== "string" || !HASH.test(event.previousHash))) ||
    typeof event.hash !== "string" ||
    !HASH.test(event.hash)
  ) {
    return { kind: "invalid_event", reason: "Event envelope is invalid." };
  }
  if (event.sequence !== expectedSequence) {
    return {
      kind: "sequence_mismatch",
      reason: `Expected sequence ${expectedSequence}, found ${event.sequence}.`,
    };
  }
  if (event.previousHash !== expectedPreviousHash) {
    return {
      kind: "chain_mismatch",
      reason: "Event previousHash does not match the verified chain head.",
    };
  }
  const { hash, ...unsigned } = event;
  if (sha256Hex(canonicalStringify(unsigned)) !== hash) {
    return { kind: "hash_mismatch", reason: "Event content hash is invalid." };
  }
  return undefined;
}

function tailCorruption(
  kind: TailCorruptionKind,
  lineNumber: number,
  byteOffset: number,
  validBytes: number,
  reason: string,
): TailCorruption {
  return { kind, lineNumber, byteOffset, validBytes, reason };
}

export class ProofGraphStore {
  readonly root: string;
  readonly eventsPath: string;
  readonly cas: ContentAddressedStore;
  private readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;

  private constructor(options: ProofGraphStoreOptions) {
    this.root = resolve(options.root);
    if (!options.root.trim() || this.root === parse(this.root).root) {
      throw new TypeError("ProofGraph root must be a dedicated non-root directory.");
    }
    this.eventsPath = join(this.root, "events.ndjson");
    this.lockPath = join(this.root, ".append.lock");
    this.cas = new ContentAddressedStore(join(this.root, "cas"));
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
    this.staleLockMs = options.staleLockMs ?? 30_000;
  }

  static async open(options: ProofGraphStoreOptions): Promise<ProofGraphStore> {
    const store = new ProofGraphStore(options);
    await ensureProtectedDirectory(store.root);
    await rejectSymlink(store.eventsPath);
    await store.cas.initialize();
    return store;
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    const startedAt = Date.now();
    while (true) {
      let handle;
      try {
        handle = await open(
          this.lockPath,
          constants.O_CREAT |
            constants.O_EXCL |
            constants.O_WRONLY |
            noFollowFlag(),
          0o600,
        );
        await handle.writeFile(
          canonicalStringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
        );
        await handle.sync();
        await handle.close();
        handle = undefined;
        return async () => {
          await unlink(this.lockPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
        };
      } catch (error) {
        await handle?.close().catch(() => undefined);
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          if (handle) await unlink(this.lockPath).catch(() => undefined);
          throw error;
        }
        const details = await lstat(this.lockPath).catch(() => undefined);
        if (details && Date.now() - details.mtimeMs > this.staleLockMs) {
          await unlink(this.lockPath).catch(() => undefined);
          continue;
        }
        if (Date.now() - startedAt >= this.lockTimeoutMs) {
          throw new Error(`Timed out acquiring ProofGraph append lock: ${this.lockPath}`);
        }
        await delay(10);
      }
    }
  }

  async replay(): Promise<ReplayResult> {
    await rejectSymlink(this.eventsPath);
    let data: Buffer;
    try {
      data = await readPrivateFile(this.eventsPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { events: [], headHash: null, validBytes: 0 };
      }
      throw error;
    }
    if (!data.length) return { events: [], headHash: null, validBytes: 0 };

    const lineRanges: Array<{ start: number; end: number }> = [];
    let start = 0;
    for (let index = 0; index < data.length; index += 1) {
      if (data[index] === 0x0a) {
        lineRanges.push({ start, end: index });
        start = index + 1;
      }
    }
    const hasIncompleteTail = start < data.length;
    const events: StoredProofGraphEvent[] = [];
    let previousHash: string | null = null;
    let validBytes = 0;

    for (let index = 0; index < lineRanges.length; index += 1) {
      const range = lineRanges[index];
      const lineNumber = index + 1;
      const isRecoverableTail = index === lineRanges.length - 1 && !hasIncompleteTail;
      const line = data.subarray(range.start, range.end).toString("utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        const reason = `Invalid JSON: ${(error as Error).message}`;
        if (isRecoverableTail) {
          return {
            events,
            headHash: previousHash,
            validBytes,
            tailCorruption: tailCorruption(
              "invalid_json",
              lineNumber,
              range.start,
              validBytes,
              reason,
            ),
          };
        }
        throw new ProofGraphCorruptionError(reason, lineNumber, range.start);
      }
      const problem = eventError(parsed, events.length + 1, previousHash);
      if (problem) {
        if (isRecoverableTail) {
          return {
            events,
            headHash: previousHash,
            validBytes,
            tailCorruption: tailCorruption(
              problem.kind,
              lineNumber,
              range.start,
              validBytes,
              problem.reason,
            ),
          };
        }
        throw new ProofGraphCorruptionError(problem.reason, lineNumber, range.start);
      }
      const event = parsed as StoredProofGraphEvent;
      events.push(event);
      previousHash = event.hash;
      validBytes = range.end + 1;
    }

    if (hasIncompleteTail) {
      return {
        events,
        headHash: previousHash,
        validBytes,
        tailCorruption: tailCorruption(
          "incomplete_line",
          lineRanges.length + 1,
          start,
          validBytes,
          "Final event is not newline-terminated.",
        ),
      };
    }
    return { events, headHash: previousHash, validBytes };
  }

  async append(input: AppendProofGraphEvent): Promise<StoredProofGraphEvent> {
    const release = await this.acquireLock();
    try {
      const replay = await this.replay();
      if (replay.tailCorruption) {
        throw new ProofGraphTailCorruptionError(replay.tailCorruption);
      }
      if (
        input.eventId &&
        replay.events.some((event) => event.eventId === input.eventId)
      ) {
        throw new Error(`ProofGraph event ID already exists: ${input.eventId}`);
      }
      validateAppendSemantics(replay.events, input);
      const payload = redactForPersistence(input.payload);
      const unsigned: UnsignedEvent = {
        schemaVersion: 1,
        sequence: replay.events.length + 1,
        eventId: input.eventId ?? randomUUID(),
        taskId: input.taskId,
        occurredAt: input.occurredAt ?? new Date().toISOString(),
        kind: input.kind,
        payload,
        previousHash: replay.headHash,
      };
      if (!unsigned.taskId.trim()) throw new TypeError("ProofGraph taskId is required.");
      if (!Number.isFinite(Date.parse(unsigned.occurredAt))) {
        throw new TypeError("ProofGraph occurredAt must be an ISO-compatible timestamp.");
      }
      const event = {
        ...unsigned,
        hash: sha256Hex(canonicalStringify(unsigned)),
      } as StoredProofGraphEvent;
      const flags =
        constants.O_CREAT |
        constants.O_APPEND |
        constants.O_WRONLY |
        noFollowFlag();
      const handle = await open(this.eventsPath, flags, 0o600);
      try {
        const details = await handle.stat();
        if (!details.isFile() || details.nlink > 1) {
          throw new Error(
            `ProofGraph event log is not a private regular file: ${this.eventsPath}`,
          );
        }
        await chmod(this.eventsPath, 0o600);
        await handle.writeFile(`${canonicalStringify(event)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(this.root);
      return event;
    } finally {
      await release();
    }
  }

  async task(taskId: string): Promise<TaskProjection> {
    const replay = await this.replay();
    if (replay.tailCorruption) throw new ProofGraphTailCorruptionError(replay.tailCorruption);
    return rebuildTaskProjection(replay.events, taskId);
  }

  async tasks(): Promise<Map<string, TaskProjection>> {
    const replay = await this.replay();
    if (replay.tailCorruption) throw new ProofGraphTailCorruptionError(replay.tailCorruption);
    return rebuildAllTaskProjections(replay.events);
  }
}
