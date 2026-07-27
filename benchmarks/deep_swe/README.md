# DeepSWE adapter

This directory integrates Krater Pro with the official
[datacurve-ai/deep-swe](https://github.com/datacurve-ai/deep-swe) task corpus
through `datacurve-pier==0.3.0`.

The adapter is deliberately benchmark-specific:

- It rejects every model except the exact ID `moonshotai/kimi-k3`.
- It requires the clean official checkout at
  `e016041a6ccf8da29906afc9a3f5a8df940a1f78`.
- It runs in `/app`, force-resets the dedicated `krater-pro-eval` branch to the
  task's starting HEAD on every attempt, verifies that the starting tree is
  clean, and commits any remaining changes so DeepSWE's `pre_artifacts.sh`
  captures them.
- It bounds wall time, model/tool steps, output tokens, session tokens, retained
  context, tool output, and the saved CLI log tail.
- It builds one self-contained host-side JavaScript benchmark entrypoint from
  Krater Pro's real provider, agent, tools, safety controls, and telemetry, then
  uploads it with the programming skills. The task container never contacts npm.
- Runtime egress is allowlisted only for the configured Krater API hostname.
- The API key is loaded only into Pier's host process (directly or via
  `--env-file`) and is never configured with `--agent-env`. The adapter uploads
  it through a host-created mode-`0600` temporary file, secures the remote file
  to mode `0600`, and the entrypoint reads and unlinks it before constructing
  the agent. Tool subprocesses therefore cannot inherit the key or read its
  handoff file. Its value is absent from commands, job configs, adapter logs,
  and reports.
- `VALIDATION.md` records the dated offline/Pier evidence and explicitly lists
  what was not executed or scored.

## Prerequisites

```bash
uv tool install datacurve-pier==0.3.0
npm install
git clone https://github.com/datacurve-ai/deep-swe /path/to/deep-swe
git -C /path/to/deep-swe checkout e016041a6ccf8da29906afc9a3f5a8df940a1f78
```

DeepSWE v1.1 tasks request 8 GiB RAM each and currently publish amd64 images.
On Apple Silicon, Docker uses emulation. Allocate at least 12–16 GiB to Docker
Desktop for reliable single-task runs; keep concurrency at one until a smoke
task passes. Both the host bundle build and the task image must provide a Node
version in Krater Pro's supported range: `^20.19.0 || >=22.12.0`. Node 21 and
Node 22.0–22.11 are rejected before inference.

## Safe plan and infrastructure check

The runner defaults to plan-only mode. It builds and smoke-tests the bundle but
does not start Docker or call Krater:

```bash
python benchmarks/deep_swe/run_deep_swe.py \
  --tasks-root /path/to/deep-swe/tasks \
  --task superjson-error-stack-serialization
```

To start the task container and validate Pier, `/app`, the uploaded bundle, and
the CLI—without an API key, paid inference, or verifier:

```bash
python benchmarks/deep_swe/run_deep_swe.py \
  --tasks-root /path/to/deep-swe/tasks \
  --task superjson-error-stack-serialization \
  --infrastructure-only
```

This mode can still pull/build the official task image. It intentionally does
not claim a benchmark score.

## One official live task

Put `KRATER_API_KEY` in the checkout's ignored `.env`, or export it. The value is
never placed in the child process argument list:

```bash
python benchmarks/deep_swe/run_deep_swe.py \
  --tasks-root /path/to/deep-swe/tasks \
  --task superjson-error-stack-serialization \
  --execute
```

Results default to `benchmarks/deep_swe/results/`, which is ignored by the
adapter-local `.gitignore`. Inspect Pier's `result.json`,
the verifier's `reward.json`, and `artifacts/model.patch`. A run only counts as
a pass when the official verifier reports it; an infrastructure check, a
non-empty patch, or a clean Krater exit is not a benchmark pass.

Multiple `--task` flags are supported. Running the complete 113-task corpus
requires the explicit `--all --execute` combination. Increase
`--n-concurrent` only when the Docker/Modal memory budget and Krater spend cap
have been reviewed.

## Direct Pier invocation

The runner prints the exact direct command in plan mode. A live command includes
the env file only as a host-process input:

```text
--env-file /absolute/path/to/.env
```

Pier 0.3 calls `load_dotenv()` in its host CLI process. `KraterProAgent` then
reads that host value directly for the one-time file upload. The command does
not contain `--agent-env`; adding the key there would make Pier merge it into
agent command environments and is explicitly rejected by the adapter. Never
paste a literal API key into agent kwargs, YAML, job configs, or shell history.

Before Pier starts a job, the runner also verifies the exact official Git
revision and rejects tracked or non-ignored untracked checkout changes. Inside
each task, only Git-visible tracked and non-ignored untracked repository state
is enforced; ignored build caches remain outside that integrity assertion.

## Offline adapter tests

Use Pier's isolated Python runtime:

```bash
'/Users/ssircar/Library/Application Support/uv/tools/datacurve-pier/bin/python' \
  -m unittest discover -s benchmarks/deep_swe -p 'test_*.py' -v
```

These tests do not use Docker, the network, or paid inference.
