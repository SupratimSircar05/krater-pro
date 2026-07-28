export function occurs(variable, type) {
  return type?.kind === "variable" && type.name === variable;
}
