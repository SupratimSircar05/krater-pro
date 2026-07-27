# JavaScript and TypeScript

## Ecosystem detection

- Look for `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.mts`, `.cts`, `.tsx`, `package.json`, and workspace manifests.
- Use the lockfile and `packageManager` field to select npm, pnpm, Yarn, or Bun. Detect Node, Deno, Bun, browser, edge, and embedded runtimes separately.
- Read `"type"`, exports/imports maps, `tsconfig` inheritance, framework config, and runtime version pins before deciding module semantics.

## Canonical toolchains

- Use the repository package manager and wrapper; never create a second lockfile.
- TypeScript commonly uses `tsc`; builds may use Vite, esbuild, Rollup, webpack, SWC, framework CLIs, Deno, or Bun.
- Testing may use Node test, Vitest, Jest, Mocha, Playwright, Cypress, or framework-specific runners. Use configured ESLint/Biome/Prettier.

## Inspect-first files

- Read `package.json` scripts/engines/exports, the lockfile, workspace file, all relevant `tsconfig*.json`, lint/format config, framework/build config, `.nvmrc`/`.node-version`, and CI.
- Trace server/client boundaries, environment-variable exposure rules, generated API types, aliases, SSR entry points, and test setup.

## Build, test, lint, and format

- Install from lock with the owning tool (`npm ci`, `pnpm install --frozen-lockfile`, `yarn install --immutable`, or the repository command).
- Prefer scripts such as `<pm> test`, `<pm> run typecheck`, `<pm> run lint`, `<pm> run format:check`, and `<pm> run build`; inspect scripts before invoking them.
- Narrow through the selected runner, e.g. `vitest run path`, `jest path`, `node --test path`, or `playwright test path`. Do not pass flags unsupported by the configured version.

## Implementation idioms

- Preserve ESM/CJS boundaries, package exports, type-only imports, runtime validation, immutable state conventions, and framework lifecycle rules.
- Avoid `any` as a fix; narrow `unknown`, model discriminated unions, handle promises explicitly, and distinguish absent from `null`.
- Keep browser-only and server-only code separated. Do not expose secrets through client bundles or public environment prefixes.

## Debugging workflow

- Capture the first meaningful stack/cause and source-mapped location. Reproduce with the pinned runtime and focused test.
- Use `node --inspect`, browser devtools, runner verbose modes, framework logs, or network tracing. Inspect generated bundle/module resolution only after source/config checks.
- For dependency issues, inspect `<pm> why <package>` or equivalent and resolved exports; do not blindly delete the lockfile.

## Concurrency, memory, and performance

- Understand event-loop phases, microtasks, streams/backpressure, workers, and abort signals. Avoid unbounded `Promise.all` and forgotten promises.
- Remove listeners/timers/subscriptions and close handles. Profile with runtime/browser tools; measure bundle size, long tasks, hydration, allocation, and server latency.
- Treat shared state across requests, workers, SSR renders, and tests as race-prone even in a single-threaded event loop.

## Security hazards

- Prevent XSS with context-appropriate escaping; avoid unsafe HTML injection, prototype pollution, dynamic code execution, open redirects, and SSRF.
- Use argument arrays for child processes, parameterized queries, dependency lock integrity, CSRF protection where relevant, and explicit CORS/auth checks.
- Do not leak secrets into logs, source maps, client config, serialized server props, or error responses.

## Interoperability

- Define JSON/date/bigint/binary conventions and validate external data at runtime; TypeScript types disappear at runtime.
- Verify browser/runtime compatibility, module conditions, package exports, source maps, and generated schema clients.
- For native addons or WASM, check ABI, architecture, memory ownership, async boundaries, and packaging.

## Common failure modes

- Wrong package manager/runtime; duplicate dependency instances; ESM/CJS mismatch; path alias works in types but not runtime; stale generated types.
- Missing `await`; swallowed rejection; hydration divergence; stale closure; unstable hook dependencies; tests left with open handles.

## Verification checklist

- [ ] Confirm runtime, package manager, lockfile, and module mode.
- [ ] Add/run focused unit and boundary tests.
- [ ] Run configured typecheck, lint, format check, and production build.
- [ ] Smoke-test the actual server/browser/CLI path.
- [ ] Inspect bundle secret exposure, async cleanup, and error behavior.
