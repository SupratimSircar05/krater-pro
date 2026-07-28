export function selectTests(changed, coverage, dependencies, allTests) {
  return allTests.filter((test) => coverage[test]?.some((file) => changed.includes(file)));
}
