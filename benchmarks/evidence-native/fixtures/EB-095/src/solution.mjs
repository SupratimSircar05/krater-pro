export function planPatch(baseDigests, currentDigests, edits) {
  return { applicable: edits, conflicts: [] };
}
