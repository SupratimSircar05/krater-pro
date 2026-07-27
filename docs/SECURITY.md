# Security model

Krater Pro is a local coding agent with powerful file and command tools. Its
controls reduce risk; they do not make arbitrary project code safe.

## Trust boundaries

- The Krater model can propose tool calls but cannot bypass tool schemas.
- Read-only tools execute immediately inside the selected workspace.
- File mutations and commands require a per-action approval unless `--yes`.
- The web client can request work only through the loopback server.
- IDE saves and terminal commands are direct user actions, not model approvals;
  they require current-project binding and remain subject to workspace,
  credential, command, and resource controls.
- Benchmark fixture checkers are trusted code and run outside the agent-visible
  workspace.

## Filesystem confinement

Paths are resolved against the physical workspace root. Lexical traversal,
absolute paths outside the root, and symlinks escaping it are rejected. Existing
ancestors are resolved before a new file is created.

Writes use a uniquely named temporary file in the destination directory and an
atomic rename, preserving an existing file's executable mode. This prevents
readers from observing partially written content, but it is not a multi-file
transaction and does not eliminate every filesystem TOCTOU race.

The IDE adds optimistic concurrency to this write path. Opening a file returns a
`sha256:` revision of its bytes. Saving requires both that revision and the
current `projectId`; a stale revision, missing/replaced file, or project switch
returns a conflict. `null` is accepted only for a genuinely new file. Per-file
serialization prevents two in-process saves from both validating the same old
revision.

Direct tool access is blocked for:

- `.git` internals;
- `.env` variants other than examples/templates;
- `.npmrc`, `.pypirc`, and `.netrc`;
- common credential and SSH-key names; and
- PEM, P12, PFX, and key files.

Binary and oversized reads are rejected. Recursive searches skip dependency,
build, coverage, VCS, and internal directories.

## Commands

Commands run from the workspace with:

- a 1–600 second bound;
- capped stdout/stderr;
- a minimal environment allowlist without provider credentials;
- process-group termination on Unix after timeout; and
- hard blocks for common forced recursive deletion, destructive Git cleanup,
  disk formatting, shutdown, and reboot forms.

Model-proposed commands require approval. Pressing Run in the IDE terminal is
itself an explicit user execution request, so the terminal does not display a
second model-approval card. Its API additionally requires the current
`projectId`, caps the command at 8 KiB, accepts only 1–120 second timeouts, limits
concurrency, ignores stdin, and sanitizes returned terminal control sequences.

On macOS, if `/usr/bin/sandbox-exec` exists, commands run with a generated
sandbox profile and a private temporary home. Writes are allowed only beneath
the selected workspace and that temporary directory. Reads and writes to
`.env`, `.krater`, common credential files, and developer credential
directories are denied. Network access remains available for package managers,
tests, and provider-independent project tooling.

On other systems, or without `sandbox-exec`, these process, environment,
workspace, timeout, and command controls do not form an OS sandbox. Even on
macOS the profile is defense in depth, not a proof that project code is safe. A
permitted test/build can execute arbitrary code with reachable user privileges.

## Local server

The server accepts only loopback bind hosts. API responses use `no-store`, disable
MIME sniffing, and suppress Express identification. Session IDs are random UUIDs.
Approvals expire after ten minutes and are denied on client disconnect or
session disposal.

Project switching does not retarget a live session. Each session is bound to
the selected physical workspace when it is created; a successful project change
disposes every prior session. Local folders must already exist and use absolute
paths. Remote project input accepts only canonical public
`https://github.com/<owner>/<repo>[.git]` URLs, disables credential helpers and
interactive prompts, uses an isolated Git home, limits clone output/time, and
removes its own partial destination after failure. Scratch and cloned projects
are created only under the launch workspace’s `.krater/` directory.

Editor, Git, and terminal requests participate in the same project-operation
gate. A project change is rejected while one is active, and new IDE work is
rejected while a change is in progress. Mutating IDE requests also carry
`projectId`, preventing an old tab from writing or running against the newly
selected root. Read responses report their project ID so the client can detect
stale state.

The loopback page receives a random, HttpOnly, SameSite=Strict local-session
cookie. API routes require that token (or its same-session request header),
enforce loopback Host and matching Origin checks, and set CSP, frame denial,
no-referrer, `no-store`, and MIME-sniffing protections. This is a local
single-user boundary, not internet-facing authentication.

Do not expose the port through tunnels, reverse proxies, containers, or port
forwarding without adding real authentication, authorization, origin/CSRF
controls, TLS, audit logs, quotas, and multi-user workspace isolation.

## Krater credentials

Krater Pro supports documented bearer API keys. A GUI key remains only in the
tab's React memory; the server-side key is never returned to the browser.
Neither the GUI nor IDE reads Krater cookies, browser storage, private web-app
tokens, or undocumented network requests. The browser setup handoff is
**not OAuth** and cannot turn a logged-in free or paid web session into API
access.
See [AUTHENTICATION.md](AUTHENTICATION.md).

## Recommended operation

- Keep work in version control.
- Review every displayed mutation and command.
- Avoid `--yes` for untrusted repositories.
- Use a low-credit Krater key where possible.
- Review benchmark reports before sharing; they can contain source and command
  output.
- Rotate any credential that appears in a prompt, log, screenshot, report, or
  committed file.
