# Evidence-Native Sealed Microbenchmark

This directory contains **100 executable local repair tasks**, with one distinct
microbenchmark mapped to every expert specification from `KC-001` through
`KC-100` in `benchmarks/tasks.json`. The tasks use deterministic Node.js and
Python fixtures and a host-side sealed checker.

These tasks cover focused invariants from distributed state, parsers, data
integrity, security, performance, accessibility, build tooling, protocols,
reliability, and agent-safe repository operations. They validate that Krater
can materialize a controlled seed, withhold a behavioral checker, run it, and
record a typed verdict.

Each task deliberately narrows one expert specification to a bounded function
or state-machine repair. Passing a microbenchmark is **not** equivalent to
solving its multi-hour expert source specification. This suite does not
constitute a SWE-bench score or an authoritative score for the separate
100-task expert catalog.

## Commands

All commands are offline and make no Krater API call:

```sh
# Validate strict manifest schema, fixture inventories, path confinement, and
# the SHA-256 seal on every checker.
node --import tsx benchmarks/evidence-native/runner.ts --validate

# Materialize every intentionally incomplete seed in a temporary directory and
# prove its checker rejects it.
node --import tsx benchmarks/evidence-native/runner.ts --smoke

# Check an already materialized candidate. The directory is never modified.
node --import tsx benchmarks/evidence-native/runner.ts \
  --task EB-001 \
  --workspace /absolute/path/to/candidate
```

`--json` emits a bounded machine-readable summary. Exit codes are `0` for a
successful validation or passing candidate, `1` for a normal benchmark
failure, and `2` for a harness or integrity error.

## Layout and trust boundary

```text
manifest.json
fixtures/
  EB-NNN/
    src/solution.mjs or src/solution.py
checkers/
  sealed-checker.mjs
runner.ts
```

The runner copies only the exact files listed in `task.fixture.files`. It:

- rejects absolute paths, traversal, backslashes, undeclared fixture files,
  symlinks, and special files;
- refuses to materialize over any caller-owned content;
- verifies the host checker against the digest pinned in the manifest;
- never copies checker code, expected values, or an expected patch into the
  candidate workspace;
- executes the checker with a bounded timeout and output size; and
- accepts only the minimal report contract below.

```json
{
  "format": "krater.sealed-checker-report/v1",
  "taskId": "EB-001",
  "passed": false,
  "checks": [
    { "id": "behavior-1", "passed": false }
  ]
}
```

Extra fields are rejected. In particular, the contract has no field for an
expected diff, secret test input, command, environment mutation, or arbitrary
diagnostic text. A checker can establish observable behavior, not that one
specific patch was used.

“Sealed” here means **withheld from the task workspace and
content-addressed**, not encrypted or signed. A maintainer with repository
access can inspect the checker. Release provenance can later add signature
verification on top of this digest.

## Authoring format

Every manifest object uses an exact-key schema. A task declares:

- `id`: stable `EB-NNN` identity;
- `sourceSpecId`: the broader `KC-NNN` concept from which the microtask was
  derived;
- `runtime`: `node` or `python`;
- a public prompt and at least two public acceptance criteria;
- one confined fixture root and an exhaustive regular-file inventory; and
- one host-side checker entry, lowercase SHA-256 digest, and timeout.

Manifest data cannot declare commands, arguments, network access,
environment variables, setup scripts, or teardown scripts. Adding one of
those fields is a validation error.

The checked-in manifest has additional release invariants:

- exactly 100 unique `EB-001` through `EB-100` task identifiers;
- exactly 100 unique `KC-001` through `KC-100` source-specification mappings;
- one fixture directory and one exhaustive regular-file inventory per task;
- 52 Node.js tasks and 48 Python tasks; and
- every seed is intentionally incomplete and rejected by its checker.

When checker behavior changes, recompute the digest deliberately:

```sh
shasum -a 256 benchmarks/evidence-native/checkers/sealed-checker.mjs
```

Update every manifest reference in the same reviewed change. A digest mismatch
is an integrity failure, never a normal task failure.

## Safety limits

The current checker runner is suitable only for these repository-controlled
fixtures. Timeout, output, environment, path, and process-group bounds reduce
accidental damage, but they are **not an OS sandbox**. Do not use this runner
for arbitrary downloaded repositories or untrusted candidate programs until
Krater's cross-platform native supervisor is available. An integrity check is
not containment.

The checker reports behavioral evidence only. A passing task should be
combined with the task contract, environment fingerprint, source and final
digests, and the wider ProofGraph capsule before any product-level completion
claim.
