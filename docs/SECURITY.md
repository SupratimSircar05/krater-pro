# Security model

Krater Pro is a local coding agent with powerful file and command tools. Its
controls reduce risk; they do not make arbitrary project code safe.

## Trust boundaries

- The Krater model can propose tool calls but cannot bypass tool schemas.
- Read-only tools execute immediately inside the selected workspace.
- File mutations and commands require a per-action approval unless `--yes`;
  under `--yes`, commands use verified fail-closed unattended containment and
  never inherit blanket uncontained approval.
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

Evidence-enabled CLI and `krater web` agent tasks add a separate ProofPatch
layer. Model file tools operate on a private copy under `.krater/staging/`.
After the turn, Krater records a create/edit/delete/move preview plus
base/final digests and leaves the selected workspace unchanged. Explicit
publication rechecks each file's existence, digest, size, and mode, writes
verified backups, journals each applied change, and rolls back after an error.
The journal can recover incomplete publication states after a restart.

This is recoverable multi-file publication, not one indivisible filesystem
operation. Commands can have process, network, database, or external API side
effects that ProofPatch cannot reverse. The current staging implementation is
a bounded copy, not a detached Git worktree or filesystem copy-on-write layer.
The CLI, `krater web`, and Electron desktop launcher opt into this evidence
path. Direct server embedders must opt in explicitly during the compatibility
release.

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
- best-effort termination of the initial Unix process group or Windows process
  tree after timeout, cancellation, or shutdown; and
- regex preflight rejections for common spellings of forced recursive
  deletion, destructive Git cleanup, protected-secret reads, disk formatting,
  shutdown, and reboot.

The destructive-data and protected-secret checks are advisory
defense-in-depth. They recognize documented common spellings; they are not a
shell parser, an allowlist, or an OS security boundary. Alternate tools,
aliases, interpreters, encodings, constructed command strings, or other shell
forms can evade a regex guard. An attended command that passes these checks is
not thereby safe.

Attended cancellation is also best-effort rather than containment. On POSIX,
Krater signals the command's initial process group; on Windows, it asks
`taskkill /T /F` to terminate the initial process tree and falls back to the
direct child. A command can escape that scope by creating a new session with
`setsid`, detaching or re-parenting a descendant, or handing work to another
service. Escaped work may survive timeout, cancellation, or app shutdown and
must be cleaned up independently.

Model-proposed commands require approval unless the caller deliberately
selected fail-closed unattended mode (`--yes`). Pressing Run in the IDE terminal
is itself an explicit user execution request, so the terminal does not display
a second model-approval card. Its API additionally requires the current
`projectId`, caps the command at 8 KiB, accepts only 1–120 second timeouts, limits
concurrency, ignores stdin, and sanitizes returned terminal control sequences.

Strict unattended model execution is allowed only through a native adapter
whose executable probes verify every requested containment control. If the
adapter or any required control is missing, unverifiable, or weaker than the
request, execution fails closed; it never falls back to the attended
compatibility runner.

On macOS, the verified native adapter probes undeclared-file denial,
outbound-network denial, fork denial, and installation of hard
CPU/address-space limits. The request binds the staged workspace, read-only
host-selected dependency roots, existing protected paths, deny-all networking,
one process, output bytes, and wall time. Protected paths and hard-linked
aliases are denied even though the staged root is writable. Credential-looking
argv and environment names are refused. The one-process ceiling is deliberately
stricter than the requested numerical ceiling. The current model-facing
shell-string integration can run shell builtins only; external programs and
ordinary build/test commands require a child process and are not supported in
unattended mode. Structured host-owned callers may use the adapter to run one
exact executable. Seatbelt cannot safely implement an exact hostname allowlist,
so no network allowlist capability is advertised.

Explicitly approved attended commands and the user-entered IDE terminal retain
the compatibility command runner. On macOS it uses a generated Seatbelt
profile and private temporary home, confines writes, denies protected paths,
and denies spawned-command network access. The returned execution metadata
labels this `macos_seatbelt_best_effort`; it is not presented as the strict
native adapter. Without that profile, an attended result is labeled
`approved_uncontained`.

The packaged Electron command gate also compares its live parent executable
with the canonical Krater executable before accepting the internal gate route.
That parent check is defense-in-depth only. It does not authenticate arbitrary
same-user processes, contain descendants, or replace a verified native
sandbox.

No verified Linux namespace/seccomp/cgroup supervisor ships in this slice, and
the Windows restricted-token/Job Object native supervisor is not yet complete.
Unattended model commands therefore fail closed on Linux and Windows. Windows
attended cancellation uses `taskkill`, not Job Object lifetime enforcement.
Explicit attended approval remains possible, but the process, environment,
output, timeout, parent-check, and regex controls do not form an OS sandbox and
project code can execute with reachable user privileges. A successful local
native probe is executable evidence for the advertised controls; it is not a
formal proof that arbitrary project code is safe.

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

Each server start creates a random local-session token. Every launch URL carries
a separate one-use bootstrap token in its URL fragment. Browsers do not send
fragments in HTTP requests. The UI removes the fragment from the address bar,
posts it once as a bootstrap header, and receives the session token. Invalid or
reused bootstrap tokens are rejected. A newly created desktop window receives
a fresh bootstrap. Treat an unconsumed launch URL as sensitive and do not copy
it into chat, logs, or screenshots.

The renderer keeps the returned session token in memory and origin-scoped
`sessionStorage`, whose origin includes the loopback port, then attaches it as
an API request header. Krater does not put this bearer in a cookie, so another
service on a different loopback port cannot receive it through ambient cookie
rules. API routes also enforce loopback Host and matching Origin checks and set
CSP, frame denial, no-referrer, `no-store`, and MIME-sniffing protections. This
one-use local launch bootstrap is a local single-user boundary, not Krater
account authentication or an internet-facing multi-user login.

Do not expose the port through tunnels, reverse proxies, containers, or port
forwarding without adding real authentication, authorization, origin/CSRF
controls, TLS, audit logs, quotas, and multi-user workspace isolation.

## Native desktop shell

The macOS, Windows, and Linux apps run this same server on `127.0.0.1`. By
default, the launcher selects an available ephemeral port; a fixed port can be
requested, but the host cannot be changed. A single-instance lock prevents
accidental duplicate shells, and app shutdown requests cancellation of agent
activity, denies pending approvals, closes HTTP connections, and releases the
port. As described above, attended descendants that escape the initial process
group or Windows task tree may survive that cancellation request.

The Electron renderer has `nodeIntegration` disabled, context isolation and
sandboxing enabled, no preload bridge, no remote module, and no persistent
session partition. Permission requests, webviews, downloads, insecure content,
and navigation away from the exact loopback origin are denied. HTTPS links open
in the system browser rather than gaining an Electron window. Production
packages disable DevTools and apply Electron fuses that disable Run-as-Node,
`NODE_OPTIONS`, CLI inspection, and loading application code outside the ASAR.

An API key inherited by the main process or loaded from the launch workspace's
`.env` is not exposed to the renderer. A key pasted in Settings follows the
existing in-memory web flow and disappears when the app exits. Electron does
not add key storage, IPC, logging, analytics, update services, or crash uploads.

Version 0.1.0 community installers are unsigned and are therefore expected to
trigger macOS Gatekeeper or Windows SmartScreen warnings. Published release
checksums provide integrity checking but not publisher identity. See
[DESKTOP.md](DESKTOP.md) for the warning and future signing/notarization secret
names.

## Krater credentials

Krater Pro supports documented bearer API keys. A GUI key remains only in the
tab's React memory; the server-side key is never returned to the browser.
Neither the GUI nor IDE reads Krater cookies, browser storage, private web-app
tokens, or undocumented network requests. The browser setup handoff is
**not OAuth** and cannot turn a logged-in free or paid web session into API
access.
See [AUTHENTICATION.md](AUTHENTICATION.md).

## Shipping credentials and external effects

The normal CLI, web server, and desktop app do not auto-enable GitHub or
Cloudflare mutations. A trusted host must inject the structured shipping
service explicitly. Public API bodies contain credential handles, never
credential values. Provider adapters resolve those handles only inside the
host call, use fixed provider domains and typed endpoints, discard provider
response bodies on errors, and persist only digests plus opaque recovery
handles.

Each mutation requires a durable proof-backed plan, exact provider preflight,
digest-bound user confirmation, persistent idempotency reservation, and final
provider reconciliation. Compensation is also a separately confirmed
structured operation and fails closed after provider drift. It is recovery,
not a guarantee that all provider side effects are reversible. Supported
operations and gaps are documented in [SHIPPING.md](SHIPPING.md).

## Recommended operation

- Keep work in version control.
- Review every displayed mutation and command.
- Avoid `--yes` for untrusted repositories.
- Use a low-credit Krater key where possible.
- Review benchmark reports before sharing; they can contain source and command
  output.
- Rotate any credential that appears in a prompt, log, screenshot, report, or
  committed file.

ProofGraph, policy simulation, persistent cache, and ProofPatch have additional
threat and non-claim boundaries in
[evidence-native.md](evidence-native.md#threat-boundaries).
