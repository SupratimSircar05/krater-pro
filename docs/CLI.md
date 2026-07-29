# CLI reference

Both installed entry points run the same CLI:

```sh
krater
krater-pro
```

## Global options

| Option | Meaning |
| --- | --- |
| `-k, --api-key <key>` | One-invocation Krater key; avoid where shell history is retained |
| `--base-url <url>` | Krater-compatible OpenAI API root |
| `-m, --model <id>` | `auto` for Smart Router, or an exact Krater model ID |
| `-C, --cwd <path>` | Workspace root |
| `-y, --yes` | Automatically approve file mutations; run model commands only through verified, fail-closed unattended containment |
| `--context-chars <n>` | Estimated request-context character budget |
| `--tool-output-chars <n>` | Retained characters per tool result |
| `--response-style <style>` | `concise` or `standard` |
| `--max-steps <n>` | Bounded model/tool turns, 1 through 128 |
| `--max-output-tokens <n>` | Per-response generation ceiling |
| `--session-token-budget <n>` | Stop before another request after the reported session total |
| `--assurance <level>` | Evidence contract: `fast`, `standard`, or `high` |
| `--max-cost-usd <amount>` | Quote a positive USD ceiling; actual-spend enforcement is not connected yet |
| `--max-time <duration>` | Abort a one-shot task after an `ms`, `s`, `m`, or `h` duration |
| `--assume <mode>` | `ask` requests the highest-value divergent decision; `best` records a deterministic best-judgment assumption |
| `--json` | Emit JSON preflight/contract/patch/verdict records; streamed agent output can still share stdout after execution starts |
| `-V, --version` | Product version |
| `-h, --help` | Help |

## Interactive mode

Run without a prompt:

```sh
krater
```

The header reports model mode, workspace, and key source without printing the
key. In automatic mode, each evidence task emits a compact routing audit before
the model response. Commands:

- `/help`: show the short command card;
- `/clear`: clear any active task context before the next prompt;
- `/understood`: show the latest outcome contract (`/contract` remains an
  alias);
- `/plan`: show the current versioned executable plan;
- `/assumptions`: show recorded assumptions;
- `/proof`: show the latest evidence verdict and gaps (`/evidence` remains an
  alias);
- `/why`: show claims and the known gaps behind the latest verdict;
- `/publish`: publish the most recent reviewed ProofPatch, asking before
  accepting any evidence gaps;
- `/ship`: report structured GitHub/Cloudflare adapter readiness without
  discovering ambient credentials or executing a raw-shell deployment;
- `/watch`: show the locally recorded Proof Lease and production-observation
  snapshot without claiming background monitoring;
- `/undo`: discard the most recent staged ProofPatch or restore its published
  files (`/rollback` remains an alias); and
- `/exit` or `/quit`: close cleanly.

Streaming text is printed immediately. Tool calls show their name and compact
arguments. Read-only actions run immediately. Mutations display an approval
question with a default of No.

Evidence-mode interactive prompts are independent durable tasks. A completed
prompt does not silently become model context for the next prompt, and
automatic routing runs for each new task. `/clear` discards any active
ephemeral task context; an explicit `--model <id>` remains the hard override.

## One-shot mode

```sh
krater "Review the current diff"
```

When stdin is non-interactive, protected actions are denied unless `--yes` was
explicitly supplied. Model edits and commands execute with an isolated
copy-based workspace as their root. If a change is justified, the turn prints
a complete ProofPatch preview and leaves the base workspace unchanged in
`review`.

Review and publish separately:

```sh
krater task plan <task-id>
krater task approve <task-id> --plan-digest <sha256-digest>
krater task verify <task-id>
krater task show <task-id>
krater task publish <task-id>
krater task publish <task-id> --accept-gaps
krater task cancel <task-id> [--reason <text>]
krater task rollback <task-id>
krater task watch <task-id>
```

The gap-acceptance flag is required only when non-publication evidence gaps
remain. `--yes` approves individual tool calls; it does not publish a reviewed
transaction or accept evidence gaps. The process exits nonzero on
configuration/provider/runtime errors.

`--yes` does not turn commands into unrestricted background shell access. On
macOS the current unattended `run_command` path permits shell builtins only
after live native-containment probes; external programs and subprocess-based
builds fail closed and require a later, explicit attended approval. Linux does
not yet ship a verified native unattended adapter, so model commands fail
closed there. File tools remain bounded to the staged workspace.

Before provider selection or staging, Krater performs bounded repository
ambiguity preflight. Unique referenced filenames are resolved and recorded
without interruption; physically distinct matches and explicit divergent
alternatives are ranked. With `--assume ask`, an interactive invocation asks
one highest-value question. If stdin is non-interactive, or `--json` is used,
Krater instead persists the task in `clarification`, writes one
`clarification_required` JSON object, performs no provider call or staging,
and exits `3`. `--assume best` records the selected best-judgment assumption
as unresolved so the agent must verify it during discovery.

## Setup and local diagnostics

```sh
krater setup
krater setup --replace
krater setup --project /path/to/project --default-assurance standard
KRATER_API_KEY=... krater setup --non-interactive --no-open
krater setup --env-fallback
krater doctor
krater doctor --json
krater doctor --live
```

`setup` inspects the selected workspace and can open the official Krater
developer page. In a terminal it reads the key with terminal echo disabled,
validates it using authenticated model discovery, and only then offers an OS
credential backend. Credential values are sent to macOS Keychain or Linux
Secret Service through standard input, never process arguments.

If secure storage is unavailable or declined, setup explains the plaintext
owner-only `.env` tradeoff and asks separately. `--env-fallback` explicitly
selects that choice. `--non-interactive` validates `KRATER_API_KEY` without
persisting it, prompting, or opening a browser. `--create-env` creates only an
empty private template. Until a credential is configured, setup returns a
`setup_required` result and exits `4`.

`--replace` starts hidden input even when a credential is configured. The old
value remains usable unless the replacement validates and persists.

`--project` selects an existing directory for this setup run.
`--default-assurance` persists the non-secret `fast`, `standard`, or `high`
trust dial under that project's protected `.krater/` state only after
credential validation. Per-invocation `--assurance` and `KRATER_ASSURANCE`
still take precedence.

`doctor` makes no network request by default. It checks the supported Node
version, workspace access, safely loaded configuration, credential presence and source,
`.env` permissions, Git availability, fail-closed containment posture, local
ProofGraph/ProofPatch initialization, and completion generation. JSON output is
a single versioned object and never contains the credential value. A configured
credential is reported as unverified; evidence storage is detected but its
artifacts are not verified by this command.

`doctor --live` is the explicit authenticated exception. It runs model
discovery, reports the `live_credential_verification` scope, and fails closed
when access cannot be established.

## Shell completion

```sh
krater completion bash
krater completion zsh
krater completion fish
```

Each command prints a deterministic completion script to stdout and requires no
credential or network access. Homebrew can install these automatically; manual
paths are documented in [INSTALLATION.md](INSTALLATION.md).

## Evidence-native commands

```sh
krater task run <prompt...>
krater task list
krater task show <task-id>
krater task plan <task-id>
krater task approve <task-id> --plan-digest <sha256-digest> [--reason <text>]
krater task resume <task-id>
krater task verify <task-id>
krater task cancel <task-id> [--reason <text>]
krater task publish <task-id> [--accept-gaps]
krater task rollback <task-id>
krater task watch <task-id>

krater proof show <task-id>
krater proof verify <task-id>
krater proof export <task-id> --format markdown [-o <path>]
krater proof export <task-id> --format json [-o <path>]

krater intent init [--namespace <name>]
krater intent add --kind <kind> --statement <text>
krater intent check
krater intent retire <intent-id> --reason <text> \
  (--replacement <intent-id> | --owner-decision <id>)

krater policy simulate <exact flow coordinates>
krater policy explain <exact flow coordinates>
krater debug causal --input <recorded-causal-run.json>
krater debug causal-live --input <live-causal-plan.json>
krater lab replay --input <sealed-evaluation.json>
krater lab calibrate --input <promotion-evaluation.json>
krater cache stats
krater cache prune
```

`task resume` reconstructs the contract and evidence state, not the private
model transcript. `task plan` shows the current versioned executable plan,
including its exact digest and proof obligations. `task approve` records a new
user-approved revision only when `--plan-digest` still matches; a concurrent
revision fails closed, and repeating approval of the current approved digest is
idempotent.

`task verify` is deliberately an offline integrity check over the recorded
plan, evidence capsule, Change Passport, proof obligations, and Proof Leases.
It does not execute repository tests or a sealed verifier. Its result says
`incomplete` and exits `2` when required durable evidence is missing, rather
than implying that checks ran. `task watch` likewise returns one local snapshot
of recorded Proof Leases and production observations. It reports
`unmonitored`, `needs_recheck`, `contradicted`, or `verified`, and explicitly
does not start a background production poller.

`task cancel` first discards an attached staged ProofPatch,
then writes a `cancelled` capsule and passport. It refuses a published
transaction and points to `task rollback`; cancellation never implicitly
reverses published files. It also refuses publication-in-progress and already
terminal `complete`, `abstained`, `blocked`, or `accepted_with_gaps` tasks.
Rolling a published transaction back restores file bytes with conflict
protection, preserves the historical final verdict, marks publication evidence
stale, and regenerates the passport with a current-workspace gap. See
[evidence-native.md](evidence-native.md) for exact storage, assurance,
publication, policy, and non-claim boundaries.

`debug causal` is a recorded-outcome adapter, not an unrestricted process
runner. Its JSON input must contain a Causal Twin `plan` plus the exact ordered
`executions` produced elsewhere; it fails closed when outcomes are missing or
extra.

`debug causal-live` is the separately named local execution path. It accepts
only structured Node.js or Python entrypoints and arguments—never a shell
command string. Every entrypoint and working directory must resolve to an
exact, non-symlink, workspace-relative path. Krater verifies the plan's
workspace digest before and after the run, rejects credential-shaped arguments
and sensitive environment names/values, bounds time and output, denies network
and writes, and executes unattended only when the native adapter verifies every
required containment control. The initial production adapter is macOS-only;
Linux fails closed until its native supervisor ships. Put the
input artifact outside the selected workspace source manifest (or below the
ignored `.krater/` state directory) so writing the plan does not change the
digest it declares.

The live path does not instrument a runtime, inject a value, force a branch, or
stub a function. The caller supplies each complete invocation and prediction.
An intervention marked `isolated` is accepted only when `changedInputs`
exactly names the differences from the baseline invocation; a causal label is
then possible only if deterministic replay and the predicted outcome change
both occur.

`lab replay` scores a sealed recorded evaluation, while `lab calibrate`
evaluates the five-point/no-regression promotion gate. Neither lab command
executes fixtures or persists a candidate promotion.

## Model discovery

```sh
krater models
```

This performs authenticated `/v1/models` discovery and prints exact IDs, one per
line. Example:

```text
moonshotai/kimi-k3
```

The `models` command still works while the configured model is `auto`; it uses a
real catalog-capable provider internally and never sends `auto` as a completion
model ID.

## Account setup

```sh
krater setup
krater doctor
krater doctor --live
krater auth login
krater auth login --no-open
krater auth status
```

This is a safe browser handoff, not OAuth or session extraction. See
[AUTHENTICATION.md](AUTHENTICATION.md).

## GUI server

```sh
krater web
krater web --port 8080
```

Only `127.0.0.1`, `localhost`, and `::1` are accepted. Source-checkout
development uses `npm run dev:web`; packaged installs serve the built GUI.

## Exit and error behavior

- A clarification-required non-interactive task exits `3` after writing its
  structured question and durable task ID, before any provider call.
- A missing credential emits `setup_required`, points to the supported
  configuration paths, performs no model call, and exits `4` once ambiguity
  preflight is ready. A divergent request can still exit `3` first so its
  clarification remains durable without spending provider tokens.
- `doctor` exits `0` when locally ready, `4` when setup is required, and `1`
  for runtime, workspace, malformed-configuration, or explicit live-
  verification issues.
- HTTP 401, 403, and 429 responses receive specific actionable messages.
- Abort signals cancel provider streaming.
- A repeated tool loop stops at the configured step bound.
- Non-success provider finish reasons and session/output token ceilings stop
  honestly instead of presenting a truncated answer as complete.
- A denied action returns a tool result to the model so it can adapt.
- Clearly destructive commands remain blocked under `--yes`.
