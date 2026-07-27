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
`https://api.krater.ai`; the key is never written to D1, cookies, logs, static
assets, or server configuration.

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
fixed non-secret `krater-pro-local-rate-limit-v1` binding because Wrangler adds
`CF-Connecting-IP` to local requests. This value is only for local testing and
must never replace the unique production secret.

Run the cloud tests and credential guard independently:

```sh
npm run cloud:test
npm run cloud:guard
```

## Production runbook

The Pages project is `krater-pro`. Its output directory is `cloud/public`, and
the `DB` binding targets the `krater-pro-cloud` D1 database.

1. Authenticate Wrangler with the intended Cloudflare account.
2. Configure a unique random production salt of at least 16 bytes with
   `npx wrangler pages secret put RATE_LIMIT_SALT --project-name krater-pro`.
   Never put its value in source or shell history.
3. Review the exact commit and confirm the working tree contains no private
   `.env`, `.dev.vars`, generated bundle, or API credential.
4. Run `npm run cloud:test`.
5. Run `npm run cloud:guard`.
6. Review pending migrations, then run
   `npm run cloud:migrate:remote`.
7. Deploy with `npm run cloud:deploy`.
8. Verify account creation, sign-in, sign-out, saved progress, the constrained
   demo, and the Krater.ai outbound link on the production `pages.dev` URL.

Remote migrations and deploys are intentionally separate commands. A frontend
release must not apply a production database migration implicitly.

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
  `Secure`, and `SameSite=Strict`; passwords are stored only as slow salted
  hashes. Session tokens stop authorizing at expiry, rotate within 24 hours,
  and expired rows are removed opportunistically. Logout removes the current
  session row, while account deletion cascades to every associated session.
- Treat D1 content as untrusted input and use parameterized queries.
- Do not log passwords, session tokens, API keys, or request bodies that may
  contain them.

`npm run cloud:guard` scans the Pages source/output boundaries and generated
Wrangler payload locations. It compares files against the root key without
printing the key, detects plausible live credentials, and rejects a cloud
configuration that defines `KRATER_API_KEY`. The guard is a final release gate,
not a substitute for code review or Cloudflare secret/audit-log review.

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

`RATE_LIMIT_SALT` is the only server-side secret required by deployed Pages
Functions. Production requests fail closed when it is absent or shorter than
16 bytes. Configure it with Wrangler or the Cloudflare dashboard; never place
its value in `wrangler.jsonc`. The local development command explicitly binds a
public deterministic test value because local Wrangler requests include a
Cloudflare IP header; production must use its independently generated secret.

---

Built by [Supratim](https://www.linkedin.com/in/supratimsircar/) with ❤️
