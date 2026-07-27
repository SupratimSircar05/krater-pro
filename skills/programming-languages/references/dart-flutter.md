# Dart and Flutter

## Ecosystem detection

- Confirm `.dart`, `pubspec.yaml`, `pubspec.lock`, Flutter platform directories, or Dart package layout.
- Distinguish pure Dart, Flutter app/plugin/package, server, web, and embedded targets. Use SDK constraints, FVM files, Melos workspace config, and CI to select versions.

## Canonical toolchains

- Use `dart` for pure packages and `flutter` for Flutter targets, preferably through FVM/repository wrappers when pinned.
- Tests use `dart test` or `flutter test`; integration tests and device tests use configured Flutter tooling.
- Quality tools include analyzer, `dart format`, custom lints, code generation with `build_runner`, and package/workspace tools such as Melos.

## Inspect-first files

- Read `pubspec.yaml`, lockfile policy, `analysis_options.yaml`, SDK/FVM pins, `melos.yaml`, `build.yaml`, generated-code conventions, platform manifests, and CI.
- Trace widget state/lifecycle, routing, dependency injection, isolates, native channels, asset declarations, flavors, and signing configuration.

## Build, test, lint, and format

- Resolve with `dart pub get` or `flutter pub get`; use `--enforce-lockfile` only where supported/configured.
- Run `dart test`/`flutter test`, focused test paths or names, `dart analyze`/`flutter analyze`, and `dart format --output=none --set-exit-if-changed .`.
- Use repository generation commands, often `dart run build_runner build`, then verify generated diffs. Build only the affected target/flavor with configured flags.

## Implementation idioms

- Preserve sound null safety, immutable widget/config objects, lifecycle disposal, async error propagation, and state-management conventions.
- Avoid using `BuildContext` across async gaps without mounted/lifecycle checks; minimize work in `build`.
- Keep platform/environment branches explicit and generated models/source-of-truth annotations synchronized.

## Debugging workflow

- Reproduce one test/device target. Use Dart/Flutter debugger, DevTools inspector/timeline/memory/network, verbose build output, logs, and widget/golden diagnostics.
- Separate analyzer, generator, platform-build, rendering, and runtime state failures.
- For dependency conflicts, inspect `dart pub deps`/`flutter pub deps` and SDK constraints; do not delete the lock without evidence.

## Concurrency, memory, and performance

- Understand event-loop scheduling, Futures/Streams, isolates, cancellation conventions, and UI-thread/platform-channel constraints.
- Cancel subscriptions/timers/controllers and dispose focus/animation/state objects. Bound stream buffers and isolate messaging.
- Profile frame build/raster time, rebuilds, image memory, shader compilation, allocations, and serialization across isolates/channels.

## Security hazards

- Do not embed production secrets in app assets/bundles. Secure tokens in platform storage and validate deep links, web views, intents, and file paths.
- Prevent unsafe URL launch, disabled TLS checks, SQL/command injection on servers, untrusted deserialization, and sensitive logs/screenshots.
- Review Android/iOS/web permissions and exported components.

## Interoperability

- Verify Method/EventChannel names, codecs, thread rules, FFI ownership, native ABI/architecture, and plugin platform implementations.
- Define JSON/date/enum/null behavior and generated-model compatibility.
- Test web/mobile/desktop conditional imports and package platform declarations.

## Common failure modes

- SDK/package constraint conflict; stale generated code; asset not declared; plugin unavailable on target; flavor/environment mismatch.
- `setState` after dispose; context after async gap; subscription leak; unbounded rebuild; golden/font/platform drift; native signing/build mismatch.

## Verification checklist

- [ ] Confirm Dart/Flutter/FVM versions, package mode, target, and flavor.
- [ ] Run focused tests, analyzer, format check, and generation diff.
- [ ] Build and smoke-test affected platforms.
- [ ] Test lifecycle disposal, async errors, navigation, and offline/failure states.
- [ ] Verify native channels/FFI, permissions, and secret-free bundles.
