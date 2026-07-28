import type {
  ReliabilityCaseResult,
  ReliabilityEvaluation,
  ReliabilityMetrics,
  ReliabilityPromotionDecision,
  ReliabilityPromotionInput,
  ReliabilityPromotionReason,
} from "./types.js";

function normalizedId(value: string): string {
  return value.trim();
}

function duplicateIds(cases: readonly ReliabilityCaseResult[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const result of cases) {
    const id = normalizedId(result.caseId);
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates].sort();
}

function validateEvaluation(evaluation: ReliabilityEvaluation): string[] {
  const errors: string[] = [];
  for (const [name, value] of [
    ["evaluation ID", evaluation.evaluationId],
    ["suite ID", evaluation.suiteId],
    ["dataset digest", evaluation.datasetDigest],
    ["configuration digest", evaluation.configurationDigest],
  ] as const) {
    if (normalizedId(value).length === 0) {
      errors.push(`${name} must be non-empty.`);
    }
  }
  if (evaluation.cases.length === 0) {
    errors.push(`Evaluation ${evaluation.evaluationId} contains no cases.`);
  }
  const duplicates = duplicateIds(evaluation.cases);
  if (duplicates.length > 0) {
    errors.push(
      `Evaluation ${evaluation.evaluationId} repeats case IDs: ${duplicates.join(", ")}.`,
    );
  }
  for (const result of evaluation.cases) {
    if (
      normalizedId(result.caseId).length === 0 ||
      normalizedId(result.taskClass).length === 0
    ) {
      errors.push("Case IDs and task classes must be non-empty.");
    }
    if (
      !Number.isInteger(result.securityFailures) ||
      result.securityFailures < 0
    ) {
      errors.push(
        `Case ${result.caseId} has an invalid security failure count.`,
      );
    }
    if (
      result.costUsd !== undefined &&
      (!Number.isFinite(result.costUsd) || result.costUsd < 0)
    ) {
      errors.push(`Case ${result.caseId} has an invalid cost.`);
    }
    if (
      result.latencyMs !== undefined &&
      (!Number.isFinite(result.latencyMs) || result.latencyMs < 0)
    ) {
      errors.push(`Case ${result.caseId} has an invalid latency.`);
    }
  }
  return errors;
}

function mean(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function reliabilityMetrics(
  evaluation: ReliabilityEvaluation,
): ReliabilityMetrics {
  const byClass = new Map<
    string,
    { caseCount: number; resolvedCount: number }
  >();
  let resolvedCount = 0;
  let securityFailures = 0;
  let abstentionErrors = 0;
  const costs: number[] = [];
  const latencies: number[] = [];

  for (const result of evaluation.cases) {
    if (result.resolved) resolvedCount += 1;
    securityFailures += result.securityFailures;
    if (result.abstention === "incorrect") abstentionErrors += 1;
    if (result.costUsd !== undefined) costs.push(result.costUsd);
    if (result.latencyMs !== undefined) latencies.push(result.latencyMs);

    const taskClass = result.taskClass.trim();
    const current = byClass.get(taskClass) ?? {
      caseCount: 0,
      resolvedCount: 0,
    };
    current.caseCount += 1;
    if (result.resolved) current.resolvedCount += 1;
    byClass.set(taskClass, current);
  }

  const byTaskClass = Object.fromEntries(
    [...byClass.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([taskClass, metrics]) => [
        taskClass,
        {
          ...metrics,
          resolutionRate:
            metrics.caseCount === 0
              ? 0
              : (metrics.resolvedCount / metrics.caseCount) * 100,
        },
      ]),
  );

  return {
    caseCount: evaluation.cases.length,
    resolvedCount,
    resolutionRate:
      evaluation.cases.length === 0
        ? 0
        : (resolvedCount / evaluation.cases.length) * 100,
    securityFailures,
    abstentionErrors,
    averageCostUsd: mean(costs),
    averageLatencyMs: mean(latencies),
    byTaskClass,
  };
}

function caseMap(
  evaluation: ReliabilityEvaluation,
): Map<string, ReliabilityCaseResult> {
  return new Map(
    evaluation.cases.map((result) => [normalizedId(result.caseId), result]),
  );
}

function sameCaseSet(
  left: ReliabilityEvaluation,
  right: ReliabilityEvaluation,
): boolean {
  const leftIds = [...caseMap(left).keys()].sort();
  const rightIds = [...caseMap(right).keys()].sort();
  return (
    leftIds.length === rightIds.length &&
    leftIds.every((id, index) => id === rightIds[index])
  );
}

function addReason(
  reasons: ReliabilityPromotionReason[],
  reason: ReliabilityPromotionReason,
): void {
  if (
    reasons.some(
      (existing) =>
        existing.code === reason.code && existing.message === reason.message,
    )
  ) {
    return;
  }
  reasons.push(reason);
}

export function evaluateReliabilityPromotion(
  input: ReliabilityPromotionInput,
): ReliabilityPromotionDecision {
  const minimumImprovementPoints = input.minimumImprovementPoints ?? 5;
  if (
    !Number.isFinite(minimumImprovementPoints) ||
    minimumImprovementPoints < 5
  ) {
    throw new Error(
      "Reliability promotion requires at least a five percentage-point improvement.",
    );
  }

  const reasons: ReliabilityPromotionReason[] = [];
  const evaluations = [
    input.ruleGeneration,
    input.baselineHoldout,
    input.candidateHoldout,
  ];
  const validationErrors = evaluations.flatMap(validateEvaluation);
  if (validationErrors.length > 0) {
    addReason(reasons, {
      code: "invalid_evaluation",
      message: validationErrors.join(" "),
    });
  }

  if (
    input.ruleGeneration.role !== "rule_generation" ||
    !input.ruleGeneration.sealed
  ) {
    addReason(reasons, {
      code: "invalid_evaluation",
      message:
        "Rule-generation results must be a sealed rule_generation evaluation.",
    });
  }
  if (
    input.baselineHoldout.role !== "private_holdout" ||
    input.candidateHoldout.role !== "private_holdout" ||
    !input.baselineHoldout.sealed ||
    !input.candidateHoldout.sealed
  ) {
    addReason(reasons, {
      code: "holdout_not_private_or_sealed",
      message: "Both holdout evaluations must be private and sealed.",
    });
  }

  if (
    input.baselineHoldout.suiteId !== input.candidateHoldout.suiteId ||
    input.baselineHoldout.datasetDigest !==
      input.candidateHoldout.datasetDigest ||
    !sameCaseSet(input.baselineHoldout, input.candidateHoldout)
  ) {
    addReason(reasons, {
      code: "holdout_mismatch",
      message:
        "Baseline and candidate must run the exact same sealed holdout cases.",
    });
  }

  const ruleGenerationIds = new Set(
    input.ruleGeneration.cases.map((result) => normalizedId(result.caseId)),
  );
  const contaminated = input.candidateHoldout.cases
    .map((result) => normalizedId(result.caseId))
    .filter((caseId) => ruleGenerationIds.has(caseId))
    .sort();
  if (contaminated.length > 0) {
    addReason(reasons, {
      code: "holdout_contamination",
      message:
        "Rule-generation and private holdout cases must remain strictly disjoint.",
      caseIds: contaminated,
    });
  }

  const baseline = reliabilityMetrics(input.baselineHoldout);
  const candidate = reliabilityMetrics(input.candidateHoldout);
  const improvementPoints =
    candidate.resolutionRate - baseline.resolutionRate;
  if (improvementPoints + Number.EPSILON < minimumImprovementPoints) {
    addReason(reasons, {
      code: "insufficient_improvement",
      message: `Holdout resolution improved by ${improvementPoints.toFixed(2)} points; ${minimumImprovementPoints.toFixed(2)} are required.`,
    });
  }

  const baselineCases = caseMap(input.baselineHoldout);
  const securityRegressions: string[] = [];
  const abstentionRegressions: string[] = [];
  for (const candidateCase of input.candidateHoldout.cases) {
    const baselineCase = baselineCases.get(normalizedId(candidateCase.caseId));
    if (baselineCase === undefined) continue;
    if (candidateCase.securityFailures > baselineCase.securityFailures) {
      securityRegressions.push(candidateCase.caseId);
    }
    if (
      candidateCase.abstention === "incorrect" &&
      baselineCase.abstention !== "incorrect"
    ) {
      abstentionRegressions.push(candidateCase.caseId);
    }
  }
  if (securityRegressions.length > 0) {
    addReason(reasons, {
      code: "security_regression",
      message:
        "The candidate introduced new security failures on private holdout cases.",
      caseIds: securityRegressions.sort(),
    });
  }
  if (abstentionRegressions.length > 0) {
    addReason(reasons, {
      code: "abstention_regression",
      message:
        "The candidate introduced incorrect abstention behavior on private holdout cases.",
      caseIds: abstentionRegressions.sort(),
    });
  }

  return {
    promote: reasons.length === 0,
    candidateId: input.candidateId,
    candidateKind: input.candidateKind,
    minimumImprovementPoints,
    improvementPoints,
    baseline,
    candidate,
    reasons,
  };
}
