export function mergeRegister(left, right) {
  return left.timestamp >= right.timestamp ? left : right;
}
