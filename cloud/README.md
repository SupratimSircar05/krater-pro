# Krater Pro Cloud

Krater Pro Cloud is the public companion site for the local Krater Pro coding
agent. It is a Cloudflare Pages application with Pages Functions and a D1
database. Visitors can explore the product, create an account, save portal
progress, and follow the official handoff to [Krater.ai](https://krater.ai/) to
obtain their own API key.

The cloud application never contains, proxies, or distributes the maintainer's
Krater API key. It cannot issue a Krater subscription or API credential; those
remain first-party Krater.ai actions.

## Scope

The hosted companion and the local coding product deliberately have different
trust boundaries:

| Cloudflare Pages companion | Local Krater Pro CLI and IDE |
| --- | --- |
| Product tour and bounded virtual-workspace demo | Full agentic coding workflows |
| User account and saved portal progress in D1 | Local repository files and Git history |
| Official Krater.ai signup and API-key handoff | User-supplied Krater API key |
| No arbitrary shell, repository clone, or host filesystem | Sandboxed commands inside the selected workspace |

Pages Functions are not a remote shell. The hosted experience must never accept
or execute arbitrary commands, mount a local project, or pretend that its demo
has modified a user's repository.

The demo persists only bounded virtual workspace JSON: files, chat messages, and
an optional active path. A visitor may pass their own Krater API key transiently
in the dedicated request header to validate it or run the exact
`moonshotai/kimi-k3` demo. Pages Functions forward that request only to
`https://api.krater.ai`. If that endpoint redirects, the client follows at most
three redirects, requires HTTPS, and permits only `krater.ai` or its
subdomains; it never forwards the key to an off-domain redirect. The key is
never written to D1, cookies, logs, static assets, or server configuration.

## Local development

Requirements:

- Node.js 22 or later (required by the pinned Wrangler release)
- a Cloudflare account for remote operations
- Wrangler authentication for deploys or remote migrations

From the repository root:

```sh
npm install
npm run cloud:migrate:local
npm run cloud:dev
```

The local migration uses Wrangler's local D1 store. Local accounts and progress
do not appear in the production database. The `cloud:dev` command supplies the
fixed non-secret `krater-pro-local-rate-limit-v1` rate-limit salt because
Wrangler adds `CF-Connecting-IP` to local requests. It also supplies the
non-secret `krater-pro-local-password-pepper-v1` test pepper. These values are
only for local testing and must never replace the independent production
secrets.

Run the cloud tests and credential guard independently:

```sh
npm run cloud:test
npm run cloud:guard
```

## Production runbook

The Pages project is `krater-pro`. Its output directory is `cloud/public`, and
the `DB` binding targets the `krater-pro-cloud` D1 database.
The `global_fetch_strictly_public` compatibility flag keeps provider requests
on Cloudflare's public-network path and preserves the intended SSRF boundary.

1. Authenticate Wrangler with the intended Cloudflare account.
2. Configure a unique random production salt of at least 16 bytes with
   `npx wrangler pages secret put RATE_LIMIT_SALT --project-name krater-pro`.
3. Configure a separate cryptographically random password pepper of at least
   32 bytes with
   `npx wrangler pages secret put PASSWORD_PEPPER --project-name krater-pro`.
   Never reuse the rate-limit salt, put either value in source, or pass either
   value as a command argument. Back the pepper up in an appropriate secret
   manager: losing or replacing it makes every existing password hash
   unverifiable. Do not rotate it without a deliberate account migration.
4. Review the exact commit and confirm the working tree contains no private
   `.env`, `.dev.vars`, generated bundle, or API credential.
5. Run `npm run cloud:test`.
6. Run `npm run cloud:guard`.
7. Review pending migrations, then run
   `npm run cloud:migrate:remote`.
8. Deploy with `npm run cloud:deploy`.
9. Verify account creation, sign-in, sign-out, saved progress, the constrained
   demo, and the Krater.ai outbound link on the production `pages.dev` URL.

Remote migrations and deploys are intentionally separate commands. A frontend
release must not apply a production database migration implicitly.

`GET /api/health` is a readiness check, not a process liveness claim. It returns
only `{"ok":true}` after validating both required secret bindings and a trivial
D1 query. Missing configuration or unavailable D1 returns a generic `503`
without identifying or exposing the failing dependency.

## Security invariants

- Never put `KRATER_API_KEY` in `wrangler.jsonc`, Pages environment variables,
  D1, source files, static assets, or generated Pages payloads.
- Never commit root `.env` or Cloudflare `.dev.vars` files.
- Never send the maintainer's credential to a visitor, browser, log, analytics
  service, or error response.
- Every user obtains and controls their own paid API key from Krater.ai.
- User-supplied demo keys are transient request data: never persist or log the
  `x-krater-api-key` header.
- Authentication uses the `__Host-krater_session` cookie with `HttpOnly`,
  `Secure`, and `SameSite=Strict`. Passwords are first keyed with HMAC-SHA-256
  using the deployment-only pepper, then processed with 100,000-iteration
  PBKDF2-SHA256 and a unique per-user salt; neither plaintext passwords nor the
  pepper are stored in D1. Account passwords must contain 15 through 128
  characters. Session tokens stop authorizing at expiry, rotate within 24
  hours, and expired rows are removed opportunistically. Logout removes the
  current session row, while account deletion cascades to every associated
  session.
- Login protection combines an IP-only bucket before body parsing with a
  separate IP-independent bucket keyed by a secret hash of the normalized
  email. D1 never receives the raw email in `rate_limits`. The account bucket
  atomically reserves every attempt before password derivation, closing
  concurrent distributed-guess bursts. Invalid or nonexistent credentials keep
  the reservation; successful verification removes all account reservations in
  the same D1 batch that creates the session, so successful attempts do not
  remain counted. The tradeoff is that enough targeted failures can temporarily
  throttle legitimate login for that email for the 15-minute window; the
  independent IP bucket limits how quickly one source can cause it.
- Treat D1 content as untrusted input and use parameterized queries.
- Do not log passwords, session tokens, API keys, or request bodies that may
  contain them.

`npm run cloud:guard` scans the Pages source/output boundaries and generated
Wrangler payload locations. It compares files against the root key without
printing it, compares against exact deployment-secret process values when they
are available without printing them, detects plausible live credentials, and
rejects checked-in cloud configuration that defines `KRATER_API_KEY`,
`PASSWORD_PEPPER`, or `RATE_LIMIT_SALT`. The guard is a final release gate, not
a substitute for code review or Cloudflare secret/audit-log review.

## Configuration

The checked-in `wrangler.jsonc` contains only public resource identifiers:

- Pages project: `krater-pro`
- D1 binding: `DB`
- D1 database: `krater-pro-cloud`
- migrations: `cloud/migrations`

No maintainer-owned Krater credential is required by the hosted companion. A
visitor can browse, create an account, and save progress without one; live
Krater inference requires that visitor's own transiently supplied key. A
developer's local Krater Pro `.env` remains outside the cloud application's
runtime and deploy payload.

Deployed Pages Functions require two independent server-side secrets:
`RATE_LIMIT_SALT` (at least 16 bytes) and `PASSWORD_PEPPER` (at least 32 bytes).
Password registration and login fail closed when the pepper is missing or too
short; production rate-limited routes fail closed when the rate salt is missing
or too short. Configure both with Wrangler or the Cloudflare dashboard and
never place either value in `wrangler.jsonc`. The local development command
explicitly binds public deterministic test values; production must use
independently generated secrets. Back up the production pepper securely; loss
or replacement prevents existing users from verifying their passwords, so
pepper rotation requires a planned account migration.

---

Built by [Supratim](https://www.linkedin.com/in/supratimsircar/) with ❤️
