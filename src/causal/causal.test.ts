import { describe, expect, it } from "vitest";
import {
  CausalTwinExecutionError,
  CausalTwinRunner,
  rankDistinguishingExperiments,
  type CausalExperiment,
  type CausalHypothesis,
  type CausalTwinPlan,
  type ProcessExecution,
  type ProcessRunner,
  type ProcessRunnerRequest,
} from "./index.js";

const SNAPSHOT = `sha256:${"a".repeat(64)}` as const;

const hypotheses: readonly CausalHypothesis[] = [
  {
    id: "bad-mode",
    statement: "A bad mode causes the failure.",
    baselineExpectation: { keys: ["exit:1"] },
  },
  {
    id: "bad-fixture",
    statement: "The fixture causes the failure.",
    baselineExpectation: { keys: ["exit:1"] },
  },
];

function experiment(
  overrides: Partial<CausalExperiment> & Pick<CausalExperiment, "id">,
): CausalExperiment {
  return {
    id: overrides.id,
    title: overrides.title ?? "Toggle the mode",
    estimatedCost: overrides.estimatedCost ?? 1,
    intervention:
      overrides.intervention ??
      ({
        kind: "environment",
        description: "Set MODE to safe",
        changedInputs: ["MODE"],
        isolated: true,
      } as const),
    invocation:
      overrides.invocation ??
      ({
        runtime: "node",
        entrypoint: "fixture.mjs",
        environment: { MODE: "safe" },
      } as const),
    predictions:
      overrides.predictions ??
      [
        { hypothesisId: "bad-mode", expected: { keys: ["success"] } },
        { hypothesisId: "bad-fixture", expected: { keys: ["exit:1"] } },
      ],
  };
}

function plan(overrides: Partial<CausalTwinPlan> = {}): CausalTwinPlan {
  return {
    id: "causal-run",
    snapshotDigest: SNAPSHOT,
    baseline: {
      runtime: "node",
      entrypoint: "/Users/alice/project/fixture.mjs",
      args: ["--token=kr_secret_abcdefghijklmnop"],
      environment: {
        MODE: "broken",
        API_KEY: "kr_secret_abcdefghijklmnop",
      },
    },
    hypotheses,
    experiments: [experiment({ id: "toggle-mode" })],
    privacy: {
      secrets: ["kr_secret_abcdefghijklmnop"],
    },
    ...overrides,
  };
}

class QueueRunner implements ProcessRunner {
  readonly requests: ProcessRunnerRequest[] = [];

  constructor(private readonly results: ProcessExecution[]) {}

  async run(request: ProcessRunnerRequest): Promise<ProcessExecution> {
    this.requests.push(request);
    const result = this.results.shift();
    if (!result) throw new Error("No queued result");
    return result;
  }
}

function failed(stdout = "failure"): ProcessExecution {
  return {
    exitCode: 1,
    stdout,
    stderr: "",
    durationMs: 5,
  };
}

function passed(stdout = "pass"): ProcessExecution {
  return {
    exitCode: 0,
    stdout,
    stderr: "",
    durationMs: 7,
  };
}

describe("experiment ranking", () => {
  it("keeps only distinguishing experiments and selects the cheapest first", () => {
    const ranked = rankDistinguishingExperiments(hypotheses, [
      experiment({ id: "expensive", estimatedCost: 8 }),
      experiment({
        id: "same-prediction",
        estimatedCost: 0,
        predictions: [
          { hypothesisId: "bad-mode", expected: { keys: ["success"] } },
          { hypothesisId: "bad-fixture", expected: { keys: ["success"] } },
        ],
      }),
      experiment({ id: "cheap", estimatedCost: 2 }),
    ]);

    expect(ranked).toEqual([
      {
        experimentId: "cheap",
        rank: 1,
        estimatedCost: 2,
        distinguishingPairs: 1,
      },
      {
        experimentId: "expensive",
        rank: 2,
        estimatedCost: 8,
        distinguishingPairs: 1,
      },
    ]);
  });
});

describe("causal twin runner", () => {
  it("labels only the matching predicted controlled change as causal", async () => {
    const secret = "kr_secret_abcdefghijklmnop";
    const runner = new QueueRunner([
      failed(`user alice@example.com token ${secret} ${"x".repeat(100)}`),
      failed("same semantic failure"),
      passed("fixed"),
    ]);
    const report = await new CausalTwinRunner(runner).run(
      plan({ limits: { maxOutputBytesPerStream: 48 } }),
    );

    expect(report.verdict).toBe("causal_evidence_established");
    expect(report.causalHypothesisIds).toEqual(["bad-mode"]);
    expect(report.determinism).toMatchObject({
      established: true,
      replayCount: 2,
      outcomeKeys: ["exit:1", "exit:1"],
    });
    expect(report.experiments[0].assessments).toEqual([
      expect.objectContaining({
        hypothesisId: "bad-mode",
        label: "causal",
        predictedChange: true,
        observedChange: true,
        reasons: ["predicted_controlled_change_observed"],
      }),
      expect.objectContaining({
        hypothesisId: "bad-fixture",
        label: "observational",
        predictedChange: false,
        observedChange: true,
      }),
    ]);

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("alice@example.com");
    expect(serialized).not.toContain("/Users/alice");
    expect(serialized).not.toContain('"API_KEY":"');
    expect(report.baseline[0].stdout.truncated).toBe(true);
    expect(report.baseline[0].stdout.capturedBytes).toBeLessThanOrEqual(48);
    expect(report.baseline[0].invocation.environmentKeys).toEqual([
      "API_KEY",
      "MODE",
    ]);
    expect(runner.requests).toHaveLength(3);
    expect(runner.requests[0]).toMatchObject({
      runtime: "node",
      maxOutputBytesPerStream: 48,
    });
  });

  it("produces stable content digests and delegates Python through the same boundary", async () => {
    const first = failed("same");
    const second = { ...failed("same"), durationMs: 999 };
    const runner = new QueueRunner([first, second, passed()]);
    const pythonPlan = plan({
      baseline: {
        runtime: "python",
        entrypoint: "fixture.py",
      },
      experiments: [
        experiment({
          id: "python-toggle",
          invocation: {
            runtime: "python",
            entrypoint: "fixture.py",
            args: ["--mode", "safe"],
          },
        }),
      ],
    });
    const report = await new CausalTwinRunner(runner).run(pythonPlan);

    expect(report.baseline[0].digest).toBe(report.baseline[1].digest);
    expect(report.baseline[0].id).not.toBe(report.baseline[1].id);
    expect(runner.requests.map((request) => request.runtime)).toEqual([
      "python",
      "python",
      "python",
    ]);
  });

  it("keeps an unchanged predicted intervention observational", async () => {
    const runner = new QueueRunner([
      failed(),
      failed(),
      failed("still broken"),
    ]);
    const report = await new CausalTwinRunner(runner).run(plan());
    const assessment = report.experiments[0].assessments.find(
      (candidate) => candidate.hypothesisId === "bad-mode",
    );

    expect(report.verdict).toBe("observational_only");
    expect(assessment).toMatchObject({
      label: "observational",
      predictedChange: true,
      observedChange: false,
    });
    expect(assessment?.reasons).toContain("outcome_did_not_change");
    expect(assessment?.reasons).toContain(
      "intervention_did_not_match_prediction",
    );
  });

  it("refuses causal inference when baseline replay is not deterministic", async () => {
    const runner = new QueueRunner([failed(), passed()]);
    const report = await new CausalTwinRunner(runner).run(plan());

    expect(report.verdict).toBe("baseline_not_deterministic");
    expect(report.determinism.established).toBe(false);
    expect(report.experiments).toEqual([]);
    expect(report.causalHypothesisIds).toEqual([]);
    expect(runner.requests).toHaveLength(2);
  });

  it("requires an isolated intervention for a causal label", async () => {
    const runner = new QueueRunner([failed(), failed(), passed()]);
    const unisolated = experiment({
      id: "unisolated",
      intervention: {
        kind: "caller_defined",
        description: "Caller changed several unknown inputs.",
        changedInputs: ["unknown"],
        isolated: false,
      },
    });
    const report = await new CausalTwinRunner(runner).run(
      plan({ experiments: [unisolated] }),
    );

    expect(report.verdict).toBe("observational_only");
    expect(report.experiments[0].assessments[0]).toMatchObject({
      label: "observational",
      interventionIsolated: false,
    });
    expect(report.experiments[0].assessments[0].reasons).toContain(
      "intervention_not_isolated",
    );
  });

  it("reports when no experiment distinguishes competing hypotheses", async () => {
    const runner = new QueueRunner([failed(), failed()]);
    const report = await new CausalTwinRunner(runner).run(
      plan({
        experiments: [
          experiment({
            id: "same",
            predictions: [
              { hypothesisId: "bad-mode", expected: { keys: ["success"] } },
              {
                hypothesisId: "bad-fixture",
                expected: { keys: ["success"] },
              },
            ],
          }),
        ],
      }),
    );

    expect(report.verdict).toBe("no_distinguishing_experiment");
    expect(report.rankedExperiments).toEqual([]);
    expect(runner.requests).toHaveLength(2);
  });

  it("scrubs process-runner errors before rethrowing", async () => {
    const secret = "kr_secret_abcdefghijklmnop";
    const runner: ProcessRunner = {
      async run() {
        throw new Error(`authorization: Bearer ${secret}`);
      },
    };

    await expect(
      new CausalTwinRunner(runner).run(
        plan({ privacy: { secrets: [secret] } }),
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(CausalTwinExecutionError);
      expect(String(error)).not.toContain(secret);
      expect(String(error)).toContain("[REDACTED]");
      return true;
    });
  });

  it("rejects unsupported or weakly identified plans before execution", async () => {
    const runner = new QueueRunner([]);

    await expect(
      new CausalTwinRunner(runner).run(
        plan({
          snapshotDigest: "not-a-digest" as `sha256:${string}`,
        }),
      ),
    ).rejects.toThrow(/snapshot digest/);
    expect(runner.requests).toEqual([]);
  });
});
