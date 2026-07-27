# Token, cache, and cost efficiency

Krater Pro applies conservative compression: reduce repeated context and noisy
tool output without changing technical meaning.

## Stable prefix

The system rules and tool definitions are deterministic and placed before
dynamic workspace/model details. Providers that support prefix caching can
therefore reuse more prompt tokens across turns. Krater Pro reads
`prompt_tokens_details.cached_tokens` when the provider reports it.

Krater Pro does not claim a cache hit unless the provider reports one.

## Context budget

`KRATER_CONTEXT_CHARS` bounds an inexpensive character estimate before each
provider request. The compactor:

1. preserves the stable system prompt;
2. groups messages into complete user turns;
3. retains newest complete turns;
4. avoids orphaning an assistant tool call from its tool result; and
5. adds a truthful note when older turns were omitted.

The estimate is a hard pre-request ceiling. If the newest complete user turn,
including its tool calls/results and omission note, cannot fit, Krater Pro
refuses the next provider call with an actionable error instead of silently
overspending or sending malformed tool history. This is a deterministic
character budget, not an exact tokenizer; actual tokens depend on the model.

## Tool-output budget

`KRATER_TOOL_OUTPUT_CHARS` controls each result sent back to the model. Tool
output is normalized by:

- stripping ANSI terminal control sequences;
- normalizing line endings;
- removing trailing whitespace before newlines;
- collapsing excessive blank lines; and
- preserving both the head and tail with an explicit omission count.

Head/tail retention keeps command context and final error summaries more useful
than a head-only cut.

## Read-only cache

Successful results from deterministic read-oriented tools are keyed with sorted
JSON arguments and reused only within one user turn:

- `workspace_map`
- `list_files`
- `read_file`
- `search_files`
- `git_status`
- `git_diff`
- `list_skills`
- `load_skill`

Any attempted mutating tool clears the cache before execution. The next user
message also starts with an empty tool cache, so editor, watcher, Git, and other
external-process changes between turns are observed instead of serving stale
source state. `/clear` also clears it.

## Progressive repository and skill context

`workspace_map` provides manifests, dominant extensions, and top-level structure
in one compact read. Language guidance starts with metadata, loads the routing
skill only when relevant, and then loads a single selected reference. This avoids
eagerly injecting dozens of guides.

## Response style

`concise` removes filler and repeated narration. It must not shorten exact code,
identifiers, errors, security warnings, irreversible-action explanations, or
ordered procedures whose sequence matters. `standard` provides more explanatory
detail.

## Metrics

Every usage event can report:

- request prompt, completion, and total tokens;
- provider-reported cached prompt tokens;
- cumulative session prompt, completion, total, and cached tokens; and
- number of provider requests.

The GUI displays these after completion; the CLI prints compact request/session
information as it arrives.

## Hard cost ceilings

`KRATER_MAX_OUTPUT_TOKENS` is sent to Krater on every completion request
(default `8192`). `KRATER_SESSION_TOKEN_BUDGET` stops the agent before starting
another provider request once provider-reported cumulative usage reaches the
configured total (default `250000`). The token budget cannot undo usage already
incurred by the final request, so benchmark reports retain the exact observed
totals.
