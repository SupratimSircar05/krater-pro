# Evidence-native foundation

Krater Pro is evolving toward a local-first IDE that does not call work
complete without replayable evidence. This document describes the foundation
that is present in this source tree. It is a status document, not a statement
that the nine-month Evidence-Native IDE roadmap is complete.

The current implementation provides:

- a durable, hash-chained ProofGraph event store;
- conservative evidence capsules and Change Passports;
- a host-enforced Action/Abstention Gate before model-proposed file edits;
- outcome contracts, an integrated bounded ambiguity preflight, and
  living-intent libraries;
- opt-in, version-controlled `.krater-intent/` artifacts;
- a journaled ProofPatch transaction engine and copy-based staging bridge;
- exact-label policy simulation and a persistent verified-cache library;
- an Evidence view with staged publish/discard/rollback controls and
  read/mutation `/api/v2` task endpoints;
- selective-jury, merge-forecast, causal-debugging, reliability-promotion,
  mastery, and sandbox-supervisor foundations, with recorded-artifact CLI/API
  adapters for causal and reliability evaluation; and
- 100 deterministic evidence-foundation microbenchmarks with sealed checkers.

Several of those foundations are not yet connected to the normal agent flow.
The [current limitations](#current-limitations) section is normative when it
conflicts with broader roadmap language.

## Task lifecycle

ProofGraph recognizes the durable lifecycle:

```text
intake
  → discovery
  → clarification
  → reproduction
  → staging
  → verification
  → review
  → publication
  → complete
```

It also recognizes these terminal outcomes:

- `abstained`: the recorded gate supports a no-code-change outcome;
- `blocked`: required authority or evidence could not be established;
- `accepted_with_gaps`: publication was explicitly accepted despite recorded
  evidence gaps;
- `cancelled`: execution stopped without a clean completion verdict.

The state-transition validator rejects skipped or backward active-state
transitions. A task may move to `blocked`, `abstained`, or `cancelled` from an
active state, and only verification/review/publication may become
`accepted_with_gaps`.

The CLI, a server started with `krater web`, and the Electron desktop launcher
enable evidence mode. Direct library embedders must opt in through
`ServerOptions.evidenceMode` during the compatibility release.

## ProofGraph

`src/proofgraph/` stores an append-only event stream at:

```text
.krater/proofgraph/events.ndjson
```

Every stored event contains a sequence number, task ID, event kind, canonical
payload, previous-event hash, and its own SHA-256 hash. The store:

- serializes appends through a private lock;
- validates task identity and state transitions before append;
- rebuilds task projections from events rather than trusting a mutable index;
- detects incomplete JSON, invalid events, sequence gaps, broken previous-hash
  links, and content-hash mismatches;
- refuses further trusted reads or appends after a corrupt tail; and
- creates protected, non-symlink state paths.

Supported event payloads currently cover task creation/state, contracts,
intent, actions, evidence, claims, capsules, and passports. The store also
contains a content-addressed object store under
`.krater/proofgraph/cas/`. CAS objects are verified on read and text-like
content is redacted before persistence. The current task runtime records its
primary events inline; it does not yet move all large artifacts into the CAS.

Hash chaining detects accidental or deliberate modification after the first
trusted hash. It is not an identity signature, transparency log, remote
attestation, or proof that the originating tool was honest.

## Outcome contracts and the Action/Abstention Gate

Each evidence task starts with a local outcome contract. It contains the
request, one selected interpretation, assumptions, acceptance criteria,
non-goals, assurance, budgets, permitted capability names, required checks,
negative guarantees, and creation time.

The implemented assurance profiles are:

| Assurance | Default budget | Required checks |
| --- | --- | --- |
| `fast` | $0.25, 40,000 tokens, 5 minutes, 12 tool steps | workspace digest and a targeted check |
| `standard` | $2, 200,000 tokens, 30 minutes, 50 tool steps | fast checks plus typecheck, tests, secret scan, and conflict check |
| `high` | $10, 1,000,000 tokens, 2 hours, 200 tool steps | standard checks plus independent verification, mutation/property, security, and rollback checks |

These figures are contract defaults, not a claim that every limit is enforced
end to end. `--max-time` currently aborts a one-shot CLI task. Existing agent
step and session-token limits still apply. The evidence runtime records
`--max-cost-usd`, but the provider path does not yet calculate and stop on
actual USD spend. Unperformed assurance checks remain visible as gaps.

In evidence mode, `write_file` and `replace_in_file` are rejected until the
model calls `record_action_gate`. The gate must cite successful tool-call IDs
from the current user turn. Invented, failed, prior-turn, or missing references
are rejected by the host. Its outcomes are:

- `change_required`;
- `partial_fix_requires_change`;
- `configuration_documentation_or_user_action`;
- `already_satisfied_no_change`;
- `cannot_establish_safely`.

Only the first two authorize a publishable file edit. A supported no-change
decision is recorded as a valid `abstained` result. A missing gate, conflicting
evidence, or an unsafe/unknown result blocks a clean completion.

The gate is deliberately narrower than a capability approval. It decides
whether an edit is justified. Ordinary Allow/Deny approval still decides
whether an otherwise justified edit or command may execute.

### Ambiguity preflight

`src/intent/ambiguity.ts` normalizes candidate interpretations, detects
implementations that converge, and ranks remaining questions by:

```text
(impact × risk × irreversibility) / question cost
```

`src/ambiguity-preflight.ts` connects that ranking to CLI evidence tasks before
model selection or staging. It performs a metadata-only repository scan
bounded to 2,000 entries, discovers manifests and referenced paths, resolves a
bare filename when it has one repository match, and asks when that name has
multiple physically distinct matches. Symlink aliases resolving to one
physical target converge and do not interrupt. Explicit `either … or …`
alternatives are also ranked.

With `--assume ask`, an interactive invocation asks only the highest-value
question and records the selected interpretation as a user-resolved
assumption. A non-interactive invocation, or any invocation using `--json`,
does not call the provider or create a staging workspace when clarification is
required. It persists the task in `clarification`, emits a
`clarification_required` JSON object containing the choices, repository facts,
and task ID, and exits with status `3`.

With `--assume best`, Krater chooses the first interpretation of the
highest-ranked ambiguity deterministically, records it as an unresolved agent
assumption, and adds that context to the execution prompt for verification
during repository discovery.

This is a conservative preflight, not a general semantic parser for every form
of underspecification. It does not yet calibrate useful-question rates from
outcomes, ask a sequence of dependent questions, or expose a v2 API for
answering and resuming a task left in `clarification`.

## Living intent

Two related intent representations exist:

1. Per-task `IntentNode` events in ProofGraph.
2. An explicitly initialized, human-readable `.krater-intent/` directory for
   shared source control.

Initialize the shared form only when wanted:

```sh
krater intent init
krater intent add \
  --kind invariant \
  --statement "API keys never enter exported evidence" \
  --stable-key secret-export-boundary
krater intent check
krater intent retire <intent-id> \
  --reason "Replaced by the scoped credential-handle invariant" \
  --replacement <replacement-intent-id>
```

Initialization creates:

```text
.krater-intent/
  manifest.json
  intents.json
```

IDs are deterministic within the selected namespace. Artifacts are normalized,
written atomically, rejected if symlinked or malformed, and checked against
known in-memory secret values. Retirement requires a reason and either a
different active replacement or an explicit owner-decision ID.

The graph validator reports duplicate IDs, missing sources or targets, missing
coverage, stale links, contradictions, and invalid retirement. Its in-memory
link model supports intent, symbol, file, test, schema, evidence, patch, and
commit targets.

The normal agent does not yet maintain all of those bidirectional links
automatically. The CLI currently exposes add/check/retire, but no CLI command
for adding links. ProofGraph task creation records the task requirement; it
does not yet produce full symbol-to-test semantic blame.

## Evidence grades, capsules, and passports

Krater Pro uses these grades in increasing order:

1. `not_established`
2. `observed`
3. `tested`
4. `stress_tested`
5. `formally_verified`

`formally_verified` is accepted only for `formal_proof` evidence with a
well-formed proof-artifact digest. A supported claim cannot declare a grade
higher than its strongest non-stale supporting evidence. A Change Passport
shows the weakest current evidence grade, so one weak obligation is not hidden
by an unrelated strong test.

The current runtime recognizes test, typecheck/static-analysis, security-scan,
and build-like commands using bounded command-name matching. Successful
recognized commands become `tested` evidence with origin `agent_author`.
Action-gate evidence is `observed`. This classification does not inspect test
quality, mutation score, mock use, branch coverage, or checker independence.
The Evidence view exposes every record's typed origin as repository, agent,
independent verifier, human, or host-tool evidence instead of presenting all
green checks as interchangeable.

An evidence capsule contains:

- the outcome contract and verdict;
- optional base/final workspace digests;
- changed-behavior and negative-guarantee statements;
- evidence and claims;
- gaps and approvals;
- prompt, completion, and cached-token counts; optional USD cost; and elapsed
  time;
- a canonical SHA-256 digest.

The Change Passport is a smaller review projection containing intent IDs,
changed paths, evidence grades, gaps, approvals, provenance labels, and the
capsule digest. JSON and Markdown exports are redacted before hashing.

Verify local integrity with:

```sh
krater proof show <task-id>
krater proof verify <task-id>
krater proof export <task-id> --format markdown -o passport.md
krater proof export <task-id> --format json -o passport.json
```

`proof verify` verifies canonical digests and evidence-grade invariants. It
does not yet verify an SSH/GPG signature, a build identity, SLSA compliance, or
third-party provenance.

## ProofPatch transactions

`src/proofpatch/` implements a journaled local transaction engine for regular
files. A transaction can preview and publish:

- create;
- edit;
- delete;
- move/rename.

Before publication, ProofPatch compares the current file existence, digest,
size, and mode with the captured base. A mismatch raises a conflict instead of
overwriting a concurrent edit. It writes same-directory temporary files,
maintains verified backups, records each applied change in a durable journal,
rolls back after publication errors, and can recover incomplete journal states
after a process interruption.

“Atomic” here means journaled all-or-rollback publication as implemented by the
transaction engine. A multi-file change cannot be made indivisible by the
underlying filesystem, so crash recovery and backup verification are part of
the guarantee.

The crash-recovery matrix injects every declared failure point before and
after each create, edit, delete, and two-step move/rename journal position. It
verifies exact intermediate state, file modes, restart recovery, complete base
restoration, reopened status, and idempotent second recovery.

`src/staging-workspace.ts` adds a bounded copy-based task workspace and creates
a task-to-transaction binding under `.krater/proofpatch/bindings/`. CLI tasks
and evidence-enabled browser sessions run model file edits and model commands
inside this isolated copy. The selected base workspace is unchanged until a
separate publish action succeeds. Dependencies that were not copied can be
made available to the staged command sandbox as read-only roots.

The bridge excludes private Krater state, dependency directories, build
output, and non-template `.env` files from publishable snapshots. It infers
unambiguous same-content moves and records unsupported paths rather than
silently skipping them.

### Publication integration status

CLI and evidence-enabled browser agent edits now run in the isolated staged
workspace. At the end of a change task, Krater computes base/final workspace
digests, prepares a complete ProofPatch preview and durable binding, removes
the temporary working copy, and leaves the task in `review`. It does not
publish merely because the user approved an individual tool call or supplied
`--yes`.

For the CLI, publication is a separate explicit action:

```sh
krater task show <task-id>
krater task publish <task-id>

# Required only when the reviewed passport still has evidence gaps:
krater task publish <task-id> --accept-gaps

# Discard a staged transaction or restore a published transaction:
krater task rollback <task-id>

# Cancel an unpublished task; an attached staged transaction is discarded first:
krater task cancel <task-id> [--reason <text>]
```

Without `--accept-gaps`, publication refuses when any non-publication gap
remains. Interactive `/publish` shows the gaps and asks for one explicit
confirmation; saying No leaves the base workspace unchanged. A successful
gap-free publish adds a tested ProofPatch receipt and ends `complete`.
Publication with explicit gap acceptance ends `accepted_with_gaps`.

Interactive `/rollback` and `task rollback` use the same durable ProofPatch
binding. Discarding a still-reviewed patch transitions the task to `cancelled`.
Rolling back a published patch preserves its historical `complete` or
`accepted_with_gaps` verdict, marks the old publication evidence stale, records
tested rollback evidence, clears the no-longer-present changed behavior, and
regenerates the capsule/passport with an explicit current-workspace gap. This
keeps the append-only historical verdict while preventing the passport from
implying that the published behavior is still present.

The staging bridge is currently copy-based for both Git and scratch projects;
it is not the planned detached Git-worktree implementation. A newly created
file whose parent directory does not already exist is reported as unsupported
by the bridge.

## Context labels, capabilities, and policy simulation

`src/trust/` can label context by:

- source: user, system policy, repository, local tool, external tool, or
  generated;
- trust: authoritative instruction, approved policy, or untrusted data;
- sensitivity: public, proprietary, PII, secret, or license-restricted;
- permitted destinations and operations.

Its fail-closed rules deny secret-to-model, secret-to-network,
untrusted-data-to-command, and license-restricted egress unless an exact
time-bounded capability carries the corresponding exception. Capability
operation, resource, and scope are exact; wildcards are rejected. Decisions
include a provenance path and remediation.

Try the simulator before model spend:

```sh
krater policy simulate \
  --operation execute \
  --resource npm-test \
  --scope workspace \
  --destination command \
  --source repository \
  --trust untrusted_data \
  --sensitivity public \
  --content "npm test"
```

Use `krater policy explain` with the same coordinates for the compact
human-readable decision. `POST /api/v2/policy/simulate` accepts the structured
simulation request.

This is currently a policy engine and simulator, not a complete context
firewall. The normal prompt assembler, provider calls, tool dispatcher,
ProofPatch, cache, and exports do not yet propagate and enforce labels at every
hop. Conversational approval cannot create a persistent policy, but a
user-authored policy-file format has not been added either.

## Verified Work Cache

`src/verified-cache/` is a local content-addressed JSON cache. Keys cover
declared source, configuration, toolchain, environment, policy, and dependency
inputs. Entries support:

- TTL expiration;
- caller-supplied validation;
- object-digest verification;
- exact descriptor and proof-dependency matching;
- targeted invalidation and expired-entry pruning;
- content deduplication and statistics.

A cached `model_conclusion` is not eligible as evidence unless it declares
proof dependencies. Callers can require evidence eligibility through
`getEvidence`.

The cache lives under:

```text
.krater/cache/
  entries/
  objects/
```

Inspect it with:

```sh
krater cache stats
krater cache prune
```

The agent does not yet populate this persistent cache with repository maps,
builds, tests, traces, or verifier results. The existing agent still has a
separate, one-turn in-memory cache for identical successful read-only tool
calls. No token/time savings target should be attributed to the persistent
verified cache until it is wired into execution and measured.

## CLI

Evidence-native commands currently available are:

| Command | Current behavior |
| --- | --- |
| `krater task run <prompt...>` | Runs one task in an isolated workspace, then records its contract, ProofPatch preview, capsule, passport, and verdict |
| `krater task list` | Lists local ProofGraph tasks |
| `krater task show <task-id>` | Prints durable task detail as JSON |
| `krater task resume <task-id>` | Inspects resumable state; does not resume a saved model transcript |
| `krater task cancel <task-id> [--reason <text>]` | Cancels an unpublished task; a staged ProofPatch is durably discarded before the cancelled capsule/passport is written |
| `krater task publish <task-id> [--accept-gaps]` | Publishes the attached reviewed ProofPatch after unchanged-base checks; gaps require explicit acceptance |
| `krater task rollback <task-id>` | Discards a staged ProofPatch or restores a published one |
| `krater intent init\|check\|add\|retire` | Manages explicit `.krater-intent/` artifacts |
| `krater proof show\|verify\|export` | Reads and validates capsules/passports |
| `krater policy simulate\|explain` | Evaluates one structured context flow |
| `krater debug causal --input <json>` | Replays a Causal Twin plan from ordered, caller-recorded Node.js/Python outcomes; it does not execute a process |
| `krater debug causal-live --input <json>` | Executes direct caller-supplied Node.js/Python entrypoints only inside verified native containment; checks the workspace digest before/after and fails closed when containment is unavailable |
| `krater lab replay --input <json>` | Scores one sealed recorded reliability evaluation; it does not execute benchmark fixtures |
| `krater lab calibrate --input <json>` | Evaluates the promotion gate without persisting a router, skill, prompt, or policy change |
| `krater cache stats\|prune` | Inspects or prunes the persistent cache |

Common evidence options are:

```text
--assurance fast|standard|high
--max-cost-usd <positive number>
--max-time <duration: ms|s|m|h>
--assume ask|best
--json
```

`--json` makes preflight, contract, patch, and verdict records
machine-readable, but streamed agent text/tool output can still share stdout
after execution begins. It is not yet a single schema-stable JSON result
envelope. A clarification-required result is different: it emits one
structured object and exits `3` before provider execution. `--max-cost-usd` is
quoted but not enforced against actual provider spend.

Interactive mode exposes `/understood`, `/plan`, `/proof`, `/ship`, `/watch`,
and `/undo`, while preserving `/contract`, `/evidence`, and `/rollback` as
compatibility aliases. `/assumptions`, `/why`, and `/publish` remain available.
Every prompt gets a fresh isolated staging workspace. `/publish` acts on the
most recently reviewed task and asks before accepting gaps; `/undo` acts on
that task's durable binding. `/ship` is informational unless a trusted host has
configured the typed provider adapter, and `/watch` is explicitly a local
record snapshot rather than a background production poller.

Cancellation never doubles as rollback: a task whose ProofPatch has been
published is refused with an explicit `task rollback` instruction. ProofPatch
publish, rollback, and cancellation routes are mutually exclusive within the
local server, so two lifecycle mutations cannot run concurrently. Cancellation
also refuses publication-in-progress and already terminal `complete`,
`abstained`, `blocked`, or `accepted_with_gaps` tasks; retrying an already
fully recorded `cancelled` task is idempotent. Causal replay remains explicit:
`debug causal` requires a JSON object with `plan` and the exact ordered
`executions` recorded by an external runner.

The separately named `debug causal-live` vertical slice performs direct
Node.js/Python execution. It accepts no shell string, resolves exact
workspace-relative entrypoints and working directories, rejects symlink
entrypoints and credential-bearing inputs, verifies the secret/build-output
excluding workspace digest before and after the run, and bounds output and
wall time. The process receives only declared non-sensitive environment
values, read-only workspace access, and no network. Unattended execution
requires a verified native adapter; the current production adapter is macOS
Seatbelt plus host-owned process limits, while Windows and Linux fail closed.
This is caller-supplied invocation replay with controlled alternate inputs—not
runtime instrumentation, value injection, branch override, or function
stubbing. A causal label remains limited to a deterministic, predicted outcome
change from an exactly declared isolated invocation difference. The
reliability commands require sealed result artifacts; they neither run a suite
nor promote configuration.

## Local API and Evidence view

The local API uses the same loopback Host/Origin/session-token boundary as the
rest of the GUI. Its implemented evidence routes are:

| Method/path | Current behavior |
| --- | --- |
| `GET /api/v2/tasks` | Lists tasks for the current project |
| `GET /api/v2/tasks/:taskId` | Returns contract, intent, action, evidence, claims, gaps, and digests |
| `GET /api/v2/tasks/:taskId/events` | Replays stored events after `Last-Event-ID` or `?after=` as SSE, then closes |
| `GET /api/v2/tasks/:taskId/passport?format=json\|markdown` | Returns or downloads a redacted passport/capsule; JSON includes digest verification |
| `POST /api/v2/tasks/:taskId/resume` | Reports whether durable state is resumable; starts no agent by itself |
| `POST /api/v2/tasks/:taskId/cancel` | Accepts optional `{ "reason": "..." }`; discards a staged binding first and returns a durable cancelled capsule/passport; refuses published bindings with the rollback route |
| `POST /api/v2/tasks/:taskId/publish` | Publishes a reviewed binding; JSON body `{ "acceptGaps": true }` is required when gaps remain |
| `POST /api/v2/tasks/:taskId/rollback` | Discards a staged binding or restores a published one with conflict protection |
| `POST /api/v2/policy/simulate` | Runs the label/capability policy simulator |
| `POST /api/v2/merge/forecast` | Strictly validates caller-supplied semantic patch descriptors and forecasts conflicts without reading or mutating the workspace |
| `POST /api/v2/debug/causal` | Accepts `{ "plan": ..., "executions": [...] }` and returns a recorded-outcome Causal Twin replay; spawns no process |
| `POST /api/v2/debug/causal/live` | Accepts `{ "plan": ... }` for the selected local project and returns a live sandbox receipt plus Causal Twin report; returns `503` when verified native containment is unavailable |
| `POST /api/v2/lab/replay` | Accepts `{ "evaluation": ... }` and scores a sealed recorded result set |
| `POST /api/v2/lab/calibrate` | Accepts a reliability promotion input and returns a non-persisted gate decision |
| `GET /api/v2/cache/stats` | Returns persistent-cache statistics |

The task-event endpoint is resumable replay, not a continuous subscription.
Live agent output continues to use
`POST /api/sessions/:sessionId/messages`.

The GUI has an **Evidence** view alongside IDE and Chat. Evidence-enabled
browser sessions stage model changes without mutating the selected workspace.
The view lists project tasks and displays contract boundaries, intent, claims,
evidence grades, known gaps, event counts, and passport export. Reviewed tasks
show **Publish patch** and **Discard patch** actions. A task with evidence gaps
requires a checkbox that explicitly accepts every displayed gap before the
publish button becomes available. Published tasks show **Roll back** with a
confirmation prompt. Successful mutations refresh the evidence detail.

The view refreshes task evidence on demand; it does not yet render every
planned evidence lens or provide live ProofGraph event following.

The planned v2 task-creation API, clarification/capability answers, intent graph
APIs, live causal execution, scheduled reliability-lab suites, and standalone
passport-verification endpoint are not implemented. Current causal and lab
routes evaluate caller-supplied recorded artifacts only.

## Local storage and privacy

| Path | Visibility | Purpose |
| --- | --- | --- |
| `.krater/proofgraph/events.ndjson` | ignored/private | Hash-chained task events |
| `.krater/proofgraph/cas/` | ignored/private | Digest-verified redacted objects |
| `.krater/proofpatch/` | ignored/private | Transaction journals, blobs, backups, and task bindings |
| `.krater/staging/` | ignored/private | Temporary copy-based task workspaces |
| `.krater/cache/` | ignored/private | Persistent verified-cache entries and objects |
| `.krater/scratch/` | ignored/private | User-created scratch workspaces |
| `.krater/skills/` | ignored/private | Workspace-specific skills |
| `.krater-intent/` | opt-in/shared | Human-readable manifest and living-intent graph |

`.krater/` is ignored by this repository. First use may create its protected
subdirectories; `.krater-intent/` is created only by explicit `intent init`.

ProofGraph, CAS, intent files, cache entries, and exports apply structural and
pattern-based redaction. Sensitive field names and common bearer/API-key,
GitHub, AWS, JWT, credential-URL, and query-token patterns are replaced with
`[REDACTED]`. Raw model conversation history remains in memory and is not
written by the evidence runtime.

Redaction is defense in depth, not a general secret detector. Arbitrary
application secrets can have unknown formats. Never put a secret in a task,
source file, test output, or command when a host-side credential handle would
work. Run `npm run guard:secrets` before publishing evidence or releases.

Detailed local artifacts are not yet encrypted with an OS-protected key. There
is no hidden telemetry in this foundation, but filesystem access to the user
account can read unencrypted `.krater/` data.

## Evidence-foundation benchmark

`benchmarks/evidence-native/` contains 100 deterministic Node.js/Python
microtasks (`EB-001` through `EB-100`), one bounded executable mapping for each
broader `KC-001` through `KC-100` specification. They prove the fixture,
withheld-checker, and verdict infrastructure; passing these focused repairs is
not equivalent to solving the 100 multi-hour expert specifications and is not
a SWE-bench score.

Run them without a Krater key or network:

```sh
node --import tsx benchmarks/evidence-native/runner.ts --validate
node --import tsx benchmarks/evidence-native/runner.ts --smoke
```

`--validate` checks exact schemas, fixture inventories, path confinement, and
the pinned checker digest. `--smoke` materializes each deliberately incomplete
seed and requires the checker to reject it. To check an already materialized
candidate:

```sh
node --import tsx benchmarks/evidence-native/runner.ts \
  --task EB-001 \
  --workspace /absolute/path/to/candidate
```

“Sealed” means the checker is withheld from the candidate workspace and pinned
by SHA-256. It is not encrypted or signed. The runner applies path, timeout,
environment, output, and process-group bounds, but it is not an OS sandbox and
must not run arbitrary downloaded code.

The existing 100-task catalog remains the broader specification/runner suite.
All 100 evidence-foundation microtasks have a deterministic seed plus sealed
checker format.

## Foundation libraries not yet wired end to end

The following source modules have unit-tested contracts, but their presence is
not evidence of a completed product feature:

- `src/sandbox/`: validates requests, bounds receipts, redacts sensitive
  arguments, and ships a narrow macOS adapter. Its live probe verifies
  Seatbelt file/network/fork denial and hard CPU/address-space limits.
  Unattended runtime commands bind the staged root, protected-path denies,
  deny-all networking, one process, output, and wall time. Exact network
  allowlists and subprocess trees are unsupported. Linux and Windows expose
  unavailable contracts and fail closed for unattended execution; explicitly
  approved attended commands remain a separately labeled compatibility path.
- `src/intelligence/jury.ts`: trigger, independence, cost, evidence-floor, and
  dissent decisions. It does not spawn agents or sealed verifier workspaces.
- `src/intelligence/merge-forecaster.ts`: forecasts conflicts from caller
  supplied semantic touches and a dependency DAG. A strict local API adapter
  exposes this calculation, but it does not extract touches from real branches,
  inspect workspace state, or continuously build/test combined patches.
- `src/intelligence/reliability-lab.ts`: evaluates a proposed router, skill,
  prompt, or policy promotion against sealed disjoint results. It does not
  schedule replays, manage a private holdout store, or update the router.
- `src/causal/`: ranks distinguishing experiments, runs supplied deterministic
  Node/Python invocations through a host-provided `ProcessRunner`, scrubs
  output, and labels a hypothesis causal only after a predicted isolated
  intervention changes the outcome. CLI/API adapters can replay
  caller-recorded executions, but no production process runner, automatic
  instrumentation, or debugger UI is connected.
- `src/mastery/`: implements opt-in session, hint, reflection, private signal,
  export, and deletion data rules. It has no durable application store,
  settings UI, or task-agent integration.

## Current limitations

The following roadmap claims are explicitly **not established** by the current
foundation:

- There is no detached Git-worktree backend and no copy-on-write filesystem
  backend.
- There is no context-isolated blind verifier or pre-patch hidden test author.
- Policy labels are not propagated through every prompt/tool/cache/export flow.
- External pushes, deployments, migrations, and API mutations do not have a
  complete structured side-effect escrow.
- Cross-platform native filesystem/network/process containment is not shipped.
- Verified Work Cache is not populated or consumed by normal agent execution.
- Jury and Mastery Mode are not exposed through product workflows. Merge
  forecasting is limited to a non-persisted caller-supplied descriptor API; it
  does not inspect or combine real branches. Causal Twin has recorded replay
  plus a narrow direct-process macOS live slice; it has no runtime
  instrumentation, arbitrary value injection, Linux/Windows live adapter, or
  dedicated UI. Reliability Lab remains a caller-recorded artifact adapter
  without scheduling or configuration promotion.
- Passports are digest-verified but not SSH/GPG-signed.
- Local evidence is redacted but not encrypted with an OS-protected key.
- Full task resume reconstructs evidence state, not the prior private model
  transcript.
- The `/api/v2` surface is partial and has one compatibility release only in
  design, not a completed compatibility contract.
- Monaco is the editor surface with local TypeScript/JavaScript, JSON, CSS,
  HTML, and base editor workers. The planned narrow host-owned semantic
  service, Python semantics, local LSP integration, and syntax-tree fallback
  service are not implemented.
- WCAG 2.2 AA, VoiceOver, NVDA, Orca, and participatory accessibility
  acceptance have not been completed.
- There are 100 executable sealed microtasks, but their focused behavioral
  checks do not establish correctness on the broader expert specifications.
- A deterministic property suite now proves zero stale hits across 10,000
  mutations of every declared Verified Work Cache dependency dimension.
  Normal execution currently caches only recomputed workspace maps; build,
  test, static-analysis, and verifier artifact reuse remains unimplemented.
- FixedBench, AgentDojo-derived policy targets, jury gains,
  semantic-conflict metrics, and causal-debugging exit gates have not been
  measured by this implementation.
- Release signing/notarization and supported-architecture launch gates remain
  separate release work.
- No evidence is graded `formally_verified` without a real proof artifact, and
  the product makes no formal-correctness claim.

## Threat boundaries

ProofGraph can record what Krater Pro observed; it cannot make an untrusted
command safe or prove that a test has adequate assertions. ProofPatch can
restore known file bytes; it cannot compensate arbitrary external side effects
caused by a process. Policy simulation can explain a decision; until it is
wired at every flow boundary, it is not a complete prompt-injection defense.
A hash proves content identity, not source identity.

The normal safety guidance remains:

- keep source under version control;
- avoid `--yes` on untrusted repositories;
- review commands and complete patches;
- do not expose the loopback server through a tunnel or reverse proxy;
- do not run benchmark checkers from untrusted sources;
- rotate any credential that appears in source, output, a prompt, or an
  exported artifact.

See [SECURITY.md](SECURITY.md) for the existing workspace, command, local
server, Electron, and credential boundaries.

## Validation

Use the repository gates rather than treating this document as proof:

```sh
npm run typecheck
npm test
npm run build
npm run guard:secrets
node --import tsx benchmarks/evidence-native/runner.ts --validate
node --import tsx benchmarks/evidence-native/runner.ts --smoke
node dist/cli.js --help
```

For a release, record exact command output, platform/tool versions, source
digest, relevant package lock digest, and every skipped check. A passing unit
suite does not by itself satisfy the roadmap’s platform, accessibility,
security, benchmark, or release exit gates.
