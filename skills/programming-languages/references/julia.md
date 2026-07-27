# Julia

## Ecosystem detection

- Confirm `.jl`, `Project.toml`, `Manifest.toml`, Julia package layout, Pluto notebooks, or Julia-specific CI.
- Determine Julia version, active project, package/app/notebook role, sysimage/GPU/MPI/native dependencies, and manifest platform assumptions.

## Canonical toolchains

- Use Julia's `Pkg` with `--project` and the committed manifest. Packages use `Pkg.test`; documentation/builds commonly use Documenter or repository scripts.
- Quality tools may include JuliaFormatter, Aqua, JET, StaticLint, coverage, BenchmarkTools, and PackageCompiler when configured.
- Use Pluto/IJulia tooling only for corresponding notebooks and preserve reproducible environments.

## Inspect-first files

- Read `Project.toml`, `Manifest.toml`, `LocalPreferences.toml` policy, `src/<Package>.jl`, `test/runtests.jl`, `Artifacts.toml`, extension/weak-dependency declarations, formatter config, and CI.
- Trace module load order, multiple dispatch, type stability, globals, generated functions, native artifacts, threading, and distributed setup.

## Build, test, lint, and format

- Instantiate without resolving versions: `julia --project=. -e 'using Pkg; Pkg.instantiate()'`.
- Test with `julia --project=. -e 'using Pkg; Pkg.test()'` or focused repository/test script. Run formatter check/Aqua/JET only when configured.
- Build docs, sysimages, or artifacts through repository commands; never rewrite the manifest with `Pkg.update()` just to test.

## Implementation idioms

- Use multiple dispatch around stable abstractions, concrete field types where helpful, generic numeric/array interfaces, and mutation `!` naming.
- Avoid untyped global hot-path state, method piracy, invalidating broad method definitions, and needless type annotations on arguments.
- Preserve missing/nothing semantics, 1-based indexing, views/copies, dimensionality, and numerical tolerance.

## Debugging workflow

- Reproduce in a fresh process with exact project/version. Use stack traces, `@show`, Debugger/Infiltrator, `@code_warntype`, `@which`, `methods`, and package status.
- Separate compilation latency from runtime performance and package resolution from code defects.
- For native crashes/GPU/MPI, verify artifacts/drivers/ABI and reduce to the boundary call before changing algorithms.

## Concurrency, memory, and performance

- Understand tasks, threads, channels, distributed workers, thread-local state, and library thread safety. Do not mutate shared arrays unsafely.
- Profile and benchmark after warm-up with interpolated inputs. Watch type instability, dynamic dispatch, globals, allocations, broadcasting temporaries, views, and BLAS oversubscription.
- Preserve GC roots and Julia thread rules in `ccall`/callbacks.

## Security hazards

- Do not evaluate/include untrusted Julia or deserialize untrusted Julia objects. Treat package build scripts and artifacts as executable supply-chain inputs.
- Prevent shell/SQL/path injection, unsafe temporary files, oversized data allocation, and secrets in notebook outputs/logs.
- Validate network downloads and cryptographic/TLS settings.

## Interoperability

- For `ccall`, match ABI, types, ownership, nullability, callbacks, GC preservation, and library lifetime.
- Define Arrow/JSON/table missing values, categorical/date/timezone behavior, array order/strides, and numeric precision.
- Verify Python/R/GPU/MPI bridge versions and environment isolation.

## Common failure modes

- Wrong active project/manifest; world-age or method invalidation; type instability; global-scope performance; accidental copy.
- Precompilation cache/extension mismatch; artifact unavailable on target; task exception not fetched; 1-based/column-major assumption.

## Verification checklist

- [ ] Confirm Julia version, active project, manifest, artifacts, and target.
- [ ] Run focused/package tests, configured formatter/static checks, and docs/build.
- [ ] Test fresh-process startup/precompile and representative numerics.
- [ ] Benchmark after warm-up and inspect allocations/type stability.
- [ ] Verify native/GPU/distributed/data boundaries and reproducibility.
