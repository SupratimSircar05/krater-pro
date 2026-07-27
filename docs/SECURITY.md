# Security model

Krater Pro is a local coding agent with powerful file and command tools. Its
controls reduce risk; they do not make arbitrary project code safe.

## Trust boundaries

- The Krater model can propose tool calls but cannot bypass tool schemas.
- Read-only tools execute immediately inside the selected workspace.
- File mutations and commands require a per-action approval unless `--yes`.
- The web client can request work only through the loopback server.
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

Approval remains essential. A permitted test/build can execute arbitrary code
from the repository or its dependencies. The command guard is defense in depth,
not a complete shell parser or OS sandbox.

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

Do not expose the port through tunnels, reverse proxies, containers, or port
forwarding without adding real authentication, authorization, origin/CSRF
controls, TLS, audit logs, quotas, and multi-user workspace isolation.

## Recommended operation

- Keep work in version control.
- Review every displayed mutation and command.
- Avoid `--yes` for untrusted repositories.
- Use a low-credit Krater key where possible.
- Review benchmark reports before sharing; they can contain source and command
  output.
- Rotate any credential that appears in a prompt, log, screenshot, report, or
  committed file.
