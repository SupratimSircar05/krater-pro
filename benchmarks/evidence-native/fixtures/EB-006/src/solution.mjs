export function isSafeChildPath(root, candidate) {
  return candidate.startsWith(root);
}
