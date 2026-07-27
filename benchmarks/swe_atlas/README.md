# Krater Pro × SWE-Atlas

This directory integrates Krater Pro with the official
[Scale AI SWE-Atlas](https://github.com/scaleapi/SWE-Atlas) task corpus through
the Harbor v0.18 custom-agent API. It supports all three official tracks:

| Track | Directory | Official task count | Required agent output |
| --- | --- | ---: | --- |
| Codebase Q&A | `data/qa` | 124 | `/logs/agent/answer.txt` with `<<FINAL_ANSWER>>` tags |
| Test Writing | `data/tw` | 90 | repository tests and `/logs/agent/manifest.txt` with `<<TEST_MANIFEST>>` tags |
| Refactoring | `data/rf` | 70 | minimal non-test working-tree changes |

The integration is pinned to SWE-Atlas commit
`6de82c3603fb9e254170b440d7560441eb257176`, Harbor `v0.18.0`, the
`moonshotai/kimi-k3` model, and `https://api.krater.ai/v1`.

## What is included

- `krater_agent.py`: a Harbor `BaseInstalledAgent` implementation.
- `agent_core.py`: validated model, endpoint, task, artifact, and telemetry
  contracts with no Harbor dependency.
- `prepare_task.py`: copies official tasks without changing the upstream
  checkout and applies a strict agent-phase network policy.
- `config/{qa,tw,rf}.yaml`: reproducible Docker job configurations.
- `agent_entry.ts` and `build_bundle.sh`: build a self-contained benchmark
  entrypoint that accepts a temporary key file rather than an API-key
  environment variable.
- `payload_verify.mjs`: verifies the uploaded bundle and exact skills payload
  before inference.
- `run_smoke.sh`: one deterministic task from a selected track.
- `run_category.sh`: an explicitly cost-gated complete track.
- `tests/` and `test_offline.sh`: no-network, no-inference validation.
- `VALIDATION.md`: dated evidence and explicit boundaries of the latest
  adapter-validation pass.

## Security and fidelity

The API key is accepted only through the host Harbor process's
`KRATER_API_KEY` environment variable. It is deliberately absent from every
`AgentConfig.env` block. Harbor v0.18 scopes `AgentConfig.env` across every
agent setup/run `exec`, so that channel would expose the key to tool
subprocesses. Instead, the custom agent reads the host value directly, writes a
host mode-`0600` temporary file, uploads and secures a remote mode-`0600` file,
and passes only that path to the benchmark entrypoint. The entrypoint reads and
unlinks the file before constructing `AgentSession`; tool subprocesses inherit
neither the value nor a readable handoff file. The key is never put in a
command, bundle, task copy, job config, or result file.

`prepare_task.py` changes only the copied task's `[agent]` network policy:

1. If the official task already has an allowlist, every official host is kept.
2. `api.krater.ai` is added exactly once.
3. A task with public networking is restricted to `api.krater.ai`.

This means model traffic can reach Krater while SWE-Atlas package-registry and
toolchain exceptions remain available only where the official task declared
them. The adapter does not install packages or download a runtime during a
trial. Each image must already contain `^20.19.0 || >=22.12.0`; Node 21 and
Node 22.0–22.11 fail setup before inference with an actionable error.

The repository's `skills/programming-languages` tree is uploaded beside the
bundle and discovered as Krater Pro's built-in skill catalog. This keeps expert
language guidance available without network access. Before inference, the
adapter verifies the bundle digest and a deterministic, symlink-free manifest
covering every skills file path, size, and digest.

The adapter discovers the repository without interpolating task text into a
shell command. Every trial requires a clean initial Git-visible repository and
records its starting HEAD. Q&A runs require the same final HEAD, an empty diff,
and no tracked or non-ignored untracked Git-visible changes. Test-writing and
refactoring runs diff the final working tree against the recorded starting
revision, so committed, staged, and unstaged edits are captured; untracked files
are added as binary-compatible no-index diffs. Ignored build caches are outside
this Git integrity assertion.

Task preparation also rejects a dirty or wrong-revision official SWE-Atlas
checkout. Generated bundles, prepared tasks, and Harbor results are ignored by
the adapter-local `.gitignore`.

## Prerequisites

- Node.js `^20.19.0 || >=22.12.0` on the host.
- Project dependencies installed with `npm install`.
- Docker with enough resources for the official task. SWE-Atlas task metadata
  requests 16 CPUs, 16,384 MiB memory, and 20,480 MiB storage.
- Official Harbor v0.18.0 installed.
- The official SWE-Atlas checkout at the pinned commit.
- `KRATER_API_KEY` exported in the shell.
- Judge credentials required by the official verifier:
  `OPENAI_API_KEY`, `OPENAI_API_BASE`, and optionally `EVAL_MODEL`.

No `.env` file is sourced by these scripts. This avoids unintentionally
exporting unrelated workspace secrets. You may load your `.env` into the shell
yourself before invoking the harness.

## Offline validation

From the Krater Pro repository root:

```bash
bash benchmarks/swe_atlas/test_offline.sh
```

This uses Harbor v0.18's actual Python classes for a mocked custom-agent
lifecycle. It checks host-only secret handoff, absence of key material from
executed commands/environments, remote payload-digest enforcement,
network-policy transformation, closed model/endpoint contracts, artifact
instructions, workspace/revision discovery, telemetry parsing, checkout
cleanliness, overwrite safety, and Python/JavaScript syntax. It does not call
Krater, Docker, a judge, or any paid service.

## Build the agent payload

```bash
bash benchmarks/swe_atlas/build_bundle.sh
export KRATER_PRO_BUNDLE="$PWD/benchmarks/swe_atlas/.artifacts/krater-pro.mjs"
```

The bundle contains Krater Pro's provider, agent loop, tools, safety controls,
and runtime dependencies behind the key-file-only benchmark entrypoint. Harbor
uploads this local file directly to each task image, so `npm install` is not
needed inside the benchmark.

## One-task Docker smoke runs

Set the official checkout and key without printing the key:

```bash
export SWE_ATLAS_ROOT=/absolute/path/to/SWE-Atlas
export KRATER_API_KEY=your_key
export OPENAI_API_KEY=your_judge_key
export OPENAI_API_BASE=https://your-judge-endpoint/v1
```

Run one deterministic smoke per category:

```bash
bash benchmarks/swe_atlas/run_smoke.sh qa
bash benchmarks/swe_atlas/run_smoke.sh tw
bash benchmarks/swe_atlas/run_smoke.sh rf
```

The selected task IDs are:

- Q&A: `task-6905333b74f22949d97ba9cc`
- Test Writing: `task-6902ef3ab97fe23e2ad2722c`
- Refactoring: `task-69d196f015a150488265afc2`

Pass another official task ID as the second argument to select it explicitly:

```bash
bash benchmarks/swe_atlas/run_smoke.sh tw task-6902ef3ab97fe23e2ad27279
```

The scripts validate Harbor's version and the upstream commit before starting.
They replace only `task-*` directories inside that track's ignored `.work`
directory, preventing a prior smoke selection from leaking into the next run.
They do not pull or run anything until invoked.

## Complete-category runs

A full run is intentionally gated because it can pull many large images and
consume substantial Krater and judge tokens:

```bash
export SWE_ATLAS_CONFIRM_FULL=YES
export HARBOR_CONCURRENCY=1
bash benchmarks/swe_atlas/run_category.sh qa
bash benchmarks/swe_atlas/run_category.sh tw
bash benchmarks/swe_atlas/run_category.sh rf
```

Raise concurrency only after confirming Docker or the configured execution
backend has the required aggregate CPU, memory, and storage.

## Results and interpretation

Harbor stores jobs under `benchmarks/swe_atlas/results/<track>/`. Inspect each
trial's verifier reward together with:

- `agent/krater-pro.txt`: sanitized CLI transcript and usage lines.
- `agent/answer.txt`: Q&A answer submitted to the official judge.
- `agent/manifest.txt`: Test Writing manifest submitted to the verifier.
- `agent/submission.diff`: Test Writing/Refactoring patch, including untracked
  files.
- `agent/submission.status`: final Git status.
- `agent/setup/bundle.sha256`: exact Krater Pro payload identity.
- `agent/setup/skills.sha256`: deterministic identity of the complete skills
  file set.
- `agent/setup/payload-manifest.json`: the file-level sizes and hashes enforced
  inside the task image before inference.

Passing the offline tests proves adapter contracts only. It does not constitute
an SWE-Atlas score. Report benchmark grades only from completed official Harbor
verifier results, including failures and the exact task count attempted.

## Known constraints

- The official task images are large and many request more memory than a
  default Docker Desktop allocation.
- Official verifiers use an external judge, so a valid judge endpoint is
  separate from the Krater model key.
- The single-file bundle still requires a compatible Node runtime in the task
  image. This is deliberate: broadening a restricted task allowlist merely to
  download an agent runtime would weaken benchmark isolation.
- No paid inference is performed by build or offline validation commands.
