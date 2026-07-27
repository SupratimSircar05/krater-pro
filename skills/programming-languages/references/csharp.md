# C# and .NET

## Ecosystem detection

- Confirm `.cs`, `.csproj`, `.fsproj` references, `.sln`/`.slnx`, `global.json`, `Directory.Build.*`, or NuGet files.
- Distinguish modern .NET, .NET Framework, Mono, Unity, Xamarin/MAUI, ASP.NET, Blazor, and NativeAOT. Target framework monikers control available APIs.

## Canonical toolchains

- Use the SDK pinned by `global.json` and repository `dotnet` commands; use MSBuild/Visual Studio/Unity tooling when project type requires it.
- Tests commonly use xUnit, NUnit, or MSTest. Quality tools may include analyzers, StyleCop, Roslynator, dotnet format, coverage, and BenchmarkDotNet.
- Respect central package management and workload manifests.

## Inspect-first files

- Read solution/project files, `global.json`, `Directory.Build.props/targets`, `Directory.Packages.props`, NuGet config/lock, nullable/implicit-using settings, launch/app settings, and CI.
- Trace source generators, target-specific code, trimming/AOT configuration, EF migrations, and public assemblies.

## Build, test, lint, and format

- Use `dotnet restore --locked-mode` when a lock is maintained, then `dotnet build --no-restore` and `dotnet test --no-build`; align flags with repository scripts.
- Narrow with `dotnet test <project> --filter <expression>`. Use configuration/TFM parameters when multi-targeted.
- Run `dotnet format --verify-no-changes` or configured analyzers. Use `dotnet pack`/`publish` for packaging or AOT/trimming verification when relevant.

## Implementation idioms

- Preserve nullable reference contracts, async all the way, `IDisposable`/`IAsyncDisposable`, cancellation tokens, records/value semantics, and dependency-injection lifetimes.
- Avoid `async void` except event handlers, sync-over-async, mutable statics, broad exception swallowing, and repeated enumeration.
- Follow framework binding/serialization conventions without exposing domain objects unintentionally.

## Debugging workflow

- Reproduce one project/test with full exception chain and inner exceptions. Use debugger, `dotnet-trace`, `dotnet-counters`, `dotnet-dump`, logs/scopes, or generated source inspection.
- Diagnose restore/build with binary logs when needed; inspect NuGet dependency graphs and assembly load context for resolution conflicts.
- For ASP.NET, distinguish middleware ordering, configuration binding, DI construction, routing, and request cancellation.

## Concurrency, memory, and performance

- Respect Task scheduling, synchronization contexts, thread-pool starvation, cancellation, channels, and async stream disposal.
- Use concurrent collections or synchronization for shared state; do not assume DI singletons are request-confined.
- Measure allocations, GC, exceptions, contention, async overhead, database calls, and serialization with profilers or BenchmarkDotNet.

## Security hazards

- Prevent insecure deserialization, injection in SQL/commands/LDAP, path traversal, mass assignment, XSS/CSRF, SSRF, and authorization gaps.
- Protect data-protection keys and secrets; validate forwarded headers, CORS, cookies, antiforgery, and TLS configuration.
- Avoid logging tokens, connection strings, claims, or personal data.

## Interoperability

- Check target frameworks, strong names, assembly/API compatibility, COM/PInvoke calling conventions, native ownership, and trimming annotations.
- Define JSON naming/nullability/date/number behavior and version contracts. Verify F#/VB consumers and generated clients.

## Common failure modes

- SDK/TFM mismatch; stale NuGet cache/lock; assembly version conflict; disposed scoped service; missing `await`.
- Sync-over-async deadlock; deferred LINQ enumeration; EF tracking/N+1 issues; source generator only fails in CI; trimming reflection breakage.

## Verification checklist

- [ ] Confirm SDK, workload, target frameworks, configuration, and lock state.
- [ ] Run focused tests, analyzer/format checks, and solution build.
- [ ] Pack/publish affected targets, including trimmed/AOT when configured.
- [ ] Exercise request cancellation, disposal, auth, serialization, and database boundaries.
- [ ] Check runtime smoke path and assembly/native consumers.
