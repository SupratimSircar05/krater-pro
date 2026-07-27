# Agentic IDE

Krater Pro includes an integrated browser workbench powered by the same
`AgentSession`, Krater provider, Smart Coding Router, tools, approvals, and
selected project as the CLI and Chat view. It is not a disconnected editor
mock: agent tool calls operate on the workspace shown in the IDE, and the
explorer, Git view, and clean editor tabs refresh after an agent turn.

## Start the IDE

```sh
npm run build
krater web
```

Open <http://127.0.0.1:4317>. The app starts in **IDE** view. Use the IDE/Chat
switch in the top bar to move between the workbench and a full-width
conversation without starting a second agent session.

The server accepts loopback hosts only. Do not expose it through a tunnel,
reverse proxy, container port, or public interface without adding a real
multi-user authentication and authorization layer.

## Workbench layout

The IDE combines four project-scoped surfaces:

- **Explorer** — a filtered, collapsible tree of safe workspace files.
- **Editor** — tabbed UTF-8 text editing with line numbers, dirty-state
  indicators, explicit reload/save, and conflict detection.
- **Terminal and source control** — bounded non-interactive commands, Git
  status, and working-tree or staged diffs.
- **Krater agent** — the complete streaming conversation, Smart Router audit,
  tool activity, token metrics, and Allow/Deny approval cards.

The agent panel can be hidden without stopping its conversation. On smaller
screens, the explorer and agent become overlay panels so the editor remains
usable.

## Agent-assisted editing

Select text in an open file and choose **Ask Krater**, use the editor context
menu, or choose **Ask Krater** without a selection to attach the current file.
Krater Pro adds the relative path, selected line range, and at most 6,000
characters of code to the composer. Context truncation is explicit.

Review the generated prompt before sending it. The prompt enters the same
conversation shown in Chat view:

1. `Auto · Smart Router` resolves the first task, unless an exact model was
   selected.
2. The chosen model inspects or changes the selected project with Krater Pro
   tools.
3. Agent-requested edits and commands still produce Allow/Deny cards.
4. When the turn finishes, the explorer, Git state, and editor tabs that had no
   local unsaved changes refresh from disk.

Dirty tabs are deliberately not overwritten by an agent refresh. If both the
agent and editor changed the same file, the next save is rejected as a revision
conflict; reload or merge the latest file instead of forcing an overwrite.

## Editor consistency boundaries

Every file read returns a `sha256:` revision of the exact bytes opened. A save
must include:

- the current `projectId`;
- the workspace-relative path;
- the complete UTF-8 content; and
- that returned revision, or `null` only when creating a file that does not
  exist.

The server returns HTTP `409` if the selected project changed or the file was
created, removed, or modified since it was opened. Saves are serialized per
destination and published with the same atomic-write path used by agent edits.
Binary files, invalid UTF-8, protected secrets, paths outside the workspace,
hard-linked files, and editor documents over 1 MiB are rejected.

Project changes are also serialized against active editor, Git, and terminal
operations. The GUI warns before discarding dirty tabs, starts a clean agent
task after a successful switch, and never retargets an existing session to a
new filesystem root.

## Workspace terminal

The terminal is for explicit user commands, not an interactive PTY. Standard
input is closed, output is capped and stripped of terminal control sequences,
and the UI offers 5-, 15-, and 30-second timeouts. The API enforces a 120-second
maximum, an 8 KiB command limit, and at most four concurrent terminal
operations.

Every command:

- runs from the selected workspace;
- carries the current `projectId`;
- receives a minimal environment without the Krater key or unrelated provider
  credentials;
- is rejected when it matches destructive-data or protected-secret reads; and
- is terminated as a process group after timeout, cancellation, or shutdown.

On macOS, when `/usr/bin/sandbox-exec` is available, Krater Pro additionally
runs the command in a sandbox profile. Writes are limited to the selected
workspace and a private temporary home; `.env`, `.krater`, common credentials,
and developer credential directories remain denied. Network access is allowed
so normal package and test commands can work.

On other systems, or if `sandbox-exec` is unavailable, the command still has
the bounds, environment filtering, workspace working directory, and command
guards above, but it is **not** OS-sandboxed. A project script can execute
arbitrary code with the Krater Pro process's user permissions. Keep projects in
version control and do not run untrusted commands.

The user-entered terminal is separate from model tool approval: submitting its
Run button is the user's explicit request to execute that command. Commands
proposed by the model continue through the normal Allow/Deny workflow.

## Source control

Source control is read-only. It displays the current branch, structured
porcelain status, and either the working-tree or staged diff. Git inspection is
pinned to the selected workspace and refuses repositories whose `.git`
metadata or effective work tree escapes that boundary. Diff output and paths
are bounded and sanitized before reaching the browser.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| <kbd>Cmd/Ctrl</kbd> + <kbd>S</kbd> | Save the active file |
| <kbd>Cmd/Ctrl</kbd> + <kbd>P</kbd> | Focus the Explorer filter |
| <kbd>Cmd/Ctrl</kbd> + <kbd>B</kbd> | Toggle Explorer |
| <kbd>Cmd/Ctrl</kbd> + <kbd>J</kbd> | Toggle/focus Terminal |
| <kbd>Cmd/Ctrl</kbd> + <kbd>.</kbd> | Toggle the Krater agent panel |
| <kbd>Up</kbd>/<kbd>Down</kbd> in Terminal | Navigate command history |

## IDE API

| Method/path | Purpose |
| --- | --- |
| `GET /api/ide/tree?path=.&depth=6` | Bounded workspace tree |
| `GET /api/ide/file?path=…` | Open a UTF-8 document and return its revision |
| `PUT /api/ide/file` | Conflict-safe save with `projectId` and revision |
| `GET /api/ide/git/status` | Structured, bounded Git status |
| `GET /api/ide/git/diff?staged=false` | Working-tree or staged diff |
| `POST /api/ide/terminal` | Bounded command with `projectId` and timeout |

All routes inherit the loopback Host/Origin checks, local session token,
`no-store` response policy, filesystem confinement, and protected-path rules
described in [SECURITY.md](SECURITY.md).

## Credential boundary

The IDE does not read a Krater browser session. Krater currently exposes API-key
authentication for this integration, not a documented third-party OAuth/OIDC
flow. Configure `KRATER_API_KEY` in `.env`, the process environment, the CLI
invocation, or the tab-memory Settings field. See
[AUTHENTICATION.md](AUTHENTICATION.md).

The current workbench focuses on agent collaboration, text editing, bounded
commands, and Git inspection. It does not claim an interactive shell, language
server, debugger adapter, extension marketplace, or complete containment of
untrusted project code.
