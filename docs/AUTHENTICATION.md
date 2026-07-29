# Authentication

## Supported credentials

Krater Pro uses the bearer-key authentication documented by Krater’s
OpenAI-compatible API:

```http
Authorization: Bearer kr_live_…
```

Core CLI/server configuration selects its effective key in this order:

1. CLI `--api-key`
2. process `KRATER_API_KEY`
3. an OS-protected credential scoped to the selected workspace path
4. selected workspace `.env`

Browser requests add one request-scoped layer: a non-empty key entered in GUI
Settings overrides the server's effective key for that tab's model discovery
and agent messages. If the tab has no key, the server falls back to the core
CLI → environment → `.env` result above.

The CLI option is retained for compatibility but can be visible in shell
history and process inspection. Prefer `krater setup`, which never puts a key
in arguments. Never commit `.env`.

## First-run setup

`krater setup` is the recommended first-run entry point. It checks the selected
workspace, can open Krater's official developer page, accepts the key using
terminal raw mode with no echo, and validates it with authenticated model
discovery. Persistence is attempted only after validation.

The recommended persistence backend is selected by the host:

- macOS: a generic-password item in Keychain. `security` receives the value
  through its password prompt on standard input; the value is not an argument.
- Linux: Secret Service through `secret-tool`; the value is supplied on
  standard input. Setup fails closed if the binary or session service is
  unavailable.

The account name is a one-way digest of the normalized selected workspace path.
Credential lookup derives that account and host backend directly; it does not
trust a workspace marker. Secure credential storage writes no marker or
encrypted blob into the workspace, and it does not delete legacy credential
files through workspace pathnames. If secure storage is unavailable or
declined, setup explains that `.env` is plaintext and asks separately before
writing an owner-only file. `--env-fallback` is the explicit non-default choice
for that fallback.

To rotate a credential, run `krater setup --replace`. The existing value stays
active until the replacement passes model discovery and the selected backend
accepts it.

`krater auth login` opens <https://krater.ai/developers>. After signing in,
create or retrieve an API key using Krater’s official controls, then place it in
the workspace `.env` or paste it into GUI Settings.

```sh
krater setup
krater doctor
krater doctor --live
krater auth login
krater auth status
```

Use `krater auth login --no-open` on a remote or headless machine.
For CI or another headless environment:

```sh
KRATER_API_KEY=... krater setup --non-interactive --no-open
```

This performs authenticated model discovery but never persists the value.
Without a credential it returns `setup_required` and exits `4`.
`krater setup --create-env --non-interactive --no-open` remains available to
create only an empty owner-private template.

`krater auth status` checks whether a key is configured and reports its source
and selected model. It does not call Krater, validate the credential, confirm
model access, or inspect remaining credits. Treat its positive result as
**configured, unverified**; use `krater models` or an actual request when live
verification is required.

`krater doctor` performs broader offline installation checks and reports
credential presence and source without exposing its value. It exits `4` with a
machine-readable `setup_required` status when no key is configured. Only the
explicit `krater doctor --live` form performs authenticated model discovery;
the report then uses `live_credential_verification` scope and says
`verified` or `failed`. `auth status` remains an offline presence check.

## Why this is not OAuth

As verified on 2026-07-27, Krater’s public developer material documents API-key
authentication but does not publish the authorization endpoint, token endpoint,
client registration, scopes, redirect contract, PKCE requirements, or OIDC
discovery metadata required for a third-party OAuth implementation.

Krater Pro does not:

- read Krater cookies from Chrome or another browser;
- inspect a logged-in page’s local/session storage;
- copy internal bearer tokens from network traffic;
- replay undocumented web-app requests; or
- claim that a browser handoff grants API eligibility.

Those techniques would expose reusable account credentials, couple the product
to private implementation details, and bypass the consent and scope guarantees
OAuth is intended to provide.

If Krater publishes an OAuth flow later, support should use Authorization Code
with PKCE, a loopback redirect for the CLI, state and nonce validation, explicit
scopes, short-lived access tokens, refresh-token rotation, and OS credential
storage. Session scraping must not be used as a substitute.

## Free and paid accounts

Krater controls which plans and accounts receive API access and credits. Krater
Pro cannot turn a free web session into API access. The browser handoff is
available to every user, but inference succeeds only when Krater issues a
credential authorized for the requested API/model.

## GUI key handling

A key entered in GUI Settings:

- stays in React component memory;
- is sent only to the loopback Krater Pro server for the request;
- is not placed in localStorage or sessionStorage;
- is not returned by `/api/status`; and
- disappears when the tab closes or reloads.

Without a tab key, the local server uses its effective key from the core
precedence above. `/api/status` exposes only whether that server-side key is
configured; it neither validates the key with Krater nor accounts for a
tab-only key. Key source and value are never sent to the browser. Consequently,
the GUI labels describe configured/readiness state, not verified authentication
or model entitlement.

## Local launch bootstrap

The local web and desktop UI use a one-time launch bootstrap that is separate
from Krater API authentication. Each server start creates a random
local-session token and a distinct bootstrap token. The exact launch URL
contains the bootstrap token in its fragment, which is not sent to the HTTP
server. The UI removes it from the address bar and exchanges it once through a
dedicated header. The returned session token stays in memory and
origin-and-port-scoped `sessionStorage`; API calls attach it as a header.
Invalid or reused bootstrap tokens are rejected, and cookies are not used for
local API authorization.

The desktop main process loads that URL directly. `krater web` prints it for
the local user to open. Treat the unconsumed URL as sensitive and do not share
it in logs, screenshots, or chat. Possession of the local session token
authorizes requests only to that loopback server instance; it does not
authenticate a Krater account, grant API/model access, or provide multi-user
authentication.

## Child-process isolation

Model-requested commands receive a minimal allowlist of environment variables.
`KRATER_API_KEY`, `OPENAI_API_KEY`, and other unrelated credentials are not
forwarded. Independent benchmark checkers also run without the Krater key.
