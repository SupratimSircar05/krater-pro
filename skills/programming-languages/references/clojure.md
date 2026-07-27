# Clojure

## Ecosystem detection

- Confirm `.clj`, `.cljs`, `.cljc`, `deps.edn`, `project.clj`, `bb.edn`, `shadow-cljs.edn`, or Boot files.
- Determine JVM Clojure, ClojureScript, Babashka, Graal/native, and build tool/version aliases from config and CI.

## Canonical toolchains

- Use Clojure CLI/tools.deps, Leiningen, deps-new/build.clj, Shadow-CLJS, or Babashka according to repository evidence.
- Tests may use `clojure.test`, kaocha, Cognitect test runner, Lein test, or cljs runners.
- Quality tools may include clj-kondo, zprint/cljfmt, eastwood, reflection warnings, and dependency checks.

## Inspect-first files

- Read dependency/build files and aliases/profiles, lock strategy, `build.clj`, namespace layout, test runner config, lint/format config, JVM options, AOT/native config, and CI.
- Trace macros, multimethods/protocols, atoms/agents/refs, core.async, lazy sequences, dynamic vars, Java interop, and generated JS.

## Build, test, lint, and format

- Invoke declared aliases/tasks, such as `clojure -M:test`, `clojure -X:test`, `lein test`, or `npx shadow-cljs compile/test`; exact aliases are repository-defined.
- Run configured `clj-kondo`, format check, build/uberjar, cljs compilation, and native-image checks.
- Do not infer dependency commands from another Clojure build tool or update dependencies just to test.

## Implementation idioms

- Prefer immutable data transformations, pure functions, explicit state holders, namespaced keywords, sequence/transducer clarity, and data-oriented APIs.
- Preserve laziness realization boundaries, nil/false semantics, metadata, protocol dispatch, macro hygiene, and exception data.
- Avoid mutable Java collections, hidden dynamic state, unbounded lazy work, and macros where functions suffice.

## Debugging workflow

- Reproduce one namespace/test with exact alias/profile. Use REPL evaluation, `tap>`, `ex-info` data, stack traces with compiler frames filtered carefully, and clj-kondo.
- Macroexpand when syntax/macros are implicated; inspect realized values/classes for interop and laziness issues.
- For cljs, distinguish macro/JVM compile, JS compile, module bundling, and browser/runtime failures.

## Concurrency, memory, and performance

- Choose atoms/refs/agents/vars/core.async according to coordination semantics; bound channels and thread pools.
- Avoid blocking go blocks, side effects in retries/lazy sequences, and retained sequence heads.
- Profile JVM/JS targets. Watch reflection, boxing, persistent data churn, lazy retention, keywordization/atom creation, and transducer realization.

## Security hazards

- Never `read-string` untrusted input without safe EDN settings; avoid eval, dynamic requiring/var resolution, Java serialization, command/SQL interpolation, and unsafe tagged literals.
- Bound EDN/JSON nesting/size and sanitize secrets from printed data/exceptions.
- Review macros/build hooks and dependency repositories as executable inputs.

## Interoperability

- Verify Java classes/type hints/reflection, checked exceptions, nullability, collections, and AOT/Graal reflection metadata.
- Define EDN/JSON keyword/string, ratio/bigint, date, set, nil, and tagged-value behavior.
- For ClojureScript, test JS module exports, promises, `undefined`/nil, and advanced compilation.

## Common failure modes

- Wrong alias/profile/tool; namespace/file mismatch; stale AOT; macro available on wrong platform.
- Lazy side effect runs late/twice; retained lazy head; reflection slowdown; false and nil conflated; blocking in core.async go; mutable interop surprise.

## Verification checklist

- [ ] Confirm runtime, build tool, aliases/profiles, dependency pins, and target.
- [ ] Run focused/full tests, clj-kondo, format, build, and cljs/native targets.
- [ ] Test lazy realization, state/concurrency, errors, and malformed EDN/data.
- [ ] Profile reflection/allocation or channel pressure where relevant.
- [ ] Verify Java/JS/wire consumers and optimized production build.
