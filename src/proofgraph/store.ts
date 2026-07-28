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

  if (input.kind === "task.state.changed") {
    const current = rebuildTaskProjection(events, input.taskId);
    if (input.payload.from && input.payload.from !== current.state) {
      throw new Error(
        `Task state event expected ${input.payload.from}, current state is ${current.state}.`,
      );
    }
    assertTaskStateTransition(current.state, input.payload.to);
    return;
  }

  const recordTaskId =
    input.kind === "contract.set"
      ? input.payload.contract.taskId
      : input.kind === "intent.recorded"
        ? input.payload.intent.taskId
        : input.kind === "action.recorded"
          ? input.payload.action.taskId
          : input.kind === "evidence.recorded"
            ? input.payload.evidence.taskId
            : input.kind === "claim.recorded"
              ? input.payload.claim.taskId
              : input.kind === "capsule.generated"
                ? input.payload.capsule.taskId
                : input.payload.passport.taskId;
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
