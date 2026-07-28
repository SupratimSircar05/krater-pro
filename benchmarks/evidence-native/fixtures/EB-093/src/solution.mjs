export function selectEnabledFeatures(load, features, maximumCost) {
  if (load > 0.8) return [];
  return features.map((feature) => feature.id);
}
