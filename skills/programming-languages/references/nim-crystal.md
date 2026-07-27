# Nim and Crystal

## Ecosystem detection

- Nim: confirm `.nim`, `.nimble`, `nim.cfg`, lock/version-manager files, or generated C/C++/JS targets.
- Crystal: confirm `.cr`, `shard.yml`, `shard.lock`, `spec/`, or Crystal project layout.
- Identify which language first; despite similar syntax, toolchains, type systems, concurrency, and libraries are unrelated.

## Canonical toolchains

- Nim uses pinned `nim` plus Nimble/Atlas or repository build tools; tests may use `unittest`, testament, or custom tasks; formatting often uses `nimpretty` when configured.
- Crystal uses pinned `crystal` plus Shards; tests use `crystal spec`; formatting uses `crystal tool format`.
- Respect target backend, GC/memory mode, threads, cross compiler, and native library requirements.

## Inspect-first files

- Nim: read nimble/config/lock files, compiler switches/defines, macros/templates, generated-code policy, C/JS backend settings, tests, and CI.
- Crystal: read shard/lock, compiler version pin, specs, macros/annotations, native link flags, formatter policy, and CI.
- For both, trace ownership/lifetime at FFI, exceptions/results, compile-time code, global initialization, and platform branches.

## Build, test, lint, and format

- Nim commands vary by project: use declared Nimble tasks, commonly `nimble test`, and compile via repository flags; `nim check`/`nimpretty` only when supported/configured.
- Crystal: use `shards install` without updating lock, `crystal spec [path]`, `crystal tool format --check`, and `crystal build` with repository release flags.
- Test debug and release modes plus configured C/C++/JS backend or static/cross builds; do not invent flags across compiler versions.

## Implementation idioms

- Nim: preserve distinct/ref/value types, effect/exception policy, iterators, generics, macros/templates, ownership/GC mode, and explicit C bindings.
- Crystal: preserve nilable unions, structs/classes, blocks, macros, exception model, enumerable laziness, and type inference across all call sites.
- In both, avoid hiding runtime behavior in macros, returning borrowed foreign memory without lifetime contracts, or weakening types to bypass compiler errors.

## Debugging workflow

- Confirm exact compiler version and full compile command. Reduce to one module/spec and inspect first compiler/macro expansion error.
- Use emitted C/C++/JS and native debuggers for Nim backend faults; use Crystal debugger/backtraces, expanded macros, and native linker diagnostics.
- Inspect dependency resolution, conditional defines, and generated code before clearing caches.

## Concurrency, memory, and performance

- Nim concurrency, ARC/ORC/refc, async runtimes, threads, and channels depend on compiler flags/version; verify thread-safety of shared objects and foreign libraries.
- Crystal fibers are cooperatively scheduled; blocking native calls can stall execution. Bound channels/fibers and close resources.
- Benchmark release builds; watch allocations, GC/ARC cycles, copying, macros/code size, C calls, async backpressure, and integer overflow behavior.

## Security hazards

- Audit compile-time macros, unsafe pointers, C bindings, serialization, command/SQL interpolation, path/archive handling, and untrusted sizes.
- Avoid executing untrusted Nim/Crystal code or build hooks and keep secrets out of compile flags/logs.
- Validate TLS, auth, parser limits, and file permissions in network applications.

## Interoperability

- Define C ABI/layout/calling convention, ownership, callbacks, GC rooting, exceptions, strings/slices, and compiler-generated symbol names.
- Nim JS backend requires JS module/type/null behavior; Crystal native libraries require compatible libc/architecture.
- Preserve JSON/date/numeric/null schema behavior and shard/nimble public APIs.

## Common failure modes

- Nim compiler/GC/backend/define mismatch; template hygiene or macro expansion; C generated code fails on target; dangling `cstring`.
- Crystal compiler mismatch; nilability inferred differently; fiber blocked by native call; shard native library missing; release-only overflow.

## Verification checklist

- [ ] Identify Nim versus Crystal and confirm compiler, package manager, target, memory/runtime mode, and lock.
- [ ] Run focused/full tests, configured format/checks, and debug/release builds.
- [ ] Test compile-time branches, errors, memory cleanup, and concurrency.
- [ ] Cross-build/run supported targets and inspect generated/native boundary failures.
- [ ] Verify C/JS/wire compatibility and malformed-input security.
