import {
  appendFile,
  chmod,
  link,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, parse } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  CasIntegrityError,
  InvalidTaskTransitionError,
  ProofGraphCorruptionError,
  ProofGraphStore,
  ProofGraphTailCorruptionError,
  assertTaskStateTransition,
  canonicalStringify,
  canTransitionTaskState,
} from "./index.js";
import type {
  ActionRecord,
  IntentNode,
  TaskContract,
} from "./index.js";

const NOW = "2026-07-28T10:00:00.000Z";
const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "krater-proofgraph-"));
  temporaryRoots.push(root);
  return root;
}

function contract(taskId: string): TaskContract {
  return {
    schemaVersion: 1,
    id: `contract-${taskId}`,
    taskId,
    request: "Inspect Authorization: Bearer persistence-secret",
    interpretations: [],
    assumptions: [],
    acceptanceCriteria: [],
    nonGoals: [],
    assurance: "standard",
    budget: {},
    allowedCapabilities: ["read"],
    requiredChecks: [],
    negativeGuarantees: ["Do not persist secrets"],
    createdAt: NOW,
  };
}

function action(id: string, taskId = "task-1"): ActionRecord {
  return {
    id,
    taskId,
    name: "read_file",
    capability: "read",
    provenance: {
      source: "local_tool",
      trust: "approved_policy",
      sensitivity: "proprietary",
    },
    input: { path: `src/${id}.ts` },
    sideEffects: [],
    status: "succeeded",
    startedAt: NOW,
    completedAt: NOW,
  };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe("ProofGraphStore", () => {
  it("refuses a filesystem root as protected state storage", async () => {
    await expect(
      ProofGraphStore.open({ root: parse(tmpdir()).root }),
    ).rejects.toThrow(/dedicated non-root directory/i);
  });

  it("appends fsynced, hash-chained events and rebuilds a task projection", async () => {
    const root = await temporaryRoot();
    const store = await ProofGraphStore.open({ root });
    const created = await store.append({
      taskId: "task-1",
      kind: "task.created",
      payload: { contract: contract("task-1") },
      occurredAt: NOW,
    });
    const discovery = await store.append({
      taskId: "task-1",
      kind: "task.state.changed",
      payload: { from: "intake", to: "discovery", reason: "Repository inspected" },
      occurredAt: NOW,
    });
    const intent: IntentNode = {
      id: "intent-1",
      taskId: "task-1",
      kind: "requirement",
      statement: "Preserve parsing behavior",
      status: "active",
      links: [{ type: "file", target: "src/parser.ts" }],
      createdAt: NOW,
      updatedAt: NOW,
    };
    await store.append({
      taskId: "task-1",
      kind: "intent.recorded",
      payload: { intent },
      occurredAt: NOW,
    });

    expect(created.sequence).toBe(1);
    expect(created.previousHash).toBeNull();
    expect(discovery.previousHash).toBe(created.hash);
    const replay = await store.replay();
    expect(replay.tailCorruption).toBeUndefined();
    expect(replay.events).toHaveLength(3);
    expect(replay.headHash).toBe(replay.events[2].hash);

    const projection = await store.task("task-1");
    expect(projection.state).toBe("discovery");
    expect(projection.intents).toEqual([intent]);
    expect(projection.stateHistory).toHaveLength(2);
    expect(projection.lastEventHash).toBe(replay.headHash);

    const persisted = await readFile(store.eventsPath, "utf8");
    expect(persisted).not.toContain("persistence-secret");
    expect(persisted).toContain("[REDACTED]");
    if (process.platform !== "win32") {
      expect((await stat(root)).mode & 0o777).toBe(0o700);
      expect((await stat(store.eventsPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("serializes concurrent appenders without duplicate sequences", async () => {
    const root = await temporaryRoot();
    const store = await ProofGraphStore.open({ root, lockTimeoutMs: 10_000 });
    await store.append({
      taskId: "task-1",
      kind: "task.created",
      payload: { contract: contract("task-1") },
    });

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.append({
          taskId: "task-1",
          kind: "action.recorded",
          payload: { action: action(`action-${index}`) },
        }),
      ),
    );

    const replay = await store.replay();
    expect(replay.tailCorruption).toBeUndefined();
    expect(replay.events.map((event) => event.sequence)).toEqual(
      Array.from({ length: 21 }, (_, index) => index + 1),
    );
    expect((await store.task("task-1")).actions).toHaveLength(20);
  });

  it("detects an incomplete crash tail and refuses to extend it", async () => {
    const root = await temporaryRoot();
    const store = await ProofGraphStore.open({ root });
    await store.append({
      taskId: "task-1",
      kind: "task.created",
      payload: { contract: contract("task-1") },
    });
    await appendFile(store.eventsPath, '{"schemaVersion":1');

    const replay = await store.replay();
    expect(replay.events).toHaveLength(1);
    expect(replay.tailCorruption).toMatchObject({
      kind: "incomplete_line",
      lineNumber: 2,
    });
    await expect(
      store.append({
        taskId: "task-1",
        kind: "action.recorded",
        payload: { action: action("blocked") },
      }),
    ).rejects.toBeInstanceOf(ProofGraphTailCorruptionError);
  });

  it("distinguishes recoverable final corruption from interior corruption", async () => {
    const root = await temporaryRoot();
    const store = await ProofGraphStore.open({ root });
    await store.append({
      taskId: "task-1",
      kind: "task.created",
      payload: { contract: contract("task-1") },
    });
    await store.append({
      taskId: "task-1",
      kind: "action.recorded",
      payload: { action: action("action-1") },
    });
    const lines = (await readFile(store.eventsPath, "utf8")).trimEnd().split("\n");
    const final = JSON.parse(lines[1]) as Record<string, unknown>;
    final.taskId = "tampered";
    await writeFile(store.eventsPath, `${lines[0]}\n${canonicalStringify(final)}\n`);

    expect((await store.replay()).tailCorruption?.kind).toBe("hash_mismatch");

    await writeFile(
      store.eventsPath,
      `${lines[0]}\n{"broken":true}\n${lines[1]}\n`,
    );
    await expect(store.replay()).rejects.toBeInstanceOf(ProofGraphCorruptionError);
  });

  it("rejects protected event paths that are symbolic links", async () => {
    if (process.platform === "win32") return;
    const root = await temporaryRoot();
    const outside = join(await temporaryRoot(), "outside.ndjson");
    await writeFile(outside, "");
    const { symlink } = await import("node:fs/promises");
    await symlink(outside, join(root, "events.ndjson"));
    await expect(ProofGraphStore.open({ root })).rejects.toThrow(/symbolic link/i);
  });

  it("refuses to append to a hard-linked event log", async () => {
    if (process.platform === "win32") return;
    const root = await temporaryRoot();
    const store = await ProofGraphStore.open({ root });
    await writeFile(store.eventsPath, "");
    await link(store.eventsPath, join(await temporaryRoot(), "event-copy"));

    await expect(
      store.append({
        taskId: "task-1",
        kind: "task.created",
        payload: { contract: contract("task-1") },
      }),
    ).rejects.toThrow(/private regular file/i);
  });
});

describe("task state transitions", () => {
  it("allows only the ordered workflow and explicit terminal alternatives", () => {
    expect(canTransitionTaskState("intake", "discovery")).toBe(true);
    expect(canTransitionTaskState("intake", "reproduction")).toBe(false);
    expect(canTransitionTaskState("review", "accepted_with_gaps")).toBe(true);
    expect(canTransitionTaskState("intake", "accepted_with_gaps")).toBe(false);
    expect(canTransitionTaskState("complete", "discovery")).toBe(false);
    expect(() => assertTaskStateTransition("intake", "reproduction")).toThrow(
      InvalidTaskTransitionError,
    );
  });

  it("rejects an invalid transition before it reaches the durable log", async () => {
    const root = await temporaryRoot();
    const store = await ProofGraphStore.open({ root });
    await store.append({
      taskId: "task-1",
      kind: "task.created",
      payload: { contract: contract("task-1") },
    });

    await expect(
      store.append({
        taskId: "task-1",
        kind: "task.state.changed",
        payload: { from: "intake", to: "verification" },
      }),
    ).rejects.toBeInstanceOf(InvalidTaskTransitionError);
    expect((await store.replay()).events).toHaveLength(1);
  });
});

describe("ContentAddressedStore", () => {
  it("deduplicates content, redacts text, and verifies reads", async () => {
    const root = await temporaryRoot();
    const store = await ProofGraphStore.open({ root });
    const first = await store.cas.put("api_key=cas-secret");
    const second = await store.cas.put("api_key=cas-secret");

    expect(first.digest).toBe(second.digest);
    expect(first.redacted).toBe(true);
    expect((await store.cas.get(first.digest)).toString()).toBe(
      "api_key=[REDACTED]",
    );

    const json = await store.cas.putJson({
      password: "json-secret",
      safe: true,
    });
    expect(await store.cas.getJson(json.digest)).toEqual({
      password: "[REDACTED]",
      safe: true,
    });
  });

  it("detects an object modified behind its digest", async () => {
    const root = await temporaryRoot();
    const store = await ProofGraphStore.open({ root });
    const reference = await store.cas.put("immutable");
    const hex = reference.digest.slice("sha256:".length);
    const path = join(root, "cas", hex.slice(0, 2), hex.slice(2));
    await chmod(path, 0o600);
    await writeFile(path, "tampered");
    await expect(store.cas.get(reference.digest)).rejects.toBeInstanceOf(
      CasIntegrityError,
    );
  });

  it("refuses a CAS object that was hard-linked outside protected storage", async () => {
    if (process.platform === "win32") return;
    const root = await temporaryRoot();
    const store = await ProofGraphStore.open({ root });
    const reference = await store.cas.put("private evidence");
    const hex = reference.digest.slice("sha256:".length);
    const objectPath = join(root, "cas", hex.slice(0, 2), hex.slice(2));
    await link(objectPath, join(await temporaryRoot(), "cas-copy"));

    await expect(store.cas.get(reference.digest)).rejects.toThrow(
      /private regular file/i,
    );
  });
});
