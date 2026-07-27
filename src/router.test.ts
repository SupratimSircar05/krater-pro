import { describe, expect, it } from "vitest";
import {
  classifyCodingTask,
  routeCodingTask,
  SmartCodingRouter,
  type AvailableModel,
  type ModelProfile,
} from "./router.js";

function profile(
  id: string,
  overrides: Partial<ModelProfile> = {},
): ModelProfile {
  return {
    id,
    tier: "balanced",
    relativeCost: 40,
    codingScore: 70,
    agenticScore: 70,
    intelligenceScore: 70,
    contextWindow: 128_000,
    supportsTools: true,
    ...overrides,
  };
}

describe("classifyCodingTask", () => {
  it("classifies narrow requests as routine and infers no unnecessary tools", () => {
    const assessment = classifyCodingTask({
      prompt: "Explain this one-line typo.",
    });

    expect(assessment).toMatchObject({
      complexity: "routine",
      risk: "low",
      contextSize: "small",
      toolNeeds: [],
      targetQuality: 45,
    });
  });

  it("raises complexity, risk, context, and tool requirements deterministically", () => {
    const assessment = classifyCodingTask({
      prompt:
        "Implement a repo-wide zero-downtime production database migration. " +
        "Investigate the distributed transaction race condition, edit the code, " +
        "run integration tests, benchmark it, and commit the fix.",
      contextCharacters: 450_000,
    });

    expect(assessment.complexity).toBe("expert");
    expect(assessment.risk).toBe("high");
    expect(assessment.contextSize).toBe("huge");
    expect(assessment.toolNeeds).toEqual([
      "edit",
      "execute",
      "git",
      "inspect",
    ]);
    expect(assessment.targetQuality).toBeGreaterThanOrEqual(88);
  });

  it("honors explicit tool needs instead of prompt inference", () => {
    const assessment = classifyCodingTask({
      prompt: "Fix and test the UI.",
      toolNeeds: ["browser"],
    });

    expect(assessment.toolNeeds).toEqual(["browser"]);
  });
});

describe("SmartCodingRouter", () => {
  it("treats an available explicit model as a hard override", () => {
    const router = new SmartCodingRouter({
      catalog: [
        profile("cheap/model", {
          tier: "economy",
          relativeCost: 1,
          codingScore: 20,
          agenticScore: 20,
          intelligenceScore: 20,
          contextWindow: 2_000,
          supportsTools: false,
        }),
        profile("premium/model", {
          tier: "premium",
          relativeCost: 90,
          codingScore: 98,
          agenticScore: 98,
          intelligenceScore: 98,
        }),
      ],
    });

    const decision = router.route({
      prompt: "Fix a production security-critical payment race and run tests.",
      availableModels: ["cheap/model", "premium/model"],
      explicitModel: "cheap/model",
    });

    expect(decision.model).toBe("cheap/model");
    expect(decision.explicitOverride).toBe(true);
    expect(decision.confidence).toBe(1);
    expect(decision.reasons[0]).toMatch(/hard override/i);
    expect(decision.reasons.join(" ")).toMatch(/warning/i);
  });

  it("rejects an explicit model that is not available", () => {
    expect(() =>
      routeCodingTask({
        prompt: "Explain this function.",
        availableModels: ["available/model"],
        explicitModel: "missing/model",
      }),
    ).toThrow(/not in the available Krater model list/);
  });

  it("selects only from the available model IDs", () => {
    const decision = routeCodingTask(
      {
        prompt: "Implement an endpoint and run its tests.",
        availableModels: ["available/model"],
      },
      {
        catalog: [
          profile("unavailable/perfect", {
            relativeCost: 0,
            codingScore: 100,
            agenticScore: 100,
            intelligenceScore: 100,
          }),
          profile("available/model"),
        ],
      },
    );

    expect(decision.model).toBe("available/model");
    expect(decision.candidates.map((candidate) => candidate.model)).toEqual([
      "available/model",
    ]);
  });

  it("chooses the cheapest Pareto candidate that meets a routine quality target", () => {
    const decision = routeCodingTask(
      {
        prompt: "Explain this small change.",
        availableModels: ["economy/model", "premium/model"],
      },
      {
        catalog: [
          profile("economy/model", {
            tier: "economy",
            relativeCost: 8,
            codingScore: 58,
            agenticScore: 55,
            intelligenceScore: 58,
          }),
          profile("premium/model", {
            tier: "premium",
            relativeCost: 85,
            codingScore: 96,
            agenticScore: 96,
            intelligenceScore: 96,
          }),
        ],
      },
    );

    expect(decision.model).toBe("economy/model");
    expect(decision.tier).toBe("economy");
    expect(decision.reasons.join(" ")).toMatch(/lowest-cost Pareto-efficient/);
  });

  it("selects a high-accuracy model when cheaper candidates miss an expert target", () => {
    const decision = routeCodingTask(
      {
        prompt:
          "Implement and verify a repo-wide constant-time cryptographic protocol " +
          "migration across multiple services; reproduce the race and run tests.",
        availableModels: ["cheap/model", "expert/model"],
      },
      {
        catalog: [
          profile("cheap/model", {
            tier: "economy",
            relativeCost: 5,
            codingScore: 62,
            agenticScore: 55,
            intelligenceScore: 60,
          }),
          profile("expert/model", {
            tier: "premium",
            relativeCost: 82,
            codingScore: 97,
            agenticScore: 96,
            intelligenceScore: 98,
          }),
        ],
      },
    );

    expect(decision.assessment.complexity).toBe("expert");
    expect(decision.assessment.risk).toBe("high");
    expect(decision.model).toBe("expert/model");
  });

  it("uses Kimi K3 as a strong balanced coding candidate when it clears the target", () => {
    const decision = routeCodingTask(
      {
        prompt:
          "Implement a parser refactor, inspect the repository, and run integration tests.",
        availableModels: [
          "cheap/code-lite",
          "moonshotai/kimi-k3",
          "premium/code-max",
        ],
      },
      {
        catalog: [
          profile("cheap/code-lite", {
            tier: "economy",
            relativeCost: 5,
            codingScore: 52,
            agenticScore: 48,
            intelligenceScore: 54,
          }),
          profile("premium/code-max", {
            tier: "premium",
            relativeCost: 88,
            codingScore: 96,
            agenticScore: 96,
            intelligenceScore: 96,
          }),
        ],
      },
    );

    expect(decision.model).toBe("moonshotai/kimi-k3");
    expect(decision.tier).toBe("balanced");
  });

  it("uses live pricing and benchmark metadata to optimize the frontier", () => {
    const models: AvailableModel[] = [
      {
        id: "live/efficient",
        pricing: { prompt: "1", completion: "3", input_cache_read: "0.2" },
        context_length: 128_000,
        supported_parameters: ["tools", "tool_choice"],
        benchmarks: {
          artificial_analysis: {
            coding_index: "82",
            agentic_index: 80,
            intelligence_index: 78,
          },
        },
      },
      {
        id: "live/costly",
        pricing: { prompt: 10, completion: 30 },
        context_length: 128_000,
        supported_parameters: ["tools"],
        benchmarks: {
          artificial_analysis: {
            coding_index: 82,
            agentic_index: 80,
            intelligence_index: 78,
          },
        },
      },
    ];

    const decision = routeCodingTask({
      prompt: "Implement the fix and run tests.",
      availableModels: models,
    });

    expect(decision.model).toBe("live/efficient");
    expect(
      decision.candidates.find((candidate) => candidate.model === "live/efficient")
        ?.metadataCompleteness,
    ).toBe(1);
    expect(
      decision.candidates.find((candidate) => candidate.model === "live/efficient")
        ?.costScore,
    ).toBeLessThan(
      decision.candidates.find((candidate) => candidate.model === "live/costly")!
        .costScore,
    );
  });

  it("filters models that explicitly lack tool support", () => {
    const decision = routeCodingTask({
      prompt: "Implement the change and run tests.",
      availableModels: [
        {
          id: "no-tools/model",
          supported_parameters: ["temperature"],
          benchmarks: {
            artificial_analysis: {
              coding_index: 99,
              agentic_index: 99,
              intelligence_index: 99,
            },
          },
        },
        {
          id: "tools/model",
          supported_parameters: ["tools"],
          benchmarks: {
            artificial_analysis: {
              coding_index: 70,
              agentic_index: 70,
              intelligence_index: 70,
            },
          },
        },
      ],
    });

    expect(decision.model).toBe("tools/model");
    expect(
      decision.candidates.find((candidate) => candidate.model === "no-tools/model"),
    ).toMatchObject({
      eligible: false,
      supportsTools: false,
    });
  });

  it("filters media-output models from automatic coding routes", () => {
    const decision = routeCodingTask({
      prompt: "Implement the change and run tests.",
      availableModels: [
        {
          id: "image/model",
          architecture: {
            input_modalities: ["text", "image"],
            output_modalities: ["text", "image"],
          },
          supported_parameters: ["tools"],
          pricing: { prompt: 0, completion: 0 },
          benchmarks: {
            artificial_analysis: {
              coding_index: 99,
              agentic_index: 99,
              intelligence_index: 99,
            },
          },
        },
        {
          id: "text/model",
          architecture: {
            input_modalities: ["text"],
            output_modalities: ["text"],
          },
          supported_parameters: ["tools"],
          pricing: { prompt: 1, completion: 3 },
          benchmarks: {
            artificial_analysis: {
              coding_index: 70,
              agentic_index: 70,
              intelligence_index: 70,
            },
          },
        },
      ],
    });

    expect(decision.model).toBe("text/model");
    expect(
      decision.candidates.find((candidate) => candidate.model === "image/model")
        ?.disqualifiers,
    ).toContain("coding-agent output must be text-only, not text+image");
  });

  it("fails clearly when every available model explicitly lacks required tools", () => {
    expect(() =>
      routeCodingTask({
        prompt: "Edit the file and run tests.",
        availableModels: [
          { id: "chat/model", supported_parameters: ["temperature"] },
        ],
      }),
    ).toThrow(/required tool calling is unsupported/);
  });

  it("filters models with an insufficient live context window", () => {
    const decision = routeCodingTask({
      prompt: "Review this codebase.",
      contextCharacters: 200_000,
      availableModels: [
        {
          id: "short/model",
          context_length: 16_000,
          supported_parameters: ["tools"],
        },
        {
          id: "long/model",
          context_length: 128_000,
          supported_parameters: ["tools"],
        },
      ],
    });

    expect(decision.model).toBe("long/model");
    expect(
      decision.candidates.find((candidate) => candidate.model === "short/model")
        ?.eligible,
    ).toBe(false);
  });

  it("falls back deterministically when model metadata and profiles are unknown", () => {
    const request = {
      prompt: "Answer a coding question.",
      availableModels: ["zeta/unknown", "alpha/unknown"],
    } as const;

    expect(routeCodingTask(request).model).toBe("alpha/unknown");
    expect(routeCodingTask(request).confidence).toBeLessThan(0.8);
  });

  it("accepts custom catalog overrides for built-in model IDs", () => {
    const router = new SmartCodingRouter({
      catalog: [
        profile("moonshotai/kimi-k3", {
          tier: "premium",
          relativeCost: 99,
          codingScore: 30,
          agenticScore: 30,
          intelligenceScore: 30,
        }),
        profile("custom/model", {
          tier: "economy",
          relativeCost: 1,
          codingScore: 80,
          agenticScore: 80,
          intelligenceScore: 80,
        }),
      ],
    });

    const decision = router.route({
      prompt: "Implement and test a parser.",
      availableModels: ["moonshotai/kimi-k3", "custom/model"],
    });

    expect(decision.model).toBe("custom/model");
  });

  it("validates custom profile scores without making network calls", () => {
    expect(
      () =>
        new SmartCodingRouter({
          catalog: [profile("bad/model", { codingScore: 101 })],
        }),
    ).toThrow(/codingScore/);
  });
});
