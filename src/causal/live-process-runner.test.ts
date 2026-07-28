import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { computeWorkspaceSnapshotDigest } from "../staging-workspace.js";
import type {
  NativeAdapterExecutionRequest,
  NativeAdapterExecutionResult,
  NativeSandboxAdapter,
  PlatformCapabilityReport,
} from "../sandbox/index.js";
import {
  LiveCausalUnavailableError,
  LiveCausalValidationError,
  parseLiveCausalPlan,
  runLiveCausalTwin,
  type CausalTwinPlan,
} from "./index.js";

const temporaryPaths: string[] = [];
const fixtureRoot = fileURLToPath(new URL("./fixtures/", import.meta.url));

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "krater-live-causal-"));
  temporaryPaths.push(root);
  await writeFile(
    join(root, "fixture.mjs"),
    await readFile(join(fixtureRoot, "live-node.mjs")),
  );
  await writeFile(
    join(root, "fixture.py"),
    await readFile(join(fixtureRoot, "live-python.py")),
  );
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

function capabilityReport(): PlatformCapabilityReport {
  return {
    platform: "darwin",
    verification: "verified",
    availability: "available",
    expectedPrimitives: [
      "macos_sandbox_profile",
      "macos_process_limits",
    ],
    verifiedPrimitives: [
      "macos_sandbox_profile",
      "macos_process_limits",
    ],
    controls: {
      filesystemBoundary: true,
      processIsolation: true,
      networkDeny: true,
      networkAllowlist: true,
      cpuLimit: true,
      memoryLimit: true,
      wallTimeLimit: true,
      processCountLimit: true,
      outputLimit: true,
    },
    adapterId: "test-only-verified-adapter",
    supportsApprovedUncontainedExecution: false,
    reason: "Test-owned adapter with an explicit verified capability report.",
    verifiedAt: "2026-07-28T00:00:00.000Z",
  };
}

class TestProcessAdapter implements NativeSandboxAdapter {
  readonly id = "test-only-verified-adapter";
  readonly requests: NativeAdapterExecutionRequest[] = [];
  readonly #environment: NodeJS.ProcessEnv;

  constructor(environment: NodeJS.ProcessEnv) {
    this.#environment = environment;
  }

  async probe(): Promise<PlatformCapabilityReport> {
    return capabilityReport();
  }

  async run(
    request: NativeAdapterExecutionRequest,
  ): Promise<NativeAdapterExecutionResult> {
    this.requests.push(request);
    return new Promise((resolveResult, reject) => {
      const child = spawn(
        request.command.executable,
        [...request.command.arguments],
        {
          cwd: request.command.workingDirectory,
          env: { ...this.#environment },
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", reject);
      child.once("close", (exitCode, signal) => {
        resolveResult({
          exitCode,
          ...(signal ? { signal } : {}),
          terminationReason: "exit",
          output: [
            { stream: "stdout", data: Buffer.concat(stdout) },
            { stream: "stderr", data: Buffer.concat(stderr) },
          ],
        });
      });
    });
  }

  async cancel(): Promise<void> {
    // The deterministic fixtures finish before cancellation is required.
  }
}

function adapterOptions() {
  let adapter: TestProcessAdapter | undefined;
  return {
    runnerOptions: {
      platform: "darwin" as const,
      adapterFactory: (
        _platform: NodeJS.Platform,
        environment: NodeJS.ProcessEnv,
      ) => {
        adapter = new TestProcessAdapter(environment);
        return adapter;
      },
    },
    adapter: () => adapter,
  };
}

async function plan(
  root: string,
  runtime: "node" | "python",
  overrides: Partial<CausalTwinPlan> = {},
): Promise<{ plan: CausalTwinPlan }> {
  const entrypoint = runtime === "node" ? "fixture.mjs" : "fixture.py";
  return {
    plan: {
      id: `live-${runtime}`,
      snapshotDigest: (await computeWorkspaceSnapshotDigest(
        root,
      )) as `sha256:${string}`,
      baseline: {
        runtime,
        entrypoint,
        environment: { KRATER_CAUSAL_MODE: "broken" },
      },
      hypotheses: [
        {
          id: "mode",
          statement: "The selected mode causes the failure.",
          baselineExpectation: { keys: ["exit:7"] },
        },
        {
          id: "fixture",
          statement: "The fixture itself always fails.",
          baselineExpectation: { keys: ["exit:7"] },
        },
      ],
      experiments: [
        {
          id: "safe-mode",
          title: "Change only the mode.",
          intervention: {
            kind: "environment",
            description: "Set the non-secret mode input to safe.",
            changedInputs: ["KRATER_CAUSAL_MODE"],
            isolated: true,
          },
          invocation: {
            runtime,
            entrypoint,
            environment: { KRATER_CAUSAL_MODE: "safe" },
          },
          estimatedCost: 1,
          predictions: [
            { hypothesisId: "mode", expected: { keys: ["success"] } },
            { hypothesisId: "fixture", expected: { keys: ["exit:7"] } },
          ],
        },
      ],
      limits: {
        baselineReplays: 2,
        maxExperiments: 1,
        defaultTimeoutMs: 2_000,
        maxOutputBytesPerStream: 1_024,
      },
      ...overrides,
    },
  };
}

describe("live causal process execution", () => {
  it.runIf(process.platform === "darwin")(
    "runs the Node.js fixture through the production macOS containment adapter",
    async () => {
      const root = await workspace();
      const result = await runLiveCausalTwin(await plan(root, "node"), {
        workspaceRoot: root,
      });

      expect(result.execution).toMatchObject({
        containment: "secure",
        adapterId: "macos-seatbelt-v1",
        platform: "darwin",
        executionCount: 3,
      });
      expect(result.report.verdict).toBe("causal_evidence_established");
    },
    15_000,
  );

  it("establishes Node.js causal evidence only after the isolated intervention changes the outcome", async () => {
    const root = await workspace();
    const adapter = adapterOptions();
    const result = await runLiveCausalTwin(await plan(root, "node"), {
      workspaceRoot: root,
      runnerOptions: adapter.runnerOptions,
    });

    expect(result).toMatchObject({
      mode: "live_sandboxed_process_execution",
      executedProcesses: true,
      workspaceDigestVerified: true,
      execution: {
        executionCount: 3,
        containment: "secure",
        adapterId: "test-only-verified-adapter",
      },
      report: {
        verdict: "causal_evidence_established",
        causalHypothesisIds: ["mode"],
      },
    });
    expect(result.report.baseline.map((item) => item.outcome.key)).toEqual([
      "exit:7",
      "exit:7",
    ]);
    expect(result.report.experiments[0].observation.outcome.key).toBe("success");
    expect(result.report.experiments[0].assessments[0]).toMatchObject({
      hypothesisId: "mode",
      label: "causal",
      observedChange: true,
      interventionIsolated: true,
    });
    expect(adapter.adapter()?.requests).toHaveLength(3);
    expect(
      adapter.adapter()?.requests.every(
        (request) =>
          request.containment === "secure" &&
          request.network.policy === "deny" &&
          request.resources[0].access === "read",
      ),
    ).toBe(true);
  });

  it("executes the same causal contract for a deterministic Python fixture", async () => {
    let python: string | undefined;
    for (const candidate of [
      "/usr/bin/python3",
      "/opt/homebrew/bin/python3",
      "/usr/local/bin/python3",
    ]) {
      try {
        await access(candidate);
        python = candidate;
        break;
      } catch {
        // Continue through the fixed, host-owned candidates.
      }
    }
    expect(python).toBeTruthy();
    const root = await workspace();
    const adapter = adapterOptions();
    const result = await runLiveCausalTwin(await plan(root, "python"), {
      workspaceRoot: root,
      runnerOptions: {
        ...adapter.runnerOptions,
        pythonExecutable: python,
      },
    });

    expect(result.report.verdict).toBe("causal_evidence_established");
    expect(result.report.experiments[0].assessments[0]).toMatchObject({
      label: "causal",
      observedChange: true,
    });
  });

  it("keeps unchanged and non-isolated outcomes observational", async () => {
    const root = await workspace();
    const input = await plan(root, "node");
    const original = input.plan.experiments[0];
    input.plan = {
      ...input.plan,
      experiments: [
        {
          ...original,
          intervention: {
            ...original.intervention,
            isolated: false,
            changedInputs: ["KRATER_CAUSAL_MODE", "unknown"],
          },
        },
      ],
    };
    const adapter = adapterOptions();
    const result = await runLiveCausalTwin(input, {
      workspaceRoot: root,
      runnerOptions: adapter.runnerOptions,
    });

    expect(result.report.verdict).toBe("observational_only");
    expect(result.report.experiments[0].assessments[0]).toMatchObject({
      label: "observational",
      observedChange: true,
      interventionIsolated: false,
    });
  });

  it("rejects a false isolation declaration before starting any process", async () => {
    const root = await workspace();
    const input = await plan(root, "node");
    input.plan = {
      ...input.plan,
      experiments: [
        {
          ...input.plan.experiments[0],
          intervention: {
            ...input.plan.experiments[0].intervention,
            changedInputs: ["NOT_THE_CHANGED_INPUT"],
          },
        },
      ],
    };
    const adapter = adapterOptions();

    await expect(
      runLiveCausalTwin(input, {
        workspaceRoot: root,
        runnerOptions: adapter.runnerOptions,
      }),
    ).rejects.toThrow(/must exactly name.*KRATER_CAUSAL_MODE/i);
    expect(adapter.adapter()).toBeUndefined();
  });

  it("fails closed before execution when verified containment is unavailable", async () => {
    const root = await workspace();
    await expect(
      runLiveCausalTwin(await plan(root, "node"), {
        workspaceRoot: root,
        runnerOptions: {
          platform: "linux",
          adapterFactory: () => undefined,
        },
      }),
    ).rejects.toBeInstanceOf(LiveCausalUnavailableError);
  });

  it("rejects traversal, unknown fields, and credential-bearing inputs", async () => {
    const root = await workspace();
    const traversal = await plan(root, "node");
    traversal.plan = {
      ...traversal.plan,
      baseline: {
        ...traversal.plan.baseline,
        entrypoint: "../fixture.mjs",
      },
      experiments: traversal.plan.experiments.map((experiment) => ({
        ...experiment,
        invocation: {
          ...experiment.invocation,
          entrypoint: "../fixture.mjs",
        },
      })),
    };
    const adapter = adapterOptions();
    await expect(
      runLiveCausalTwin(traversal, {
        workspaceRoot: root,
        runnerOptions: adapter.runnerOptions,
      }),
    ).rejects.toThrow(/workspace-relative|traversal/i);
    expect(adapter.adapter()?.requests ?? []).toHaveLength(0);

    const inputWithUnknownField = {
      ...(await plan(root, "node")),
      shellCommand: "node fixture.mjs",
    };
    expect(() => parseLiveCausalPlan(inputWithUnknownField)).toThrow(
      /unsupported field shellCommand/i,
    );

    const credential = await plan(root, "node");
    credential.plan = {
      ...credential.plan,
      baseline: {
        ...credential.plan.baseline,
        environment: { API_KEY: "do-not-pass" },
      },
    };
    await expect(
      runLiveCausalTwin(credential, {
        workspaceRoot: root,
        runnerOptions: adapterOptions().runnerOptions,
      }),
    ).rejects.toBeInstanceOf(LiveCausalValidationError);
  });
});
