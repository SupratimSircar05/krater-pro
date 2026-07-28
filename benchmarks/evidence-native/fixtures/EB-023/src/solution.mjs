export function processSaga(state, event) {
  return {
    ...state,
    processed: [...state.processed, event.id],
    outbox: [...state.outbox, { type: `${event.type}-accepted`, key: event.id }],
  };
}
