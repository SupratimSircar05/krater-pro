export function replaySchedule(schedule, operations) {
  return [...schedule]
    .sort((left, right) => left.at - right.at)
    .map((entry) => operations[entry.operation]());
}
