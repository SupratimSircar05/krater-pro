# Groovy

## Ecosystem detection

- Confirm `.groovy`, `build.gradle`/`.gradle`, Jenkinsfiles, Spock tests, Grails config, or Groovy scripts.
- Determine Groovy, JDK, Gradle/Grails/Jenkins versions and whether code is compiled, dynamically scripted, or statically checked.

## Canonical toolchains

- Prefer `./gradlew`, Maven wrapper, Grails wrapper/CLI, or host (Jenkins) tooling declared by the repository.
- Tests commonly use Spock, JUnit, or framework harnesses. Quality may use CodeNarc, Spotless, JaCoCo, and compiler/static-check options.
- Pipeline DSLs execute inside host-specific sandboxes and are not equivalent to standalone Groovy.

## Inspect-first files

- Read wrapper/build/settings files, dependency catalogs, Groovy compiler options, Jenkins shared-library layout, Grails config, Spock setup, CodeNarc/style config, and CI.
- Trace metaprogramming, categories/traits, AST transforms, DSL delegates, binding variables, Java interfaces, and generated sources.

## Build, test, lint, and format

- Use repository tasks: typically `./gradlew test`, focused `./gradlew test --tests 'pkg.Spec.feature'`, `./gradlew check`, and configured CodeNarc/format tasks.
- For Maven/Grails/Jenkins libraries, use their declared test/build harness; standalone `groovy` only validates scripts designed for it.
- Test with production JDK/Groovy/host versions because dynamic dispatch and DSL APIs drift.

## Implementation idioms

- Preserve property/bean semantics, closures/delegation, truthiness, GString versus String, optional typing, and DSL contracts.
- Prefer `@CompileStatic`/type checking only where project policy supports it; do not paper over dynamic host APIs.
- Avoid global metaclass mutation, implicit binding state, ambiguous closure resolution, and side effects in Gradle configuration.

## Debugging workflow

- Reproduce one spec/task/pipeline harness and inspect complete exception cause. Use Spock diagnostics, Gradle stacktrace/info, debugger, AST/type diagnostics, and host logs.
- Separate Groovy compilation, Gradle configuration/execution, Jenkins CPS/sandbox, and application runtime failures.
- Inspect actual runtime classes/method resolution when Java overloads or dynamic methods are involved.

## Concurrency, memory, and performance

- Apply JVM concurrency rules plus closure/binding ownership and host executor constraints.
- Do not share mutable script binding or metaclass changes across parallel tests/builds; avoid blocking Jenkins CPS or reactive event loops.
- Profile JVM behavior and watch dynamic dispatch, reflection, GString allocation, collection closures, Gradle configuration time, and retained build daemons.

## Security hazards

- Never evaluate untrusted Groovy or interpolate it into Jenkins/Gradle scripts. Groovy sandboxing requires host enforcement.
- Prevent GString command/SQL injection, unsafe deserialization, path traversal, dependency/plugin supply-chain attacks, and credential logging in pipelines.
- Use Jenkins credentials bindings carefully and avoid exposing secrets through process arguments or serialized pipeline state.

## Interoperability

- Verify Java method/property/overload resolution, nullability, checked exceptions, SAM coercion, generics erasure, and binary target.
- For Gradle/Jenkins/Grails DSLs, preserve host object lifecycle and version compatibility.
- Convert GString to String at strict API boundaries when required.

## Common failure modes

- Groovy/JDK/Gradle mismatch; method missing due to wrong DSL delegate; GString map key/equality surprise; closure captures mutable loop state.
- Static compilation rejects dynamic host API; Jenkins CPS cannot serialize object; Gradle configuration-time side effect; Java overload ambiguity.

## Verification checklist

- [ ] Confirm Groovy/JDK/build tool/host versions and execution mode.
- [ ] Run focused/full tests, CodeNarc/format, and build/check tasks.
- [ ] Test dynamic/static paths, DSL delegates, host sandbox, and serialization.
- [ ] Inspect concurrency/global metaclass state and pipeline secret handling.
- [ ] Verify Java and actual Jenkins/Grails/Gradle host behavior.
