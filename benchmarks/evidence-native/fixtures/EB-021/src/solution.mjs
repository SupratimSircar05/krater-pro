export function publishResult(state, token, result) {
  return { ...state, published: result, publishedToken: token };
}
