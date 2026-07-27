# OCaml

## Ecosystem detection

- Confirm `.ml`/`.mli`, `dune-project`, `dune` files, `.opam`, `opam.locked`, or `esy.json`.
- Determine OCaml compiler version, Dune/opam/Esy/Nix environment, bytecode/native/JS/WASM target, and language extensions/preprocessors.

## Canonical toolchains

- Prefer Dune with the repository opam/Esy/Nix switch; use ocamlbuild/Make only when authoritative.
- Tests may use Alcotest, OUnit, QCheck, inline tests, Cram tests, or Dune custom rules.
- Quality tools may include ocamlformat, odoc, Merlin, dune lint, and compiler warnings.

## Inspect-first files

- Read `dune-project`, relevant `dune` stanzas, opam package/lock files, compiler pins, `.ocamlformat`, preprocessors/PPX, interfaces, generated modules, and CI.
- Trace module wrapping, functors, variant evolution, effect/Lwt/Async usage, FFI stubs, and target-specific rules.

## Build, test, lint, and format

- Use `dune build`, `dune runtest`, focused `dune build <alias-or-target>`, and `dune fmt`/`dune build @fmt` according to configured Dune version.
- Run `dune build @check`, documentation, expect/inline tests, or project-specific lint aliases when declared.
- Instantiate the selected opam/Esy/Nix environment without upgrading locked dependencies.

## Implementation idioms

- Preserve `.mli` abstraction, algebraic data types, exhaustive matching, immutable data, labeled/optional arguments, and explicit error results.
- Avoid unsafe casts, polymorphic comparison on unsuitable values, exposed representations, and exceptions for routine recoverable flow when local style uses results.
- Respect functor/module boundaries and PPX-generated contracts.

## Debugging workflow

- Start with the first compiler error and inspect inferred signatures/types in Merlin/utop. Reduce one module/test.
- Use `Printexc` backtraces, ocamldebug for bytecode where useful, GDB/native tools for crashes, QCheck shrinking, and Dune verbose rule output.
- Diagnose stale/missing modules through Dune dependency/module wrapping rather than manual compile order.

## Concurrency, memory, and performance

- Distinguish OCaml 4 runtime constraints, OCaml 5 domains/effects, Lwt, Async, and processes. Libraries may not be domain-safe.
- Preserve cancellation/resource brackets and avoid blocking cooperative schedulers.
- Benchmark/profile allocations, minor/major GC, closures, boxing, polymorphic operations, retained structures, and multicore contention.

## Security hazards

- Avoid `Marshal` on untrusted data, dynamic code loading, shell/SQL interpolation, unsafe FFI, path traversal, and unbounded parser recursion/allocation.
- Treat PPX preprocessors, Dune rules, and opam build scripts as executable.
- Keep secrets out of exception printers, derived serializers, and logs.

## Interoperability

- For C stubs, manage GC roots, blocking sections, callbacks, exceptions, ownership, custom blocks, compiler/runtime ABI, and domains.
- Define JSON variant/option representation, numeric widths, timezone, and schema compatibility.
- Verify js_of_ocaml/Melange/WASM runtime/module boundaries separately.

## Common failure modes

- Compiler/opam switch mismatch; module wrapping/name conflict; interface/implementation mismatch; PPX version break.
- Non-exhaustive match; polymorphic equality/comparison surprise; Lwt promise not awaited; closure retains data; C value not rooted.

## Verification checklist

- [ ] Confirm compiler, switch/lock, Dune, PPX, flags, and target.
- [ ] Run focused/full tests, formatting, warning/check aliases, and docs.
- [ ] Test pattern/error paths, scheduler cancellation, and resource cleanup.
- [ ] Profile allocations/concurrency if affected.
- [ ] Verify C and serialized/web-target boundaries.
