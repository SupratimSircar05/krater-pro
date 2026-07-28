# Evidence-Native Foundation Benchmark

This directory contains Krater Pro's first **20 executable local acceptance
tasks** for the evidence-native foundation. They are intentionally small,
deterministic Node.js and Python repairs derived from concepts in
`benchmarks/tasks.json`.

These are infrastructure acceptance tasks. They validate that Krater can
materialize a controlled seed, withhold a behavioral checker, run it, and
record a typed verdict. They are **not** the “20 hardest coding problems,” do
not replace the 100 expert specifications, and do not constitute a SWE-bench
score.

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
