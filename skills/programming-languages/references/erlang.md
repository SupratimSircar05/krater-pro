# Erlang

## Ecosystem detection

- Confirm `.erl`, `.hrl`, `.app.src`, `rebar.config`, `rebar.lock`, OTP application layout, or release config.
- Determine Erlang/OTP version, Rebar3/Make/Bazel workflow, parse transforms, NIFs/drivers, and release/embedded target.

## Canonical toolchains

- Prefer repository `rebar3`; use Make/erlc only when authoritative.
- Tests may use EUnit, Common Test, Proper, or custom suites. Quality tools may include formatter, Dialyzer, xref, Elvis, and coverage.
- Release tooling may use relx/Rebar, Mix, or custom scripts.

## Inspect-first files

- Read `rebar.config`, lock, app/resource files, supervision/application modules, release config, sys/runtime config, records/includes, parse transforms, NIF code, and CI.
- Trace registered names, process links/monitors, messages, ETS/Mnesia, hot upgrade policy, and distribution/security configuration.

## Build, test, lint, and format

- Use `rebar3 compile`, `rebar3 eunit`, `rebar3 ct`, or focused suite/case options supported by the configured version.
- Run configured format, Dialyzer, xref, Proper, docs, and release builds. Do not update the lock or deploy a release for local validation.
- Compile/test with production profiles when profile-specific dependencies/macros matter.

## Implementation idioms

- Use pattern matching, tagged tuples, behaviours, immutable state, supervision, selective receive with care, and explicit timeout/error semantics.
- Keep server callbacks responsive, offload blocking work, and avoid process dictionary for ordinary state.
- Preserve message protocol compatibility and let supervisors own restarts rather than defensive catch-all loops.

## Debugging workflow

- Reproduce one EUnit/CT/Proper case. Inspect crash reports, linked exits, error_logger/Logger metadata, SASL reports, and full exception reason/stack.
- Use shell tracing, `sys` inspection, Observer, recon tools, process/ETS/mailbox metrics, and release config checks cautiously.
- For distribution failures, verify node naming, cookies, ports, TLS, and version compatibility without exposing secrets.

## Concurrency, memory, and performance

- Bound mailboxes and process creation; understand copying, off-heap binaries, schedulers, reductions, ETS contention, timers, and backpressure.
- Use links/monitors/supervisors deliberately. Do not block schedulers with long NIFs or unmanaged ports.
- Profile scheduler/process memory, binary retention, GC, message sizes, ETS patterns, and Mnesia transactions under realistic load.

## Security hazards

- Never create atoms from untrusted input or use unsafe `binary_to_term` options. Restrict distribution cookies/ports/TLS and remote code capabilities.
- Validate message/data shapes, command/path construction, uploads, and resource limits. Redact process state/crash reports.
- Audit NIFs, ports, parse transforms, and release scripts as native/executable boundaries.

## Interoperability

- Preserve Elixir/Erlang behaviours, record/map representation, app names, return tuples, exceptions, and OTP version expectations.
- Define external term/JSON/protobuf versioning and safe decoding limits.
- NIF/driver/port protocols require ABI, ownership, scheduling, framing, and crash strategy.

## Common failure modes

- OTP/Rebar profile mismatch; missing application dependency; stale parse transform; registered-name collision.
- Mailbox growth; selective receive starvation; call cycle/deadlock; linked exit not trapped correctly; binary retained by small sub-binary; unsafe NIF stalls VM.

## Verification checklist

- [ ] Confirm OTP/Rebar/profile, lock, app dependencies, and release target.
- [ ] Run focused/full EUnit/CT/Proper, Dialyzer/xref, format, and compile warnings.
- [ ] Test supervision, exits, timeouts, mailbox pressure, and shutdown.
- [ ] Verify distribution/release config and safe term/message handling.
- [ ] Exercise Elixir, NIF/port, storage, and wire compatibility.
