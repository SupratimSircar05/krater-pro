import { createStableRecordId } from "./stable-id.js";
import type { AmbiguityCandidate, RankedAmbiguity } from "./types.js";

function unitInterval(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a finite number between 0 and 1.`);
  }
  return value;
}

function positive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number.`);
  }
  return value;
}

function uniqueStrings(values: readonly string[], label: string): string[] {
  const unique = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  if (!unique.length) throw new Error(`${label} must contain at least one value.`);
  return unique;
}

function normalizeCandidate(candidate: AmbiguityCandidate): RankedAmbiguity {
  const question = candidate.question.trim();
  if (!question) throw new Error("Ambiguity question must not be empty.");
  const interpretations = uniqueStrings(
    candidate.interpretations,
    "Ambiguity interpretations",
  );
  if (interpretations.length < 2) {
    throw new Error("An ambiguity must contain at least two distinct interpretations.");
  }
  const implementationFingerprints = candidate.implementationFingerprints?.map(
    (fingerprint) => fingerprint.trim(),
  );
  if (implementationFingerprints?.some((fingerprint) => !fingerprint)) {
    throw new Error("Implementation fingerprints must not contain empty values.");
  }
  if (
    implementationFingerprints &&
    implementationFingerprints.length !== interpretations.length
  ) {
    throw new Error(
      "Implementation fingerprints must map one-to-one to interpretations.",
    );
  }
  const impact = unitInterval(candidate.impact, "Impact");
  const risk = unitInterval(candidate.risk, "Risk");
  const irreversibility = unitInterval(candidate.irreversibility, "Irreversibility");
  const questionCost = positive(candidate.questionCost, "Question cost");
  const id =
    candidate.id?.trim() ||
    createStableRecordId("ambiguity", [question, ...interpretations]);
  const converges =
    implementationFingerprints !== undefined &&
    new Set(implementationFingerprints).size === 1;

  return {
    id,
    question,
    interpretations,
    ...(implementationFingerprints ? { implementationFingerprints } : {}),
    impact,
    risk,
    irreversibility,
    questionCost,
    score: (impact * risk * irreversibility) / questionCost,
    converges,
  };
}

export interface RankAmbiguityOptions {
  includeConvergent?: boolean;
  minimumScore?: number;
}

export function rankAmbiguities(
  candidates: readonly AmbiguityCandidate[],
  options: RankAmbiguityOptions = {},
): RankedAmbiguity[] {
  const minimumScore = options.minimumScore ?? 0;
  if (!Number.isFinite(minimumScore) || minimumScore < 0) {
    throw new Error("Minimum ambiguity score must be a non-negative finite number.");
  }
  return candidates
    .map(normalizeCandidate)
    .filter(
      (candidate) =>
        candidate.score >= minimumScore &&
        (options.includeConvergent === true || !candidate.converges),
    )
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

export function selectNextClarification(
  candidates: readonly AmbiguityCandidate[],
  options: RankAmbiguityOptions = {},
): RankedAmbiguity | undefined {
  return rankAmbiguities(candidates, options)[0];
}
