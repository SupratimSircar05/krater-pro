export function decidePolicy(rules, request) {
  const match = rules.find((rule) => rule.operation === request.operation);
  return match?.effect ?? "allow";
}
