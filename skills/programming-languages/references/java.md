# Java

## Ecosystem detection

- Confirm `.java`, `module-info.java`, Maven `pom.xml`, Gradle settings/build files, or wrapper scripts.
- Use `.java-version`, `.sdkmanrc`, Maven toolchains, Gradle JVM settings, and CI to identify the JDK. Distinguish JVM, Android, GraalVM/native-image, and annotation-processor constraints.

## Canonical toolchains

- Prefer `./mvnw` or `./gradlew`; use system Maven/Gradle only when no wrapper exists.
- Use JUnit/TestNG and configured Checkstyle, SpotBugs, Error Prone, PMD, JaCoCo, Spotless, or formatter plugins.
- For JPMS, Android, Spring, Jakarta EE, Quarkus, or Micronaut, follow framework lifecycle and packaging rather than generic `javac`.

## Inspect-first files

- Read wrapper versions, `pom.xml` or `settings.gradle*`/`build.gradle*`, dependency catalogs, `module-info.java`, compiler/release settings, annotation processors, application config, and CI.
- Check source sets, generated sources, test fixtures, profiles, multi-module boundaries, and migration/schema files.

## Build, test, lint, and format

- Maven: use `./mvnw test`, `./mvnw verify`, or focused `./mvnw -Dtest=Class#method test`; respect profiles.
- Gradle: inspect tasks, then use `./gradlew test`, `./gradlew check`, `./gradlew build`, or `./gradlew :module:test --tests 'pkg.Class.method'`.
- Run configured format/check tasks such as `spotlessCheck`; do not assume plugin task names. Use `clean` only when stale outputs are evidenced.

## Implementation idioms

- Preserve nullability contracts, value equality, generics variance, checked-exception/API behavior, immutability, and resource ownership with try-with-resources.
- Prefer explicit domain types and constructor validity; avoid mutable statics and broad catch blocks.
- Treat reflection, proxies, records, sealed types, serialization, and annotation processing as version/framework-sensitive.

## Debugging workflow

- Start from the earliest `Caused by`, suppressed exception, compiler diagnostic, or failing assertion.
- Reproduce the narrow module/test. Use JDWP/IDE debugging, `jstack`/`jcmd`, GC logs, Java Flight Recorder, or heap dumps when warranted.
- Inspect dependency convergence (`dependency:tree` or Gradle dependency reports), classpaths, module opens/exports, and processor output.

## Concurrency, memory, and performance

- Use happens-before reasoning for shared state; choose executors, futures, virtual threads, reactive flows, or structured concurrency according to the pinned JDK/framework.
- Preserve interruption and cancellation; bound pools/queues and close executors. Avoid blocking event loops or common pools.
- Measure with JMH/JFR/profilers. Watch allocation, boxing, lock contention, N+1 I/O, classloader leaks, and GC behavior.

## Security hazards

- Avoid unsafe Java deserialization, expression-language injection, XXE, reflection over untrusted names, path traversal, and command/SQL concatenation.
- Validate archive entries, TLS/hostname settings, authorization, and framework binding. Keep credentials out of properties and diagnostics.
- Review dependency/plugin provenance and do not weaken certificate validation to make tests pass.

## Interoperability

- Check bytecode target/JDK compatibility, JPMS boundaries, JNI ownership, native library architecture, and Kotlin/Scala nullability/default arguments.
- Define serialization schema evolution, timezone/decimal conventions, database transaction behavior, and generated-client versions.

## Common failure modes

- Wrapper JDK differs from IDE; source/target/release mismatch; dependency eviction; classpath/module-path confusion; stale generated sources.
- Equality/hashCode errors; stream reuse; leaked resources; lazy-loading outside a transaction; test parallelism and mutable singleton leakage.

## Verification checklist

- [ ] Confirm wrapper, JDK, language level, profiles, and target runtime.
- [ ] Run focused test plus module checks.
- [ ] Run formatter/static analysis and package/verify task.
- [ ] Exercise startup, serialization/database, and shutdown paths as applicable.
- [ ] Check concurrency cancellation, resource closure, and compatibility.
