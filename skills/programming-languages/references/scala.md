# Scala

## Ecosystem detection

- Confirm `.scala`, `build.sbt`, Mill files, Scala CLI directives, or Maven/Gradle Scala plugins.
- Determine Scala 2 versus 3, JVM/Scala.js/Scala Native, and binary suffixes such as `_2.13` or `_3`.
- Use wrapper/version files, `project/build.properties`, plugin declarations, and CI to select the toolchain.

## Canonical toolchains

- Prefer repository sbt, Mill, Scala CLI, Maven, or Gradle commands; do not introduce a second build system.
- Tests may use ScalaTest, MUnit, Specs2, uTest, or Weaver. Formatting/static checks commonly use Scalafmt, Scalafix, WartRemover, or compiler warnings.
- Preserve effect/runtime choices such as Cats Effect, ZIO, Akka/Pekko, Monix, or Futures rather than mixing abstractions casually.

## Inspect-first files

- Read `build.sbt`, `project/*.scala`, `plugins.sbt`, `build.properties`, Mill/Scala CLI directives, dependency lock/update policy, `.scalafmt.conf`, `.scalafix.conf`, and CI.
- Inspect cross-project settings, compiler flags, macros/derivation, generated sources, and framework runtime configuration.

## Build, test, lint, and format

- sbt: use `sbt test`, `sbt 'testOnly pkg.Spec -- -z case'`, `sbt compile`, or scoped `project/module` commands.
- Mill/Scala CLI: use configured `./mill module.test` or `scala-cli test .`; command syntax is build-specific, so inspect aliases/tasks first.
- Run configured `scalafmtCheckAll`, Scalafix/check tasks, fatal-warning compilation, and cross-version builds. Do not assume task availability.

## Implementation idioms

- Preserve referential transparency and the chosen effect/error model. Avoid mixing blocking side effects into pure or effectful APIs.
- Use exhaustive algebraic data types, total functions where practical, explicit execution contexts, and collection types appropriate to complexity.
- Treat implicits/givens, typeclass resolution, variance, macros, and opaque/newtypes as API and compile-time behavior.

## Debugging workflow

- Reduce compiler/type errors to the first failing expression; inspect inferred types, implicit/given search, and expansion output when available.
- Run one suite/module. Use JVM debugging, thread dumps, effect-runtime tracing, dependency trees, and sbt `last` for task failures.
- Separate build-definition/plugin failures from application failures and Scala binary-version conflicts.

## Concurrency, memory, and performance

- Respect the selected effect runtime, scheduler, fibers, backpressure, cancellation, and blocking pool. Never hide blocking I/O on compute pools.
- For Futures, make execution contexts explicit and preserve failure handling. For actors/streams, reason about mailbox/buffer growth and supervision.
- Benchmark with JMH or configured tools. Watch allocation from collections/closures, boxing, retained lazy values, and macro-generated code size.

## Security hazards

- Apply JVM safeguards; avoid unsafe Java serialization, runtime compilation/eval, XML parser defaults, command/SQL interpolation, and deserializing untrusted ADTs without limits.
- Guard effectful boundaries, authorization, actor messages, and stream/resource limits. Never log secrets in case-class `toString`.

## Interoperability

- Verify Scala binary version, TASTy/classfile target, Java API ergonomics, nullability, SAMs, and collection conversions.
- For Scala.js/Native, validate JS/native exports, module format, linker mode, ownership, and platform APIs.
- Keep wire schemas and effect/callback cancellation semantics explicit across services.

## Common failure modes

- `_2.13`/`_3` dependency mismatch; divergent implicit/given search; initialization order; erased overload clash; non-exhaustive match.
- Blocking on compute pool; lost Future failure; lazy value deadlock; actor/stream resource leak; sbt shell state differs from clean invocation.

## Verification checklist

- [ ] Confirm Scala version, platform, build tool, and cross-build matrix.
- [ ] Run focused tests, compile with configured warnings, and formatting/static checks.
- [ ] Build all affected cross targets and downstream API consumers.
- [ ] Test effect cancellation, resource safety, and concurrency pressure.
- [ ] Check binary/wire compatibility and runtime smoke behavior.
