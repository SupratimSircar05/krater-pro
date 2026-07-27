# Swift and Objective-C

## Ecosystem detection

- Confirm `.swift`, `.m`/`.mm`, headers, `Package.swift`, Xcode projects/workspaces, CocoaPods/Cartfile, or Apple-platform targets.
- Determine Swift language/tools version, Xcode/SDK, deployment target, Objective-C ARC mode, platform, architecture, and package manager.

## Canonical toolchains

- Use Swift Package Manager for `Package.swift`; use `xcodebuild`/Xcode schemes for app/framework projects. Respect CocoaPods/Carthage only when present.
- Tests use XCTest or Swift Testing; quality may use SwiftFormat, SwiftLint, clang-format/static analyzer, and Xcode diagnostics.
- Use the selected Xcode via repository/CI conventions; CLI Swift alone may not represent Apple SDK behavior.

## Inspect-first files

- Read `Package.swift`, `Package.resolved`, project/workspace and scheme settings, `.xcconfig`, entitlements, plist, bridging headers/module maps, Podfile, lint config, and CI.
- Trace actors/queues, ownership annotations, nullability, generated resources/code, app lifecycle, and signing capabilities.

## Build, test, lint, and format

- SPM: use `swift build`, `swift test`, or `swift test --filter <test>` with the pinned toolchain.
- Xcode: inspect schemes/destinations, then use `xcodebuild -workspace|-project ... -scheme ... -destination ... test`; never invent signing changes merely to test.
- Run configured `swiftformat --lint`, SwiftLint, clang checks, and archive/build-for-testing tasks where packaging matters.

## Implementation idioms

- Preserve value/reference semantics, optional handling, protocol constraints, actor isolation, `Sendable`, structured concurrency, and explicit error behavior.
- Use ARC-aware ownership (`weak`/`unowned` only with proven lifetime), deterministic resource cleanup, and main-actor UI updates.
- In Objective-C, preserve nullability, lightweight generics, designated initializers, selector/KVO behavior, and ARC/Core Foundation ownership rules.

## Debugging workflow

- Reproduce one target/test and inspect the first compiler/runtime cause. Use LLDB, Xcode view/memory/thread tools, Instruments, Address/Thread Sanitizer, and concurrency diagnostics.
- For project failures, inspect resolved build settings, scheme membership, module maps, derived generated files, and dependency resolution.
- Treat deleting DerivedData as a diagnostic only after confirming stale build evidence.

## Concurrency, memory, and performance

- Respect actor isolation, task cancellation, task-group lifetime, queue confinement, autorelease pools, and callback thread contracts.
- Avoid detached tasks and retain cycles in closures/delegates/timers. Bridge async/callback APIs with exactly-once continuation resumption.
- Profile with Instruments. Watch ARC traffic, copy-on-write, bridging, main-thread work, image/data allocation, and Objective-C message hot paths.

## Security hazards

- Protect Keychain data, entitlements, URL/file handling, web views, deep links, pasteboard, and privacy-sensitive logs.
- Avoid insecure archive decoding, format/command injection, disabled TLS validation, hard-coded secrets, and overbroad app capabilities.
- Validate untrusted Objective-C selectors/classes and Swift dynamic decoding inputs.

## Interoperability

- Verify Swift/Objective-C exposure names, nullability, generics, errors, async bridging, module stability, library evolution, and generated headers.
- For C/C++, confirm module maps, ABI, ownership, exception boundaries, and Objective-C++ compilation.
- Test platform/version availability and binary framework architecture slices.

## Common failure modes

- Wrong Xcode/SDK/destination; missing target membership; package resolution drift; signing masks compile issue.
- Retain cycle; unowned crash; continuation resumed twice; UI off main actor; Objective-C null reaches nonoptional Swift; availability failure.

## Verification checklist

- [ ] Confirm Xcode/Swift/SDK, scheme, destination, deployment target, and dependency state.
- [ ] Run focused tests plus configured lint/format and target build.
- [ ] Test concurrency cancellation, actor/thread behavior, and memory lifecycle.
- [ ] Verify ObjC/C bridges, availability, resources, and archive/framework output.
- [ ] Smoke-test the real app path on appropriate simulator/device when required.
