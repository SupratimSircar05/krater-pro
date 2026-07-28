export function retryDelay(attempt, baseMs, maximumMs) {
  return baseMs * (2 ** attempt);
}
