export function applyFrame(state, frame) {
  return { ...state, frames: [...state.frames, frame] };
}
