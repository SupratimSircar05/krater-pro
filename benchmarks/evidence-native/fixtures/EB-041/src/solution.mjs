export function isVisible(version, snapshot, committed) {
  return version.created <= snapshot;
}
