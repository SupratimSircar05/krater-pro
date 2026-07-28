export function validateCallback(session, query) {
  return typeof query.code === "string" && query.code.length > 0;
}
