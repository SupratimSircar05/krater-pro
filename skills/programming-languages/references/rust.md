# Rust

## Ecosystem detection

- Confirm `.rs`, `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, workspace members, or Bazel/non-Cargo Rust targets.
- Determine stable/beta/nightly, edition, target triple, feature set, `no_std`, async runtime, and FFI/WASM/embedded constraints.

## Canonical toolchains

- Prefer `rustup`-pinned `cargo` and repository aliases/config. Use non-Cargo build systems only when authoritative.
- Standard checks are rustfmt, Clippy, `cargo check/build/test`; additional tools may include nextest, Miri, cargo-deny/audit, tarpaulin/llvm-cov, criterion, loom, and fuzzers.
- Honor workspace feature resolver, default features, and minimum-supported-Rust policy.

## Inspect-first files

- Read workspace/package manifests, lockfile policy, toolchain file, `.cargo/config.toml`, feature declarations, build scripts, generated bindings, unsafe modules, and CI.
- Trace crate boundaries, public API, error types, async runtime, target cfgs, proc macros, and vendoring.

## Build, test, lint, and format

- Use `cargo fmt --all -- --check`, `cargo check --workspace --all-targets`, configured `cargo clippy ... -- -D warnings`, and `cargo test` or `cargo nextest run`.
- Narrow with `cargo test -p <crate> <filter> -- --exact`; supply the same feature/target flags as production.
- Build/check feature combinations and targets actually supported. Run docs/tests, examples, `no_std`, Miri, audit, or semver checks when configured.

## Implementation idioms

- Encode ownership/lifetimes and invariants in types; use `Result`/`Option`, iterator patterns, RAII guards, and minimal public surface.
- Preserve error context and cancellation/resource behavior. Avoid `unwrap`/`expect` in recoverable library/server paths.
- Isolate `unsafe`, state its invariants, minimize its scope, and expose safe wrappers.

## Debugging workflow

- Start with the first compiler error or panic cause; later borrow/type errors are often cascades.
- Use focused tests with backtraces, `dbg!` temporarily, rust-gdb/rust-lldb, logs/tracing, Miri for undefined behavior, and dependency/feature trees.
- Inspect macro expansion, build-script output, target cfg, and linker args when generation or linking fails.

## Concurrency, memory, and performance

- Respect `Send`/`Sync`, pinning, atomics, lock ordering, async cancellation, task ownership, and blocking pools.
- Avoid holding locks across `.await`, detached tasks without shutdown, unbounded channels, or accidental cloning/copying.
- Benchmark/profile release builds. Watch allocation, bounds checks, monomorphization/code size, contention, cache behavior, and async wakeups.

## Security hazards

- Audit unsafe code, FFI, deserialization limits, integer/size arithmetic, path/archive handling, command/SQL construction, and cryptographic usage.
- Avoid leaking secrets through `Debug`, panic, tracing, or core dumps. Review build scripts/proc macros as executable dependencies.
- Use dependency advisories as evidence, not an automatic breaking-upgrade mandate.

## Interoperability

- Expose `repr(C)` FFI types, stable integer widths, explicit ownership/destructors, panic containment, callbacks, and allocator rules.
- Verify C ABI/linkage, WASM host imports, serde/protobuf schema behavior, and language binding generation.
- Rust ABI is not stable; do not expose ordinary Rust layout across foreign or compiler-version boundaries.

## Common failure modes

- Feature unification surprise; target-only compile failure; stale/generated bindings; duplicate native symbols; MSRV regression.
- Deadlock from lock across await; task silently cancelled/detached; self-referential/pinning mistake; unsound unsafe lifetime; integer cast truncation.

## Verification checklist

- [ ] Confirm toolchain, edition, target, features, and MSRV.
- [ ] Run format, check, Clippy, focused/full tests, and docs as configured.
- [ ] Exercise supported feature/target matrix plus Miri/sanitizers/race-model tests where relevant.
- [ ] Review unsafe invariants, async shutdown, and malformed inputs.
- [ ] Verify FFI/wire consumers and release-mode behavior.
