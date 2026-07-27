# F#

## Ecosystem detection

- Confirm `.fs`/`.fsi`/`.fsx`, `.fsproj`, solution files, `global.json`, Paket files, or `dotnet` tooling.
- Determine .NET/Mono/Fable target, SDK/TFM, exact compile-file order, and framework/workload.

## Canonical toolchains

- Use the pinned .NET SDK and project/solution commands; use Paket or NuGet according to repository metadata.
- Tests commonly use Expecto, xUnit, NUnit, or FsCheck. Formatting/static tools may include Fantomas and analyzers.
- For Fable, follow the configured Node/package-manager and bundler in addition to .NET.

## Inspect-first files

- Read `.fsproj` file order/items, solution, `global.json`, `Directory.Build.*`, package metadata/lock, Paket files, formatter config, test setup, Fable config, and CI.
- Trace module/namespace boundaries, signatures, computation expressions, units of measure, generated code, and C#-facing APIs.

## Build, test, lint, and format

- Use `dotnet restore` per lock policy, `dotnet build`, and `dotnet test`; narrow to a test project/filter supported by its runner.
- Run configured `fantomas --check`, analyzers, packaging, and Fable build/test scripts.
- Do not reorder `.fsproj` compile items casually; file order is semantic.

## Implementation idioms

- Prefer discriminated unions, records, exhaustive matching, immutable transformations, `Result`/`Option`, and pipeline clarity.
- Keep null isolated at interop boundaries; distinguish `option` from nullable/reference null and preserve units of measure.
- Follow local async choice (`async`, `task`, streams) and computation-expression semantics; do not mix cancellation/error models casually.

## Debugging workflow

- Start with earliest type/order error and inspect inferred types in FSI/IDE. Run one test/property with minimal input.
- Use .NET debugger, exception chains, logging, FsCheck shrinking, `dotnet-trace`/dump tools, and generated Fable output only when boundary-specific.
- Diagnose missing values/modules through project compile order and accessibility before adding `open`.

## Concurrency, memory, and performance

- Understand F# async workflows versus Tasks, cancellation tokens, mailboxes/agents, immutable structure sharing, and .NET thread safety.
- Avoid sync-over-async, unbounded agents/mailboxes, shared mutable refs, and retained closures/sequences.
- Measure allocation, sequence re-enumeration, boxing, reflection, tail recursion/stack, and Fable JS behavior.

## Security hazards

- Apply .NET safeguards; avoid unsafe deserialization, quotations/dynamic compilation from input, command/SQL interpolation, path traversal, and null assumptions.
- Do not expose secrets through structural printing, exception data, or logs.
- Validate web binding/auth separately from domain type validity.

## Interoperability

- Verify C# names, `CLIMutable`, union/option representation, nullability, delegates/events, exceptions, tasks, generic variance, and assembly compatibility.
- For Fable, define JS object/module/null/undefined and async behavior.
- Keep serialization formats explicit rather than relying on default union encoding.

## Common failure modes

- Wrong SDK/TFM; compile-file order; value restriction; ambiguous overload from C#; null reaches F#.
- Sequence re-executes side effects; async workflow never started; task/async cancellation lost; union serialization changes; Fable-only runtime mismatch.

## Verification checklist

- [ ] Confirm SDK/TFM, project file order, dependencies, and target backend.
- [ ] Run focused/full tests, Fantomas/analyzers, build, and package.
- [ ] Test union/option/null, async cancellation, and error paths.
- [ ] Check C#/JS consumers and serialization compatibility.
- [ ] Smoke-test .NET and Fable targets actually affected.
