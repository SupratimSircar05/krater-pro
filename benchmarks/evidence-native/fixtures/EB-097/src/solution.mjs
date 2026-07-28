export function indexRepositoryText(text) {
  return { chunks: text.split(/\s+/), source: text };
}
