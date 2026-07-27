import { describe, expect, it, vi } from "vitest";
import {
  ROUTER_FALLBACK_MODEL,
  isAutomaticModel,
  selectCodingModel,
} from "./model-selection.js";

describe("selectCodingModel", () => {
  it("recognizes an omitted or explicit auto choice", () => {
    expect(isAutomaticModel(undefined)).toBe(true);
    expect(isAutomaticModel(" AUTO ")).toBe(true);
    expect(isAutomaticModel("moonshotai/kimi-k3")).toBe(false);
  });

  it("honors an explicit model without loading the catalog", async () => {
    const loadModels = vi.fn();

    await expect(
      selectCodingModel({
        requestedModel: "vendor/selected",
        prompt: "Fix it.",
        loadModels,
      }),
    ).resolves.toEqual({
      model: "vendor/selected",
      mode: "explicit",
      catalog: "not-needed",
    });
    expect(loadModels).not.toHaveBeenCalled();
  });

  it("uses live metadata for an auditable automatic route", async () => {
    const selection = await selectCodingModel({
      requestedModel: "auto",
      prompt: "Implement a parser refactor and run integration tests.",
      loadModels: async () => [
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
          id: ROUTER_FALLBACK_MODEL,
          pricing: { prompt: 3, completion: 15 },
          context_length: 1_048_576,
          supported_parameters: ["tools", "tool_choice"],
          benchmarks: {
            artificial_analysis: {
              coding_index: 76.2,
              agentic_index: 50.1,
              intelligence_index: 57.1,
            },
          },
        },
      ],
    });

    expect(selection).toMatchObject({
      model: ROUTER_FALLBACK_MODEL,
      mode: "smart",
      catalog: "live",
      decision: {
        explicitOverride: false,
        assessment: { complexity: "advanced" },
      },
    });
  });

  it("falls back to Kimi K3 when catalog discovery fails", async () => {
    const selection = await selectCodingModel({
      prompt: "Fix and test the bug.",
      loadModels: async () => {
        throw new Error("offline");
      },
    });

    expect(selection).toMatchObject({
      model: ROUTER_FALLBACK_MODEL,
      mode: "smart",
      catalog: "fallback",
    });
    expect(selection.decision?.reasons.join(" ")).toMatch(/metadata was unavailable/i);
    expect(selection.decision?.confidence).toBeLessThanOrEqual(0.62);
  });

  it("requires a tool-capable chat model even for a read-shaped first prompt", async () => {
    const selection = await selectCodingModel({
      prompt: "Read package.json and report the package name.",
      loadModels: async () => [
        {
          id: "google/lyria-3-clip-preview",
          pricing: { prompt: 0, completion: 0 },
          context_length: 1_048_576,
          supported_parameters: ["max_tokens"],
          architecture: {
            input_modalities: ["text", "image"],
            output_modalities: ["text", "audio"],
          },
        },
        {
          id: "code/chat",
          pricing: { prompt: 1, completion: 3 },
          context_length: 128_000,
          supported_parameters: ["tools", "tool_choice"],
          architecture: {
            input_modalities: ["text"],
            output_modalities: ["text"],
          },
        },
      ],
    });

    expect(selection.model).toBe("code/chat");
    expect(selection.decision?.assessment.toolNeeds).toContain("inspect");
    expect(
      selection.decision?.candidates.find(
        (candidate) => candidate.model === "google/lyria-3-clip-preview",
      ),
    ).toMatchObject({ eligible: false, supportsTools: false });
  });
});
