# MATLAB and Octave

## Ecosystem detection

- Confirm `.m`, `.mlx`, `.slx`, MATLAB project/toolbox files, `mex` sources, or Octave package metadata.
- Distinguish MATLAB from GNU Octave, release/version, installed toolboxes, Simulink, code generation, GPU, and target hardware.

## Canonical toolchains

- Use the pinned MATLAB release and required toolboxes/licenses; use Octave only when the project explicitly supports it.
- Tests may use `matlab.unittest`, project test runners, Simulink Test, or Octave BIST.
- Quality/build tools include Code Analyzer, `matlab -batch`, toolbox packaging, MEX, codegen, and model checks as configured.

## Inspect-first files

- Read MATLAB project metadata, startup/path setup, tests, package/class directories (`+pkg`, `@Class`), toolbox requirements, data dictionaries, model callbacks, MEX build scripts, and CI.
- Identify path precedence, persistent/global state, random seed, numeric types/shapes, generated code, solver/sample-time settings, and platform dependencies.

## Build, test, lint, and format

- Prefer headless repository commands such as `matlab -batch "results=runtests(...); assertSuccess(results)"`; quote through a script/runner when expressions become complex.
- Use Octave `octave --no-gui --quiet <script>` or `test` only for explicitly supported projects.
- Run Code Analyzer/project checks and configured model/codegen/MEX/toolbox builds. Command APIs vary by release, so copy CI/project usage rather than inventing flags.

## Implementation idioms

- Preserve matrix dimensions, column-major layout, 1-based indexing, complex numbers, class/value-handle semantics, and implicit expansion compatibility.
- Preallocate when material, vectorize for clarity/performance, and distinguish elementwise (`.*`, `./`, `.^`) from matrix operations.
- Avoid modifying global path/options/state without restoration; make units, coordinate frames, and tolerances explicit.

## Debugging workflow

- Reproduce with exact release/toolboxes in a clean path/session. Use `dbstop if error`, debugger, diagnostic reports, profiler, test diagnostics, and minimal MAT data.
- Inspect `size`, `class`, sparsity, `NaN`/`Inf`, complex values, table/categorical types, and path resolution (`which -all`).
- For Simulink, inspect model diagnostics, solver/sample times, algebraic loops, initialization callbacks, and generated-code logs.

## Concurrency, memory, and performance

- Understand implicit multithreading, `parfor`/workers, GPU arrays, tall/distributed arrays, and MEX thread safety.
- Avoid oversubscribing BLAS/workers and repeatedly transferring CPU/GPU data.
- Profile representative data. Watch temporary arrays, growing matrices, dense conversion, copies from indexing, worker data transfer, and persistent caches.

## Security hazards

- Do not execute untrusted scripts/models/MAT objects or load arbitrary MEX binaries.
- Prevent command/path injection, unsafe archive/file access, secrets in scripts/workspaces/figures, and unbounded data allocation.
- Treat model callbacks, startup files, Java integration, and generated build hooks as executable code.

## Interoperability

- Verify MEX API/interleaved-complex mode, compiler support, ownership, dimensions, integer widths, and architecture.
- Define HDF5/MAT version, array order, indexing, missing values, table/categorical, timezone, and numeric precision across Python/C/Fortran.
- For Simulink/codegen, validate interface buses, sample timing, fixed-point, and target compiler.

## Common failure modes

- Wrong function selected from path; toolbox/release mismatch; script/function name collision; row/column shape drift.
- Matrix versus elementwise operator; implicit expansion unavailable; handle aliasing; stale persistent state; MEX ABI mismatch; model callback side effects.

## Verification checklist

- [ ] Confirm MATLAB/Octave release, toolboxes, project path, and target.
- [ ] Run focused/full tests and Code Analyzer/project checks.
- [ ] Test dimensions, types, `NaN`/`Inf`, tolerances, and representative data.
- [ ] Profile memory/runtime and parallel/GPU behavior if affected.
- [ ] Verify MEX/model/codegen/data interchange on target.
