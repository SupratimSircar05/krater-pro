import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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

  it("pins the complete EB and KC inventories without duplicates", async () => {
    const manifest = await readEvidenceBenchmarkManifest(benchmarkRoot);
    const expectedTaskIds = Array.from(
      { length: 100 },
      (_, index) => `EB-${String(index + 1).padStart(3, "0")}`,
    );
    const expectedSourceSpecIds = Array.from(
      { length: 100 },
      (_, index) => `KC-${String(index + 1).padStart(3, "0")}`,
    );

    expect(manifest.tasks.map((task) => task.id)).toEqual(expectedTaskIds);
    expect(
      manifest.tasks.map((task) => task.sourceSpecId).sort(),
    ).toEqual(expectedSourceSpecIds);
    expect(new Set(manifest.tasks.map((task) => task.title)).size).toBe(100);
    expect(new Set(manifest.tasks.map((task) => task.prompt)).size).toBe(100);
    expect(manifest.tasks.filter((task) => task.runtime === "node")).toHaveLength(52);
    expect(manifest.tasks.filter((task) => task.runtime === "python")).toHaveLength(48);

    const fixtureDigests = await Promise.all(
      manifest.tasks.map(async (task) => {
        const contents = await readFile(
          join(benchmarkRoot, task.fixture.root, task.fixture.files[0]),
        );
        return createHash("sha256").update(contents).digest("hex");
      }),
    );
    expect(new Set(fixtureDigests).size).toBe(100);
  });

  it("executes all 100 seeded tasks and proves none is already satisfied", async () => {
    const manifest = await readEvidenceBenchmarkManifest(benchmarkRoot);
    await validateEvidenceBenchmarkAssets(benchmarkRoot, manifest);
    const results = await smokeEvidenceSeeds(benchmarkRoot, manifest);
    expect(results).toHaveLength(100);
    expect(results.every((result) => result.seedRejected)).toBe(true);
  }, 120_000);
});
