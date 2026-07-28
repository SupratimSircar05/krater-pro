export function mergeIntervals(intervals) {
  intervals.sort((left, right) => left[0] - right[0]);
  const output = [];
  for (const interval of intervals) {
    const previous = output.at(-1);
    if (previous && interval[0] < previous[1]) previous[1] = interval[1];
    else output.push(interval);
  }
  return output;
}
