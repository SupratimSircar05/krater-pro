# Haskell

## Ecosystem detection

- Confirm `.hs`/`.lhs`, Cabal files, `cabal.project`, `stack.yaml`, `package.yaml`, `flake.nix`, or GHC options.
- Determine GHC version, Cabal versus Stack/Nix workflow, language extensions, package flags, target backend, and resolver/index state.

## Canonical toolchains

- Use repository Cabal/Stack/Nix pins; do not mix package environments.
- Tests may use Hspec, tasty, QuickCheck, Hedgehog, or custom suites declared in package metadata.
- Quality tools may include fourmolu/ormolu, hlint, Weeder, doctest, Haddock, HPC, and GHC warnings.

## Inspect-first files

- Read `.cabal`/`package.yaml`, `cabal.project*`, `stack.yaml*`, `cabal.project.freeze`, GHCup/Nix pins, formatter/lint config, CI, and test suite declarations.
- Trace extensions, CPP, generated modules, orphan instances, FFI, unsafe functions, effect stack, strictness, and RTS settings.

## Build, test, lint, and format

- Cabal: use `cabal build all`, `cabal test all`, or `cabal test <suite> --test-options=...`; Stack: use configured `stack build --test`.
- Run repository format check, `hlint`, warning-clean compile, Haddock/doctests, and property tests when configured.
- Do not update freeze files/resolvers merely to build. Test supported GHC/package-flag matrices where the change affects compatibility.

## Implementation idioms

- Preserve purity and the selected effect/error abstraction; keep partial functions and bottoms out of externally reachable paths.
- Model invariants with algebraic types, use total pattern matches, control laziness/strictness intentionally, and avoid orphan instances.
- Respect typeclass coherence, newtype abstraction, resource brackets, async exception safety, and API stability.

## Debugging workflow

- Start with the earliest type error and simplify inferred constraints. Use typed holes, `:info`/`:type`, compiler dumps selectively, one suite/property, and reduced input.
- Use GHCi debugger, stack traces/profiling, eventlog/ThreadScope, heap profiles, and dependency plans.
- For laziness bugs, force values in controlled locations and distinguish exception creation from evaluation.

## Concurrency, memory, and performance

- Understand sparks versus threads, STM/MVars, async cancellation/exceptions, masking, resource brackets, and laziness retention.
- Never swallow asynchronous exceptions indiscriminately; use structured `withAsync`-style lifetimes and bounded queues.
- Benchmark with criterion and profile allocations/retainers/eventlog. Watch thunks, space leaks, fusion loss, contention, and excessive parallelism.

## Security hazards

- Avoid partial parsers, unsafe deserialization, `read` on untrusted input, shell/SQL construction, unsafe FFI, and unbounded lazy input.
- Set parser/resource/time limits, validate paths/URLs, and keep secrets out of derived `Show`, exceptions, and logs.
- Review Template Haskell, custom preprocessors, and Setup/build hooks as executable dependencies.

## Interoperability

- For FFI, define calling convention, stable C types, ownership, pinned memory, callbacks, thread/runtime entry, and exception containment.
- Define Aeson JSON field/optional/numeric/date behavior and schema evolution.
- Verify GHC/package ABI compatibility, dynamic/static linking, and JS/WASM/native backends separately.

## Common failure modes

- Wrong GHC/resolver; ambiguous/typeclass constraint; non-exhaustive or partial function; lazy I/O resource leak.
- Space leak; async exception breaks invariant; deadlock in STM/MVar; orphan instance conflict; FFI callback/GC lifetime error.

## Verification checklist

- [ ] Confirm GHC/build pin, flags, extensions, resolver/freeze state, and target.
- [ ] Run focused/full suites, property tests, format/lint, warnings, and docs.
- [ ] Test totality/error paths, async exceptions, and resource cleanup.
- [ ] Profile representative allocation/concurrency when affected.
- [ ] Verify FFI/wire compatibility and supported compiler matrix.
