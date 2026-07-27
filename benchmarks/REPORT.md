# Krater Pro Expert Benchmark

This benchmark is an execution harness for the 100 expert tasks in
[`tasks.json`](./tasks.json). It is designed to produce inspectable evidence, not a
marketing claim that a model or product is “perfect.”

## Safe default

The runner is offline unless `--live` is explicitly present. With no arguments it
validates the whole catalog and lists its tasks. Validation and listing do not load
an API key, construct a Krater provider, or make a network request.

```sh
npx tsx benchmarks/run.ts
npx tsx benchmarks/run.ts --validate
npx tsx benchmarks/run.ts --list --category concurrency-distributed
npx tsx benchmarks/run.ts --task KC-001
```

`--live` by itself is rejected. A paid run must select one task or one ten-task
category. Running all 100 tasks also requires the explicit `--all` acknowledgement.

```sh
# .env in the directory from which the runner is invoked
KRATER_API_KEY=your_key_here
KRATER_MODEL=moonshotai/kimi-k3

# One task, using an isolated dossier workspace
npx tsx benchmarks/run.ts --live --task KC-001 --model moonshotai/kimi-k3

# One task against a copy of a fixture repository
npx tsx benchmarks/run.ts --live --task KC-001 \
  --model moonshotai/kimi-k3 \
  --workspace ./fixtures/KC-001 \
  --output ./benchmarks/results/KC-001-kimi-k3

# Execute a reviewed independent checker from that fixture
npx tsx benchmarks/run.ts --live --task KC-001 \
  --workspace ./fixtures/KC-001 \
  --trust-checkers

# Ten tasks
npx tsx benchmarks/run.ts --live --category concurrency-distributed

# All 100; intentionally verbose because this can be expensive
npx tsx benchmarks/run.ts --live --all
```

Use the exact model ID returned by Krater if it differs from the illustrative
`moonshotai/kimi-k3` value. The runner loads `KRATER_API_KEY`, `KRATER_BASE_URL`,
`KRATER_MODEL`, `KRATER_CONTEXT_CHARS`, `KRATER_TOOL_OUTPUT_CHARS`,
`KRATER_RESPONSE_STYLE`, `KRATER_MAX_STEPS`, `KRATER_MAX_OUTPUT_TOKENS`, and
`KRATER_SESSION_TOKEN_BUDGET` through the same configuration
path as Krater Pro. The resolved efficiency and step settings are passed to every
benchmark `AgentSession` and recorded in the report. The runner reports only the
key source (`environment` or `.env`), never the key value.

## Catalog validation

Runtime validation is deliberately strict and does not coerce malformed JSON:

- exactly 100 tasks, in array order `KC-001` through `KC-100`;
- exactly ten declared categories and exactly ten tasks in each;
- unique task IDs, task titles, and category IDs;
- expert difficulty, a bounded positive time estimate, and a declared category;
- substantive prompts and setup summaries;
- multiple capabilities, acceptance criteria, hidden checks, and hazards;
- non-empty stack and safe relative seed-file paths; and
- no undeclared fields at any catalog, category, task, or setup level.

A broken catalog fails before selection, configuration, workspace copying, or API
access.

## Live-run methodology

Each selected task gets a fresh temporary root and a separate `workspace`
subdirectory. Krater Pro's `AgentSession` is rooted there. Its benchmark approval
handler automatically allows only `write_file` and `replace_in_file` against
that isolated workspace; `run_command` is denied and returned to the model as a
denial result. Read-only tools continue to run normally.

When `--workspace` is provided, the runner recursively copies regular files while
skipping symlinks and paths that commonly contain dependencies, repository
internals, or secrets. Exclusions include `.git`, `node_modules`, `.env*`,
`secrets`, credential files, private-key formats, and runner-owned
`.krater-benchmark` metadata. Without `--workspace`, the runner creates a
`BENCHMARK_TASK.md` dossier. Catalog seed-file names in a dossier are descriptive;
the runner does not invent fixture contents.

Supplying a workspace does not authorize executable checker code. By default the
runner does not discover or copy a checker. `--trust-checkers` is accepted only
with both `--live` and `--workspace`; it is the separate, explicit opt-in for the
trusted process described below.

The live prompt includes the public task, setup, acceptance criteria, and hazards.
Catalog `hiddenChecks` are never included in the prompt or dossier. They are
descriptions for future fixture/checker authors; their presence in the JSON catalog
does not mean they were executed.

For every task the runner records:

- relative timestamps for every streamed text, tool call, tool result, usage,
  completion, and error event;
- streamed text both as chunks and as a combined value;
- tool-call and tool-result success counts;
- aggregate reported token usage;
- thrown and streamed runtime errors;
- wall-clock start, finish, and duration;
- execution-score components; and
- independent-check status and acceptance-rubric status.

The isolated root is removed after evidence is captured. JSON and Markdown reports
are written only after the selected run finishes.

## Independent checker protocol

Correctness requires evidence outside the model's own answer. A fixture workspace
may provide one checker at:

```text
.krater-benchmark/checks/KC-001.mjs
.krater-benchmark/checks/KC-001.js
.krater-benchmark/checks/KC-001.sh
```

Only after `--trust-checkers` is supplied does the runner discover the first
matching extension and copy it into a runner-controlled directory outside the
agent's workspace. The entire `.krater-benchmark` directory remains withheld
from the agent. The runner calculates SHA-256 over the copied bytes and displays
the checker’s source-relative path and hash before execution. Both values are
retained in the JSON and Markdown evidence. After the agent finishes, the
checker runs with the isolated workspace as its current directory and without
the Krater API key in its environment.

An exit code of zero means the independent checker asserts that the task's
acceptance rubric passed. Any nonzero exit, timeout, or spawn error marks the
rubric as externally failed. If no checker exists, every criterion remains
`unverified`, even if the model says its solution is correct or its own tests pass.

The checker is a trusted independent process, not an AgentSession tool and not
covered by the model-command denial above. It can execute fixture code with the
runner user's permissions, so review the exact file before opting in and compare
the displayed hash with the reviewed copy. It should test observable behavior,
invariants, adversarial cases, and cleanup. A weak checker produces weak evidence.

## Score interpretation

The 100-point **execution score is not a correctness score**.

| Component | Points | What is observed |
| --- | ---: | --- |
| Session completion | 40 | `AgentSession` emitted `done` before its step bound |
| Error-free runtime | 30 | No error event or thrown run error was captured |
| Tool reliability | 30 | Proportion of observed tool results with `ok: true` |

If the model uses no tools, tool reliability is `not-exercised` and earns zero
points. A fluent one-turn answer can therefore score at most 70/100 and still has
unverified correctness. A denied `run_command` or another failed tool result
lowers tool reliability; a later successful tool result does not erase that
evidence.

Reports keep these concepts separate:

- `executionScore` describes whether the agent run completed and its tools worked;
- `externalCheck` describes independent executable evidence; and
- `rubric` is unverified unless that checker actually ran.

Do not average execution scores and label the result “accuracy.” For model
comparisons, use identical catalog versions, fixture commits, checker versions,
model IDs, step limits, and repeated trials. Report pass rates and variance
separately from execution behavior.

## Report paths

`--output` accepts:

- a stem (`results/run-1` → `results/run-1.json` and `results/run-1.md`);
- an existing directory or a path ending in `/` (a generated stem is added); or
- a `.json`/`.md` filename (both formats use the same basename).

Without `--output`, reports go under `benchmarks/results/` with a timestamp, model,
and selection in the filename.

The Markdown report is a readable summary. The JSON report is the authoritative
machine-readable event record.

## Credit and data warning

Live benchmarking can consume substantial paid Krater credits. One task may require
many streamed model turns; a category runs ten independent sessions; `--all` runs
one hundred. Start with one task, inspect its report, and confirm model pricing and
account limits before scaling up.

The runner excludes common secret paths, supplies a reduced environment to tools,
and redacts the configured Krater key from captured strings. That is defense in
depth, not a guarantee that arbitrary fixture content or model output is safe to
publish. Reports can contain source snippets, command output, local paths, or other
sensitive project data. Review reports before sharing them.
