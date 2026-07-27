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
- IDE tree/document APIs, protected reads, 1 MiB editor bounds,
  revision-conflict saves, current-`projectId` enforcement, Git status/diff,
  bounded terminal commands, destructive-command rejection, and project-change
  exclusion while IDE work is active;
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

## Live Smart Router validation

On 2026-07-27, the built CLI was run with `--model auto` against the live Krater
catalog. For a standard, low-risk repository-inspection task, Smart Router
selected `z-ai/glm-5.2` as an economy-tier candidate at 95% confidence. The
resolved model called `read_file` for `package.json` and returned the required
marker:

```text
ROUTER_OK krater-pro 0.1.0
```

Krater reported 3,585 cumulative tokens and 1,280 cached prompt tokens. The
catalog source was reported as live. A sandbox-restricted attempt first
exercised the visible fallback path to `moonshotai/kimi-k3`; the approved
network run then used live metadata. No key value was printed.

The first GUI automatic-routing trial exposed a genuine catalog-eligibility
defect: a zero-priced Lyria music endpoint was treated as a text candidate and
failed upstream. Krater Pro was then tightened to require tool support and
text-only output modalities for every automatic coding route, with regression
coverage for media models. The same production GUI flow was rerun successfully:
Smart Router selected `z-ai/glm-5.2`, rendered its live audit card, called
`read_file`, and displayed:

```text
GUI_ROUTER_OK krater-pro 0.1.0
```

The GUI displayed 3,568 session tokens for the successful trial.

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

## Agentic IDE acceptance

The final production browser pass must cover the integrated IDE, not only the
Chat layout:

- IDE is the initial view and switching to Chat preserves the same
  conversation;
- Explorer loads the selected project, filters entries, and opens a text file;
- an editor change shows dirty state, saves, refreshes Git, and survives a
  reload;
- an external or agent edit causes a stale-revision save to return a visible
  conflict instead of overwriting the file;
- **Ask Krater** places the file path and selected code in the composer without
  auto-submitting it;
- a bounded terminal command displays sanitized stdout, exit state, and
  duration, while a destructive or protected-secret command is rejected;
- working-tree and staged Git diffs load from the selected repository;
- a project switch warns about dirty tabs, starts a clean agent task, and
  cannot reuse an old `projectId`; and
- agent completion refreshes the tree, Git state, and clean tabs without
  replacing an unsaved tab.

macOS terminal acceptance should also confirm that `sandbox-exec` is used when
present and that writes outside the workspace/protected credential reads are
denied. On a platform without that facility, the record must state that only
the process, environment, command, timeout, and workspace controls were
exercised; it must not call the terminal OS-sandboxed.

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

## Official benchmark execution record

Status observed on 2026-07-27:

| Suite | Adapter/infrastructure evidence | Official correctness evidence |
| --- | --- | --- |
| DeepSWE | Offline adapter passed. | Not executed: its 8 GiB task request exceeds the available 7.75 GiB Docker VM. No reward exists. |
| SWE-Atlas | Offline adapter and configuration/bundle checks passed. | Not executed: its 16 GiB task request exceeds the available 7.75 GiB Docker VM. No Harbor reward exists. |
| SWE-bench Pro-os | Infrastructure-only container path passed. | First exact `moonshotai/kimi-k3` patch failed at **0/1**, with 11/14 official tests passing. A second rerun ended on an incomplete provider stream and yielded no score. |

The offline and infrastructure rows validate harness behavior only. They are not
benchmark passes, and Krater Pro currently makes no claim that all three suites
pass. The failed SWE-bench Pro-os result remains the authoritative scored
attempt until a later patch passes the official evaluator. Full interpretation:
[BENCHMARKS.md](BENCHMARKS.md).
