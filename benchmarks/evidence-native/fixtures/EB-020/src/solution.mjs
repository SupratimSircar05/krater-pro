export function gradeClaim(evidence) {
  if (evidence.length === 0) return "not-established";
  return evidence.every((item) => item.passed) ? "formally-verified" : "observed";
}
