export function rewriteFetchJson(source) {
  return source.replace(/fetchJson\(([^,]+),\s*([^)]+)\)/g, "fetchJson($1, { timeout: $2 })");
}
