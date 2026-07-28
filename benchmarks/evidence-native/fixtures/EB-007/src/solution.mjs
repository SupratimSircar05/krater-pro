export function redactSecrets(text) {
  return text.replaceAll(/sk-[A-Za-z0-9]+/g, "[REDACTED]");
}
