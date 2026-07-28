import { describe, expect, it } from "vitest";
import {
  assessJuryTrigger,
  decideJury,
  evaluateReliabilityPromotion,
  forecastSemanticMerge,
  planJury,
  type JuryCandidate,
  type ReliabilityCaseResult,
  type ReliabilityEvaluation,
} from "./index.js";

function candidate(
  overrides: Partial<JuryCandidate> & Pick<JuryCandidate, "id">,
): JuryCandidate {
  return {
    id: overrides.id,
    modelId: overrides.modelId ?? `model-${overrides.id}`,
    promptDigest: overrides.promptDigest ?? `prompt-${overrides.id}`,
    patchDigest: overrides.patchDigest ?? `patch-${overrides.id}`,
    evidenceGrade: overrides.evidenceGrade ?? "tested",
    verificationVerdict: overrides.verificationVerdict ?? "passed",
    checks: overrides.checks ?? [
      {
        id: "repo-tests",
        passed: true,
        evidenceRefs: [`test:${overrides.id}`],
      },
    ],
    evidenceRefs: overrides.evidenceRefs ?? [`test:${overrides.id}`],
    contradictionRefs: overrides.contradictionRefs,
    securityFailures: overrides.securityFailures ?? 0,
    actualCostUsd: overrides.actualCostUsd ?? 0.4,
    voteCount: overrides.voteCount,
  };
}

describe("confidence-triggered jury", () => {
  it("does not convene by default when policy thresholds are not crossed", () => {
    const trigger = assessJuryTrigger({
      risk: 0.2,
      ambiguity: 0.1,
      routerConfidence: 0.9,
      routerCalibrationError: 0.02,
      routerCalibrationSamples: 100,
    });

    expect(trigger).toEqual({
      shouldConvene: false,
      triggers: [],
      reasons: [],
    });
    expect(
      planJury(trigger, 1, [
        {
          id: "a",
          modelId: "m1",
          promptDigest: "p1",
          estimatedCostUsd: 0.2,
        },
        {
          id: "b",
          modelId: "m2",
          promptDigest: "p2",
          estimatedCostUsd: 0.2,
        },
      ]).status,
    ).toBe("not_triggered");
  });

  it("plans only an affordable independent pair", () => {
    const trigger = assessJuryTrigger({
      risk: 0.9,
      ambiguity: 0.1,
    });
    const planned = planJury(trigger, 0.5, [
      {
        id: "same-a",
        modelId: "m",
        promptDigest: "same",
        estimatedCostUsd: 0.1,
      },
      {
        id: "same-b",
        modelId: "m",
        promptDigest: "same",
        estimatedCostUsd: 0.1,
      },
      {
        id: "independent",
        modelId: "m",
        promptDigest: "different",
        estimatedCostUsd: 0.3,
      },
    ]);

    expect(planned.status).toBe("planned");
    expect(planned.candidateIds).toEqual(["same-a", "independent"]);
    expect(planned.estimatedCostUsd).toBeCloseTo(0.4);
    expect(planned.costLimitUsd).toBe(1);
  });

  it("lets deterministic evidence outrank votes and preserves dissent", () => {
    const trigger = assessJuryTrigger({
      risk: 0.2,
      ambiguity: 0.1,
      verificationContradiction: true,
    });
    const decision = decideJury({
      trigger,
      assurance: "standard",
      primaryAgentCostUsd: 1,
      candidates: [
        candidate({
          id: "popular",
          evidenceGrade: "tested",
          voteCount: 99,
        }),
        candidate({
          id: "proven",
          evidenceGrade: "stress_tested",
          voteCount: 0,
        }),
      ],
    });

    expect(decision.status).toBe("selected");
    expect(decision.selectedCandidateId).toBe("proven");
    expect(decision.ignoredVoteCounts).toEqual({
      popular: 99,
      proven: 0,
    });
    expect(decision.dissent).toEqual([
      expect.objectContaining({
        candidateId: "popular",
        evidenceRefs: ["test:popular"],
      }),
    ]);
  });

  it("abstains when no proposal clears the assurance floor", () => {
    const trigger = assessJuryTrigger({
      risk: 0.9,
      ambiguity: 0,
    });
    const decision = decideJury({
      trigger,
      assurance: "high",
      primaryAgentCostUsd: 1,
      candidates: [
        candidate({ id: "a", evidenceGrade: "tested" }),
        candidate({
          id: "b",
          evidenceGrade: "stress_tested",
          contradictionRefs: ["mutation:survivor"],
        }),
      ],
    });

    expect(decision.status).toBe("abstained");
    expect(decision.selectedCandidateId).toBeUndefined();
    expect(decision.dissent).toHaveLength(2);
  });

  it("blocks a jury that exceeds twice the single-agent cost", () => {
    const trigger = assessJuryTrigger({
      risk: 0.9,
      ambiguity: 0,
    });
    const decision = decideJury({
      trigger,
      assurance: "standard",
      primaryAgentCostUsd: 0.25,
      candidates: [
        candidate({ id: "a", actualCostUsd: 0.3 }),
        candidate({ id: "b", actualCostUsd: 0.3 }),
      ],
    });

    expect(decision.status).toBe("blocked_budget");
    expect(decision.totalCostUsd).toBeCloseTo(0.6);
    expect(decision.costLimitUsd).toBeCloseTo(0.5);
  });
});

describe("semantic merge forecaster", () => {
  it("orders a compatible dependency DAG", () => {
    const result = forecastSemanticMerge([
      {
        id: "schema",
        schemas: [{ id: "users", operation: "add", shapeDigest: "v1" }],
      },
      {
        id: "api",
        dependencies: ["schema"],
        symbols: [{ id: "createUser", operation: "write", contractDigest: "v1" }],
      },
      {
        id: "ui",
        dependencies: ["api"],
        symbols: [{ id: "UserCard", operation: "write", contractDigest: "v1" }],
      },
    ]);

    expect(result.safeToCombine).toBe(true);
    expect(result.orderedPatchIds).toEqual(["schema", "api", "ui"]);
    expect(result.conflicts).toEqual([]);
  });

  it("detects semantic conflicts without relying on textual overlap", () => {
    const result = forecastSemanticMerge([
      {
        id: "feature-a",
        intents: [
          { id: "intent:auth", effect: "fulfills", fingerprint: "passwordless" },
        ],
        symbols: [
          { id: "Auth.login", operation: "signature_change", contractDigest: "a" },
        ],
        schemas: [{ id: "User", operation: "alter", shapeDigest: "a" }],
        invariants: [{ id: "no-plaintext", effect: "preserves" }],
      },
      {
        id: "feature-b",
        intents: [{ id: "intent:auth", effect: "contradicts" }],
        symbols: [
          { id: "Auth.login", operation: "write", contractDigest: "b" },
        ],
        schemas: [{ id: "User", operation: "alter", shapeDigest: "b" }],
        invariants: [{ id: "no-plaintext", effect: "weakens" }],
      },
    ]);

    expect(result.safeToCombine).toBe(false);
    expect(result.conflicts.map((conflict) => conflict.category)).toEqual(
      expect.arrayContaining(["intent", "symbol", "schema", "invariant"]),
    );
    expect(result.blockingConflictCount).toBeGreaterThanOrEqual(4);
  });

  it("detects patch cycles and divergent migration order", () => {
    const result = forecastSemanticMerge([
      {
        id: "a",
        dependencies: ["b"],
        migrations: [
          {
            id: "migration-a",
            resource: "db",
            order: 2,
            fromVersion: "1",
            toVersion: "2a",
          },
        ],
      },
      {
        id: "b",
        dependencies: ["a"],
        migrations: [
          {
            id: "migration-b",
            resource: "db",
            order: 2,
            fromVersion: "1",
            toVersion: "2b",
          },
        ],
      },
    ]);

    expect(result.safeToCombine).toBe(false);
    expect(result.orderedPatchIds).toEqual([]);
    expect(result.conflicts.map((conflict) => conflict.category)).toEqual(
      expect.arrayContaining(["dependency_cycle", "migration"]),
    );
    expect(
      result.conflicts.some(
        (conflict) => conflict.recommendation === "reorder",
      ),
    ).toBe(true);
  });
});

function cases(
  count: number,
  resolved: number,
  prefix = "holdout",
): ReliabilityCaseResult[] {
  return Array.from({ length: count }, (_, index) => ({
    caseId: `${prefix}-${index}`,
    taskClass: index % 2 === 0 ? "repair" : "abstention",
    resolved: index < resolved,
    securityFailures: 0,
    abstention: "not_applicable",
    costUsd: 0.1,
    latencyMs: 10,
  }));
}

function evaluation(
  overrides: Partial<ReliabilityEvaluation> &
    Pick<ReliabilityEvaluation, "evaluationId" | "role" | "cases">,
): ReliabilityEvaluation {
  return {
    evaluationId: overrides.evaluationId,
    suiteId: overrides.suiteId ?? "suite",
    datasetDigest: overrides.datasetDigest ?? "dataset-v1",
    role: overrides.role,
    configurationDigest:
      overrides.configurationDigest ?? `config-${overrides.evaluationId}`,
    sealed: overrides.sealed ?? true,
    cases: overrides.cases,
  };
}

describe("private reliability lab promotion gate", () => {
  it("promotes only after a sealed holdout improves by at least five points", () => {
    const decision = evaluateReliabilityPromotion({
      candidateId: "router-v2",
      candidateKind: "router",
      ruleGeneration: evaluation({
        evaluationId: "rules",
        role: "rule_generation",
        cases: cases(5, 5, "training"),
      }),
      baselineHoldout: evaluation({
        evaluationId: "baseline",
        role: "private_holdout",
        cases: cases(20, 10),
      }),
      candidateHoldout: evaluation({
        evaluationId: "candidate",
        role: "private_holdout",
        cases: cases(20, 11),
      }),
    });

    expect(decision.promote).toBe(true);
    expect(decision.improvementPoints).toBeCloseTo(5);
    expect(decision.reasons).toEqual([]);
    expect(decision.candidate.byTaskClass.repair.caseCount).toBe(10);
  });

  it("blocks holdout contamination even with a large improvement", () => {
    const decision = evaluateReliabilityPromotion({
      candidateId: "prompt-v2",
      candidateKind: "prompt",
      ruleGeneration: evaluation({
        evaluationId: "rules",
        role: "rule_generation",
        cases: cases(2, 2, "holdout"),
      }),
      baselineHoldout: evaluation({
        evaluationId: "baseline",
        role: "private_holdout",
        cases: cases(20, 5),
      }),
      candidateHoldout: evaluation({
        evaluationId: "candidate",
        role: "private_holdout",
        cases: cases(20, 15),
      }),
    });

    expect(decision.promote).toBe(false);
    expect(decision.reasons).toContainEqual(
      expect.objectContaining({
        code: "holdout_contamination",
        caseIds: ["holdout-0", "holdout-1"],
      }),
    );
  });

  it("blocks per-case security and abstention regressions", () => {
    const baselineCases = cases(20, 10);
    const candidateCases = cases(20, 15);
    candidateCases[12] = {
      ...candidateCases[12],
      securityFailures: 1,
    };
    candidateCases[13] = {
      ...candidateCases[13],
      abstention: "incorrect",
    };

    const decision = evaluateReliabilityPromotion({
      candidateId: "policy-v2",
      candidateKind: "policy",
      ruleGeneration: evaluation({
        evaluationId: "rules",
        role: "rule_generation",
        cases: cases(2, 2, "training"),
      }),
      baselineHoldout: evaluation({
        evaluationId: "baseline",
        role: "private_holdout",
        cases: baselineCases,
      }),
      candidateHoldout: evaluation({
        evaluationId: "candidate",
        role: "private_holdout",
        cases: candidateCases,
      }),
    });

    expect(decision.promote).toBe(false);
    expect(decision.reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining(["security_regression", "abstention_regression"]),
    );
  });
});
