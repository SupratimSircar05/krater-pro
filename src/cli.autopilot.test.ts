import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvidenceTask, openEvidenceStore } from "./evidence-runtime.js";
import { VerifiedWorkCache, type CacheDescriptor } from "./verified-cache/index.js";

const sourceRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(sourceRoot);
const cliPath = join(sourceRoot, "cli.ts");
const temporaryPaths: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "krater-cli-autopilot-"));
  temporaryPaths.push(path);
  return path;
}

function runCli(args: readonly string[]): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", cliPath, ...args],
      {
        cwd: projectRoot,
        env: { ...process.env, KRATER_API_KEY: "" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

async function seedTask(cwd: string): Promise<string> {
  const task = await EvidenceTask.start({
    cwd,
    projectId: "cli",
    request: "Add a durable verified task plan.",
    assurance: "standard",
  });
  return task.taskId;
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Verified Autopilot CLI", () => {
  it("shows a versioned task plan in a stable JSON envelope", async () => {
    const cwd = await temporaryDirectory();
    const taskId = await seedTask(cwd);

    const result = await runCli([
      "--cwd",
      cwd,
      "--json",
      "task",
      "plan",
      taskId,
    ]);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    const envelope = JSON.parse(result.stdout);
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      type: "task_plan",
      ok: true,
      taskId,
      result: {
        plan: {
          taskId,
          revision: 1,
          status: "active",
        },
      },
    });
    expect(envelope.result.plan.steps.map((step: { kind: string }) => step.kind))
      .toEqual(["discover", "implement", "verify", "review", "publish"]);
  });

  it("approves only the exact current digest and is idempotent", async () => {
    const cwd = await temporaryDirectory();
    const taskId = await seedTask(cwd);
    const store = await openEvidenceStore(cwd);
    const initial = (await store.task(taskId)).autopilot.currentPlan;
    expect(initial).toBeDefined();

    const stale = await runCli([
      "--cwd",
      cwd,
      "--json",
      "task",
      "approve",
      taskId,
      "--plan-digest",
      `sha256:${"0".repeat(64)}`,
    ]);
    expect(stale.code).toBe(1);
    expect(stale.stderr).toMatch(/changed after it was opened/i);
    expect((await store.task(taskId)).autopilot.currentPlan?.revision).toBe(1);

    const approved = await runCli([
      "--cwd",
      cwd,
      "--json",
      "task",
      "approve",
      taskId,
      "--plan-digest",
      initial!.digest,
      "--reason",
      "Approved in the CLI test.",
    ]);
    expect(approved).toMatchObject({ code: 0, stderr: "" });
    const approval = JSON.parse(approved.stdout);
    expect(approval).toMatchObject({
      schemaVersion: 1,
      type: "task_plan_approval",
      ok: true,
      taskId,
      result: {
        idempotent: false,
        plan: { revision: 2, status: "approved" },
      },
    });

    const repeated = await runCli([
      "--cwd",
      cwd,
      "--json",
      "task",
      "approve",
      taskId,
      "--plan-digest",
      approval.result.plan.digest,
    ]);
    expect(repeated).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(repeated.stdout)).toMatchObject({
      ok: true,
      result: {
        idempotent: true,
        plan: { revision: 2, status: "approved" },
      },
    });
  });

  it("reports incomplete recorded evidence without pretending to run checks", async () => {
    const cwd = await temporaryDirectory();
    const taskId = await seedTask(cwd);

    const result = await runCli([
      "--cwd",
      cwd,
      "--json",
      "task",
      "verify",
      taskId,
    ]);

    expect(result).toMatchObject({ code: 2, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      type: "task_recorded_verification",
      ok: false,
      taskId,
      result: {
        mode: "offline_recorded_evidence",
        executedChecks: false,
        status: "incomplete",
        plan: { available: true, valid: true },
        evidence: {
          capsuleAvailable: false,
          passportAvailable: false,
        },
      },
    });
  });

  it("labels watch as an unmonitored local snapshot", async () => {
    const cwd = await temporaryDirectory();
    const taskId = await seedTask(cwd);

    const result = await runCli([
      "--cwd",
      cwd,
      "--json",
      "task",
      "watch",
      taskId,
    ]);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      type: "task_watch_snapshot",
      ok: true,
      taskId,
      result: {
        state: "unmonitored",
        activeMonitoring: false,
        productionObservations: [],
        proofLeases: [],
      },
    });
  });

  it("prunes only expired verified-cache entries", async () => {
    const cwd = await temporaryDirectory();
    const cache = new VerifiedWorkCache(join(cwd, ".krater", "cache"));
    const descriptor: CacheDescriptor = {
      namespace: "cli-prune",
      artifactKind: "repository_map",
      inputs: {
        source: { digest: "source" },
        config: { version: 1 },
        toolchain: { node: process.versions.node },
        environment: { platform: process.platform },
        policy: { network: false },
      },
    };
    await cache.put(descriptor, { files: [] }, { now: 1, ttlMs: 1 });

    const result = await runCli([
      "--cwd",
      cwd,
      "--json",
      "cache",
      "prune",
    ]);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({ removed: 1 });
    await expect(cache.stats()).resolves.toMatchObject({ entries: 0 });
  });
});
