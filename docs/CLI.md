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
| `-m, --model <id>` | Model returned by Krater `/v1/models` |
| `-C, --cwd <path>` | Workspace root |
| `-y, --yes` | Automatically approve mutations and commands |
| `--context-chars <n>` | Estimated request-context character budget |
| `--tool-output-chars <n>` | Retained characters per tool result |
| `--response-style <style>` | `concise` or `standard` |
| `--max-steps <n>` | Bounded model/tool turns, 1 through 128 |
| `--max-output-tokens <n>` | Per-response generation ceiling |
| `--session-token-budget <n>` | Stop before another request after the reported session total |
| `-V, --version` | Product version |
| `-h, --help` | Help |

## Interactive mode

Run without a prompt:

```sh
krater
```

The header reports model, workspace, and key source without printing the key.
Commands:

- `/help`: show the short command card;
- `/clear`: clear messages, usage totals, and session tool cache;
- `/exit` or `/quit`: close cleanly.

Streaming text is printed immediately. Tool calls show their name and compact
arguments. Read-only actions run immediately. Mutations display an approval
question with a default of No.

## One-shot mode

```sh
krater "Review the current diff"
```

When stdin is non-interactive, protected actions are denied unless `--yes` was
explicitly supplied. The process exits nonzero on configuration/provider/runtime
errors.

## Model discovery

```sh
krater models
```

This performs authenticated `/v1/models` discovery and prints exact IDs, one per
line. Example:

```text
moonshotai/kimi-k3
```

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

- Missing credentials explain all supported configuration paths.
- HTTP 401, 403, and 429 responses receive specific actionable messages.
- Abort signals cancel provider streaming.
- A repeated tool loop stops at the configured step bound.
- Non-success provider finish reasons and session/output token ceilings stop
  honestly instead of presenting a truncated answer as complete.
- A denied action returns a tool result to the model so it can adapt.
- Clearly destructive commands remain blocked under `--yes`.
