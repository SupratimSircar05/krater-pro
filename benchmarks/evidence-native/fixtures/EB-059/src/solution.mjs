export function coalesceQueue(queue, item, maximum) {
  return [...queue, item].slice(-maximum);
}
