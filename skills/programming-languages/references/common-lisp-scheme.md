# Common Lisp and Scheme

## Ecosystem detection

- Confirm `.lisp`/`.lsp`/`.cl` or `.scm`/`.ss`/`.sls`/`.rkt`, ASDF systems, Quicklisp files, Racket packages, Scheme library declarations, or implementation scripts.
- Identify the exact implementation and standard/dialect: SBCL, CCL, ECL, CLISP, ABCL, Racket, Guile, Chez, Gambit, Chicken, or another Scheme. Language/runtime commands are not interchangeable.

## Canonical toolchains

- Common Lisp commonly uses ASDF plus Quicklisp/qlot; Scheme uses implementation package/build tools. Racket uses `raco`; Guile/Chicken/Chez have distinct workflows.
- Tests and quality tools are library/project-specific (FiveAM, Parachute, RackUnit, SRFI test suites, formatters/linters). Follow declared systems/scripts.
- Use implementation version pins, images, features, and package environments from CI.

## Inspect-first files

- Read `.asd`, package definitions, lock/qlot files, Scheme library/module declarations, implementation config, macro files, reader extensions, FFI, test systems, and CI.
- Trace package/module namespaces, readtables, compile/load order, dynamic/special variables, conditions/restarts, continuations, and generated images.

## Build, test, lint, and format

- Common Lisp: load/test through the declared ASDF system in the pinned implementation; command forms vary, so mirror CI or project scripts.
- Racket commonly uses `raco test`, `raco make`, and `raco pkg`; other Schemes require their own runner/compiler.
- Run configured formatter/linter/compiler warning checks and build standalone image/executable only through project tooling.

## Implementation idioms

- Preserve package/module boundaries, lexical versus dynamic binding, macro hygiene/evaluation timing, multiple values, condition/restart or exception conventions, and proper tail behavior where promised.
- In Common Lisp, avoid symbol/package pollution and unintended generic-method overlap. In Scheme, respect the selected report and available SRFIs.
- Prefer functions over macros unless syntax/control of evaluation is required; document mutation and representation invariants.

## Debugging workflow

- Reproduce in exact implementation with a fresh image/environment. Use REPL debugger/restarts, trace, macroexpand, compiler notes, backtraces, and focused test.
- Inspect read versus compile versus load time, package/current module, symbol identity, hygiene, dynamic bindings, and optimization declarations.
- For implementation/native crashes, isolate FFI/image/GC boundary and use implementation diagnostics.

## Concurrency, memory, and performance

- Thread/fiber/future support and memory guarantees are implementation-specific. Do not assume standard thread safety or portable atomics.
- Protect shared mutable structures, close ports/resources, and preserve dynamic bindings across worker boundaries as intended.
- Profile allocation/GC, consing, generic dispatch, numeric boxing, closure retention, continuations, and compiler optimization notes.

## Security hazards

- Reader input can execute or intern symbols depending on settings; disable read-time evaluation and never eval untrusted forms.
- Avoid unsafe deserialization/images, FFI, shell/SQL interpolation, path traversal, package/symbol exhaustion, and unbounded recursion/allocation.
- Treat macros, reader extensions, package install hooks, and saved images as executable supply-chain surfaces.

## Interoperability

- FFI differs by implementation; verify ABI, foreign memory lifetime, callbacks, GC pinning/rooting, exceptions/nonlocal exits, and threads.
- Define s-expression/JSON symbol/string/list/vector/null/numeric conventions and encoding.
- Test JVM/.NET/native embedding or C API against the exact implementation build.

## Common failure modes

- Wrong dialect/implementation; package/symbol identity mismatch; compile/load order; macro captures/evaluates twice.
- Dynamic binding lost; reader case/readtable difference; proper-tail assumption fails; stale saved image; FFI object reclaimed; implementation-only API.

## Verification checklist

- [ ] Confirm implementation, version, standard/dialect, package environment, and features.
- [ ] Run focused/full project tests and configured compile/style checks.
- [ ] Test macro expansion, package/module loading, conditions/errors, and malformed input.
- [ ] Check threading/resource cleanup and implementation portability.
- [ ] Verify FFI, serialization, and standalone image/executable behavior.
