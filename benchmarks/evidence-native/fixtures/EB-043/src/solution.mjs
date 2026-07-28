export function applyEvent(projection, event) {
  return {
    ...projection,
    value: projection.value + event.delta,
    offsets: { ...projection.offsets, [event.partition]: event.offset },
  };
}
