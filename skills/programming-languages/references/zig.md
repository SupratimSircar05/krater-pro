# Zig

## Ecosystem detection

- Confirm `.zig`, `build.zig`, `build.zig.zon`, Zig C/C++ integration, or freestanding/embedded targets.
- Determine exact Zig version/commit because build API and language semantics change rapidly; inspect target, optimize mode, libc, and CPU features.

## Canonical toolchains

- Use the pinned Zig binary/version manager/container and `zig build`; use direct `zig test`/`zig run` only when repository structure supports it.
- Standard formatting is `zig fmt`; tests are language/build-runner tests. Linters/analyzers are project-specific.
- Zig may be the C/C++ compiler/linker; preserve target/sysroot/libc configuration.

## Inspect-first files

- Read `build.zig`, `build.zig.zon`, version pins, modules/dependencies, build options, target/link settings, generated files, C headers, allocator policy, tests, and CI.
- Trace error unions, optionals, comptime/generics, ownership, allocator parameters, defer/errdefer, sentinel/slice lifetimes, and exported ABI.

## Build, test, lint, and format

- Use `zig build`, declared steps such as `zig build test`, and configured target/optimize options discovered from `zig build --help`.
- Run `zig fmt --check` or repository formatting command; direct `zig test path.zig` may miss build options/modules.
- Cross-build all affected target triples and run only where executable. Do not update dependency hashes/URLs except for intentional dependency changes.

## Implementation idioms

- Make allocators and ownership explicit; pair allocations/resources with `defer`/`errdefer` and avoid returning slices into dead storage.
- Propagate error unions with context appropriate to local APIs; handle optionals and exhaustive switches.
- Keep comptime work bounded and readable; isolate `@ptrCast`/unsafe pointer arithmetic behind validated invariants.

## Debugging workflow

- Start with the first compile/comptime error. Reproduce in Debug mode and one test.
- Use GDB/LLDB, Zig stack traces, sanitizers where target/toolchain support them, build verbose output, emitted IR/assembly, and allocation-debug tools.
- Verify exact Zig version before modifying code for build API errors.

## Concurrency, memory, and performance

- Use explicit synchronization/atomics and thread ownership; standard-library concurrency APIs are version-sensitive.
- Respect allocator thread safety, object lifetimes, callback threads, and cancellation/shutdown for spawned threads.
- Benchmark optimized modes. Watch allocations, bounds checks, copies, comptime/code size, integer overflow mode differences, alignment, and cache layout.

## Security hazards

- Audit pointer casts, slices, integer arithmetic, C interop, parsers, allocators, command/path construction, and untrusted sizes.
- Do not rely on safety checks that disappear/change in release modes; validate at trust boundaries.
- Review dependency build code and avoid logging secrets or accepting unverified downloads.

## Interoperability

- Verify C ABI, `extern`/`export`, calling convention, layout/alignment, null/sentinel pointers, ownership/allocator pairing, libc, and symbol linkage.
- Zig internal ABI/layout is not a stable foreign interface; use C-compatible types.
- Test cross-target artifacts and generated headers/bindings.

## Common failure modes

- Zig version/build API mismatch; comptime evaluation surprise; slice/use-after-scope; wrong allocator frees memory.
- Release-mode overflow/undefined behavior; sentinel mismatch; cross-target libc/sysroot/link failure; C macro/bitfield translation mismatch.

## Verification checklist

- [ ] Confirm exact Zig version, target/CPU, optimize mode, libc, and build steps.
- [ ] Run focused tests, `zig build test`, format check, and debug/release builds.
- [ ] Test allocation failures, errors, boundaries, and supported cross targets.
- [ ] Audit pointer/comptime/allocator/thread invariants.
- [ ] Verify C ABI/linking and target runtime behavior.
