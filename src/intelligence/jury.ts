import {
  INTELLIGENCE_EVIDENCE_GRADES,
  type IntelligenceAssurance,
  type IntelligenceEvidenceGrade,
  type JuryCandidate,
  type JuryCandidatePlan,
  type JuryDecision,
  type JuryDecisionInput,
  type JuryDissent,
  type JuryPlan,
  type JuryPolicy,
  type JuryTriggerAssessment,
  type JuryTriggerContext,
  type PartialJuryPolicy,
} from "./types.js";

export const DEFAULT_JURY_POLICY: Readonly<JuryPolicy> = Object.freeze({
  riskThreshold: 0.75,
  ambiguityThreshold: 0.65,
  routerConfidenceFloor: 0.55,
  routerCalibrationErrorThreshold: 0.15,
  minimumCalibrationSamples: 20,
  minimumCandidates: 2,
  maximumCandidates: 2,
  maximumCostMultiplier: 2,
  evidenceFloor: Object.freeze({
    fast: "observed",
    standard: "tested",
    high: "stress_tested",
  }),
});

const evidenceRank = new Map<IntelligenceEvidenceGrade, number>(
  INTELLIGENCE_EVIDENCE_GRADES.map((grade, index) => [grade, index]),
);

function assertUnitInterval(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a finite number between 0 and 1.`);
  }
}

function assertNonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative number.`);
  }
}

function normalizePolicy(overrides?: PartialJuryPolicy): JuryPolicy {
  const evidenceFloor = {
    ...DEFAULT_JURY_POLICY.evidenceFloor,
    ...overrides?.evidenceFloor,
  };
  const policy: JuryPolicy = {
    ...DEFAULT_JURY_POLICY,
    ...overrides,
    evidenceFloor,
  };

  assertUnitInterval("risk threshold", policy.riskThreshold);
  assertUnitInterval("ambiguity threshold", policy.ambiguityThreshold);
  assertUnitInterval("router confidence floor", policy.routerConfidenceFloor);
  assertUnitInterval(
    "router calibration error threshold",
    policy.routerCalibrationErrorThreshold,
  );
  if (
    !Number.isInteger(policy.minimumCalibrationSamples) ||
    policy.minimumCalibrationSamples < 1
  ) {
    throw new Error("minimum calibration samples must be a positive integer.");
  }
  if (
    !Number.isInteger(policy.minimumCandidates) ||
    policy.minimumCandidates < 2
  ) {
    throw new Error("minimum jury candidates must be an integer of at least two.");
  }
  if (
    !Number.isInteger(policy.maximumCandidates) ||
    policy.maximumCandidates < policy.minimumCandidates
  ) {
    throw new Error(
      "maximum jury candidates must be an integer at least as large as the minimum.",
    );
  }
  if (
    !Number.isFinite(policy.maximumCostMultiplier) ||
    policy.maximumCostMultiplier <= 0
  ) {
    throw new Error("maximum jury cost multiplier must be positive.");
  }
  if (policy.maximumAbsoluteCostUsd !== undefined) {
    assertNonNegative(
      "maximum absolute jury cost",
      policy.maximumAbsoluteCostUsd,
    );
  }

  return policy;
}

function costLimit(primaryAgentCostUsd: number, policy: JuryPolicy): number {
  assertNonNegative("primary agent cost", primaryAgentCostUsd);
  const relativeLimit = primaryAgentCostUsd * policy.maximumCostMultiplier;
  return policy.maximumAbsoluteCostUsd === undefined
    ? relativeLimit
    : Math.min(relativeLimit, policy.maximumAbsoluteCostUsd);
}

function isIndependent(
  left: Pick<JuryCandidatePlan, "modelId" | "promptDigest">,
  right: Pick<JuryCandidatePlan, "modelId" | "promptDigest">,
): boolean {
  return (
    left.modelId.trim() !== right.modelId.trim() ||
    left.promptDigest.trim() !== right.promptDigest.trim()
  );
}

export function assessJuryTrigger(
  context: JuryTriggerContext,
  overrides?: PartialJuryPolicy,
): JuryTriggerAssessment {
  const policy = normalizePolicy(overrides);
  assertUnitInterval("risk", context.risk);
  assertUnitInterval("ambiguity", context.ambiguity);
  if (context.routerConfidence !== undefined) {
    assertUnitInterval("router confidence", context.routerConfidence);
  }
  if (context.routerCalibrationError !== undefined) {
    assertUnitInterval(
      "router calibration error",
      context.routerCalibrationError,
    );
  }
  if (
    context.routerCalibrationSamples !== undefined &&
    (!Number.isInteger(context.routerCalibrationSamples) ||
      context.routerCalibrationSamples < 0)
  ) {
    throw new Error("router calibration samples must be a non-negative integer.");
  }

  const triggers: JuryTriggerAssessment["triggers"][number][] = [];
  const reasons: string[] = [];
  if (context.risk >= policy.riskThreshold) {
    triggers.push("high_risk");
    reasons.push(
      `Risk ${context.risk.toFixed(2)} met the ${policy.riskThreshold.toFixed(2)} jury threshold.`,
    );
  }
  if (context.ambiguity >= policy.ambiguityThreshold) {
    triggers.push("high_ambiguity");
    reasons.push(
      `Ambiguity ${context.ambiguity.toFixed(2)} met the ${policy.ambiguityThreshold.toFixed(2)} jury threshold.`,
    );
  }
  if (context.verificationContradiction === true) {
    triggers.push("verification_contradiction");
    reasons.push("Verification contradicted the primary patch.");
  }
  if (context.materiallyDifferentDesigns === true) {
    triggers.push("material_design_divergence");
    reasons.push("Viable designs have materially different outcomes.");
  }

  const hasEnoughCalibration =
    (context.routerCalibrationSamples ?? 0) >=
    policy.minimumCalibrationSamples;
  const lowConfidence =
    context.routerConfidence !== undefined &&
    context.routerConfidence < policy.routerConfidenceFloor;
  const highCalibrationError =
    context.routerCalibrationError !== undefined &&
    context.routerCalibrationError >=
      policy.routerCalibrationErrorThreshold;
  if (hasEnoughCalibration && (lowConfidence || highCalibrationError)) {
    triggers.push("poor_router_calibration");
    reasons.push(
      "Historical router confidence is poorly calibrated for this task class.",
    );
  }

  return {
    shouldConvene: triggers.length > 0,
    triggers,
    reasons,
  };
}

interface CandidatePair {
  candidates: readonly [JuryCandidatePlan, JuryCandidatePlan];
  cost: number;
}

export function planJury(
  trigger: JuryTriggerAssessment,
  primaryAgentCostUsd: number,
  candidates: readonly JuryCandidatePlan[],
  overrides?: PartialJuryPolicy,
): JuryPlan {
  const policy = normalizePolicy(overrides);
  const limit = costLimit(primaryAgentCostUsd, policy);
  if (!trigger.shouldConvene) {
    return {
      status: "not_triggered",
      triggers: trigger.triggers,
      candidateIds: [],
      estimatedCostUsd: 0,
      costLimitUsd: limit,
      reasons: ["No selective jury trigger fired."],
    };
  }

  const normalized = [...candidates]
    .map((candidate) => {
      assertNonNegative(
        `estimated cost for jury candidate ${candidate.id}`,
        candidate.estimatedCostUsd,
      );
      if (
        candidate.id.trim().length === 0 ||
        candidate.modelId.trim().length === 0 ||
        candidate.promptDigest.trim().length === 0
      ) {
        throw new Error(
          "Jury candidate IDs, model IDs, and prompt digests must be non-empty.",
        );
      }
      return candidate;
    })
    .sort(
      (left, right) =>
        left.estimatedCostUsd - right.estimatedCostUsd ||
        left.id.localeCompare(right.id),
    );

  const pairs: CandidatePair[] = [];
  for (let left = 0; left < normalized.length; left += 1) {
    for (let right = left + 1; right < normalized.length; right += 1) {
      if (!isIndependent(normalized[left], normalized[right])) continue;
      pairs.push({
        candidates: [normalized[left], normalized[right]],
        cost:
          normalized[left].estimatedCostUsd +
          normalized[right].estimatedCostUsd,
      });
    }
  }
  pairs.sort(
    (left, right) =>
      left.cost - right.cost ||
      left.candidates[0].id.localeCompare(right.candidates[0].id) ||
      left.candidates[1].id.localeCompare(right.candidates[1].id),
  );

  if (pairs.length === 0) {
    return {
      status: "insufficient_independence",
      triggers: trigger.triggers,
      candidateIds: [],
      estimatedCostUsd: 0,
      costLimitUsd: limit,
      reasons: [
        "A jury requires at least two proposals with different prompts or models.",
      ],
    };
  }

  const affordable = pairs.find((pair) => pair.cost <= limit);
  if (affordable === undefined) {
    return {
      status: "blocked_budget",
      triggers: trigger.triggers,
      candidateIds: [],
      estimatedCostUsd: pairs[0].cost,
      costLimitUsd: limit,
      reasons: [
        `The cheapest independent jury costs $${pairs[0].cost.toFixed(4)}, above the $${limit.toFixed(4)} limit.`,
      ],
    };
  }

  return {
    status: "planned",
    triggers: trigger.triggers,
    candidateIds: affordable.candidates.map((candidate) => candidate.id),
    estimatedCostUsd: affordable.cost,
    costLimitUsd: limit,
    reasons: [
      "Selected the cheapest independent candidate pair within the jury budget.",
    ],
  };
}

function candidateFailures(
  candidate: JuryCandidate,
  floor: IntelligenceEvidenceGrade,
): string[] {
  const reasons: string[] = [];
  if (candidate.verificationVerdict !== "passed") {
    reasons.push(`Verification was ${candidate.verificationVerdict}.`);
  }
  const failedChecks = candidate.checks
    .filter((check) => check.required !== false && !check.passed)
    .map((check) => check.id);
  if (failedChecks.length > 0) {
    reasons.push(`Required checks failed: ${failedChecks.join(", ")}.`);
  }
  if ((candidate.contradictionRefs?.length ?? 0) > 0) {
    reasons.push("Deterministic evidence contradicts this candidate.");
  }
  if ((candidate.securityFailures ?? 0) > 0) {
    reasons.push("Security verification reported a failure.");
  }
  if (
    (evidenceRank.get(candidate.evidenceGrade) ?? -1) <
    (evidenceRank.get(floor) ?? Number.POSITIVE_INFINITY)
  ) {
    reasons.push(
      `Evidence grade ${candidate.evidenceGrade} is below the ${floor} assurance floor.`,
    );
  }
  if (candidate.evidenceRefs.filter((ref) => ref.trim().length > 0).length === 0) {
    reasons.push("No replayable evidence reference supports this candidate.");
  }
  if (candidate.patchDigest.trim().length === 0) {
    reasons.push("The candidate has no staged patch digest.");
  }
  return reasons;
}

function candidateEvidenceScore(candidate: JuryCandidate): readonly number[] {
  const passedRequiredChecks = candidate.checks.filter(
    (check) => check.required !== false && check.passed,
  ).length;
  const evidenceCount = new Set(
    candidate.evidenceRefs.filter((ref) => ref.trim().length > 0),
  ).size;
  return [
    evidenceRank.get(candidate.evidenceGrade) ?? -1,
    passedRequiredChecks,
    evidenceCount,
    -candidate.actualCostUsd,
  ];
}

function compareEvidence(left: JuryCandidate, right: JuryCandidate): number {
  const leftScore = candidateEvidenceScore(left);
  const rightScore = candidateEvidenceScore(right);
  for (let index = 0; index < leftScore.length; index += 1) {
    const difference = rightScore[index] - leftScore[index];
    if (difference !== 0) return difference;
  }
  return left.id.localeCompare(right.id);
}

function makeDissent(
  candidate: JuryCandidate,
  failures: readonly string[],
  selected: JuryCandidate | undefined,
): JuryDissent {
  const reasons = [...failures];
  if (reasons.length === 0 && selected !== undefined) {
    reasons.push(
      `A different candidate had stronger deterministic evidence (${selected.evidenceGrade}).`,
    );
  }
  return {
    candidateId: candidate.id,
    evidenceGrade: candidate.evidenceGrade,
    reasons,
    evidenceRefs: [
      ...candidate.evidenceRefs,
      ...(candidate.contradictionRefs ?? []),
    ],
  };
}

function independenceFailure(candidates: readonly JuryCandidate[]): boolean {
  if (candidates.length < 2) return true;
  for (let left = 0; left < candidates.length; left += 1) {
    for (let right = left + 1; right < candidates.length; right += 1) {
      if (isIndependent(candidates[left], candidates[right])) return false;
    }
  }
  return true;
}

export function decideJury(input: JuryDecisionInput): JuryDecision {
  const policy = normalizePolicy(input.policy);
  const limit = costLimit(input.primaryAgentCostUsd, policy);
  const floor = policy.evidenceFloor[input.assurance];
  const totalCost = input.candidates.reduce((total, candidate) => {
    assertNonNegative(
      `actual cost for jury candidate ${candidate.id}`,
      candidate.actualCostUsd,
    );
    return total + candidate.actualCostUsd;
  }, 0);
  const ignoredVoteCounts = Object.fromEntries(
    input.candidates.map((candidate) => [
      candidate.id,
      Math.max(0, Math.trunc(candidate.voteCount ?? 0)),
    ]),
  );

  if (!input.trigger.shouldConvene) {
    return {
      status: "not_triggered",
      triggers: input.trigger.triggers,
      evidenceFloor: floor,
      totalCostUsd: totalCost,
      costLimitUsd: limit,
      reasons: ["No selective jury trigger fired."],
      dissent: [],
      ignoredVoteCounts,
    };
  }

  if (
    input.candidates.length < policy.minimumCandidates ||
    input.candidates.length > policy.maximumCandidates ||
    independenceFailure(input.candidates)
  ) {
    return {
      status: "insufficient_independence",
      triggers: input.trigger.triggers,
      evidenceFloor: floor,
      totalCostUsd: totalCost,
      costLimitUsd: limit,
      reasons: [
        `The jury requires ${policy.minimumCandidates}–${policy.maximumCandidates} independent proposals.`,
      ],
      dissent: input.candidates.map((candidate) =>
        makeDissent(candidate, ["The jury independence requirement was not met."], undefined),
      ),
      ignoredVoteCounts,
    };
  }

  if (totalCost > limit) {
    return {
      status: "blocked_budget",
      triggers: input.trigger.triggers,
      evidenceFloor: floor,
      totalCostUsd: totalCost,
      costLimitUsd: limit,
      reasons: [
        `Jury cost $${totalCost.toFixed(4)} exceeded the $${limit.toFixed(4)} limit.`,
      ],
      dissent: input.candidates.map((candidate) =>
        makeDissent(candidate, ["The bounded jury cost was exceeded."], undefined),
      ),
      ignoredVoteCounts,
    };
  }

  const evaluated = input.candidates.map((candidate) => ({
    candidate,
    failures: candidateFailures(candidate, floor),
  }));
  const eligible = evaluated
    .filter(({ failures }) => failures.length === 0)
    .map(({ candidate }) => candidate)
    .sort(compareEvidence);
  const selected = eligible[0];

  if (selected === undefined) {
    return {
      status: "abstained",
      triggers: input.trigger.triggers,
      evidenceFloor: floor,
      totalCostUsd: totalCost,
      costLimitUsd: limit,
      reasons: [
        "No candidate cleared the assurance floor with uncontradicted replayable evidence.",
      ],
      dissent: evaluated.map(({ candidate, failures }) =>
        makeDissent(candidate, failures, undefined),
      ),
      ignoredVoteCounts,
    };
  }

  return {
    status: "selected",
    triggers: input.trigger.triggers,
    selectedCandidateId: selected.id,
    evidenceFloor: floor,
    totalCostUsd: totalCost,
    costLimitUsd: limit,
    reasons: [
      "Selected by deterministic evidence grade, required checks, evidence coverage, and bounded cost; model votes were not used.",
    ],
    dissent: evaluated
      .filter(({ candidate }) => candidate.id !== selected.id)
      .map(({ candidate, failures }) =>
        makeDissent(candidate, failures, selected),
      ),
    ignoredVoteCounts,
  };
}

export function juryEvidenceFloor(
  assurance: IntelligenceAssurance,
  overrides?: PartialJuryPolicy,
): IntelligenceEvidenceGrade {
  return normalizePolicy(overrides).evidenceFloor[assurance];
}
