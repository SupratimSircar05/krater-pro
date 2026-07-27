# Fortran

## Ecosystem detection

- Confirm `.f`, `.for`, `.f90`/`.F90` and related extensions, modules, CMake/Make/fpm files, preprocessing, or scientific/HPC build scripts.
- Determine fixed/free form, Fortran standard, compiler family/version, preprocessing, ABI, precision/kind policy, BLAS/LAPACK/MPI/OpenMP/GPU target.

## Canonical toolchains

- Use configured gfortran, Intel oneAPI (`ifx`/legacy `ifort`), NVHPC, Cray, IBM, NAG, Flang, or vendor compiler.
- Build through fpm, CMake, Make, Meson, or HPC environment modules as declared.
- Tests may use pFUnit, FRUIT, test-drive, fpm tests, CTest, numerical comparison scripts, and compiler runtime checks.

## Inspect-first files

- Read build/toolchain files, compiler flags, module output/include paths, precision/kind modules, preprocessor macros, interfaces, common blocks, generated code, data files, batch scripts, and CI.
- Trace array shapes/bounds, intent/allocatable/pointer ownership, implicit typing, numerical tolerances, I/O formats, MPI decomposition, and C interoperability.

## Build, test, lint, and format

- Use repository targets/presets and exact compiler. Common flows include `fpm test` or CMake build plus CTest, but compiler flags are project-specific.
- Enable bounds, uninitialized, floating-point, interface, and backtrace checks in a compatible debug configuration; names differ by compiler.
- Run configured formatter/linter/static checks and optimized target build. Compare multiple supported compilers when portability matters.

## Implementation idioms

- Prefer modules, `implicit none`, explicit interfaces, `intent`, `iso_fortran_env` kinds, allocatables, pure/elemental procedures, and `iso_c_binding`.
- Preserve column-major arrays, 1-based/custom bounds, assumed-shape rules, pass-by-reference semantics, and numerical reproducibility.
- Avoid new common blocks, equivalence, implicit typing, aliasing that violates optimizer assumptions, and exact floating comparison.

## Debugging workflow

- Reproduce with debug checks and small deterministic input. Use GDB/vendor debuggers, compiler diagnostics, backtraces, IEEE exception trapping, sanitizers where supported, and MPI rank-local logs.
- Inspect shapes/bounds/strides/kinds, allocation state, interfaces, NaN/Inf, initialization, and file records.
- Compare debug/optimized and compiler implementations to expose undefined/uninitialized/aliasing behavior.

## Concurrency, memory, and performance

- Understand OpenMP data sharing, MPI collectives/order, coarrays, accelerator mappings, BLAS threading, and compiler auto-vectorization.
- Avoid races on saved/module state and oversubscription across MPI/OpenMP/BLAS. Pair allocations and collective calls on all ranks.
- Profile representative optimized jobs; inspect vectorization reports, cache/stride access, temporary arrays, communication, false sharing, and I/O.

## Security hazards

- Validate array dimensions, record lengths, integer allocation arithmetic, file paths, formatted input, and MPI message counts.
- Avoid unchecked C pointers, out-of-bounds hidden by optimization, unsafe temporary files, command execution from input, and secrets in batch logs.
- Treat legacy binary parsers and privileged HPC job scripts as sensitive.

## Interoperability

- Use `bind(C)` and `iso_c_binding`; verify name mangling, pass-by-value/reference, character strings, logical representation, complex types, descriptors, and ownership.
- Define column-major/order, index base, kind/precision, endian/record format, MPI ABI, and BLAS integer width.
- Test Python/R/MATLAB wrappers against exact compiler/runtime libraries.

## Common failure modes

- Compiler/module file incompatibility; fixed/free-form misread; implicit type; array temporary or shape mismatch.
- Uninitialized/save-state dependence; debug passes but optimized fails; integer kind overflow; MPI collective mismatch/deadlock; BLAS LP64/ILP64 mismatch.

## Verification checklist

- [ ] Confirm compiler/standard, source form, flags, precision, libraries, and HPC target.
- [ ] Run focused/full numerical tests with debug checks and optimized build.
- [ ] Compare tolerances, NaN/Inf, bounds/shapes, and representative datasets.
- [ ] Test MPI/OpenMP/coarray behavior and profile scaling if affected.
- [ ] Verify C/data/BLAS ABI and at least the supported compiler matrix.
