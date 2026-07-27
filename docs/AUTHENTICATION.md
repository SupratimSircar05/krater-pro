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
3. selected workspace `.env`

Browser requests add one request-scoped layer: a non-empty key entered in GUI
Settings overrides the server's effective key for that tab's model discovery
and agent messages. If the tab has no key, the server falls back to the core
CLI → environment → `.env` result above.

The CLI option is convenient but can be visible in shell history and process
inspection. Prefer a permission-restricted `.env` for local development. Never
commit the file.

## Browser-assisted setup

`krater auth login` opens <https://krater.ai/developers>. After signing in,
create or retrieve an API key using Krater’s official controls, then place it in
the workspace `.env` or paste it into GUI Settings.

```sh
krater auth login
krater auth status
```

Use `krater auth login --no-open` on a remote or headless machine.

`krater auth status` checks whether a key is configured and reports its source
and selected model. It does not call Krater, validate the credential, confirm
model access, or inspect remaining credits. Treat its positive result as
**configured, unverified**; use `krater models` or an actual request when live
verification is required.

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

## Child-process isolation

Model-requested commands receive a minimal allowlist of environment variables.
`KRATER_API_KEY`, `OPENAI_API_KEY`, and other unrelated credentials are not
forwarded. Independent benchmark checkers also run without the Krater key.
