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
| `-y, --yes` | Automatically approve mutations and commands |
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
- `/contract`: show the latest outcome contract;
- `/assumptions`: show recorded assumptions;
- `/evidence`: show the latest evidence verdict and gaps;
- `/why`: show claims and the known gaps behind the latest verdict;
- `/publish`: publish the most recent reviewed ProofPatch, asking before
  accepting any evidence gaps;
- `/rollback`: discard the most recent staged ProofPatch or restore its
  published files; and
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
krater task show <task-id>
krater task publish <task-id>
krater task publish <task-id> --accept-gaps
krater task cancel <task-id> [--reason <text>]
krater task rollback <task-id>
```

The gap-acceptance flag is required only when non-publication evidence gaps
remain. `--yes` approves individual tool calls; it does not publish a reviewed
transaction or accept evidence gaps. The process exits nonzero on
configuration/provider/runtime errors.

Before provider selection or staging, Krater performs bounded repository
ambiguity preflight. Unique referenced filenames are resolved and recorded
without interruption; physically distinct matches and explicit divergent
alternatives are ranked. With `--assume ask`, an interactive invocation asks
one highest-value question. If stdin is non-interactive, or `--json` is used,
Krater instead persists the task in `clarification`, writes one
`clarification_required` JSON object, performs no provider call or staging,
and exits `3`. `--assume best` records the selected best-judgment assumption
as unresolved so the agent must verify it during discovery.

## Evidence-native commands

```sh
krater task run <prompt...>
krater task list
krater task show <task-id>
krater task resume <task-id>
krater task cancel <task-id> [--reason <text>]
krater task publish <task-id> [--accept-gaps]
krater task rollback <task-id>

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
krater lab replay --input <sealed-evaluation.json>
krater lab calibrate --input <promotion-evaluation.json>
krater cache stats
krater cache prune
```

`task resume` reconstructs the contract and evidence state, not the private
model transcript. `task cancel` first discards an attached staged ProofPatch,
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
extra. `lab replay` scores a sealed recorded evaluation, while `lab calibrate`
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
- Missing credentials explain all supported configuration paths.
- HTTP 401, 403, and 429 responses receive specific actionable messages.
- Abort signals cancel provider streaming.
- A repeated tool loop stops at the configured step bound.
- Non-success provider finish reasons and session/output token ceilings stop
  honestly instead of presenting a truncated answer as complete.
- A denied action returns a tool result to the model so it can adapt.
- Clearly destructive commands remain blocked under `--yes`.
