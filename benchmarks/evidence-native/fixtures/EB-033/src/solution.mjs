export function composeMappings(outer, inner) {
  return outer.map((mapping) => ({ ...mapping, original: mapping.intermediate }));
}
