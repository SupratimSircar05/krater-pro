export function halfClose(state, event) {
  if (event.endsWith("eof")) return { ...state, closed: true };
  return state;
}
