export type RoutingTier = "economy" | "balanced" | "premium";
export type TaskComplexity = "routine" | "standard" | "advanced" | "expert";
export type TaskRisk = "low" | "medium" | "high";
export type ContextSize = "small" | "medium" | "large" | "huge";
export type CodingToolNeed =
  | "inspect"
  | "edit"
  | "execute"
  | "git"
  | "browser"
  | "network";

type NumericMetadata = number | string | null | undefined;

export interface AvailableModel {
  id: string;
  ownedBy?: string;
  architecture?: {
    modality?: string;
    input_modalities?: readonly string[];
    output_modalities?: readonly string[];
  };
  pricing?: {
    prompt?: NumericMetadata;
    completion?: NumericMetadata;
    input_cache_read?: NumericMetadata;
  };
  context_length?: number | string;
  supported_parameters?: readonly string[];
  benchmarks?: {
    artificial_analysis?: {
      coding_index?: NumericMetadata;
      agentic_index?: NumericMetadata;
      intelligence_index?: NumericMetadata;
    };
  };
}

/**
 * Relative fallback metadata for models whose live Krater descriptor is
 * incomplete. Scores and relativeCost are all on a 0..100 scale.
 */
export interface ModelProfile {
  id: string;
  tier: RoutingTier;
  relativeCost: number;
  codingScore: number;
  agenticScore: number;
  intelligenceScore: number;
  contextWindow: number;
  supportsTools: boolean;
}

export interface CodingTaskAssessment {
  complexity: TaskComplexity;
  risk: TaskRisk;
  contextSize: ContextSize;
  estimatedInputTokens: number;
  requiredContextTokens: number;
  toolNeeds: CodingToolNeed[];
  signals: string[];
  targetQuality: number;
}

export interface RouteCandidateAudit {
  model: string;
  tier: RoutingTier;
  qualityScore: number;
  costScore: number;
  estimatedBlendedPricePerMillion?: number;
  contextWindow: number;
  supportsTools: boolean;
  eligible: boolean;
  meetsTarget: boolean;
  onFrontier: boolean;
  metadataCompleteness: number;
  disqualifiers: string[];
}

export interface RoutingDecision {
  model: string;
  tier: RoutingTier;
  reasons: string[];
  confidence: number;
  explicitOverride: boolean;
  assessment: CodingTaskAssessment;
  candidates: RouteCandidateAudit[];
}

export interface SmartRouteRequest {
  prompt: string;
  availableModels: readonly (string | AvailableModel)[];
  explicitModel?: string | null;
  contextCharacters?: number;
  expectedOutputTokens?: number;
  toolNeeds?: readonly CodingToolNeed[];
}

export interface SmartCodingRouterOptions {
  /**
   * Profiles are merged over the built-ins by model ID. Set this to an empty
   * array to use the built-ins unchanged.
   */
  catalog?: readonly ModelProfile[];
  fallbackProfile?: Omit<ModelProfile, "id">;
}

interface ResolvedCandidate {
  audit: RouteCandidateAudit;
  utility: number;
}

const DEFAULT_FALLBACK_PROFILE: Omit<ModelProfile, "id"> = {
  tier: "balanced",
  relativeCost: 45,
  codingScore: 58,
  agenticScore: 52,
  intelligenceScore: 58,
  contextWindow: 32_768,
  supportsTools: true,
};

export const DEFAULT_MODEL_PROFILES: readonly ModelProfile[] = Object.freeze([
  {
    id: "moonshotai/kimi-k3",
    tier: "balanced",
    relativeCost: 35,
    codingScore: 84,
    agenticScore: 82,
    intelligenceScore: 83,
    contextWindow: 131_072,
    supportsTools: true,
  },
  {
    id: "openai/gpt-4o-mini",
    tier: "economy",
    relativeCost: 20,
    codingScore: 68,
    agenticScore: 66,
    intelligenceScore: 70,
    contextWindow: 128_000,
    supportsTools: true,
  },
]);

const COMPLEXITY_PATTERNS = {
  simple: /\b(typo|rename|format|comment|explain|one[- ]line|small change)\b/i,
  implementation:
    /\b(implement|create|build|add|change|fix|refactor|debug|migrate|optimi[sz]e)\b/i,
  verification:
    /\b(test|reproduce|benchmark|profile|trace|investigate|root cause|integration|e2e)\b/i,
  advanced:
    /\b(concurren|distributed|race condition|deadlock|lock[- ]free|compiler|parser|database|transaction|memory leak|protocol|architecture|backward.?compatib|cross[- ]platform)\b/i,
  expert:
    /\b(formal verification|cryptograph\w*|constant[- ]time|consensus|linearizab\w*|kernel|compiler backend|query planner|zero[- ]downtime|multi[- ]region)\b/i,
  broad:
    /\b(repo(?:sitory)?[- ]wide|entire codebase|across (?:the )?(?:project|repository)|multiple (?:packages|services|languages)|monorepo)\b/i,
};

const RISK_PATTERNS = {
  medium:
    /\b(authentication|authorization|oauth|permission|secret|privacy|payment|billing|migration|production|deployment|database|infrastructure|dependency|supply chain)\b/i,
  high:
    /\b(cryptograph\w*|credential\w*|remote code execution|rce\b|sql injection|data loss|financial|payment processing|production database|destructive|security critical|privilege escalation|zero[- ]downtime migration)\b/i,
};

const TOOL_PATTERNS: ReadonlyArray<[CodingToolNeed, RegExp]> = [
  [
    "inspect",
    /\b(repo(?:sitory)?|codebase|file|source|inspect|review|investigate|find|search)\b/i,
  ],
  ["edit", /\b(implement|create|build|add|change|fix|edit|refactor|migrate|write)\b/i],
  [
    "execute",
    /\b(run|test|debug|reproduce|benchmark|build|compile|lint|profile|execute)\b/i,
  ],
  ["git", /\b(git|commit|branch|merge|pull request|diff)\b/i],
  ["browser", /\b(browser|web ui|frontend|e2e|playwright|selenium)\b/i],
  ["network", /\b(api|http|network|download|remote service|webhook)\b/i],
];

function round(value: number, digits = 2): number {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function parseFinite(value: NumericMetadata): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseNonNegative(value: NumericMetadata): number | undefined {
  const parsed = parseFinite(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

function normalizedCatalogId(id: string): string {
  return id.trim().replace(/^~/, "");
}

function normalizedModalities(values: readonly string[] | undefined): string[] {
  return (values ?? [])
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function validateScore(value: number, field: string, id: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`Invalid ${field} for model profile "${id}"; expected 0..100.`);
  }
}

function validateProfile(profile: ModelProfile): ModelProfile {
  const id = profile.id.trim();
  if (!id) throw new Error("Model profile IDs must not be blank.");
  validateScore(profile.relativeCost, "relativeCost", id);
  validateScore(profile.codingScore, "codingScore", id);
  validateScore(profile.agenticScore, "agenticScore", id);
  validateScore(profile.intelligenceScore, "intelligenceScore", id);
  if (!Number.isSafeInteger(profile.contextWindow) || profile.contextWindow < 1) {
    throw new Error(
      `Invalid contextWindow for model profile "${id}"; expected a positive integer.`,
    );
  }
  if (!["economy", "balanced", "premium"].includes(profile.tier)) {
    throw new Error(`Invalid tier for model profile "${id}".`);
  }
  return { ...profile, id };
}

function inferFallbackProfile(
  id: string,
  base: Omit<ModelProfile, "id">,
): ModelProfile {
  const lower = id.toLowerCase();
  if (lower.includes(":free") || lower.includes("/free")) {
    return {
      ...base,
      id,
      tier: "economy",
      relativeCost: 0,
      codingScore: Math.min(base.codingScore, 48),
      agenticScore: Math.min(base.agenticScore, 45),
    };
  }
  if (/\b(?:mini|nano|small|flash)\b/.test(lower.replace(/[-_/]/g, " "))) {
    return {
      ...base,
      id,
      tier: "economy",
      relativeCost: Math.min(base.relativeCost, 22),
    };
  }
  if (/\b(?:opus|ultra|max)\b/.test(lower.replace(/[-_/]/g, " "))) {
    return {
      ...base,
      id,
      tier: "premium",
      relativeCost: Math.max(base.relativeCost, 78),
      codingScore: Math.max(base.codingScore, 72),
      agenticScore: Math.max(base.agenticScore, 70),
      intelligenceScore: Math.max(base.intelligenceScore, 74),
    };
  }
  return { ...base, id };
}

function normalizeAvailableModels(
  models: readonly (string | AvailableModel)[],
): AvailableModel[] {
  const unique = new Map<string, AvailableModel>();
  for (const entry of models) {
    const descriptor = typeof entry === "string" ? { id: entry } : entry;
    const id = descriptor.id?.trim();
    if (!id || unique.has(id)) continue;
    unique.set(id, { ...descriptor, id });
  }
  return [...unique.values()];
}

function normalizeToolNeeds(
  prompt: string,
  requested: readonly CodingToolNeed[] | undefined,
): CodingToolNeed[] {
  const allowed = new Set<CodingToolNeed>([
    "inspect",
    "edit",
    "execute",
    "git",
    "browser",
    "network",
  ]);
  if (requested) {
    return [...new Set(requested.filter((need) => allowed.has(need)))].sort();
  }
  return TOOL_PATTERNS.filter(([, pattern]) => pattern.test(prompt))
    .map(([need]) => need)
    .sort();
}

function targetFor(
  complexity: TaskComplexity,
  risk: TaskRisk,
  contextSize: ContextSize,
  toolCount: number,
): number {
  const base: Record<TaskComplexity, number> = {
    routine: 45,
    standard: 57,
    advanced: 67,
    expert: 79,
  };
  return clamp(
    base[complexity] +
      (risk === "high" ? 6 : risk === "medium" ? 2 : 0) +
      (contextSize === "huge" ? 3 : contextSize === "large" ? 1 : 0) +
      (toolCount >= 3 ? 2 : 0),
    40,
    92,
  );
}

export function classifyCodingTask(
  request: Pick<
    SmartRouteRequest,
    "prompt" | "contextCharacters" | "expectedOutputTokens" | "toolNeeds"
  >,
): CodingTaskAssessment {
  if (typeof request.prompt !== "string") {
    throw new Error("A coding prompt is required for smart model routing.");
  }
  if (
    request.contextCharacters !== undefined &&
    (!Number.isSafeInteger(request.contextCharacters) || request.contextCharacters < 0)
  ) {
    throw new Error("contextCharacters must be a non-negative integer.");
  }
  if (
    request.expectedOutputTokens !== undefined &&
    (!Number.isSafeInteger(request.expectedOutputTokens) ||
      request.expectedOutputTokens < 1)
  ) {
    throw new Error("expectedOutputTokens must be a positive integer.");
  }

  const prompt = request.prompt.trim();
  const toolNeeds = normalizeToolNeeds(prompt, request.toolNeeds);
  const contextCharacters = Math.max(request.contextCharacters ?? 0, prompt.length);
  const estimatedInputTokens = Math.max(1, Math.ceil(contextCharacters / 4));
  const expectedOutputTokens = request.expectedOutputTokens ?? 8_192;
  const requiredContextTokens = estimatedInputTokens + expectedOutputTokens;
  const contextSize: ContextSize =
    estimatedInputTokens <= 8_000
      ? "small"
      : estimatedInputTokens <= 32_000
        ? "medium"
        : estimatedInputTokens <= 100_000
          ? "large"
          : "huge";

  let complexityPoints = 1;
  const signals: string[] = [];
  const addSignal = (condition: boolean, signal: string, points: number): void => {
    if (!condition) return;
    signals.push(signal);
    complexityPoints += points;
  };

  addSignal(
    Boolean(prompt) && COMPLEXITY_PATTERNS.simple.test(prompt),
    "narrow or explanatory change",
    -2,
  );
  addSignal(
    COMPLEXITY_PATTERNS.implementation.test(prompt),
    "implementation requested",
    1,
  );
  addSignal(
    COMPLEXITY_PATTERNS.verification.test(prompt),
    "verification or diagnosis requested",
    1,
  );
  addSignal(
    COMPLEXITY_PATTERNS.advanced.test(prompt),
    "advanced engineering concern",
    2,
  );
  addSignal(
    COMPLEXITY_PATTERNS.expert.test(prompt),
    "specialist engineering concern",
    2,
  );
  addSignal(COMPLEXITY_PATTERNS.broad.test(prompt), "broad codebase scope", 2);
  addSignal(prompt.length > 1_200, "long task specification", 1);
  addSignal(prompt.length > 5_000, "very long task specification", 1);
  addSignal(contextSize === "large", "large supplied context", 1);
  addSignal(contextSize === "huge", "huge supplied context", 2);
  addSignal(toolNeeds.length >= 3, "multi-tool workflow", 1);

  const complexity: TaskComplexity =
    complexityPoints <= 0
      ? "routine"
      : complexityPoints <= 2
        ? "standard"
        : complexityPoints <= 5
          ? "advanced"
          : "expert";

  const highRisk = RISK_PATTERNS.high.test(prompt);
  const mediumRisk = RISK_PATTERNS.medium.test(prompt);
  const risk: TaskRisk = highRisk ? "high" : mediumRisk ? "medium" : "low";
  if (risk !== "low") signals.push(`${risk}-risk domain`);
  if (!signals.length) signals.push("general coding request");

  return {
    complexity,
    risk,
    contextSize,
    estimatedInputTokens,
    requiredContextTokens,
    toolNeeds,
    signals,
    targetQuality: targetFor(complexity, risk, contextSize, toolNeeds.length),
  };
}

function normalizePricePerMillion(value: NumericMetadata): number | undefined {
  const parsed = parseNonNegative(value);
  if (parsed === undefined) return undefined;
  // Providers commonly report either dollars/token or dollars/million tokens.
  return parsed > 0 && parsed < 0.01 ? parsed * 1_000_000 : parsed;
}

function blendedPrice(
  pricing: AvailableModel["pricing"],
): number | undefined {
  if (!pricing) return undefined;
  let prompt = normalizePricePerMillion(pricing.prompt);
  let completion = normalizePricePerMillion(pricing.completion);
  const cacheRead = normalizePricePerMillion(pricing.input_cache_read);
  if (prompt === undefined && completion === undefined) return undefined;
  if (prompt === undefined && completion !== undefined) prompt = completion / 3;
  if (completion === undefined && prompt !== undefined) completion = prompt * 3;
  const blendedInput =
    cacheRead === undefined
      ? prompt!
      : prompt! * 0.75 + cacheRead * 0.25;
  return round(blendedInput * 0.65 + completion! * 0.35, 6);
}

function priceToCostScore(price: number): number {
  return round((100 * price) / (price + 5), 2);
}

function qualityScore(
  coding: number,
  agentic: number,
  intelligence: number,
  assessment: CodingTaskAssessment,
): number {
  if (assessment.risk === "high") {
    return round(coding * 0.45 + agentic * 0.3 + intelligence * 0.25, 1);
  }
  if (assessment.toolNeeds.length) {
    return round(coding * 0.52 + agentic * 0.35 + intelligence * 0.13, 1);
  }
  return round(coding * 0.65 + agentic * 0.1 + intelligence * 0.25, 1);
}

function tierFromCost(costScore: number): RoutingTier {
  if (costScore <= 28) return "economy";
  if (costScore <= 68) return "balanced";
  return "premium";
}

function accuracyCostWeight(complexity: TaskComplexity): number {
  return {
    routine: 0.3,
    standard: 0.2,
    advanced: 0.12,
    expert: 0.06,
  }[complexity];
}

function isDominated(
  candidate: ResolvedCandidate,
  candidates: readonly ResolvedCandidate[],
): boolean {
  return candidates.some(
    (other) =>
      other !== candidate &&
      other.audit.eligible &&
      other.audit.qualityScore >= candidate.audit.qualityScore &&
      other.audit.costScore <= candidate.audit.costScore &&
      (other.audit.qualityScore > candidate.audit.qualityScore ||
        other.audit.costScore < candidate.audit.costScore),
  );
}

export class SmartCodingRouter {
  private readonly profiles = new Map<string, ModelProfile>();
  private readonly fallbackProfile: Omit<ModelProfile, "id">;

  constructor(options: SmartCodingRouterOptions = {}) {
    for (const rawProfile of [...DEFAULT_MODEL_PROFILES, ...(options.catalog ?? [])]) {
      const profile = validateProfile(rawProfile);
      this.profiles.set(normalizedCatalogId(profile.id), profile);
    }
    this.fallbackProfile = validateProfile({
      id: "__fallback__",
      ...(options.fallbackProfile ?? DEFAULT_FALLBACK_PROFILE),
    });
  }

  route(request: SmartRouteRequest): RoutingDecision {
    const availableModels = normalizeAvailableModels(request.availableModels);
    if (!availableModels.length) {
      throw new Error("Smart routing requires at least one available Krater model.");
    }
    const assessment = classifyCodingTask(request);
    const explicitModel = request.explicitModel?.trim();
    if (explicitModel) {
      const descriptor = availableModels.find((model) => model.id === explicitModel);
      if (!descriptor) {
        throw new Error(
          `Explicitly selected model "${explicitModel}" is not in the available Krater model list.`,
        );
      }
      const candidate = this.resolveCandidate(descriptor, assessment);
      return {
        model: explicitModel,
        tier: candidate.audit.tier,
        reasons: [
          "Explicit model selection is a hard override; automatic routing was bypassed.",
          ...candidate.audit.disqualifiers.map(
            (reason) => `Override warning: ${reason}.`,
          ),
        ],
        confidence: 1,
        explicitOverride: true,
        assessment,
        candidates: [candidate.audit],
      };
    }

    const resolved = availableModels.map((model) =>
      this.resolveCandidate(model, assessment),
    );
    const eligible = resolved.filter((candidate) => candidate.audit.eligible);
    if (!eligible.length) {
      const reasons = [
        ...new Set(resolved.flatMap((candidate) => candidate.audit.disqualifiers)),
      ];
      throw new Error(
        `No available Krater model can satisfy this route${
          reasons.length ? `: ${reasons.join("; ")}` : ""
        }.`,
      );
    }

    for (const candidate of eligible) {
      candidate.audit.onFrontier = !isDominated(candidate, eligible);
    }
    const frontier = eligible.filter((candidate) => candidate.audit.onFrontier);
    const qualified = frontier.filter((candidate) => candidate.audit.meetsTarget);
    let selected: ResolvedCandidate;
    if (qualified.length) {
      selected = [...qualified].sort(
        (a, b) =>
          a.audit.costScore - b.audit.costScore ||
          b.audit.qualityScore - a.audit.qualityScore ||
          a.audit.model.localeCompare(b.audit.model),
      )[0]!;
    } else {
      selected = [...frontier].sort(
        (a, b) =>
          b.utility - a.utility ||
          b.audit.qualityScore - a.audit.qualityScore ||
          a.audit.costScore - b.audit.costScore ||
          a.audit.model.localeCompare(b.audit.model),
      )[0]!;
    }

    const runnerUp = [...frontier]
      .filter((candidate) => candidate !== selected)
      .sort(
        (a, b) =>
          b.utility - a.utility ||
          a.audit.costScore - b.audit.costScore ||
          a.audit.model.localeCompare(b.audit.model),
      )[0];
    const margin = runnerUp
      ? Math.abs(selected.utility - runnerUp.utility)
      : 20;
    const confidence = round(
      clamp(
        0.48 +
          selected.audit.metadataCompleteness * 0.28 +
          Math.min(0.18, margin / 100) +
          (selected.audit.meetsTarget ? 0.06 : 0),
        0.4,
        0.96,
      ),
      2,
    );
    const targetReason = selected.audit.meetsTarget
      ? `It is the lowest-cost Pareto-efficient candidate meeting the ${assessment.targetQuality}-point quality target.`
      : `No candidate met the ${assessment.targetQuality}-point quality target; it has the best risk-adjusted accuracy/cost utility on the frontier.`;
    const metadataReason =
      selected.audit.estimatedBlendedPricePerMillion === undefined
        ? "Incomplete live pricing was filled from the configurable fallback catalog."
        : "Live Krater pricing and benchmark metadata informed the comparison.";

    return {
      model: selected.audit.model,
      tier: selected.audit.tier,
      reasons: [
        `Classified as ${assessment.complexity} complexity, ${assessment.risk} risk, ${assessment.contextSize} context, with ${
          assessment.toolNeeds.length
            ? assessment.toolNeeds.join(", ")
            : "no inferred tool"
        } needs.`,
        targetReason,
        metadataReason,
      ],
      confidence,
      explicitOverride: false,
      assessment,
      candidates: resolved
        .map((candidate) => candidate.audit)
        .sort((a, b) => a.model.localeCompare(b.model)),
    };
  }

  private resolveCandidate(
    descriptor: AvailableModel,
    assessment: CodingTaskAssessment,
  ): ResolvedCandidate {
    const catalogProfile = this.profiles.get(normalizedCatalogId(descriptor.id));
    const profile =
      catalogProfile ??
      inferFallbackProfile(descriptor.id, this.fallbackProfile);
    const benchmark = descriptor.benchmarks?.artificial_analysis;
    const dynamicCoding = parseNonNegative(benchmark?.coding_index);
    const dynamicAgentic = parseNonNegative(benchmark?.agentic_index);
    const dynamicIntelligence = parseNonNegative(benchmark?.intelligence_index);
    const coding = clamp(dynamicCoding ?? profile.codingScore, 0, 100);
    const agentic = clamp(dynamicAgentic ?? profile.agenticScore, 0, 100);
    const intelligence = clamp(
      dynamicIntelligence ?? profile.intelligenceScore,
      0,
      100,
    );
    const price = blendedPrice(descriptor.pricing);
    const costScore =
      price === undefined ? profile.relativeCost : priceToCostScore(price);
    const parsedContext = parseNonNegative(descriptor.context_length);
    const contextWindow =
      parsedContext !== undefined && Number.isSafeInteger(parsedContext)
        ? parsedContext
        : profile.contextWindow;
    const hasDynamicToolMetadata = Array.isArray(descriptor.supported_parameters);
    const supportsTools = hasDynamicToolMetadata
      ? descriptor.supported_parameters!.some(
          (parameter) => parameter.toLowerCase() === "tools",
        )
      : profile.supportsTools;
    const disqualifiers: string[] = [];
    const inputModalities = normalizedModalities(
      descriptor.architecture?.input_modalities,
    );
    const outputModalities = normalizedModalities(
      descriptor.architecture?.output_modalities,
    );
    if (inputModalities.length && !inputModalities.includes("text")) {
      disqualifiers.push("text input is unsupported");
    }
    if (
      outputModalities.length &&
      (outputModalities.length !== 1 || outputModalities[0] !== "text")
    ) {
      disqualifiers.push(
        `coding-agent output must be text-only, not ${outputModalities.join("+")}`,
      );
    }
    if (assessment.toolNeeds.length && !supportsTools) {
      disqualifiers.push("required tool calling is unsupported");
    }
    if (contextWindow < assessment.requiredContextTokens) {
      disqualifiers.push(
        `context window ${contextWindow} is below required ${assessment.requiredContextTokens} tokens`,
      );
    }
    const quality = qualityScore(coding, agentic, intelligence, assessment);
    const metadataFields = [
      price !== undefined,
      dynamicCoding !== undefined,
      dynamicAgentic !== undefined,
      dynamicIntelligence !== undefined,
      parsedContext !== undefined,
      hasDynamicToolMetadata,
    ];
    const metadataCompleteness = round(
      metadataFields.filter(Boolean).length / metadataFields.length,
      2,
    );
    const tier =
      price === undefined && catalogProfile
        ? catalogProfile.tier
        : tierFromCost(costScore);
    const eligible = disqualifiers.length === 0;
    const audit: RouteCandidateAudit = {
      model: descriptor.id,
      tier,
      qualityScore: quality,
      costScore,
      ...(price === undefined
        ? {}
        : { estimatedBlendedPricePerMillion: price }),
      contextWindow,
      supportsTools,
      eligible,
      meetsTarget: eligible && quality >= assessment.targetQuality,
      onFrontier: false,
      metadataCompleteness,
      disqualifiers,
    };
    return {
      audit,
      utility:
        quality - costScore * accuracyCostWeight(assessment.complexity),
    };
  }
}

export function routeCodingTask(
  request: SmartRouteRequest,
  options?: SmartCodingRouterOptions,
): RoutingDecision {
  return new SmartCodingRouter(options).route(request);
}
