import type {
  CausalExperiment,
  CausalHypothesis,
  OutcomeExpectation,
  RankedExperiment,
} from "./types.js";

function expectationSignature(expectation: OutcomeExpectation): string {
  return [...new Set(expectation.keys)].sort().join("\u0000");
}

export function countDistinguishingPairs(
  hypotheses: readonly CausalHypothesis[],
  experiment: CausalExperiment,
): number {
  const predictionByHypothesis = new Map(
    experiment.predictions.map((prediction) => [
      prediction.hypothesisId,
      expectationSignature(prediction.expected),
    ]),
  );
  let count = 0;

  for (let leftIndex = 0; leftIndex < hypotheses.length; leftIndex += 1) {
    const left = predictionByHypothesis.get(hypotheses[leftIndex].id);
    if (left === undefined) continue;
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < hypotheses.length;
      rightIndex += 1
    ) {
      const right = predictionByHypothesis.get(hypotheses[rightIndex].id);
      if (right !== undefined && left !== right) count += 1;
    }
  }
  return count;
}

/**
 * Ranks only experiments that separate at least one hypothesis pair. Cost is
 * primary; at equal cost, an experiment that separates more pairs wins.
 */
export function rankDistinguishingExperiments(
  hypotheses: readonly CausalHypothesis[],
  experiments: readonly CausalExperiment[],
): RankedExperiment[] {
  return experiments
    .map((experiment) => ({
      experimentId: experiment.id,
      rank: 0,
      estimatedCost: experiment.estimatedCost,
      distinguishingPairs: countDistinguishingPairs(hypotheses, experiment),
    }))
    .filter((candidate) => candidate.distinguishingPairs > 0)
    .sort(
      (left, right) =>
        left.estimatedCost - right.estimatedCost ||
        right.distinguishingPairs - left.distinguishingPairs ||
        left.experimentId.localeCompare(right.experimentId),
    )
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}
