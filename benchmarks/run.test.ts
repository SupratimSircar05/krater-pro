import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../src/types.js";
import {
  benchmarkToolApproval,
  calculateExecutionScore,
  createExecutionPlan,
  createIsolatedWorkspace,
  parseCliArguments,
  runBenchmarkCli,
  shouldExcludeWorkspacePath,
  type CapturedAgentEvent,
} from "./run.js";
import {
  CatalogValidationError,
  type BenchmarkCatalog,
  validateBenchmarkCatalog,
} from "./schema.js";

function makeCatalog(): BenchmarkCatalog {
  const categories = Array.from({ length: 10 }, (_, index) => ({
    id: `category-${String(index + 1).padStart(2, "0")}`,
    title: `Expert category ${index + 1}`,
    description:
      `Category ${index + 1} exercises advanced implementation and verification judgment.`,
  }));
  const tasks = Array.from({ length: 100 }, (_, index) => {
    const number = index + 1;
    const id = `KC-${String(number).padStart(3, "0")}`;
    return {
      id,
      title: `Expert implementation task ${String(number).padStart(3, "0")}`,
      category: categories[Math.floor(index / 10)].id,
      difficulty: "expert" as const,
      estimatedMinutes: 180,
      prompt:
        `Implement a production-quality solution for scenario ${id}. ` +
        "Preserve invariants under adversarial inputs, explain key tradeoffs, and prove behavior with deterministic tests.",
      requiredCapabilities: [
        `analysis-${id}`,
        `implementation-${id}`,
        `debugging-${id}`,
        `verification-${id}`,
      ],
      setup: {
        summary:
          `A deliberately incomplete fixture for ${id} with failure cases that require careful diagnosis.`,
        stack: ["TypeScript", "Node.js", "Vitest", "POSIX"],
        seedFiles: [
          `src/task-${number}.ts`,
          `src/task-${number}.test.ts`,
          `fixtures/task-${number}.json`,
          `docs/task-${number}.md`,
        ],
      },
      acceptanceCriteria: [
        `The implementation for ${id} preserves its primary invariant.`,
        `The implementation for ${id} rejects malformed boundary inputs safely.`,
        `Deterministic tests for ${id} cover success, failure, and recovery paths.`,
        `The final evidence for ${id} distinguishes verified facts from assumptions.`,
      ],
      hiddenChecks: [
        `Inject a deterministic race into ${id} and verify the invariant.`,
        `Exercise an undocumented boundary condition in ${id}.`,
        `Confirm ${id} leaves no secret, process, or temporary artifact behind.`,
      ],
      hazards: [
        `A superficially correct patch for ${id} can violate ordering under contention.`,
        `The fixture for ${id} contains misleading but non-authoritative comments.`,
        `Broad cleanup for ${id} can overwrite unrelated user-owned changes.`,
      ],
    };
  });
  return {
    name: "Krater Pro Expert Benchmark",
    version: "1.0.0",
    description:
      "One hundred demanding coding tasks for measuring execution discipline and externally verified correctness.",
    categories,
    tasks,
  };
}

const temporaryPaths: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("benchmark catalog schema", () => {
  it("accepts a rich, sequential 100-task catalog with ten tasks per category", () => {
    const catalog = makeCatalog();
    expect(validateBenchmarkCatalog(catalog)).toBe(catalog);
  });

  it("reports cardinality, sequence, uniqueness, and category-balance failures", () => {
    const missing = structuredClone(makeCatalog()) as BenchmarkCatalog;
    missing.tasks.pop();
    expect(() => validateBenchmarkCatalog(missing)).toThrow(/exactly 100 tasks/);

    const duplicate = structuredClone(makeCatalog()) as BenchmarkCatalog;
    duplicate.tasks[1].id = duplicate.tasks[0].id;
    expect(() => validateBenchmarkCatalog(duplicate)).toThrow(/must be unique/);
    expect(() => validateBenchmarkCatalog(duplicate)).toThrow(/must be KC-002/);

    const imbalanced = structuredClone(makeCatalog()) as BenchmarkCatalog;
    imbalanced.tasks[9].category = imbalanced.categories[1].id;
    expect(() => validateBenchmarkCatalog(imbalanced)).toThrow(/exactly 10 tasks/);
  });

  it("rejects shallow fields, unsafe seed paths, and undeclared object fields", () => {
    const catalog = structuredClone(makeCatalog()) as BenchmarkCatalog & {
      surprise?: boolean;
    };
    catalog.tasks[0].prompt = "too short";
    catalog.tasks[0].setup.seedFiles[0] = "../../outside.ts";
    catalog.surprise = true;

    let thrown: unknown;
    try {
      validateBenchmarkCatalog(catalog);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CatalogValidationError);
    expect((thrown as CatalogValidationError).issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("catalog.surprise"),
        expect.stringContaining("at least 80"),
        expect.stringContaining("safe relative path"),
      ]),
    );
  });

  it("requires every task to be expert and reference a declared category", () => {
    const catalog = structuredClone(makeCatalog()) as unknown as {
      tasks: Array<Record<string, unknown>>;
    };
    catalog.tasks[0].difficulty = "hard";
    catalog.tasks[1].category = "missing-category";
    expect(() => validateBenchmarkCatalog(catalog)).toThrow(/exactly "expert"/);
    expect(() => validateBenchmarkCatalog(catalog)).toThrow(/declared category/);
  });
});

describe("CLI safety gates", () => {
  it("auto-approves isolated file edits but always denies model shell commands", () => {
    expect(benchmarkToolApproval("write_file")).toBe(true);
    expect(benchmarkToolApproval("replace_in_file")).toBe(true);
    expect(benchmarkToolApproval("run_command")).toBe(false);
    expect(benchmarkToolApproval("unknown_mutation")).toBe(false);
  });

  it("parses offline defaults and refuses unbounded live execution", () => {
    const catalog = makeCatalog();
    const defaults = parseCliArguments([]);
    expect(defaults).toMatchObject({
      live: false,
      all: false,
      trustCheckers: false,
    });
    expect(createExecutionPlan(defaults, catalog)).toMatchObject({
      live: false,
      selection: "default",
      selectedTasks: expect.arrayContaining([
        expect.objectContaining({ id: "KC-001" }),
      ]),
    });

    expect(() =>
      createExecutionPlan(parseCliArguments(["--live"]), catalog),
    ).toThrow(/requires --task.*--category/i);
    expect(() =>
      createExecutionPlan(
        parseCliArguments(["--live", "--task", "KC-001", "--all"]),
        catalog,
      ),
    ).toThrow(/mutually exclusive/);
    expect(() =>
      createExecutionPlan(parseCliArguments(["--trust-checkers"]), catalog),
    ).toThrow(/requires both --live and --workspace/);
    expect(() =>
      createExecutionPlan(
        parseCliArguments([
          "--live",
          "--task",
          "KC-001",
          "--trust-checkers",
        ]),
        catalog,
      ),
    ).toThrow(/requires both --live and --workspace/);

    const explicit = createExecutionPlan(
      parseCliArguments(["--live", "--all"]),
      catalog,
    );
    expect(explicit.selection).toBe("all");
    expect(explicit.selectedTasks).toHaveLength(100);

    const trusted = createExecutionPlan(
      parseCliArguments([
        "--live",
        "--task",
        "KC-001",
        "--workspace",
        "fixture",
        "--trust-checkers",
      ]),
      catalog,
    );
    expect(trusted.selection).toBe("task");
  });

  it("never constructs a provider during default, validation, or listing modes", async () => {
    const providerFactory = vi.fn(() => {
      throw new Error("provider must not be constructed");
    });
    const stdout = vi.fn();

    const defaultResult = await runBenchmarkCli([], {
      catalog: makeCatalog(),
      providerFactory,
      stdout,
    });
    const validationResult = await runBenchmarkCli(["--validate"], {
      catalog: makeCatalog(),
      providerFactory,
      stdout,
    });
    const listResult = await runBenchmarkCli(["--list", "--category", "category-01"], {
      catalog: makeCatalog(),
      providerFactory,
      stdout,
    });
    await expect(
      runBenchmarkCli(["--validate", "--trust-checkers"], {
        catalog: makeCatalog(),
        providerFactory,
        stdout,
      }),
    ).rejects.toThrow(/requires both --live and --workspace/);

    expect(defaultResult.mode).toBe("offline");
    expect(validationResult.mode).toBe("offline");
    expect(listResult.mode).toBe("offline");
    expect(providerFactory).not.toHaveBeenCalled();
  });

  it("rejects live mode without a selection before config or provider access", async () => {
    const providerFactory = vi.fn(() => {
      throw new Error("provider must not be constructed");
    });
    await expect(
      runBenchmarkCli(["--live"], {
        catalog: makeCatalog(),
        providerFactory,
        stdout: () => undefined,
      }),
    ).rejects.toThrow(/explicit --all/);
    expect(providerFactory).not.toHaveBeenCalled();
  });

  it("recognizes secret and dependency paths excluded from isolated copies", () => {
    expect(shouldExcludeWorkspacePath(".git/config")).toBe(true);
    expect(shouldExcludeWorkspacePath("packages/api/node_modules/pkg/index.js")).toBe(true);
    expect(shouldExcludeWorkspacePath(".env")).toBe(true);
    expect(shouldExcludeWorkspacePath("apps/web/.env.production")).toBe(true);
    expect(shouldExcludeWorkspacePath("secrets/token.txt")).toBe(true);
    expect(shouldExcludeWorkspacePath("certs/service.pem")).toBe(true);
    expect(shouldExcludeWorkspacePath("src/index.ts")).toBe(false);
  });

  it("ignores checkers by default and copies a hashed checker only after explicit trust", async () => {
    const source = await temporaryDirectory("krater-source-");
    await mkdir(join(source, "src"), { recursive: true });
    await mkdir(join(source, ".git"), { recursive: true });
    await mkdir(join(source, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(source, "secrets"), { recursive: true });
    await mkdir(join(source, ".krater-benchmark", "checks"), { recursive: true });
    await writeFile(join(source, "src", "index.ts"), "export const safe = true;\n");
    await writeFile(join(source, ".env"), "KRATER_API_KEY=must-not-copy\n");
    await writeFile(join(source, ".git", "config"), "private");
    await writeFile(join(source, "node_modules", "pkg", "index.js"), "private");
    await writeFile(join(source, "secrets", "token.txt"), "private");
    await writeFile(
      join(source, ".krater-benchmark", "checks", "KC-001.sh"),
      "#!/bin/sh\nexit 0\n",
    );

    const isolated = await createIsolatedWorkspace(makeCatalog().tasks[0], source);
    temporaryPaths.push(isolated.runRoot);

    expect(await readFile(join(isolated.workspaceRoot, "src", "index.ts"), "utf8")).toContain(
      "safe",
    );
    await expect(access(join(isolated.workspaceRoot, ".env"))).rejects.toThrow();
    await expect(access(join(isolated.workspaceRoot, ".git"))).rejects.toThrow();
    await expect(access(join(isolated.workspaceRoot, "node_modules"))).rejects.toThrow();
    await expect(access(join(isolated.workspaceRoot, "secrets"))).rejects.toThrow();
    await expect(access(join(isolated.workspaceRoot, ".krater-benchmark"))).rejects.toThrow();
    expect(isolated.checker).toBeUndefined();
    await expect(access(join(isolated.runRoot, "checker"))).rejects.toThrow();

    const trusted = await createIsolatedWorkspace(
      makeCatalog().tasks[0],
      source,
      true,
    );
    temporaryPaths.push(trusted.runRoot);
    expect(trusted.checker?.absolutePath.startsWith(trusted.workspaceRoot)).toBe(false);
    expect(trusted.checker?.displayPath).toBe(
      join(".krater-benchmark", "checks", "KC-001.sh"),
    );
    expect(trusted.checker?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(trusted.checker!.absolutePath, "utf8")).toContain("exit 0");
  });

  it("runs and reports a hidden checker only with explicit trust", async () => {
    const invocation = await temporaryDirectory("krater-invocation-");
    const fixture = join(invocation, "fixture");
    await mkdir(join(fixture, "src"), { recursive: true });
    await mkdir(join(fixture, ".krater-benchmark", "checks"), { recursive: true });
    await writeFile(
      join(invocation, ".env"),
      [
        "KRATER_API_KEY=kr_test_super_secret",
        "KRATER_MODEL=test/kimi",
        "KRATER_CONTEXT_CHARS=10000",
        "KRATER_TOOL_OUTPUT_CHARS=1000",
        "KRATER_RESPONSE_STYLE=standard",
        "KRATER_MAX_STEPS=1",
        "",
      ].join("\n"),
    );
    await writeFile(join(fixture, "src", "index.ts"), "export const answer = 42;\n");
    await writeFile(
      join(fixture, ".krater-benchmark", "checks", "KC-001.sh"),
      [
        "#!/bin/sh",
        "test -z \"$KRATER_API_KEY\" || exit 9",
        "test -f src/index.ts || exit 10",
        "exit 0",
        "",
      ].join("\n"),
    );
    const outputStem = join(invocation, "reports", "fake-live");
    const stdout = vi.fn();
    const defaultStdout = vi.fn();
    const providerFactory = vi.fn((providerOptions) => ({
      async complete(
        _messages: unknown,
        _tools: unknown,
        onText: (text: string) => void,
      ) {
        const text = `Finished without tools; accidental echo ${providerOptions.apiKey}`;
        onText(text);
        return {
          message: { role: "assistant" as const, content: text },
          usage: { promptTokens: 20, completionTokens: 8, totalTokens: 28 },
        };
      },
      async listModels() {
        return [];
      },
    }));

    const defaultResult = await runBenchmarkCli(
      [
        "--live",
        "--task",
        "KC-001",
        "--workspace",
        "fixture",
        "--output",
        `${outputStem}-default`,
      ],
      {
        catalog: makeCatalog(),
        cwd: invocation,
        providerFactory,
        stdout: defaultStdout,
      },
    );
    expect(defaultResult.mode).toBe("live");
    if (defaultResult.mode !== "live") throw new Error("expected a live result");
    expect(defaultResult.report.run.trustCheckers).toBe(false);
    expect(defaultResult.report.results[0].externalCheck.status).toBe(
      "not-enabled",
    );
    expect(defaultStdout.mock.calls.flat().join("")).not.toContain(
      "Trusted checker:",
    );

    const result = await runBenchmarkCli(
      [
        "--live",
        "--task",
        "KC-001",
        "--workspace",
        "fixture",
        "--trust-checkers",
        "--output",
        outputStem,
      ],
      {
        catalog: makeCatalog(),
        cwd: invocation,
        providerFactory,
        stdout,
      },
    );

    expect(result.mode).toBe("live");
    if (result.mode !== "live") throw new Error("expected a live result");
    expect(providerFactory).toHaveBeenCalledTimes(2);
    expect(result.report.run).toMatchObject({
      contextChars: 10_000,
      toolOutputChars: 1_000,
      responseStyle: "standard",
      maxSteps: 1,
      trustCheckers: true,
    });
    expect(result.report.results[0].externalCheck.status).toBe("passed");
    expect(result.report.results[0].externalCheck.checker).toBe(
      join(".krater-benchmark", "checks", "KC-001.sh"),
    );
    expect(result.report.results[0].externalCheck.sha256).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(result.report.results[0].rubric).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "external-check-passed" }),
      ]),
    );
    expect(result.report.results[0].executionScore.score).toBe(70);
    const json = await readFile(result.paths.json, "utf8");
    const markdown = await readFile(result.paths.markdown, "utf8");
    expect(json).not.toContain("kr_test_super_secret");
    expect(markdown).not.toContain("kr_test_super_secret");
    expect(stdout.mock.calls.flat().join("")).not.toContain("kr_test_super_secret");
    expect(stdout.mock.calls.flat().join("")).toContain(
      "Trusted checker: .krater-benchmark",
    );
    expect(stdout.mock.calls.flat().join("")).toMatch(/SHA-256: [a-f0-9]{64}/);
    expect(json).toContain("[REDACTED]");
    expect(markdown).toMatch(/sha256: [a-f0-9]{64}/);
  });

  it("resolves auto once and records the concrete model for a comparable run", async () => {
    const invocation = await temporaryDirectory("krater-router-benchmark-");
    await writeFile(
      join(invocation, ".env"),
      "KRATER_API_KEY=kr_test_router_secret\n",
    );
    const providerFactory = vi.fn((providerOptions) => ({
      async complete(
        _messages: unknown,
        _tools: unknown,
        onText: (text: string) => void,
      ) {
        const text = `completed with ${providerOptions.model}`;
        onText(text);
        return {
          message: { role: "assistant" as const, content: text },
          usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
        };
      },
      async listModels() {
        return [
          {
            id: "cheap/model",
            pricing: { prompt: 0.1, completion: 0.2 },
            context_length: 128_000,
            supported_parameters: ["tools"],
            benchmarks: {
              artificial_analysis: {
                coding_index: 30,
                agentic_index: 25,
                intelligence_index: 30,
              },
            },
          },
          {
            id: "moonshotai/kimi-k3",
            pricing: { prompt: 3, completion: 15 },
            context_length: 1_048_576,
            supported_parameters: ["tools"],
            benchmarks: {
              artificial_analysis: {
                coding_index: 76.2,
                agentic_index: 50.1,
                intelligence_index: 57.1,
              },
            },
          },
        ];
      },
    }));
    const stdout = vi.fn();

    const result = await runBenchmarkCli(
      [
        "--live",
        "--task",
        "KC-001",
        "--model",
        "auto",
        "--output",
        join(invocation, "router-report"),
      ],
      {
        catalog: makeCatalog(),
        cwd: invocation,
        providerFactory,
        stdout,
      },
    );

    expect(result.mode).toBe("live");
    if (result.mode !== "live") throw new Error("expected a live result");
    expect(providerFactory).toHaveBeenCalledTimes(2);
    expect(providerFactory.mock.calls[0][0].model).toBe(
      "moonshotai/kimi-k3",
    );
    expect(providerFactory.mock.calls[1][0].model).toBe(
      "moonshotai/kimi-k3",
    );
    expect(result.report.run.model).toBe("moonshotai/kimi-k3");
    expect(stdout.mock.calls.flat().join("")).toMatch(
      /Smart Router selected moonshotai\/kimi-k3/i,
    );
  });
});

describe("honest execution scoring", () => {
  it("does not award tool points or correctness for model prose alone", () => {
    const events: CapturedAgentEvent[] = [
      {
        atMs: 1,
        event: { type: "text", text: "Everything is correct; trust me." },
      },
      { atMs: 2, event: { type: "done", steps: 1 } },
    ];
    const score = calculateExecutionScore(events, []);
    expect(score.score).toBe(70);
    expect(score.toolReliability.status).toBe("not-exercised");
    expect(score.warning).toMatch(/not a correctness score/i);
  });

  it("scores only observed tool-result success and captured runtime errors", () => {
    const toolResult = (
      id: string,
      ok: boolean,
    ): Extract<AgentEvent, { type: "tool_result" }> => ({
      type: "tool_result",
      id,
      name: "run_command",
      output: ok ? "passed" : "failed",
      ok,
    });
    const events: CapturedAgentEvent[] = [
      { atMs: 1, event: toolResult("one", true) },
      { atMs: 2, event: toolResult("two", false) },
      { atMs: 3, event: { type: "done", steps: 2 } },
    ];
    const score = calculateExecutionScore(events, ["test command failed"]);
    expect(score.score).toBe(55);
    expect(score.errorFree.points).toBe(0);
    expect(score.toolReliability.points).toBe(15);
    expect(score.toolReliability.status).toBe("partial");
  });
});
