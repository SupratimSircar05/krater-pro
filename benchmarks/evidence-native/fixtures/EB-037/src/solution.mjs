export function analyzePatterns(variants, arms) {
  const present = new Set(arms);
  return { missing: variants.filter((value) => !present.has(value)), redundant: [] };
}
