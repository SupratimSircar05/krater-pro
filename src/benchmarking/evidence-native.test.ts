import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHECKER_REPORT_FORMAT,
  EvidenceBenchmarkValidationError,
  materializeEvidenceFixture,
  readEvidenceBenchmarkManifest,
  runSealedChecker,
  validateEvidenceBenchmarkAssets,
  validateEvidenceBenchmarkManifest,
  validateSealedCheckerReport,
} from "./evidence-native.js";

const benchmarkRoot = resolve(process.cwd(), "benchmarks/evidence-native");
const temporaryPaths: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "krater-evidence-test-"));
  temporaryPaths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("evidence benchmark manifest", () => {
  it("validates the 100 deterministic foundation tasks and all sealed assets", async () => {
    const manifest = await readEvidenceBenchmarkManifest(benchmarkRoot);
    expect(manifest.tasks).toHaveLength(100);
    expect(new Set(manifest.tasks.map((task) => task.sourceSpecId)).size).toBe(100);
    await expect(
      validateEvidenceBenchmarkAssets(benchmarkRoot, manifest),
    ).resolves.toBeUndefined();
  });

  it("rejects unsafe fixture paths, executable fields, and malformed checker seals", () => {
    const invalid = {
      format: "krater.evidence-benchmark/v1",
      suite: {
        id: "unsafe-suite",
        name: "Unsafe suite",
        version: "1.0.0",
        description:
          "This deliberately invalid suite exercises strict evidence manifest validation.",
      },
      tasks: [
        {
          id: "EB-001",
          sourceSpecId: "KC-001",
          title: "Unsafe fixture task",
          runtime: "node",
          prompt:
            "This prompt is long enough but its fixture and checker metadata are intentionally unsafe.",
          acceptanceCriteria: ["One behavior is correct.", "Another behavior is safe."],
          fixture: { root: "fixtures/../secret", files: ["../../secret"] },
          checker: {
            entry: "checkers/check.mjs",
            sha256: "not-a-digest",
            timeoutMs: 0,
            command: "curl example.test",
          },
        },
      ],
    };
    expect(() => validateEvidenceBenchmarkManifest(invalid)).toThrow(
      EvidenceBenchmarkValidationError,
    );
    expect(() => validateEvidenceBenchmarkManifest(invalid)).toThrow(/command is not allowed/);
    expect(() => validateEvidenceBenchmarkManifest(invalid)).toThrow(/safe path/);
  });
});

describe("sealed checker contract", () => {
  it("rejects extra diagnostic fields and inconsistent aggregate verdicts", () => {
    expect(() =>
      validateSealedCheckerReport(
        {
          format: CHECKER_REPORT_FORMAT,
          taskId: "EB-001",
          passed: true,
          checks: [{ id: "behavior-1", passed: false, expected: "secret answer" }],
        },
        "EB-001",
      ),
    ).toThrow(/expected is not allowed/);

    expect(() =>
      validateSealedCheckerReport(
        {
          format: CHECKER_REPORT_FORMAT,
          taskId: "EB-001",
          passed: true,
          checks: [{ id: "behavior-1", passed: false }],
        },
        "EB-001",
      ),
    ).toThrow(/conjunction/);
  });

  it("keeps the checker outside the fixture and rejects the incomplete seed", async () => {
    const manifest = await readEvidenceBenchmarkManifest(benchmarkRoot);
    const task = manifest.tasks[0];
    const workspace = await temporaryDirectory();
    await materializeEvidenceFixture(benchmarkRoot, task, workspace);

    const execution = await runSealedChecker(benchmarkRoot, task, workspace);
    expect(execution.report.taskId).toBe("EB-001");
    expect(execution.report.passed).toBe(false);
    await expect(
      import("node:fs/promises").then(({ access }) =>
        access(join(workspace, "checkers/sealed-checker.mjs")),
      ),
    ).rejects.toThrow();
  });

  it("accepts a behaviorally correct repair without comparing an expected patch", async () => {
    const manifest = await readEvidenceBenchmarkManifest(benchmarkRoot);
    const task = manifest.tasks[0];
    const workspace = await temporaryDirectory();
    await materializeEvidenceFixture(benchmarkRoot, task, workspace);
    await writeFile(
      join(workspace, "src/solution.mjs"),
      [
        "export function parsePort(value) {",
        '  if (!/^[1-9][0-9]{0,4}$/.test(value)) throw new Error("invalid port");',
        "  const port = Number(value);",
        '  if (port > 65535) throw new Error("invalid port");',
        "  return port;",
        "}",
        "",
      ].join("\n"),
    );

    const execution = await runSealedChecker(benchmarkRoot, task, workspace);
    expect(execution.report.passed).toBe(true);
    expect(execution.report.checks.every((check) => check.passed)).toBe(true);
  });

  it("refuses to materialize over caller-owned workspace content", async () => {
    const manifest = await readEvidenceBenchmarkManifest(benchmarkRoot);
    const workspace = await temporaryDirectory();
    await writeFile(join(workspace, "owned.txt"), "do not overwrite\n");
    await expect(
      materializeEvidenceFixture(benchmarkRoot, manifest.tasks[0], workspace),
    ).rejects.toThrow(/must be empty/);
  });
});
