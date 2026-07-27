# Krater Pro × SWE-bench Pro

This adapter runs Krater Pro against the official open-source
[SWE-bench Pro](https://github.com/scaleapi/SWE-bench_Pro-os) evaluator contract.
It is pinned to the audited upstream revision and defaults to a read-only plan.
No Docker image is pulled and no paid model request is made unless the operator
chooses explicit runtime flags.

## Audited contract

| Item | Pin |
| --- | --- |
| Upstream revision | `ca10a60a5fcae51e6948ffe1485d4153d421e6c5` |
| Dataset | `helper_code/sweap_eval_full_v2.jsonl` (731 instances) |
| Dataset SHA-256 | `b5b2462bfbf5aeb2cb7ba7d215778a1768b85f9d7ad7f748546c7f80a0ad1510` |
| Evaluator SHA-256 | `bb5d4c5486be296e464e695df3747064aaa3bb197394bc6d39980634afec2034` |
| Image helper SHA-256 | `d1a858866dd2622c0e37986dd7b86698e5ea53546f30901d1bf0d6ba1b97384f` |
| Model | `moonshotai/kimi-k3` |
| Endpoint | `https://api.krater.ai/v1` |
| Node runtime layer | `node:20.19.5-bookworm-slim` |
| Docker platform | `linux/amd64` |

The default smoke target is the relatively small Ansible instance:

```text
instance_ansible__ansible-9a21e247786ebd294dafafca1105fcd770ff46c6-v67cdaa49f89b34e42b69d5b7830b3c3ad3d8803f
```

Its official image is derived with the same tag algorithm used by
`helper_code/image_uri.py`. The harness adds only a pinned Node runtime, the
self-contained Krater Pro bundle, and the product's programming skills. The
repository and test environment remain those from the official instance image.
Resolved Docker image IDs and repository digests are written to every run
manifest, so an exact execution can be audited even though the upstream dataset
publishes image tags rather than immutable digests.

Before any plan or run, the adapter also requires the checkout's evaluator,
dataset, image helper, complete `run_scripts` tree, and instance-Dockerfile tree
to be clean at the pinned Git revision. The selected instance's run script,
parser, and Dockerfile must be regular Git-tracked files. Unrelated files
outside those evaluator inputs do not invalidate the checkout.

## Safety and cost gates

- Plan-only is the default.
- Paid inference requires `--execute`.
- Missing images are never downloaded unless `--pull` is also explicit.
- `--infrastructure-only` builds and starts the image, verifies the repository
  and Krater Pro runtime, and stops without model inference.
- The API key is accepted only from `KRATER_API_KEY`. There is deliberately no
  `--api-key` option.
- The key is streamed over `docker exec` stdin to a mode-`0600` file in the
  ephemeral container. The entrypoint reads and unlinks it before constructing
  the agent, so it never reaches argv, Docker environment metadata, image layers,
  tool subprocess environments, logs, or artifacts.
- Model and endpoint are hard-pinned to exact Kimi K3 through Krater.
- The container has explicit CPU, memory, PID, capability, and runtime bounds.
- Agent telemetry is structured, redacted, and capped at 1 MiB. Patches are
  capped at 16 MiB and binary patches are rejected.
- The container is always removed in `finally`, including timeout and failure.
- The official evaluator runs one worker with test-container networking blocked.
- Agent image cache keys hash the entire material build context (bundle,
  Dockerfile, and all skills), the platform/build arguments, and the immutable
  resolved IDs of both the official instance image and Node image. A changed
  skill, Dockerfile, bundle, or base image cannot silently reuse a stale image.
- Evaluation retries accept only self-consistent run artifacts whose official
  pins, instance metadata, prediction, compatible prediction, patch bytes,
  byte count, and SHA-256 all verify before Docker is touched.
- If the outer official evaluator times out, cleanup considers only containers
  created after that evaluator started, then additionally requires the exact
  official image, entrypoint/command, and run-specific `/workspace` bind mount.
  Removed, skipped, and failed cleanup IDs are recorded in `run.json`.

The generation container needs outbound HTTPS for the Krater request. Docker
does not provide a portable per-host egress allowlist, so the prompt and tool
policy prohibit network commands while the provider is fixed to
`api.krater.ai`. Run this harness only on a Docker host whose own egress policy
allows that endpoint and blocks destinations you do not trust.

## Plan and preflight

Show the reproducible plan without touching Docker:

```bash
python3 benchmarks/swe_pro/run_swe_pro.py
```

Also inspect Docker resources, still without building, pulling, or inference:

```bash
python3 benchmarks/swe_pro/run_swe_pro.py --preflight
```

The default instance needs a 6 GiB container limit. On Apple Silicon, the
official `linux/amd64` image runs under emulation and will be slower.

## Infrastructure smoke (no inference)

This only works without downloads when both the official instance image and
`node:20.19.5-bookworm-slim` are already local:

```bash
python3 benchmarks/swe_pro/run_swe_pro.py --infrastructure-only
```

To explicitly permit those image downloads:

```bash
python3 benchmarks/swe_pro/run_swe_pro.py \
  --infrastructure-only \
  --pull
```

The known Ansible image is roughly hundreds of MiB compressed. Other official
instances can be much larger. Review free disk space before using `--pull`.

## One paid generation

Export the key into the runner process, then request the exact smoke instance:

```bash
export KRATER_API_KEY='your-key'
python3 benchmarks/swe_pro/run_swe_pro.py \
  --execute \
  --pull \
  --output-dir benchmarks/swe_pro/results/ansible-smoke
```

The adapter intentionally does not read the project `.env` itself. If the key
is stored there, export it into the shell using a trusted local mechanism before
running the harness. Never paste a key into command history.

Generation produces:

- `run.json`: pins, resolved images, limits, durations, state, and result;
- `telemetry.jsonl`: bounded tool and token events without model prose;
- `agent.stderr.txt`: bounded and key-redacted diagnostic output;
- `submission.diff`: the patch against the official base commit;
- `predictions.json`: the official evaluator input schema;
- `official-raw-sample.jsonl`: the validated one-row evaluator input, when used;
- `<instance>/<instance>.pred`: SWE-agent/gather-patches compatible prediction.

`run.json` also records the full build-context digest, immutable Node and
instance image IDs, and complete official-evaluation attempt history. The patch
record is flushed before the generation container is removed, so a later
evaluation does not require another paid model call.

## Official evaluation

Use `--evaluate` to invoke the pinned upstream `swe_bench_pro_eval.py` after
generation:

```bash
export KRATER_API_KEY='your-key'
python3 benchmarks/swe_pro/run_swe_pro.py \
  --execute \
  --pull \
  --evaluate \
  --output-dir benchmarks/swe_pro/results/ansible-official
```

`--evaluate` requires `--pull` because the current official local-Docker
evaluator unconditionally calls `client.images.pull(...)`, even when the tag is
already local. The adapter does not patch that behavior. Official stdout,
stderr, per-test artifacts, and `eval_results.json` are retained under the run
directory.

The pinned evaluator reads lowercase `fail_to_pass`/`pass_to_pass` cells and
calls `eval()` on string values, while the pinned bundled JSONL uses uppercase
keys and mixed list/string values. The adapter therefore writes a one-row
`official-raw-sample.jsonl` containing only the required public fields, with
validated test-name lists encoded canonically. The upstream evaluator itself is
left byte-for-byte unchanged and its SHA-256 is checked before every run.

Install the upstream evaluator dependencies in an isolated environment before
using this mode:

```bash
python3 -m venv .krater/venvs/swe-pro
. .krater/venvs/swe-pro/bin/activate
pip install -r /private/tmp/krater-pro-evals/SWE-bench_Pro-os/requirements.txt
```

The upstream evaluator currently does not expose Docker CPU/memory flags. The
adapter performs a resource preflight and bounds its outer process, but it calls
the evaluator unchanged for score compatibility.

### Evaluate an existing patch without inference

If generation completed but evaluation was skipped, interrupted, or could not
start because its Python dependencies were missing, evaluate the verified run
directory without calling Krater again:

```bash
python3 benchmarks/swe_pro/run_swe_pro.py \
  --evaluate-existing benchmarks/swe_pro/results/ansible-smoke \
  --pull
```

This mode does not read `KRATER_API_KEY`, build or start the Krater agent image,
or perform model inference. `--pull` remains mandatory because the unchanged
pinned evaluator always attempts to refresh its official test image. Supplying
`--instance` is optional; when present it must exactly match the run manifest.
`--output-dir` is deliberately rejected because the passed run directory is the
only artifact root. The run directory must be owned by the current user and
must not be group- or world-writable; all protected artifacts are verified
again immediately after preflight and before evaluator use.

Every retry gets a new non-overwriting artifact set:
`official-evaluation[-N]/`, `official-raw-sample[-N].jsonl`, and bounded
`official-evaluator[-N].{stdout,stderr}.txt`. The top-level status reflects the
latest attempt, while `official_evaluation_attempts` retains the complete
passed, failed, or infrastructure-error history.

## Offline validation

These checks do not pull images or call Krater:

```bash
python3 -m unittest benchmarks.swe_pro.test_run_swe_pro -v

node --import tsx benchmarks/swe_pro/agent_entry.ts --version

node_modules/.bin/esbuild benchmarks/swe_pro/agent_entry.ts \
  --bundle \
  --platform=node \
  --format=esm \
  --target=node20.19 \
  --banner:js='import { createRequire as __kraterCreateRequire } from "node:module"; const require = __kraterCreateRequire(import.meta.url);' \
  --outfile=/tmp/krater-pro-swe-pro-agent.mjs
node /tmp/krater-pro-swe-pro-agent.mjs --version
```

## Current local blockers

The adapter can be validated completely offline, but an official run cannot be
claimed until all of the following are intentionally supplied:

1. the official instance and Node runtime images (or permission to `--pull`);
2. sufficient Docker disk, at least 6 GiB allocated memory, and `linux/amd64`
   emulation on Apple Silicon;
3. `KRATER_API_KEY` and approval for paid Kimi K3 inference;
4. isolated Python dependencies for the unchanged official evaluator;
5. time and spend budgets before scaling beyond the single smoke instance.

Passing the infrastructure smoke proves the container/runtime integration only.
Passing `eval_results.json` from the pinned evaluator proves the benchmark case.
