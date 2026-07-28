export function nextShutdownAction(state) {
  if (!state.socketsClosed) return "close-sockets";
  if (!state.accepting) return "flush";
  return "stop-accepting";
}
