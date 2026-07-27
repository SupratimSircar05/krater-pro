# Go

## Ecosystem detection

- Confirm `.go`, `go.mod`, `go.work`, `go.sum`, vendoring, or generated Go markers.
- Read the `go`/`toolchain` directives, build tags, target environment, and CI. Distinguish standard Go, TinyGo, cgo, plugins, and WASM.

## Canonical toolchains

- Use the pinned Go toolchain and standard commands; honor workspace, module, vendor, and private-module settings.
- Tests use `go test`; quality commonly uses `gofmt`, `go vet`, `staticcheck`, or golangci-lint when configured.
- Code generation must run through checked `go generate` directives or repository scripts, not by editing generated files.

## Inspect-first files

- Read `go.mod`, `go.work`, `go.sum`, vendor policy, `tools.go`, Make/Task files, linter config, build tags, `//go:generate`, package docs, and CI.
- Identify `internal` boundaries, commands under `cmd/`, context/error conventions, cgo files, and platform-specific suffixes.

## Build, test, lint, and format

- Use `go test ./...`, focused `go test ./path -run 'TestName' -count=1`, `go vet ./...`, and `gofmt -l .`; substitute repository targets when they add required tags/env.
- Use `go test -race` only on supported targets; use configured linter and `go build ./...`.
- Run `go mod tidy` only when dependency changes require it because it mutates module metadata. Verify generated-code diffs after generation.

## Implementation idioms

- Keep interfaces small and consumer-owned; pass `context.Context` first without storing it; wrap errors with `%w`.
- Make zero values useful where local style does. Defer cleanup immediately after successful acquisition and preserve partial-write/error semantics.
- Avoid goroutine ownership ambiguity, typed-nil interfaces, shadowed errors, and overusing panic.

## Debugging workflow

- Reproduce one package/test with `-v -count=1`; inspect error wrapping and race output.
- Use Delve, `go test -run`, `-trace`, `pprof`, execution traces, goroutine dumps, and module graph commands as appropriate.
- For build selection, inspect `go env` selectively, build tags, file suffixes, cgo state, and module replacements without dumping secrets.

## Concurrency, memory, and performance

- Define goroutine lifetime, cancellation, channel ownership/closure, and backpressure. Every spawned goroutine needs an exit path.
- Protect maps/shared state, avoid copying mutex-bearing structs, and test races. Bound fan-out and timers.
- Benchmark with `go test -bench -benchmem`; profile CPU/heap/block/mutex. Watch allocation escapes, interface boxing, retained slices, and excessive conversions.

## Security hazards

- Prevent command/SQL/template injection, path traversal, SSRF, unsafe archive extraction, integer/size exhaustion, and unbounded reads.
- Configure HTTP server/client timeouts, body limits, TLS verification, auth checks, and context cancellation.
- Protect private-module credentials and avoid logging request secrets or full environment.

## Interoperability

- Define JSON zero/null behavior, time zones, number widths, protobuf versions, and API error semantics.
- For cgo, verify C ABI, pointer-passing rules, thread callbacks, allocation ownership, compiler/architecture, and cross-build support.
- Check plugin/module version identity and WASM host APIs.

## Common failure modes

- Loop-variable capture on version-sensitive code; goroutine/channel leak; concurrent map access; typed-nil error; data retained by a slice.
- Build-tag or cgo mismatch; module replacement drift; test cache hides behavior; ignored short write; context cancellation lost.

## Verification checklist

- [ ] Confirm Go/toolchain directive, workspace/module mode, tags, and target.
- [ ] Run focused tests, full relevant tests, format, vet, and configured lint.
- [ ] Run race detector and benchmarks/profiles when applicable.
- [ ] Verify cancellation, goroutine cleanup, timeouts, and malformed input.
- [ ] Build target platforms and test wire/cgo boundaries.
