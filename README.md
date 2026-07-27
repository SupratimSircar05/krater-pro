<p align="center">
  <img src="web/src/assets/krater-pro-mark.svg" width="88" height="88" alt="Krater Pro crater logo">
</p>

<h1 align="center">Krater Pro</h1>

<p align="center">
  Built by <a href="https://www.linkedin.com/in/supratimsircar/">Supratim</a> with ❤️
</p>

Krater Pro is an independent, tool-using coding agent powered by the
[Krater API](https://api.krater.ai/). The same TypeScript agent runs as an
interactive CLI and as a polished local React application.

It can map a repository, read and search source, load language-specific expert
skills, edit files, run development commands, inspect Git state, stream model
output, and ask before protected actions. It also includes a strict 100-task
expert benchmark and cost controls inspired by the practical compression ideas
in [Caveman](https://github.com/JuliusBrussee/caveman).

Krater Pro is a clean-room implementation. It is not affiliated with Krater,
Anthropic, Claude, or Claude Code. See
[UPSTREAM_REFERENCE.md](UPSTREAM_REFERENCE.md).

## Highlights

- First-class `krater` and `krater-pro` terminal commands
- Interactive conversations, one-shot prompts, model discovery, and approval
  controls
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
- Cache-friendly prompts, read-only tool-result reuse, bounded output,
  conversation compaction, and cached-token/session metrics
- Exactly 100 expert benchmark tasks across ten categories, with an offline-safe
  validator and opt-in live runner
- Workspace confinement, protected secret paths, atomic single-file
  publication, minimal child-process environments, destructive-command guards,
  and loopback-only web serving

## Quick start

Requirements: Node.js 20.19 or newer (or 22.12+), npm, and a Krater account
with API access.

```sh
npm install
cp .env.example .env
# Edit .env and set KRATER_API_KEY
npm run build
```

Start the terminal agent:

```sh
node dist/cli.js
```

Or link both command names:

```sh
npm link
krater
# krater-pro is equivalent
```

Start the local GUI:

```sh
krater web
```

Then open [http://127.0.0.1:4317](http://127.0.0.1:4317).

## Authentication

Krater Pro resolves a key in this order:

1. `--api-key`
2. `KRATER_API_KEY` in the process environment
3. `KRATER_API_KEY` in the selected workspace’s `.env`

It intentionally ignores `OPENAI_API_KEY` and `OPENAI_BASE_URL`. A command-line
key can remain in shell history, so `.env` or a carefully scoped environment
variable is safer.

```dotenv
KRATER_API_KEY=kr_live_your_key_here
KRATER_MODEL=moonshotai/kimi-k3
```

For browser-assisted setup:

```sh
krater auth login
krater auth status
```

Krater currently documents bearer API keys, not a third-party OAuth/OIDC flow.
Krater Pro therefore opens the official developer setup page but never reads a
logged-in browser’s cookies, local storage, or private session tokens. Account
and plan eligibility remain controlled by Krater. Details:
[docs/AUTHENTICATION.md](docs/AUTHENTICATION.md).

## CLI examples

```sh
# One-shot task
krater "Map this repository and explain its architecture"

# Select workspace and model
krater -C ../project --model moonshotai/kimi-k3 \
  "Find the failing test, fix it, and verify the result"

# Automatically approve displayed mutations and commands
krater --yes "Run the tests and repair the failure"

# List models available to the configured account
krater models

# Tune context/cost behavior for one invocation
krater --context-chars 90000 --tool-output-chars 12000 \
  --response-style concise --max-steps 40 \
  "Review the current implementation"
```

Interactive commands are `/help`, `/clear`, `/exit`, and `/quit`. File edits and
commands ask for approval unless `--yes` is set. Non-interactive protected
actions are denied unless `--yes` is supplied.

Full command reference: [docs/CLI.md](docs/CLI.md).

## Web GUI

```sh
npm run build
krater web --host 127.0.0.1 --port 4317
```

The server deliberately rejects non-loopback hosts. The GUI uses the server’s
configured key by default. A key pasted into Settings overrides it for that tab,
stays only in React memory, and is not saved in browser storage. The selected
model is saved locally as a non-secret preference.

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

GUI behavior and API endpoints: [docs/GUI.md](docs/GUI.md).

## Configuration

Krater Pro loads `.env` from the selected workspace (`-C`, otherwise the current
directory).

| Field | Default | Purpose |
| --- | --- | --- |
| `KRATER_API_KEY` | none | Krater bearer credential |
| `KRATER_BASE_URL` | `https://api.krater.ai/v1` | OpenAI-compatible API root |
| `KRATER_MODEL` | `openai/gpt-4o-mini` | Model ID for new sessions |
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

Approvals are not a sandbox: an allowed command can execute project code. Review
the exact command, use version control, and avoid `--yes` on untrusted
repositories. See [docs/SECURITY.md](docs/SECURITY.md).

## Development and verification

```sh
npm run typecheck
npm test
npm run benchmark:validate
npm run build
node dist/cli.js --help
```

The test suite covers configuration precedence, provider streaming, cache-aware
usage, agent tool loops, approvals, caching, skill confinement, workspace and
symlink boundaries, command guards, API/SSE sessions, benchmark validation,
isolated live-run behavior with fakes, and report generation.

Live Krater/Kimi and GUI acceptance evidence is documented in
[docs/TESTING.md](docs/TESTING.md).

## Architecture

The terminal and browser use the same `AgentSession`, provider, skill registry,
tool definitions, and workspace implementation. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Brand

The illuminated crater-and-orbit mark, product naming, colors, and attribution
rules are documented in [docs/BRAND.md](docs/BRAND.md). Use the canonical SVG
asset rather than recreating the mark.

## License

Krater Pro is released under the [MIT License](LICENSE). Third-party product and
company names belong to their respective owners.
