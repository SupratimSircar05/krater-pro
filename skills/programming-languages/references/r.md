# R

## Ecosystem detection

- Confirm `.R`, `.Rmd`, `.qmd`, `DESCRIPTION`, `NAMESPACE`, `renv.lock`, package/project files, or Shiny targets.
- Determine R version, package versus analysis/notebook/app, Bioconductor requirements, and system-library dependencies.

## Canonical toolchains

- Use pinned R via renv, containers, or CI. Packages use `R CMD`/devtools/pkgbuild; tests commonly use testthat.
- Quality tools may include lintr, styler, roxygen2, R CMD check, covr, and language-server tooling.
- Use Quarto/rmarkdown/Shiny-specific commands only when the project config selects them.

## Inspect-first files

- Read `DESCRIPTION`, `NAMESPACE`, `renv.lock`, `.Rprofile` cautiously, project files, `_targets.R`/pipeline config, test helpers, vignettes, native `src/`, and CI.
- Trace seeds, options, locale/timezone, working-directory assumptions, data provenance, generated documentation, and external services.

## Build, test, lint, and format

- Restore through configured renv without updating the lock. Run `Rscript -e 'testthat::test_local()'` or repository test command.
- Package verification uses `R CMD build .` and `R CMD check <tarball>` or configured devtools wrappers; inspect flags and environment first.
- Run configured `lintr::lint_package()`, styler check workflow, documentation generation, and notebook render on the affected artifact.

## Implementation idioms

- Preserve vectorization, missing-value (`NA`/`NaN`/`NULL`) semantics, factors, recycling rules, copy-on-modify, and class system (S3/S4/R6) conventions.
- Use explicit namespaces and stable column selection; avoid global working-directory changes and hidden modification of options/random state.
- Validate shapes/types and make data transformations and statistical assumptions auditable.

## Debugging workflow

- Reproduce in a clean session with pinned library paths and seed. Use `traceback()`, `browser()`, `recover()`, testthat snapshots, warnings-as-signals, and minimal data.
- Inspect classes, attributes, dimensions, missingness, encodings, and dispatch. Capture `sessionInfo()` with secrets/paths redacted.
- For native crashes, isolate C/C++/Fortran boundary and use sanitizers/native debugger in a compatible R build.

## Concurrency, memory, and performance

- Distinguish vectorized native work, process-based parallelism, futures, and thread-safe native libraries. Preserve reproducible RNG streams.
- Avoid exporting huge globals to workers and oversubscribing BLAS plus workers.
- Profile with `profvis`/`Rprof`, bench, and memory tools. Watch copies, growing objects in loops, joins, sparse/dense conversion, and lazy data collection.

## Security hazards

- Avoid evaluating/parsing untrusted R, unsafe deserialization (`readRDS`/workspaces), shell interpolation, SQL construction, and untrusted document code execution.
- Validate file/archive paths, URLs, upload size, and Shiny authorization. Keep tokens out of scripts, history, knitted outputs, and cached artifacts.

## Interoperability

- Define tabular types, missing values, factors/categories, timezone, encodings, and numeric precision across Python/SQL/Arrow.
- For Rcpp/native code, verify protection/GC, ownership, exceptions, thread restrictions, ABI, and package registration.
- Record package/data/schema versions for reproducibility.

## Common failure modes

- Wrong library path/R version; partial argument matching; vector recycling; factor/character mismatch; `NA` comparison mistake.
- Nonstandard evaluation captures wrong column/environment; locale/timezone/seed drift; package check differs from interactive session; implicit copies exhaust memory.

## Verification checklist

- [ ] Confirm R version, lock/library, locale/timezone, seed, and project type.
- [ ] Run focused tests, lint/style, package check or document/app render.
- [ ] Validate statistical/data assumptions, missingness, and boundary shapes.
- [ ] Measure representative performance/memory and reproducibility.
- [ ] Verify native/data-service boundaries and secret-free artifacts.
