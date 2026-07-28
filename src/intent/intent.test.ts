import { describe, expect, it } from "vitest";
import {
  buildOutcomeContract,
  classifyActionNeed,
  createIntentId,
  rankAmbiguities,
  selectNextClarification,
  validateIntentGraph,
  type ActionGateInput,
  type IntentGraph,
} from "./index.js";

describe("outcome contracts", () => {
  it("uses standard assurance by default and produces a deterministic quote", () => {
    const first = buildOutcomeContract({ request: "Fix the parser safely." });
    const second = buildOutcomeContract({
      request: "  Fix the parser safely. ",
      assurance: "standard",
    });

    expect(first).toEqual(second);
    expect(first.assurance).toBe("standard");
    expect(first.requiredChecks).toContain("tests");
    expect(first.negativeGuarantees).toContain("do_not_expose_secrets");
    expect(first.budget.maxToolSteps).toBeGreaterThan(0);
  });

  it("preserves an explicit model and never lowers requested assurance", () => {
    const contract = buildOutcomeContract({
      request: "Repair a security boundary.",
      assurance: "high",
      explicitModel: "kimi/k3",
      budget: { maxCostUsd: 4 },
      requiredChecks: ["tests", "tests", " independent_verifier "],
    });

    expect(contract.assurance).toBe("high");
    expect(contract.explicitModel).toBe("kimi/k3");
    expect(contract.budget.maxCostUsd).toBe(4);
    expect(contract.requiredChecks).toEqual(["tests", "independent_verifier"]);
  });

  it("rejects unsafe or ambiguous budget values", () => {
    expect(() =>
      buildOutcomeContract({
        request: "Do work.",
        budget: { maxTokens: 0 },
      }),
    ).toThrow(/maximum tokens.*positive integer/i);
    expect(() =>
      buildOutcomeContract({
        request: "Do work.",
        budget: { maxCostUsd: Number.POSITIVE_INFINITY },
      }),
    ).toThrow(/maximum cost.*positive/i);
  });
});

describe("action and abstention gate", () => {
  const established: ActionGateInput = {
    discoveryComplete: true,
    safeToProceed: true,
    evidenceState: "sufficient",
    observedState: "absent_or_broken",
    resolution: "code_change",
    evidenceRefs: ["test:repro", "test:repro", " "],
  };

  it.each([
    [
      { ...established },
      "change_required",
      true,
    ],
    [
      { ...established, observedState: "partially_satisfied" as const },
      "partial_fix_requires_change",
      true,
    ],
    [
      {
        ...established,
        resolution: "configuration" as const,
      },
      "configuration_documentation_or_user_action",
      false,
    ],
    [
      {
        ...established,
        observedState: "satisfied" as const,
        resolution: "none" as const,
      },
      "already_satisfied_no_change",
      false,
    ],
    [
      {
        ...established,
        evidenceState: "conflicting" as const,
      },
      "cannot_establish_safely",
      false,
    ],
  ])("classifies %# deterministically", (input, outcome, shouldStageCode) => {
    expect(classifyActionNeed(input)).toMatchObject({
      outcome,
      shouldStageCode,
    });
  });

  it("refuses internally inconsistent established states", () => {
    const result = classifyActionNeed({
      ...established,
      observedState: "satisfied",
      resolution: "code_change",
    });
    expect(result.outcome).toBe("cannot_establish_safely");
    expect(result.shouldStageCode).toBe(false);
    expect(result.evidenceRefs).toEqual(["test:repro"]);
  });
});

describe("ambiguity ranking", () => {
  it("ranks impact × risk × irreversibility ÷ question cost", () => {
    const ranked = rankAmbiguities([
      {
        id: "low-cost",
        question: "Which storage format?",
        interpretations: ["JSON", "SQLite"],
        impact: 0.8,
        risk: 0.8,
        irreversibility: 0.5,
        questionCost: 0.1,
      },
      {
        id: "lower-value",
        question: "Which label?",
        interpretations: ["Task", "Job"],
        impact: 0.2,
        risk: 0.1,
        irreversibility: 0.1,
        questionCost: 0.2,
      },
    ]);

    expect(ranked.map((candidate) => candidate.id)).toEqual([
      "low-cost",
      "lower-value",
    ]);
    expect(ranked[0].score).toBeCloseTo(3.2);
    expect(selectNextClarification(ranked)?.id).toBe("low-cost");
  });

  it("does not interrupt when interpretations converge on one implementation", () => {
    const candidate = {
      question: "Should the UI call it task or job?",
      interpretations: ["Task", "Job"],
      implementationFingerprints: ["same-change", "same-change"],
      impact: 1,
      risk: 1,
      irreversibility: 1,
      questionCost: 0.01,
    };

    expect(rankAmbiguities([candidate])).toEqual([]);
    expect(rankAmbiguities([candidate], { includeConvergent: true })[0]).toMatchObject({
      converges: true,
      score: 100,
    });
  });
});

describe("living intent graph", () => {
  const requirement = createIntentId("requirement", "parser accepts escaped comma");
  const invariant = createIntentId("invariant", "never expose secrets");

  it("creates stable IDs from normalized keys", () => {
    expect(createIntentId("requirement", " Parser   accepts escaped comma ")).toBe(
      createIntentId("requirement", "parser accepts escaped comma"),
    );
    expect(createIntentId("requirement", "parser accepts escaped comma")).not.toBe(
      createIntentId("invariant", "parser accepts escaped comma"),
    );
  });

  it("accepts current coverage and explicit retirement", () => {
    const replacement = createIntentId("requirement", "replacement parser rule");
    const graph: IntentGraph = {
      nodes: [
        {
          id: requirement,
          kind: "requirement",
          statement: "Parser accepts escaped commas.",
          status: "retired",
          retirement: {
            reason: "Superseded by the RFC parser.",
            retiredAt: "2026-07-28T00:00:00.000Z",
            replacementIntentId: replacement,
          },
        },
        {
          id: replacement,
          kind: "requirement",
          statement: "RFC parser accepts escaped commas.",
          status: "active",
        },
        {
          id: invariant,
          kind: "invariant",
          statement: "Secrets never leave the host.",
          status: "active",
        },
      ],
      links: [
        {
          fromIntentId: replacement,
          target: { kind: "test", id: "parser.test.ts:escaped" },
          relation: "fulfills",
        },
        {
          fromIntentId: invariant,
          target: { kind: "evidence", id: "secret-scan:42" },
          relation: "covers",
        },
      ],
    };

    const result = validateIntentGraph(graph);
    expect(result.valid).toBe(true);
    expect(result.retiredIntentIds).toEqual([requirement]);
    expect(result.uncoveredIntentIds).toEqual([]);
  });

  it("reports stale, contradictory, missing, and invalid retirement state", () => {
    const graph: IntentGraph = {
      nodes: [
        {
          id: requirement,
          kind: "requirement",
          statement: "Parser accepts escaped commas.",
          status: "active",
        },
        {
          id: invariant,
          kind: "invariant",
          statement: "Secrets never leave the host.",
          status: "retired",
          retirement: {
            reason: "",
            retiredAt: "not-a-date",
          },
        },
      ],
      links: [
        {
          fromIntentId: requirement,
          target: { kind: "test", id: "removed-test" },
          relation: "covers",
          state: "stale",
        },
        {
          fromIntentId: requirement,
          target: { kind: "intent", id: invariant },
          relation: "contradicts",
        },
        {
          fromIntentId: "intent:missing",
          target: { kind: "file", id: "missing.ts" },
          relation: "fulfills",
        },
      ],
    };

    const result = validateIntentGraph(graph, {
      knownTargets: { test: new Set(["live-test"]) },
    });
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "invalid_retirement",
        "stale_link",
        "missing_target",
        "contradiction",
        "missing_source_intent",
        "missing_link",
      ]),
    );
    expect(result.staleIntentIds).toContain(requirement);
    expect(result.contradictedIntentIds).toContain(requirement);
    expect(result.uncoveredIntentIds).toContain(requirement);
  });
});
