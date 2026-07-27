# Kotlin

## Ecosystem detection

- Confirm `.kt`/`.kts`, Kotlin Gradle/Maven plugins, `settings.gradle.kts`, or multiplatform source sets.
- Distinguish Kotlin/JVM, Android, Kotlin Multiplatform, Kotlin/JS, and Kotlin/Native; target differences affect APIs, memory, testing, and packaging.
- Use Gradle wrapper, version catalog, plugin versions, JDK pin, and CI as authority.

## Canonical toolchains

- Prefer `./gradlew` and configured Kotlin plugins. Maven or standalone `kotlinc` is valid only when the repository uses it.
- Tests commonly use JUnit/Kotlin test/Kotest; quality tools include detekt, ktlint, Spotless, Android lint, and binary compatibility checks.
- Respect Compose, Android, KSP, kapt, serialization, and coroutine plugin versions.

## Inspect-first files

- Read `settings.gradle.kts`, relevant `build.gradle.kts`, `gradle.properties`, `libs.versions.toml`, target/source-set blocks, compiler options, ProGuard/R8 rules, and CI.
- Inspect generated KSP/kapt code, expect/actual declarations, coroutine scopes, platform entry points, and Java-facing APIs.

## Build, test, lint, and format

- Discover tasks with `./gradlew tasks`; use target-specific tasks rather than assuming JVM.
- Common checks are `./gradlew test`, `./gradlew check`, `./gradlew :module:test --tests 'pkg.Test.name'`, `detekt`, `ktlintCheck`, or Android `lint`; use only configured tasks.
- Build the relevant target (`assemble`, `jvmTest`, `iosSimulatorArm64Test`, etc.) and avoid `clean` absent stale-artifact evidence.

## Implementation idioms

- Model nullability explicitly; prefer sealed hierarchies/data classes and exhaustive `when`.
- Preserve structured concurrency and scope ownership. Do not use `GlobalScope`, swallow cancellation, or expose mutable collections unintentionally.
- Avoid surprising platform types, excessive `!!`, hidden allocations in hot paths, and source-breaking changes to default/named parameters.

## Debugging workflow

- Reproduce the narrow target/test and inspect coroutine causes, Gradle task output, compiler diagnostics, and generated code.
- Use IDE/JDWP for JVM, platform debuggers for Native/Android, coroutine debug probes where configured, and Gradle dependency reports.
- For incremental/compiler issues, first verify inputs and tool versions; invalidate caches or clean only as a controlled diagnostic.

## Concurrency, memory, and performance

- Understand dispatcher choice, suspension versus blocking, cancellation propagation, flows/channels backpressure, and thread confinement.
- On Native or multiplatform, verify platform memory/concurrency rules for the pinned version.
- Profile the target platform. Watch excessive coroutine creation, flow replay/buffering, boxing, collection chains, UI recomposition, and JNI crossings.

## Security hazards

- Apply Java/platform safeguards plus safe Android component/export settings, WebView configuration, and storage rules.
- Avoid unsafe deserialization, SQL/command interpolation, hard-coded keys, permissive TLS, and logging tokens or user data.
- Treat `kotlin.script` and reflection over untrusted input as code execution.

## Interoperability

- For Java, verify nullability annotations, SAMs, checked exceptions, `@Jvm*` names, default arguments, wildcards, and binary compatibility.
- For multiplatform, keep common code platform-neutral and test each actual implementation.
- Validate Swift/Objective-C export shapes, JS module boundaries, serialization versions, and native ownership.

## Common failure modes

- Kotlin/JDK/plugin version mismatch; wrong source set; kapt/KSP stale output; JVM signature clash; Java platform-null surprise.
- Lost coroutine cancellation; flow never collected; blocking on main/event thread; lifecycle scope leak; Compose state instability.

## Verification checklist

- [ ] Confirm target, wrapper, JDK, Kotlin/plugin versions, and source set.
- [ ] Run focused target test and configured lint/static checks.
- [ ] Compile/package every affected platform target.
- [ ] Test coroutine cancellation, lifecycle/resource cleanup, and Java/native boundaries.
- [ ] Smoke-test the actual app/CLI/library consumer.
