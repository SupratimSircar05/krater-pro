import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseEvidenceRunnerArguments,
  smokeEvidenceSeeds,
} from "./runner.js";
import {
  readEvidenceBenchmarkManifest,
  validateEvidenceBenchmarkAssets,
} from "../../src/benchmarking/evidence-native.js";

const benchmarkRoot = resolve(process.cwd(), "benchmarks/evidence-native");

describe("evidence-native runner", () => {
  it("keeps validation offline and requires an explicit workspace for checking", () => {
    expect(parseEvidenceRunnerArguments([])).toEqual({
      mode: "validate",
      json: false,
    });
    expect(parseEvidenceRunnerArguments(["--smoke", "--json"])).toEqual({
      mode: "smoke",
      json: true,
    });
    expect(() => parseEvidenceRunnerArguments(["--task", "EB-001"])).toThrow(
      /requires --workspace/,
    );
    expect(() =>
      parseEvidenceRunnerArguments(["--smoke", "--workspace", "./candidate"]),
    ).toThrow(/valid only with --task/);
  });

  it("executes all 20 seeded tasks and proves none is already satisfied", async () => {
    const manifest = await readEvidenceBenchmarkManifest(benchmarkRoot);
    await validateEvidenceBenchmarkAssets(benchmarkRoot, manifest);
    const results = await smokeEvidenceSeeds(benchmarkRoot, manifest);
    expect(results).toHaveLength(20);
    expect(results.every((result) => result.seedRejected)).toBe(true);
  }, 30_000);
});
