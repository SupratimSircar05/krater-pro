# C++

## Ecosystem detection

- Confirm C++ sources/headers/modules, build targets, and standard flags. Extensions alone do not reveal C++ version or compiler.
- Determine compiler, standard library, ABI, architecture, C++ standard, module support, sanitizer compatibility, and package manager from build presets and CI.

## Canonical toolchains

- Use configured CMake/Meson/Bazel/Make/MSBuild/Xcode and Conan/vcpkg/system packages only as the repository specifies.
- Tests may use GoogleTest, Catch2, Boost.Test, doctest, or CTest. Quality tools include clang-format, clang-tidy, include-what-you-use, sanitizers, and static analyzers.
- Prefer repository compiler presets/toolchain files over local defaults.

## Inspect-first files

- Read `CMakePresets.json`, `CMakeLists.txt`, Meson/Bazel/project files, toolchain and dependency manifests, compiler flags, public headers/modules, generated code, and CI.
- Identify ownership models, exception/RTTI policy, ABI surface, template instantiation boundaries, platform guards, and allocator use.

## Build, test, lint, and format

- Use configured presets, e.g. `cmake --preset <name>`, `cmake --build --preset <name>`, and `ctest --preset <name>`; use the equivalent repository commands for other systems.
- Filter tests through the selected runner. Run formatting in check mode and configured clang-tidy/static analysis.
- Exercise debug and optimized builds when behavior could depend on undefined behavior, inlining, templates, or assertions. Use ASan/UBSan/TSan/MSan only where supported and avoid incompatible combinations.

## Implementation idioms

- Prefer RAII, value semantics, explicit ownership, smart pointers with justified sharing, spans/views with valid lifetimes, and strong types.
- Follow the repository's exception/error model and C++ standard. Preserve const correctness, move/copy guarantees, iterator validity, and API/ABI stability.
- Avoid owning raw pointers, naked `new`/`delete`, macro tricks, and premature template metaprogramming.

## Debugging workflow

- Start with complete compiler/template diagnostics or the first sanitizer finding. Minimize one failing test/translation unit.
- Use GDB/LLDB/Visual Studio, core dumps, sanitizer stacks, heap tools, thread analyzers, symbol inspection, and preprocessed output.
- For link/ODR issues, inspect symbols, visibility, library order, inline definitions, ABI flags, and duplicate dependency versions.

## Concurrency, memory, and performance

- Apply the C++ memory model; protect shared data and reason about atomic ordering, condition predicates, cancellation, and object lifetime.
- Avoid detached work and callbacks capturing invalid objects. Bound pools/queues and document thread affinity.
- Benchmark with optimized representative binaries. Profile allocation, cache misses, virtual dispatch, copies/moves, contention, false sharing, and vectorization.

## Security hazards

- Prevent lifetime bugs, out-of-bounds access, iterator invalidation, integer overflow, format-string misuse, unsafe deserialization, command injection, and path traversal.
- Use safe views/containers without extending them beyond owners. Validate sizes before allocation and narrow conversions.
- Harden parsers and FFI boundaries; do not disable TLS or compiler hardening to bypass failures.

## Interoperability

- Expose stable C ABIs where cross-compiler compatibility matters. Define ownership, allocator, exceptions, callbacks, packing, and calling conventions.
- Check standard-library/CRT/compiler ABI compatibility, symbol visibility, language bindings, and generated code versions.
- Never allow exceptions to cross a C ABI or foreign runtime boundary without an explicit bridge.

## Common failure modes

- Dangling reference/view; use after move; uninitialized member; ODR violation; wrong virtual destructor; iterator invalidation.
- Debug-only success; ABI/CRT mismatch; static initialization order; template constraint confusion; missing transitive include; data race.

## Verification checklist

- [ ] Confirm compiler, standard library, C++ level, ABI, and preset.
- [ ] Run focused tests and warning-clean debug/optimized builds.
- [ ] Run configured format/static checks and supported sanitizers.
- [ ] Test ownership, exception/error, concurrency, and boundary cases.
- [ ] Verify ABI consumers, packaging, and target runtime behavior.
