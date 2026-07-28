export function classifyAction(facts) {
  if (facts.acceptanceSatisfied) return "change-required";
  if (facts.partialFix) return "partial-fix";
  return "change-required";
}
