export function chooseOccurrence(candidates, afterEpochMs, repeatedTimePolicy) {
  return candidates.find((candidate) => candidate >= afterEpochMs);
}
