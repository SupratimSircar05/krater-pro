import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvidenceTask, readEvidenceTask } from "./evidence-runtime.js";
import {
  StagedTaskWorkspace,
  loadProofPatchBinding,
} from "./staging-workspace.js";

const sourceRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(sourceRoot);
const cliPath = join(sourceRoot, "cli.ts");
const temporaryPaths: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "krater-cli-advanced-"));
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

async function seedReviewedTask(cwd: string): Promise<string> {
  await writeFile(join(cwd, "source.txt"), "before\n");
  const staged = await StagedTaskWorkspace.create(cwd, "cli-cancel");
  await writeFile(join(staged.stageRoot, "source.txt"), "after\n");
  const task = await EvidenceTask.start({
    cwd,
    projectId: "cli",
    request: "Update source",
    assurance: "fast",
  });
  task.accept({
    type: "tool",
    id: "read-source",
    name: "read_file",
    args: { path: "source.txt" },
  });
  task.accept({
    type: "tool_result",
    id: "read-source",
    name: "read_file",
    output: "before",
    ok: true,
  });
  task.accept({
    type: "action_gate",
    outcome: "change_required",
    shouldStageCode: true,
    reasons: ["A source update is required."],
    evidenceRefs: ["read-source"],
  });
  task.accept({
    type: "tool",
    id: "write-source",
    name: "write_file",
    args: { path: "source.txt", content: "after" },
  });
  task.accept({
    type: "tool_result",
    id: "write-source",
    name: "write_file",
    output: "updated",
    ok: true,
  });
  task.accept({
    type: "tool",
    id: "test-source",
    name: "run_command",
    args: { command: "npm test -- source" },
  });
  task.accept({
    type: "tool_result",
    id: "test-source",
    name: "run_command",
    output: "Exit code: 0",
    ok: true,
  });
  const prepared = await staged.prepareProofPatch(task.taskId);
  await task.finish({
    baseWorkspaceDigest: prepared.baseWorkspaceDigest,
    finalWorkspaceDigest: prepared.finalWorkspaceDigest,
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

describe("advanced CLI adapters", () => {
  it("cancels a reviewed task after discarding its staged transaction", async () => {
    const cwd = await temporaryDirectory();
    const taskId = await seedReviewedTask(cwd);

    const result = await runCli([
      "--cwd",
      cwd,
      "--json",
      "task",
      "cancel",
      taskId,
      "--reason",
      "Stopped from the CLI.",
    ]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      type: "cancellation",
      taskId,
      verdict: "cancelled",
      proofPatch: { status: "rolled_back" },
    });
    await expect(loadProofPatchBinding(cwd, taskId)).resolves.toMatchObject({
      status: "rolled_back",
    });
    await expect(readFile(join(cwd, "source.txt"), "utf8")).resolves.toBe(
      "before\n",
    );
    await expect(readEvidenceTask(cwd, "cli", taskId)).resolves.toMatchObject({
      task: { state: "cancelled" },
    });
  });

  it("runs the recorded causal command without requiring an API key", async () => {
    const cwd = await temporaryDirectory();
    const inputPath = join(cwd, "causal.json");
    await writeFile(
      inputPath,
      JSON.stringify({
        plan: {
          id: "cli-causal",
          snapshotDigest: `sha256:${"c".repeat(64)}`,
          baseline: { runtime: "node", entrypoint: "fixture.mjs" },
          hypotheses: [
            {
              id: "mode",
              statement: "Mode causes failure.",
              baselineExpectation: { keys: ["exit:1"] },
            },
            {
              id: "fixture",
              statement: "Fixture causes failure.",
              baselineExpectation: { keys: ["exit:1"] },
            },
          ],
          experiments: [
            {
              id: "toggle",
              title: "Toggle mode",
              intervention: {
                kind: "environment",
                description: "Set mode to safe.",
                changedInputs: ["MODE"],
                isolated: true,
              },
              invocation: { runtime: "node", entrypoint: "fixture.mjs" },
              estimatedCost: 1,
              predictions: [
                { hypothesisId: "mode", expected: { keys: ["success"] } },
                { hypothesisId: "fixture", expected: { keys: ["exit:1"] } },
              ],
            },
          ],
        },
        executions: [
          { exitCode: 1, stdout: "", stderr: "" },
          { exitCode: 1, stdout: "", stderr: "" },
          { exitCode: 0, stdout: "", stderr: "" },
        ],
      }),
      { encoding: "utf8", mode: 0o600 },
    );

    const result = await runCli([
      "--cwd",
      cwd,
      "debug",
      "causal",
      "--input",
      inputPath,
    ]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      executedProcesses: false,
      report: {
        verdict: "causal_evidence_established",
        causalHypothesisIds: ["mode"],
      },
    });
  });

  it("fails closed when a reliability replay artifact is not sealed", async () => {
    const cwd = await temporaryDirectory();
    const inputPath = join(cwd, "evaluation.json");
    await writeFile(
      inputPath,
      JSON.stringify({
        evaluation: {
          evaluationId: "unsealed",
          suiteId: "suite",
          datasetDigest: "dataset",
          role: "private_holdout",
          configurationDigest: "config",
          sealed: false,
          cases: [
            {
              caseId: "case-1",
              taskClass: "repair",
              resolved: true,
              securityFailures: 0,
              abstention: "not_applicable",
            },
          ],
        },
      }),
      { encoding: "utf8", mode: 0o600 },
    );

    const result = await runCli([
      "--cwd",
      cwd,
      "lab",
      "replay",
      "--input",
      inputPath,
    ]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/must be sealed/i);
  });
});
