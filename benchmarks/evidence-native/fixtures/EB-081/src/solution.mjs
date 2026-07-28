export function cacheLookup(entry, question, now) {
  return entry.question === question && now <= entry.expiresAt ? entry.answer : undefined;
}
