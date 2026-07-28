#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  materializeEvidenceFixture,
  readEvidenceBenchmarkManifest,
  runSealedChecker,
  validateEvidenceBenchmarkAssets,
  type EvidenceBenchmarkManifest,
} from "../../src/benchmarking/evidence-native.js";

export interface EvidenceRunnerOptions {
  mode: "validate" | "smoke" | "check";
  taskId?: string;
  workspace?: string;
  json: boolean;
}

export function parseEvidenceRunnerArguments(argv: string[]): EvidenceRunnerOptions {
  let mode: EvidenceRunnerOptions["mode"] = "validate";
  let taskId: string | undefined;
  let workspace: string | undefined;
  let json = false;
  let selectedMode = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--validate" || argument === "--smoke") {
      if (selectedMode) throw new Error("Select only one evidence benchmark mode");
      selectedMode = true;
      mode = argument === "--smoke" ? "smoke" : "validate";
    } else if (argument === "--task") {
      if (selectedMode) throw new Error("Select only one evidence benchmark mode");
      const value = argv[++index];
      if (!value || !/^EB-\d{3}$/.test(value)) throw new Error("--task requires EB-NNN");
      selectedMode = true;
      mode = "check";
      taskId = value;
    } else if (argument === "--workspace") {
      const value = argv[++index];
      if (!value) throw new Error("--workspace requires a path");
      workspace = resolve(value);
    } else if (argument === "--json") {
      json = true;
    } else {
      throw new Error(`Unknown evidence benchmark option: ${argument}`);
    }
  }

  if (mode === "check" && !workspace) {
    throw new Error("--task requires --workspace");
  }
  if (mode !== "check" && workspace) {
    throw new Error("--workspace is valid only with --task");
  }
  return { mode, taskId, workspace, json };
}

async function validatedManifest(
  benchmarkRoot: string,
): Promise<EvidenceBenchmarkManifest> {
  const manifest = await readEvidenceBenchmarkManifest(benchmarkRoot);
  await validateEvidenceBenchmarkAssets(benchmarkRoot, manifest);
  return manifest;
}

export async function smokeEvidenceSeeds(
  benchmarkRoot: string,
  manifest: EvidenceBenchmarkManifest,
): Promise<Array<{ taskId: string; seedRejected: boolean; elapsedMs: number }>> {
  const results: Array<{ taskId: string; seedRejected: boolean; elapsedMs: number }> = [];
  for (const task of manifest.tasks) {
    const workspace = await mkdtemp(join(tmpdir(), `krater-evidence-${task.id}-`));
    try {
      await materializeEvidenceFixture(benchmarkRoot, task, workspace);
      const execution = await runSealedChecker(benchmarkRoot, task, workspace);
      results.push({
        taskId: task.id,
        seedRejected: !execution.report.passed,
        elapsedMs: execution.elapsedMs,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }
  return results;
}

export async function runEvidenceBenchmarkCli(
  argv: string[],
  benchmarkRoot = resolve(dirname(fileURLToPath(import.meta.url))),
): Promise<number> {
  const options = parseEvidenceRunnerArguments(argv);
  const manifest = await validatedManifest(benchmarkRoot);

  if (options.mode === "validate") {
    const result = {
      status: "valid",
      suite: manifest.suite.id,
      version: manifest.suite.version,
      tasks: manifest.tasks.length,
      checkerMode: "sealed-host-side",
    };
    process.stdout.write(
      options.json
        ? `${JSON.stringify(result)}\n`
        : `Valid ${result.suite} v${result.version}: ${result.tasks} task(s), sealed host checker.\n`,
    );
    return 0;
  }

  if (options.mode === "smoke") {
    const results = await smokeEvidenceSeeds(benchmarkRoot, manifest);
    const unexpectedlyPassing = results.filter((result) => !result.seedRejected);
    const result = {
      status: unexpectedlyPassing.length ? "invalid-seed" : "ready",
      tasks: results.length,
      rejectedSeeds: results.length - unexpectedlyPassing.length,
      unexpectedlyPassing: unexpectedlyPassing.map((item) => item.taskId),
      elapsedMs: results.reduce((sum, item) => sum + item.elapsedMs, 0),
    };
    process.stdout.write(
      options.json
        ? `${JSON.stringify(result)}\n`
        : `Evidence seed smoke: ${result.rejectedSeeds}/${result.tasks} incomplete seeds ` +
            `were rejected by their sealed checkers.\n`,
    );
    return unexpectedlyPassing.length ? 1 : 0;
  }

  const task = manifest.tasks.find((candidate) => candidate.id === options.taskId);
  if (!task) throw new Error(`Unknown evidence benchmark task: ${options.taskId}`);
  const execution = await runSealedChecker(
    benchmarkRoot,
    task,
    options.workspace as string,
  );
  const result = {
    taskId: task.id,
    passed: execution.report.passed,
    checks: execution.report.checks,
    elapsedMs: execution.elapsedMs,
  };
  process.stdout.write(
    options.json
      ? `${JSON.stringify(result)}\n`
      : `${task.id}: ${result.passed ? "passed" : "failed"} ` +
          `(${result.checks.filter((check) => check.passed).length}/${result.checks.length} checks).\n`,
  );
  return result.passed ? 0 : 1;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && pathToFileURL(resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
  runEvidenceBenchmarkCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`Evidence benchmark error: ${(error as Error).message}\n`);
      process.exitCode = 2;
    });
}
