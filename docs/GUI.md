# GUI guide

Krater Pro’s GUI is a local React/Vite client backed by the same agent engine as
the CLI.

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
2. Choose a model.
3. Enter a coding request or select a starter prompt.
4. Watch streamed text and tool cards.
5. Expand a tool card to inspect exact arguments and output.
6. Allow or deny protected edits/commands.
7. Review request/session/cache token metrics under the final message.

The responsive sidebar becomes a drawer on narrow screens. Keyboard focus
returns to the composer after settings close, and reduced-motion preferences
disable nonessential animation.

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
model preference is safe to persist and uses localStorage.

“Open Krater account & API setup” opens the official developer page in a new
tab. The surrounding copy explicitly states that Krater has not published
third-party OAuth and that Krater Pro will not extract browser session data.

## Local API

| Method/path | Purpose |
| --- | --- |
| `GET /api/status` | Non-secret runtime configuration |
| `GET /api/projects` | Registered projects and the current selection |
| `POST /api/projects/select` | Select an already registered project |
| `POST /api/projects/local` | Register an existing absolute local folder |
| `POST /api/projects/github` | Shallow-clone a public GitHub HTTPS repository |
| `POST /api/projects/scratch` | Create and select an isolated scratch workspace |
| `GET /api/auth/capabilities` | Supported browser-auth handoff and OAuth status |
| `GET /api/models` | Authenticated model list, cached for five minutes |
| `POST /api/sessions` | Create an in-memory conversation |
| `DELETE /api/sessions/:id` | Dispose a conversation and pending approvals |
| `POST /api/sessions/:id/messages` | Stream one turn as server-sent events |
| `POST /api/sessions/:id/approvals/:approvalId` | Resolve one pending action |

API responses disable storage caching and MIME sniffing. The server does not
advertise cross-origin access and binds only to loopback.

## Stream events

The server emits `text`, `tool`, `approval`, `tool_result`, `usage`, `done`, and
`error`. A tool result can include `cached: true`. Usage includes per-request
tokens plus cumulative session totals and provider-reported cached tokens.

If the client disconnects while an approval is pending, the abort signal denies
and removes that approval instead of leaving the agent suspended.
