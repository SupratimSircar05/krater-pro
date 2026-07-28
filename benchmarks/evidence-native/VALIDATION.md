# Foundation validation

Validation target: Evidence-Native Foundation suite `0.1.0`.

The checked-in suite must satisfy:

- exactly 20 declared tasks are present;
- every manifest and asset path passes strict confinement validation;
- every fixture inventory is exhaustive and contains only regular files;
- the checker SHA-256 matches the manifest seal;
- all 20 deliberately incomplete seeds are rejected;
- a behaviorally correct EB-001 repair passes without diff comparison;
- extra checker report fields and inconsistent verdicts are rejected; and
- materialization refuses nonempty caller-owned directories.

Run:

```sh
node --import tsx benchmarks/evidence-native/runner.ts --validate
node --import tsx benchmarks/evidence-native/runner.ts --smoke --json
npx vitest run src/benchmarking/evidence-native.test.ts \
  benchmarks/evidence-native/runner.test.ts
npx tsc -p tsconfig.server.json --noEmit
```

This file describes the repeatable gate rather than claiming a permanent
result. Release evidence should record the exact command outputs, tool
versions, environment fingerprint, and source digest from the release run.
