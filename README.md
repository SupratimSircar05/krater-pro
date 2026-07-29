<p align="center">
  <img src="web/src/assets/krater-pro-mark.svg" width="88" height="88" alt="Krater Pro crater logo">
</p>

<h1 align="center">Krater Pro</h1>

<p align="center">
  Built by <a href="https://www.linkedin.com/in/supratimsircar/">Supratim</a> with ❤️
</p>

Krater Pro is an independent, tool-using coding agent powered by the
[Krater API](https://api.krater.ai/). The same TypeScript agent runs as an
interactive CLI, a polished local React application, and native macOS and
Linux desktop apps.

It can map a repository, read and search source, load language-specific expert
skills, edit files, run development commands, inspect Git state, stream model
output, and ask before protected actions. It also includes a strict 100-task
expert benchmark and cost controls inspired by the practical compression ideas
in [Caveman](https://github.com/JuliusBrussee/caveman).

Krater Pro is a clean-room implementation. It is not affiliated with Krater,
Anthropic, Claude, or Claude Code. See
[UPSTREAM_REFERENCE.md](UPSTREAM_REFERENCE.md).

Try the hosted [Krater Pro Cloud Lab](https://krater-pro.pages.dev/) to create
an account and save a bounded virtual workspace before installing. Cloud Lab
has no shell, Git clone, or access to local files; full agentic coding runs in
the local CLI and IDE. Live Cloud Lab inference uses only the visitor's own
transient Krater API key.

## Highlights

- First-class `krater` and `krater-pro` terminal commands
- Secret-safe first-run setup, offline diagnostics, and Bash/Zsh/Fish
  completion generation
- Interactive task prompts, one-shot execution, model discovery, and approval
  controls
- Auditable Smart Coding Router that selects the lowest-cost qualified model
  from live Krater pricing and capability metadata
- Full agentic IDE with a safe file explorer, conflict-aware Monaco editor,
  bounded workspace terminal, Git status/diffs, and the active Krater agent
- Native macOS and Linux apps with a sandboxed Electron renderer,
  loopback-only ephemeral server, and reproducible GitHub Release automation
- One-use, fragment-delivered local launch tokens that are exchanged for an
  in-memory API session without cookies, query-string secrets, or persistent
  browser credentials
- Local app-style GUI with streaming, tool activity, project and model
  selection, settings, responsive layouts, and Allow/Deny actions
- One-click switching among existing local folders, isolated public GitHub
  clones, and disposable scratch workspaces
- OpenAI-compatible Krater chat completions with parallel tool calls and usage
  streaming
- `.env`, environment, and one-invocation API-key configuration
- Safe browser handoff to Krater account/API setup without scraping cookies or
  private session tokens
- Repository maps, progressive expert-skill loading, and 40+ language/ecosystem
  references
- Evidence-native foundation with bounded ambiguity preflight, a host-enforced
  Action/Abstention Gate, local hash-chained ProofGraph, isolated ProofPatch
  staging, conservative evidence capsules, Change Passports, and an Evidence
  review view
- Cache-friendly prompts, read-only tool-result reuse, bounded output,
  conversation compaction, and cached-token/session metrics
- Exactly 100 expert benchmark tasks across ten categories, with an offline-safe
  validator and opt-in live runner
- 100 executable evidence-foundation fixtures with content-addressed sealed
  checkers; these are infrastructure acceptance tasks, not an external
  benchmark score
- Workspace confinement, protected secret paths, journaled conflict-checked
  multi-file ProofPatch publication, minimal child-process environments,
  destructive-command guards, and loopback-only web serving
- Host-pinned Git execution with executable identity and SHA-256 revalidation;
  model-controlled workspaces cannot replace Git through `PATH` or `.env`

## Quick start

Requirements: macOS or Linux, Node.js `^20.19.0 || >=22.12.0`, npm, and a
Krater account with API access.

```sh
npm install
npm run build
npm link
krater setup
krater doctor
```

Start the terminal agent:

```sh
krater
```

Without a global link:

```sh
node dist/cli.js
```

Start the local GUI:

```sh
krater web
```

Open the exact loopback launch URL printed by the command. Its fragment carries
a one-use local bootstrap token; opening the bare port does not authorize API
access.

Full source, first-run, Homebrew-readiness, shell-completion, update, and
uninstall guidance: [docs/INSTALLATION.md](docs/INSTALLATION.md).

## Desktop apps

Download the macOS DMG/ZIP or Linux AppImage/DEB from
[GitHub Releases](https://github.com/SupratimSircar05/krater-pro/releases).
Each release includes `SHA256SUMS.txt`.

Windows builds and runtime support have been discontinued. The supported local
platforms are macOS and Linux.

Unsigned macOS community binaries may show an unknown-developer warning; verify
the checksum before using the operating system's one-app approval flow. Do not
disable platform security globally.

For a source checkout:

```sh
npm run desktop:test
npm run desktop:dev
```

The native shell loads the same production IDE over a dynamically selected
`127.0.0.1` port. It disables renderer Node access, uses a memory-only browser
partition, denies permissions/webviews/downloads, and keeps a pasted API key in
the existing in-memory Settings flow. Full installation, launch-option,
security, build, and signing guidance: [docs/DESKTOP.md](docs/DESKTOP.md).

## Authentication

Krater Pro resolves a key in this order:

1. `--api-key`
2. `KRATER_API_KEY` in the process environment
3. an OS-protected credential scoped to the selected workspace path
4. `KRATER_API_KEY` in the selected workspace’s `.env`

It intentionally ignores `OPENAI_API_KEY` and `OPENAI_BASE_URL`. A command-line
key can remain in shell history, so `.env` or a carefully scoped environment
variable is safer.

```dotenv
KRATER_API_KEY=kr_live_your_key_here
KRATER_MODEL=auto
```

For browser-assisted setup:

```sh
krater setup
krater doctor
krater auth login
krater auth status
```

`krater setup` accepts the key without terminal echo, validates authenticated
model discovery, then recommends macOS Keychain or Linux Secret Service. The
key is never placed in process arguments or output. A
permission-restricted plaintext `.env` is offered only as an explicitly
disclosed fallback. `krater doctor` is offline by default;
`krater doctor --live` explicitly repeats authenticated discovery.
Krater currently documents bearer API keys, not a third-party OAuth/OIDC flow.
Krater Pro therefore opens the official developer setup page but never reads a
logged-in browser’s cookies, local storage, or private session tokens. Account
and plan eligibility remain controlled by Krater. Details:
[docs/AUTHENTICATION.md](docs/AUTHENTICATION.md).

## CLI examples

```sh
# One-shot task
krater "Map this repository and explain its architecture"

# Explicitly request automatic accuracy/cost routing
krater --model auto "Repair this race condition and run the tests"

# Select workspace and model
krater -C ../project --model moonshotai/kimi-k3 \
  "Find the failing test, fix it, and verify the result"

# Approve staged file edits; commands remain fail-closed and contained
krater --yes "Run the tests and repair the failure"

# List models available to the configured account
krater models

# Check setup without making an API request
krater doctor --json

# Generate a completion script
krater completion zsh

# Tune context/cost behavior for one invocation
krater --context-chars 90000 --tool-output-chars 12000 \
  --response-style concise --max-steps 40 \
  "Review the current implementation"
```

Interactive commands include `/contract`, `/assumptions`, `/evidence`, `/why`,
`/publish`, and `/rollback`, plus `/help`, `/clear`, `/exit`, and `/quit`. File
edits and commands ask for approval unless `--yes` is set. Under `--yes`, file
edits use the staged workspace and commands use the verified fail-closed
unattended policy described below. Non-interactive protected actions are denied
unless `--yes` is supplied.

Full command reference: [docs/CLI.md](docs/CLI.md).

## Evidence-native foundation

Evidence mode requires bounded discovery and a host-validated
Action/Abstention Gate before model-proposed file edits. Each task records a
local outcome contract and hash-chained ProofGraph events, then produces a
conservative evidence capsule and Change Passport. A supported no-change
result is a valid `abstained` outcome; missing required evidence remains a
visible gap instead of becoming a clean success.

Before provider selection or staging, the CLI resolves unambiguous referenced
repository paths and ranks divergent choices. `--assume ask` asks one
highest-value question interactively; a non-interactive or `--json`
clarification persists the task, emits structured choices, performs no
provider call, and exits `3`. `--assume best` records its best-judgment choice
as unresolved for verification during discovery.

```sh
# Run and inspect a durable task
krater task run --assurance standard \
  "Reproduce the failure, repair it, and verify the result"
krater task list
krater task show <task-id>
krater task cancel <task-id> --reason "Stopped before publication"

# Inspect and verify its redacted evidence
krater proof show <task-id>
krater proof verify <task-id>
krater proof export <task-id> --format markdown -o passport.md

# Explicitly initialize shared living intent
krater intent init
krater intent check

# Preflight one labeled context flow and inspect local cache state
krater policy simulate \
  --operation execute --resource npm-test --scope workspace \
  --destination command --source repository --trust untrusted_data \
  --sensitivity public

# Replay recorded causal outcomes and score sealed reliability artifacts
krater debug causal --input recorded-causal-run.json
krater lab replay --input sealed-evaluation.json
krater lab calibrate --input promotion-evaluation.json
krater cache stats
```

Private task state, transactions, and caches live under the ignored
`.krater/` directory. Shared living-intent files are created only by explicit
`krater intent init` and live under `.krater-intent/`.

CLI and `krater web` agent edits run in an isolated copy. A change produces a
ProofPatch preview and stays in `review`; it reaches the selected workspace
only after `krater task publish <task-id>` or interactive `/publish`.
Publication refuses unresolved evidence gaps unless the user explicitly
supplies `--accept-gaps` or confirms them interactively. A task binding can be
cancelled with `task cancel`, discarded or restored with
`task rollback`/`/rollback`. Cancellation discards staged work first and
refuses published work, which requires explicit rollback. The GUI Evidence
view offers the same publish, explicit gap-acceptance, discard, and rollback
flow.

This is a foundation release, not the completed nine-month roadmap. Persistent
verified-cache reuse, end-to-end taint enforcement, native supported-platform
containment, blind verification, jury orchestration, live Causal Twin process
execution, Mastery Mode UI, signed passports, OS-key encryption, desktop
platform acceptance, and the remaining v2 task-creation, clarification,
capability, intent-graph, and verification APIs remain incomplete. The desktop
uses the same evidence-enabled loopback server, but native release acceptance
is not established by that reuse alone.
The current causal interface only replays caller-recorded outcomes, and the
current reliability interface only scores sealed result artifacts or evaluates
a non-persisted promotion decision.

Implementation details, evidence grades, storage, `/api/v2` routes, exact CLI
status, benchmark commands, and the complete non-claim list:
[docs/evidence-native.md](docs/evidence-native.md).

## Web GUI

```sh
npm run build
krater web --host 127.0.0.1 --port 4317
```

The server deliberately rejects non-loopback hosts. The GUI uses the server’s
configured key by default. A key pasted into Settings overrides it for that tab,
stays only in React memory, and is not saved in browser storage. The selected
model is saved locally as a non-secret preference. `Auto · Smart Router` is the
default; choosing an exact ID is a hard override and starts a fresh task.

The default IDE view puts the selected project’s file tree, tabbed UTF-8 editor,
bounded non-interactive terminal, Git status/diffs, and the complete streaming
Krater agent in one workbench. **Ask Krater** attaches the selected code or
current file to the same visible task transcript used in Chat view. In
evidence-enabled web sessions, each submitted prompt starts an independent
durable task; the displayed transcript is not silently reused as model context
for the next task. The **Evidence** view lists durable task contracts, intent,
claims, checks, gaps, and downloadable passports. Explicit ProofPatch
publication refreshes the explorer, source control, and clean tabs; unsaved
tabs remain untouched and revision checks prevent stale saves.

Use the project dropdown in the top bar to switch a registered workspace, open
an existing absolute local path, shallow-clone a public
`https://github.com/<owner>/<repo>` URL, or create a scratch workspace. A
project change starts a clean conversation and invalidates sessions bound to
the previous filesystem root. Scratch workspaces and GitHub clones live under
the launch workspace’s ignored `.krater/` directory.

Development mode:

```sh
npm run dev:web
```

- IDE guide: [docs/IDE.md](docs/IDE.md)
- GUI behavior and API endpoints: [docs/GUI.md](docs/GUI.md)
- CLI installation and first run: [docs/INSTALLATION.md](docs/INSTALLATION.md)
- Native desktop installation and releases: [docs/DESKTOP.md](docs/DESKTOP.md)

## Configuration

Krater Pro loads `.env` from the selected workspace (`-C`, otherwise the current
directory).

| Field | Default | Purpose |
| --- | --- | --- |
| `KRATER_API_KEY` | none | Krater bearer credential |
| `KRATER_BASE_URL` | `https://api.krater.ai/v1` | OpenAI-compatible API root |
| `KRATER_MODEL` | `auto` | Smart Router, or an exact model ID as a hard override |
| `KRATER_GIT_EXECUTABLE` | fixed system Git | Host-selected absolute Git executable outside the workspace |
| `KRATER_HOST` | `127.0.0.1` | Local GUI bind address |
| `KRATER_PORT` | `4317` | Local GUI port |
| `KRATER_CONTEXT_CHARS` | `120000` | Estimated context-character budget |
| `KRATER_TOOL_OUTPUT_CHARS` | `18000` | Per-tool retained-output budget |
| `KRATER_RESPONSE_STYLE` | `concise` | `concise` or `standard` |
| `KRATER_MAX_STEPS` | `48` | Maximum model/tool turns, from 1 to 128 |
| `KRATER_MAX_OUTPUT_TOKENS` | `8192` | Per-response generation ceiling |
| `KRATER_SESSION_TOKEN_BUDGET` | `250000` | Stop before another request after this reported session total |

Explicit CLI options override environment values, which override `.env`, which
override defaults.

`KRATER_GIT_EXECUTABLE` is deliberately host-only: set it in the process
environment or with `--git-executable`; a workspace `.env` entry is ignored.
Krater never searches `PATH` for Git and rejects executables that resolve inside
the writable workspace.

## Smart Coding Router

When `KRATER_MODEL` is unset or `auto`, Krater Pro classifies an evidence task
by complexity, risk, context size, and required coding tools. It
then compares the current `/v1/models` catalog using provider-reported pricing,
context window, tool support, and coding/agentic quality metadata. Ineligible
models are removed, the accuracy/cost Pareto frontier is calculated, and the
least expensive candidate meeting the task’s quality target is chosen.

Because Krater Pro always exposes repository tools to the model, automatic
routes require tool calling and text-only output. Image, audio, music, speech,
and other non-chat catalog endpoints remain available as explicit choices but
cannot be selected automatically.

The CLI and GUI show the chosen model, tier, confidence, catalog source, and
reasoning. The choice stays fixed for the duration of that task. A later
evidence task is routed again unless the user supplied an exact model ID. If
catalog discovery fails, the decision is visibly marked as fallback and uses
the validated `moonshotai/kimi-k3` profile. Supplying any exact model ID
bypasses automatic routing completely.

## Programming-language skills

The built-in `programming-languages` skill routes work to detailed ecosystem
references. The model first sees only skill metadata, then loads `SKILL.md`, then
only the relevant reference such as `references/python.md`. This progressive
disclosure avoids injecting every language guide into every request.

Workspace-specific skills can override built-ins under:

```text
.krater/skills/<skill-name>/SKILL.md
```

Skill files and references are size-bounded and confined to their skill
directory. See [docs/SKILLS.md](docs/SKILLS.md).

## Expert benchmark

Validate all 100 tasks without network or API-key access:

```sh
npm run benchmark:validate
npm run benchmark -- --list
```

Run one paid live task explicitly:

```sh
npm run benchmark -- --live --task KC-001 \
  --model moonshotai/kimi-k3
```

`--live` alone is rejected. A category requires an explicit category, and all
100 tasks require both `--live` and `--all`. The runner isolates each workspace,
redacts the key, records events and usage, distinguishes execution health from
correctness, and supports independent fixture checkers. Within the isolated
benchmark workspace, only `write_file` and `replace_in_file` are automatically
approved; `run_command` is denied. An optional checker is a separate, trusted
independent process—not an auto-approved model command—and is ignored unless
`--trust-checkers` is supplied together with `--live` and `--workspace`. Review
the checker before opting in; the runner prints and reports its source-relative
path and SHA-256 before execution.

Catalog: [benchmarks/TASKS.md](benchmarks/TASKS.md)
Methodology: [benchmarks/REPORT.md](benchmarks/REPORT.md)

The separate evidence-foundation suite maps all 100 expert specifications to
bounded executable microtasks with deterministic seeds and withheld,
SHA-256-pinned behavioral checkers:

```sh
node --import tsx benchmarks/evidence-native/runner.ts --validate
node --import tsx benchmarks/evidence-native/runner.ts --smoke
```

“Sealed” means withheld from the candidate workspace and content-addressed,
not encrypted, signed, or safely sandboxed for arbitrary downloaded code. See
[benchmarks/evidence-native/README.md](benchmarks/evidence-native/README.md).

### Official benchmark adapters

Krater Pro also includes container adapters for DeepSWE, SWE-bench Pro-os, and
SWE-Atlas. Adapter and infrastructure success is not a correctness score. The
current evidence is:

| Suite | Current verified status |
| --- | --- |
| DeepSWE | Offline adapter passed; official execution is blocked because its 8 GiB task request exceeds the available 7.75 GiB Docker VM. |
| SWE-Atlas | Offline adapter passed; official execution is blocked because its 16 GiB task request exceeds the available 7.75 GiB Docker VM. |
| SWE-bench Pro-os | Infrastructure-only path passed. The first exact Kimi K3 patch failed the official evaluator at 0/1 (11/14 tests); a second run ended on an incomplete provider stream and produced no score. |

Krater Pro does not claim that these suites all pass. Reproducible commands,
resource gates, and result interpretation are recorded in
[docs/BENCHMARKS.md](docs/BENCHMARKS.md).

## Efficiency

Krater Pro reduces avoidable token and latency cost through:

- a stable system/tool prefix suited to provider-side prompt caching;
- cumulative request, session, and cached-token reporting;
- deterministic removal of complete old turns when the context budget is
  exceeded;
- ANSI stripping, blank-line collapse, and head/tail retention for oversized
  tool results;
- within-turn reuse of identical successful read-only tool calls, invalidated
  after mutations and cleared before every new user turn;
- a compact repository-map tool before broad file exploration;
- five-minute model-list caching in the local server; and
- progressive language-skill loading.

These controls preserve exact code, identifiers, errors, safety warnings, and
ordered procedures. More detail: [docs/EFFICIENCY.md](docs/EFFICIENCY.md).

## Safety model

Read-only inspection runs immediately. `write_file`, `replace_in_file`, and
`run_command` require approval in normal sessions. Paths remain inside the
workspace even through symlinks. `.env`, Git internals, common credential files,
and private-key formats are protected. File edits publish through a temporary
file and same-directory atomic rename while preserving existing executable
mode. Model-run commands receive a minimal environment without Krater or
unrelated provider keys. Obviously destructive commands are blocked even under
`--yes`.

Approvals are not a sandbox: an allowed attended command can execute project code.
ProofGraph hashes make tampering detectable but do not prove tool honesty;
ProofPatch cannot compensate arbitrary process or network side effects; and
the new policy simulator is not yet an end-to-end context firewall. Review the
exact command, use version control, and avoid `--yes` on untrusted repositories.
The IDE terminal is a separate, explicit user action: it uses project-ID
binding, time/output limits, secret-stripped environment variables, and command
guards. On macOS it additionally uses `sandbox-exec` when available to confine
writes, deny protected credential paths, and deny spawned-command network
access.

`--yes` is a separate unattended policy. On macOS, Krater first executes live
Seatbelt, network-denial, no-fork, and kernel-limit probes, then runs the
command with staged-path rules, deny-all networking, a strict one-process
ceiling, hard CPU/address-space limits, and output/wall-time bounds. This
initial shell-string integration therefore supports shell builtins only. The
underlying native adapter can run one exact executable for structured,
host-owned callers, but external programs and builds are refused through
`run_command` because they require a child process. Exact network allowlists
are not claimed. If any required control is unavailable—or on Linux, where no
verified native adapter ships yet—the unattended command fails closed
without turning itself into an approval prompt. An interactive user may still
approve the exact attended command, whose result identifies whether it used
the compatibility macOS profile or an explicitly approved uncontained path. See
[docs/SECURITY.md](docs/SECURITY.md) and
[docs/evidence-native.md](docs/evidence-native.md).

### Hardened local trust boundary

The local web and desktop applications bootstrap through a fresh 43-character
token in the URL fragment. The server consumes that token exactly once and
returns a bearer session held in memory, with tab-scoped `sessionStorage` used
only for reload recovery. The token is never a cookie or query parameter, a
stale token cannot authorize a second client, and reopening a desktop window
creates a new bootstrap. API routes reject unauthenticated and mixed-case
variants.

Krater never searches a project-controlled `PATH` for Git. The host resolves an
absolute executable outside the writable workspace, records its filesystem
identity and SHA-256 digest, and revalidates both immediately before each Git
operation and inside the isolated command gate. Command scripts travel over a
private descriptor rather than process arguments or user stdin.

Credential setup writes directly to macOS Keychain or Linux Secret Service.
Private key values are never written to ProofGraph events, exported passports,
release assets, or Homebrew metadata. Workspace `.env` remains an explicitly
disclosed fallback only.

The verified checkpoint workflow runs the complete source, ProofGraph,
ProofPatch, cloud, benchmark-catalog, packaging, and secret-scan gates, plus
native command-boundary and source-Electron smoke tests on macOS and Linux.
Candidate release workflows additionally launch the distributed macOS ZIP and
Linux AppImage before publication. CodeQL and
dependency findings are repaired in source rather than dismissed as test-only
alerts.

## Development and verification

```sh
npm run typecheck
npm test
npm run guard:secrets
npm run benchmark:validate
npm run benchmark:evidence:validate
npm run desktop:test
npm run release:test
npm audit --audit-level=low
npm run build
node dist/cli.js --help
```

The test suite covers configuration precedence, provider streaming, cache-aware
usage, agent tool loops, approvals, ambiguity preflight and clarification exit
behavior, caching, skill confinement, workspace and symlink boundaries,
command guards, API/SSE sessions, ProofGraph replay and tamper detection,
Action Gate enforcement, ProofPatch publish/cancel/rollback recovery,
intent/policy/cache foundations, evidence capsules, benchmark validation,
isolated live-run behavior with fakes, and report generation.

Live Krater/Kimi and GUI acceptance evidence is documented in
[docs/TESTING.md](docs/TESTING.md).

## Architecture

The terminal, Chat view, and IDE agent use the same `AgentSession`, provider,
skill registry, tool definitions, and workspace implementation. IDE file,
terminal, and Git operations share the selected workspace boundary but remain
separate from model approval state. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Brand

The illuminated crater-and-orbit mark, product naming, colors, and attribution
rules are documented in [docs/BRAND.md](docs/BRAND.md). Use the canonical SVG
asset rather than recreating the mark.

## License

Krater Pro is released under the [MIT License](LICENSE). Third-party product and
company names belong to their respective owners.
