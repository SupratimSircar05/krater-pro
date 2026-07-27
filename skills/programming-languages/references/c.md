# C

## Ecosystem detection

- Confirm `.c`/`.h`, a C language standard flag, C targets in CMake/Meson/Make/Autotools, or embedded toolchain files.
- Distinguish hosted versus freestanding C, C standard/dialect, compiler family, libc, architecture, ABI, and cross-compilation target.

## Canonical toolchains

- Use configured GCC, Clang, MSVC C mode, vendor/embedded compiler, or cross toolchain.
- Build through the repository's CMake, Meson, Make, Ninja, Autotools, Bazel, or IDE project; never replace it with an ad hoc compile command for final verification.
- Tests and analysis may use CTest, Meson test, Unity/CMocka, sanitizers, Valgrind, clang-tidy, cppcheck, or compiler warnings.

## Inspect-first files

- Read build files, toolchain/preset files, compiler flags, feature-test macros, config headers, linker scripts, generated headers, package metadata, and CI.
- Trace public headers, ownership contracts, allocation strategy, platform abstraction, and conditional compilation.

## Build, test, lint, and format

- Use configured presets/wrappers, e.g. `cmake --preset <name>` then `cmake --build --preset <name>` and `ctest --preset <name>`, or `meson compile -C <build>` and `meson test -C <build>`.
- For Make/Autotools/vendor builds, inspect targets/options first; use the repository's test target.
- Run configured `clang-format --dry-run --Werror`, clang-tidy/cppcheck, and warning-as-error build. Add `-fsanitize=address,undefined` only on compatible host builds.

## Implementation idioms

- Make ownership, lifetime, buffer length, nullability, error returns, and aliasing explicit.
- Check integer conversions and allocation arithmetic; use bounded APIs and single-exit cleanup only when it improves resource correctness.
- Preserve ABI layout, calling convention, symbol visibility, macro semantics, and volatile/MMIO requirements.

## Debugging workflow

- Reproduce with symbols and minimal optimization when permitted, then use GDB/LLDB, core dumps, sanitizers, Valgrind, compiler diagnostics, or hardware probes.
- Inspect the first invalid read/write, lifetime violation, data race, or error-code loss rather than the eventual crash.
- Compare preprocessed output, link map/symbol tables, and disassembly for macro, link, ABI, or optimization-sensitive issues.

## Concurrency, memory, and performance

- Use the C memory model for atomics and happens-before; `volatile` is not thread synchronization.
- Pair every allocation/resource acquisition with unambiguous ownership and cleanup. Guard signal-handler and interrupt-context operations.
- Measure with profilers/counters and representative builds. Watch cache layout, false sharing, alignment, undefined behavior, and compiler optimization assumptions.

## Security hazards

- Prevent buffer overflows, use-after-free, double-free, format-string bugs, integer overflow, unterminated strings, TOCTOU, and command/path injection.
- Validate lengths before pointer arithmetic and copies. Avoid unbounded legacy functions and unsafe temporary-file patterns.
- Treat input parsers, FFI, privileged code, firmware update paths, and cryptography as high risk; enable hardening flags configured for the target.

## Interoperability

- Define ABI, endianness, packing/alignment, integer widths, ownership, allocator pairing, callbacks, and error conventions.
- Use `extern "C"` guards for C++ consumers and stable FFI-safe types for other languages.
- Verify cross-target headers, linkage, symbol versions, and generated bindings.

## Common failure modes

- Implicit/incorrect declarations; signed/unsigned or truncation errors; macro double evaluation; missing terminator; dangling stack pointer.
- Undefined behavior visible only under optimization; linker order; duplicate/missing symbols; cross-compiler struct layout; uninitialized padding.

## Verification checklist

- [ ] Confirm compiler, standard, ABI, target, and build configuration.
- [ ] Run focused tests plus warning-clean normal build.
- [ ] Run compatible sanitizers/static analysis and inspect leaks.
- [ ] Test boundary sizes, errors, cleanup, and malformed inputs.
- [ ] Verify ABI/cross-build and target runtime or hardware behavior.
