# Elixir

## Ecosystem detection

- Confirm `.ex`/`.exs`, `mix.exs`, `mix.lock`, umbrella layout, Phoenix/Ecto config, or release files.
- Determine Elixir and OTP versions from `.tool-versions`, containers, Mix requirements, and CI. Distinguish Mix, Livebook, Nerves, and scripts.

## Canonical toolchains

- Use Mix with locked Hex/Rebar dependencies and the selected `MIX_ENV`.
- Tests use ExUnit; quality commonly uses `mix format`, Credo, Dialyzer, ExCoveralls, Sobelow, and docs when configured.
- Phoenix, Ecto, LiveView, releases, and Nerves add target-specific tasks and runtime constraints.

## Inspect-first files

- Read `mix.exs`, `mix.lock`, umbrella apps, `config/*.exs`, runtime config, supervision trees, endpoint/router, schemas/migrations, formatter/quality config, releases, and CI.
- Trace process ownership, GenServer state, ETS, PubSub, Task supervision, application environment, and generated assets/code.

## Build, test, lint, and format

- Fetch/compile with repository wrappers or `mix deps.get`/`mix compile` without unlocking dependencies.
- Run `mix test`, focused `mix test path:line`, `mix format --check-formatted`, and configured Credo/Dialyzer/security tasks.
- Run Ecto migrations only against an explicit test/local database. Build assets/releases/Nerves firmware through configured aliases without deploying.

## Implementation idioms

- Use pattern matching, tagged tuples, immutable data, protocol/behaviour contracts, supervised processes, and explicit boundaries.
- Keep GenServer callbacks small; perform work in appropriate supervised tasks and never use a process as an unnecessary object wrapper.
- Preserve OTP error/supervision semantics, timeouts, idempotency, and Ecto changeset/transaction behavior.

## Debugging workflow

- Reproduce one ExUnit case and inspect exception/process exit chains. Use `dbg`, IEx, Logger metadata, `:sys.get_state` cautiously, observer/telemetry, and Ecto query logs.
- Inspect process mailbox, links/monitors, supervisor restart intensity, application config, and dependency compilation.
- Separate compilation/protocol consolidation from runtime cluster/process failures.

## Concurrency, memory, and performance

- Design bounded mailboxes, demand/backpressure, supervision, cancellation, timeouts, and retry ownership.
- Avoid blocking scheduler threads with NIFs, unsupervised `spawn`, large process state, atom creation from input, and message copying of huge terms.
- Measure scheduler utilization, reductions, memory by process/ETS/binary, GC, query latency, and LiveView render payloads.

## Security hazards

- Never convert untrusted strings to atoms. Avoid unsafe term deserialization, dynamic module/function selection, command/SQL injection, path traversal, and secrets in inspected terms.
- Enforce Phoenix CSRF/origin/session/authz and safe Ecto parameterization. Limit uploads, bodies, channels, and atom/table growth.
- Treat config/releases and dependencies with NIFs/build hooks as sensitive.

## Interoperability

- Define JSON atom/string keys, date/time, decimal, binary/Base64, protobuf, and Ecto database semantics.
- For Erlang, preserve records/maps, behaviours, exception/return conventions, app names, and OTP compatibility.
- NIF/ports require ABI, ownership, scheduler, time limits, and crash isolation.

## Common failure modes

- Wrong Elixir/OTP; stale compiled protocol/dependency; process not supervised; mailbox leak; linked exit surprises.
- GenServer call deadlock; timeout while work continues; dynamic atom leak; Ecto preload/N+1/transaction issue; runtime config absent in release.

## Verification checklist

- [ ] Confirm Elixir/OTP, Mix environment, lock, umbrella app, and target.
- [ ] Run focused/full ExUnit, format, Credo/Dialyzer, and compile warnings.
- [ ] Test supervision/restarts, timeouts, mailbox pressure, and shutdown.
- [ ] Verify Ecto/auth/input limits and release/asset build.
- [ ] Exercise Erlang/NIF/wire/cluster boundaries.
