# Verification record

## Automated layers

Run:

```sh
npm run typecheck
npm test
npm run benchmark:validate
npm run build
```

Coverage includes:

- `.env`/environment/CLI precedence and validation;
- explicit rejection of unrelated OpenAI credentials;
- streamed text, partial tool calls, model sorting, usage, and provider errors;
- agent approvals, denial behavior, loop bounds, reuse after errors, cache hits,
  mutation invalidation, and session usage;
- ANSI/output compaction and complete-turn context selection;
- skill metadata, override behavior, on-demand references, traversal, and
  symlink escape rejection;
- deterministic file operations, project maps, protected files, lexical/real
  path boundaries, binary files, and command credential stripping;
- destructive/secret command guards;
- HTTP status/auth capability/session validation, SSE approval continuation,
  model caching, and loopback-only binding;
- exactly 100 benchmark tasks, strict schema errors, selection/credit gates,
  workspace isolation, secret exclusion, write/replace-only benchmark approval,
  command denial, default checker non-discovery, explicit checker-trust gates,
  checker SHA-256 evidence, redaction, scoring, and dual-format reports.

The full automated suite is expected to pass; use the current `npm test` output
as the authoritative test and file count rather than a hard-coded snapshot.

## Built CLI acceptance

The production `dist/cli.js` was exercised against a local
Krater/OpenAI-compatible SSE mock, not only through imported classes. The CLI:

- received a split streamed `list_files` tool call;
- executed it in a fresh isolated temporary workspace;
- received and executed a `write_file` call under explicit `--yes`;
- returned both tool results to the provider;
- streamed the final assistant response; and
- produced the expected file contents.

Help, version, `auth status`, `auth login --no-open`, and package dry-run contents
were also checked from the built output.

## Live Krater/Kimi validation

On 2026-07-27, authenticated model discovery returned the exact model ID:

```text
moonshotai/kimi-k3
```

A real streamed request through `https://api.krater.ai/v1` asked Kimi K3 to call
`read_file` for `package.json` and return a fixed marker. The model issued the
tool call, Krater Pro executed it, the model consumed the result, and the final
response contained:

The final response contained the requested success marker, the then-current
package name, and version `0.1.0`. That package field reflected the temporary
pre-rebrand identity. The same provider/tool implementation is covered after
rebranding by automated tests; no second paid call was made solely to change a
marker string.

Krater reported streamed usage for both provider turns, including a final total
of 1,658 tokens. No key value was logged or placed in a report.

## GUI acceptance

The production build was exercised in a real in-app browser at desktop and
390×844 mobile sizes:

- production status and static application loaded;
- responsive navigation/sidebar drawer worked;
- Settings opened and preserved the tab-only key rule;
- missing-key errors rendered as clean messages rather than raw JSON;
- a mock Krater-compatible SSE server completed a read-only tool flow;
- a `write_file` approval card appeared;
- Deny resumed the model with a denial result;
- the denied file was absent; and
- denied actions rendered as Denied, not Failed.

The final branded build should be reloaded after every production rebuild before
release.

## Benchmark policy

Offline validation exercises all 100 task definitions without cost. Live runs
can consume substantial credits and therefore require `--live` plus an explicit
task/category, or `--live --all`. The repository does not claim “perfect”
correctness from catalog validation or model self-reporting. Correctness requires
fixture-specific independent executable checks. The live agent may automatically
write or replace files only in its isolated benchmark workspace; `run_command`
is denied. Checkers are not discovered or copied merely because `--workspace`
was supplied. A reviewed checker runs separately as trusted independent code
only when `--trust-checkers` accompanies both `--live` and `--workspace`; its
relative path and SHA-256 are shown before execution and recorded in the report.
