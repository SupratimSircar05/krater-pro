import { AUTO_MODEL } from "./config.js";
import {
  classifyCodingTask,
  routeCodingTask,
  type AvailableModel,
  type RoutingDecision,
} from "./router.js";

export const ROUTER_FALLBACK_MODEL = "moonshotai/kimi-k3";

export interface CodingModelSelection {
  model: string;
  mode: "explicit" | "smart";
  catalog: "not-needed" | "live" | "fallback";
  decision?: RoutingDecision;
}

export interface SelectCodingModelOptions {
  requestedModel?: string;
  prompt: string;
  loadModels: (signal?: AbortSignal) => Promise<AvailableModel[]>;
  contextCharacters?: number;
  expectedOutputTokens?: number;
  signal?: AbortSignal;
}

export function isAutomaticModel(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return !normalized || normalized === AUTO_MODEL;
}

/**
 * Resolves an explicit model without network work, or routes an automatic
 * selection against current Krater metadata. Catalog discovery failure falls
 * back to Kimi K3 and remains visible in the audit reason.
 */
export async function selectCodingModel(
  options: SelectCodingModelOptions,
): Promise<CodingModelSelection> {
  const requested = options.requestedModel?.trim();
  if (!isAutomaticModel(requested)) {
    return {
      model: requested!,
      mode: "explicit",
      catalog: "not-needed",
    };
  }

  let availableModels: AvailableModel[];
  let catalog: CodingModelSelection["catalog"] = "live";
  try {
    availableModels = await options.loadModels(options.signal);
    if (!availableModels.length) {
      throw new Error("The Krater model catalog was empty.");
    }
  } catch {
    if (options.signal?.aborted) {
      throw new Error("Request cancelled.");
    }
    availableModels = [{ id: ROUTER_FALLBACK_MODEL }];
    catalog = "fallback";
  }

  const assessment = classifyCodingTask({
    prompt: options.prompt,
    contextCharacters: options.contextCharacters,
    expectedOutputTokens: options.expectedOutputTokens,
  });
  const decision = routeCodingTask({
    prompt: options.prompt,
    availableModels,
    contextCharacters: options.contextCharacters,
    expectedOutputTokens: options.expectedOutputTokens,
    // Krater Pro always sends its coding tools to the completion endpoint.
    // Even an explanatory first prompt therefore requires a tool-capable chat
    // model; this also prevents media-only catalog entries from being routed.
    toolNeeds: assessment.toolNeeds.length
      ? assessment.toolNeeds
      : ["inspect"],
  });
  if (catalog === "fallback") {
    decision.reasons.push(
      "Live model metadata was unavailable, so the router used its validated Kimi K3 fallback profile.",
    );
    decision.confidence = Math.min(decision.confidence, 0.62);
  }

  return {
    model: decision.model,
    mode: "smart",
    catalog,
    decision,
  };
}
