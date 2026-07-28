export function planEntityMerge(source, target, references) {
  return references.map((reference) => ({ ...reference, entityId: target }));
}
