export function applyCodePointEdit(text, start, end, replacement) {
  return text.slice(0, start) + replacement + text.slice(end);
}
