import { describe, expect, it } from "vitest";
import {
  AdvancedAdapterInputError,
  calibrateReliabilityCandidate,
  replayRecordedCausalTwin,
  replayReliabilityEvaluation,
} from "./advanced-adapters.js";
import type {
  ReliabilityCaseResult,
  ReliabilityEvaluation,
} from "./intelligence/index.js";

const SNAPSHOT = `sha256:${"a".repeat(64)}` as const;

function causalInput(executions = [
  { exitCode: 1, stdout: "failed", stderr: "" },
  { exitCode: 1, stdout: "failed", stderr: "" },
  { exitCode: 0, stdout: "passed", stderr: "" },
]) {
  return {
    plan: {
      id: "recorded-causal-run",
      snapshotDigest: SNAPSHOT,
      baseline: {
        runtime: "node" as const,
        entrypoint: "fixture.mjs",
        environment: { MODE: "broken" },
      },
      hypotheses: [
        {
          id: "bad-mode",
          statement: "The mode causes the failure.",
          baselineExpectation: { keys: ["exit:1"] },
        },
        {
          id: "bad-fixture",
          statement: "The fixture causes the failure.",
          baselineExpectation: { keys: ["exit:1"] },
        },
      ],
      experiments: [
        {
          id: "toggle-mode",
          title: "Use the safe mode",
          intervention: {
            kind: "environment" as const,
            description: "Set MODE to safe.",
            changedInputs: ["MODE"],
            isolated: true,
          },
          invocation: {
            runtime: "node" as const,
            entrypoint: "fixture.mjs",
            environment: { MODE: "safe" },
          },
          estimatedCost: 1,
          predictions: [
            { hypothesisId: "bad-mode", expected: { keys: ["success"] } },
            {
              hypothesisId: "bad-fixture",
              expected: { keys: ["exit:1"] },
            },
          ],
        },
      ],
    },
    executions,
  };
}

function cases(
  count: number,
  resolved: number,
  prefix: string,
): ReliabilityCaseResult[] {
  return Array.from({ length: count }, (_, index) => ({
    caseId: `${prefix}-${index}`,
    taskClass: index % 2 === 0 ? "repair" : "abstention",
    resolved: index < resolved,
    securityFailures: 0,
    abstention: "not_applicable",
    costUsd: 0.1,
    latencyMs: 20,
  }));
}

function evaluation(
  id: string,
  role: ReliabilityEvaluation["role"],
  results: ReliabilityCaseResult[],
): ReliabilityEvaluation {
  return {
    evaluationId: id,
    suiteId: role === "rule_generation" ? "rules" : "holdout",
    datasetDigest: role === "rule_generation" ? "rules-v1" : "holdout-v1",
    role,
    configurationDigest: `config-${id}`,
    sealed: true,
    cases: results,
  };
}

describe("recorded causal adapter", () => {
  it("runs the causal core without claiming or performing process execution", async () => {
    const result = await replayRecordedCausalTwin(causalInput());

    expect(result.executedProcesses).toBe(false);
    expect(result.consumedExecutions).toBe(3);
    expect(result.report.verdict).toBe("causal_evidence_established");
    expect(result.report.causalHypothesisIds).toEqual(["bad-mode"]);
    expect(result.limitations.join(" ")).toMatch(/No process was executed/);
  });

  it("fails closed when recorded executions are absent or ambiguous", async () => {
    await expect(
      replayRecordedCausalTwin({ ...causalInput(), executions: [] }),
    ).rejects.toThrow(/requires recorded executions/i);

    await expect(
      replayRecordedCausalTwin({
        ...causalInput(),
        executions: [
          { exitCode: 1, stdout: "", stderr: "" },
          { exitCode: 0, stdout: "", stderr: "" },
          { exitCode: 0, stdout: "", stderr: "" },
        ],
      }),
    ).rejects.toThrow(/consumed 2 recorded execution.*3 were supplied/i);
  });

  it("redacts declared secrets from validation failures", async () => {
    const secret = "kr_secret_abcdefghijklmnop";
    const input = causalInput();
    input.plan.privacy = { secrets: [secret] };
    input.plan.hypotheses[0].id = secret;
    input.plan.hypotheses[0].statement = "";

    await expect(replayRecordedCausalTwin(input)).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toBeInstanceOf(AdvancedAdapterInputError);
        expect(String(error)).not.toContain(secret);
        expect(String(error)).toContain("[REDACTED]");
        return true;
      },
    );
  });
});

describe("private reliability lab adapters", () => {
  it("scores a sealed recorded evaluation without claiming benchmark execution", () => {
    const result = replayReliabilityEvaluation({
      evaluation: evaluation(
        "candidate",
        "private_holdout",
        cases(20, 15, "holdout"),
      ),
    });

    expect(result.executedBenchmarks).toBe(false);
    expect(result.metrics).toMatchObject({
      caseCount: 20,
      resolvedCount: 15,
      resolutionRate: 75,
      securityFailures: 0,
    });
    expect(result.limitations.join(" ")).toMatch(/does not execute/i);
  });

  it("rejects unsealed, empty, and duplicate result sets", () => {
    expect(() =>
      replayReliabilityEvaluation({
        evaluation: {
          ...evaluation("candidate", "private_holdout", cases(1, 1, "case")),
          sealed: false,
        },
      }),
    ).toThrow(/must be sealed/i);

    expect(() =>
      replayReliabilityEvaluation({
        evaluation: evaluation("candidate", "private_holdout", []),
      }),
    ).toThrow(/at least one/i);

    const duplicate = cases(2, 1, "same");
    duplicate[1] = { ...duplicate[1], caseId: duplicate[0].caseId };
    expect(() =>
      replayReliabilityEvaluation({
        evaluation: evaluation("candidate", "private_holdout", duplicate),
      }),
    ).toThrow(/repeats a case ID/i);
  });

  it("evaluates but never persists a valid promotion decision", () => {
    const secretLikeCandidateId = `ghp_${"x".repeat(24)}`;
    const result = calibrateReliabilityCandidate({
      candidateId: secretLikeCandidateId,
      candidateKind: "router",
      ruleGeneration: evaluation(
        "rules",
        "rule_generation",
        cases(2, 2, "training"),
      ),
      baselineHoldout: evaluation(
        "baseline",
        "private_holdout",
        cases(20, 10, "holdout"),
      ),
      candidateHoldout: evaluation(
        "candidate",
        "private_holdout",
        cases(20, 11, "holdout"),
      ),
    });

    expect(result.persistedPromotion).toBe(false);
    expect(result.decision.promote).toBe(true);
    expect(result.decision.improvementPoints).toBeCloseTo(5);
    expect(JSON.stringify(result)).not.toContain(secretLikeCandidateId);
    expect(result.decision.candidateId).toBe("[REDACTED]");
  });
});
