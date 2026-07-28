# GUI guide

Krater Pro’s GUI is a local React/Vite client backed by the same agent engine as
the CLI. It opens as an integrated agentic IDE and also provides full-width
Chat and Evidence views.

## Start

```sh
npm run build
krater web
```

Open <http://127.0.0.1:4317>. For live source loading:

```sh
npm run dev:web
```

## Main flow

1. Choose a project workspace in the top bar.
2. Keep `Auto · Smart Router`, or choose an exact model as a hard override.
3. Open a file from Explorer, select code if useful, and choose **Ask Krater**,
   or enter a request directly in the agent composer.
4. Watch streamed text, routing evidence, and tool cards beside the editor.
5. Expand a tool card to inspect exact arguments and output.
6. Allow or deny model-proposed edits/commands. In an evidence-enabled web
   session these actions affect an isolated staging copy, not the selected
   project.
7. Open **Evidence**, inspect the patch evidence and gaps, then explicitly
   publish or discard the reviewed ProofPatch.
8. Inspect the project, Git status/diff, passport, and token metrics after
   publication.

For an automatic task, the first assistant card includes the selected model,
cost tier, confidence, task complexity, risk, catalog source, and concise
routing reasons. The resolved model stays fixed for that task.

The responsive sidebar becomes a drawer on narrow screens. Keyboard focus
returns to the composer after settings close, and reduced-motion preferences
disable nonessential animation.

## IDE, Chat, and Evidence views

The workspace-view switch changes layout. IDE and Chat retain the same visible
transcript and model preference:

- **IDE** combines Explorer, a conflict-aware tabbed text editor, bounded
  workspace terminal, read-only source-control view, and the complete visible
  task transcript.
- **Chat** gives that transcript the full content width.
- **Evidence** lists durable project tasks and renders outcome contracts,
  intent, claims, evidence grades, gaps, passport digests, and export controls.

In evidence-enabled web sessions, each submitted prompt creates an independent
durable task and a fresh bounded model/tool loop. Prior cards remain visible in
the client, but they are not silently replayed as model context. Automatic
routing therefore runs per task; an exact model preference remains a hard
override.

An agent task that produces a patch remains `review` until publication. The
Evidence view offers:

- **Publish patch** for a reviewed transaction;
- an explicit “accept all documented gaps” checkbox when non-publication gaps
  remain;
- **Discard patch** for a staged transaction; and
- **Roll back** for a published transaction, with concurrent-edit protection.

The Evidence view refreshes ProofGraph data after these actions and signals the
IDE to reload its tree, Git state, and clean tabs. Dirty tabs remain protected
by the editor's existing conflict flow.

**Ask Krater** adds the current file path and either the selected code or a
bounded current-file excerpt to the composer for review. It does not submit the
prompt automatically. Model tool mutations retain their normal Allow/Deny
cards.

Editor saves include the current `projectId` and the revision returned when the
file was opened. The server returns a conflict instead of overwriting a file
that changed on disk. Dirty tabs do not refresh after agent activity. Project
switches warn before discarding dirty editor state and start a clean
conversation.

The user terminal is non-interactive and separate from model tool approval.
Submitting **Run** is an explicit user request; the server still enforces
command, timeout, output, environment, protected-secret, and selected-project
boundaries. macOS commands use the additional `sandbox-exec` profile when that
system facility is available. See [IDE.md](IDE.md) and
[SECURITY.md](SECURITY.md).

## Settings

The project section shows the selected workspace and offers three sources:

- an existing absolute local folder;
- a shallow clone of a public GitHub HTTPS repository; or
- a new scratch workspace under the launch project’s `.krater/scratch`
  directory.

The top-bar project dropdown also exposes all three actions and switches among
folders registered during the current server run. A switch is refused while a
response is active. Successful switches dispose old browser sessions and start
a clean task, so an existing session can never silently acquire access to a
different filesystem root.

The API-key field uses password rendering by default. The Show button reveals it
only on demand. A tab key overrides the server key but is not persisted. The
model preference is safe to persist and uses localStorage. Automatic mode stores
only the value `auto`; no catalog metadata or credential is persisted.

“Open Krater account & API setup” opens the official developer page in a new
tab. The surrounding copy explicitly states that Krater has not published
third-party OAuth and that Krater Pro will not extract browser session data.
The browser handoff does not authorize the IDE by reading a logged-in Krater
session; inference still requires an API key issued by Krater.

## Local API

| Method/path | Purpose |
| --- | --- |
| `GET /api/status` | Non-secret runtime configuration |
| `GET /api/projects` | Registered projects and the current selection |
| `POST /api/projects/select` | Select an already registered project |
| `POST /api/projects/local` | Register an existing absolute local folder |
| `POST /api/projects/github` | Shallow-clone a public GitHub HTTPS repository |
| `POST /api/projects/scratch` | Create and select an isolated scratch workspace |
| `GET /api/ide/tree` | Read a bounded Explorer tree |
| `GET /api/ide/file` | Open one UTF-8 document with its revision |
| `PUT /api/ide/file` | Save using `projectId` plus conflict revision |
| `GET /api/ide/git/status` | Read bounded structured Git status |
| `GET /api/ide/git/diff` | Read working-tree or staged diff |
| `POST /api/ide/terminal` | Run one bounded, project-bound user command |
| `GET /api/auth/capabilities` | Supported browser-auth handoff and OAuth status |
| `GET /api/models` | Authenticated model list, cached for five minutes |
| `GET /api/v2/tasks` | List durable ProofGraph tasks for the current project |
| `GET /api/v2/tasks/:taskId` | Read contract, intent, actions, evidence, claims, gaps, and digests |
| `GET /api/v2/tasks/:taskId/events` | Replay stored task events after an SSE event ID, then close |
| `GET /api/v2/tasks/:taskId/passport` | Return verified JSON or download Markdown with `?format=` |
| `POST /api/v2/tasks/:taskId/resume` | Inspect resumable evidence state without recreating a transcript |
| `POST /api/v2/tasks/:taskId/publish` | Publish reviewed ProofPatch; `{ "acceptGaps": true }` explicitly accepts gaps |
| `POST /api/v2/tasks/:taskId/rollback` | Discard or restore an attached ProofPatch |
| `POST /api/v2/policy/simulate` | Simulate one labeled context flow |
| `GET /api/v2/cache/stats` | Read persistent verified-cache statistics |
| `POST /api/sessions` | Create an in-memory browser transport session |
| `DELETE /api/sessions/:id` | Dispose a browser session and pending approvals |
| `POST /api/sessions/:id/messages` | Stream one turn as server-sent events |
| `POST /api/sessions/:id/approvals/:approvalId` | Resolve one pending action |

API responses disable storage caching and MIME sniffing. The server does not
advertise cross-origin access, requires its local session token, checks Host and
Origin, and binds only to loopback. IDE operations are serialized against
project changes, so a request cannot silently finish against a replacement
workspace.

## Stream events

The server emits `route`, `task`, `action_gate`, `text`, `tool`, `approval`,
`tool_result`, `usage`, `verdict`, `done`, and `error`. `route` is
emitted before an automatic model turn and contains the auditable selection
summary. `task`, `action_gate`, and `verdict` describe the evidence-native
lifecycle. A tool result can include `cached: true`. Usage includes per-request
tokens plus cumulative session totals and provider-reported cached tokens.

If the client disconnects while an approval is pending, the abort signal denies
and removes that approval instead of leaving the agent suspended.
