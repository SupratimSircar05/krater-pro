# PowerShell

## Ecosystem detection

- Confirm `.ps1`, `.psm1`, `.psd1`, PowerShell shebang, module manifests, Pester tests, or CI steps.
- Determine Windows PowerShell 5.1 versus PowerShell 7+, OS, execution policy context, required modules, and remoting/provider assumptions.

## Canonical toolchains

- Use `pwsh` or `powershell.exe` matching the project. Dependencies may use PSGallery/PSResourceGet, PowerShellGet, or vendored modules.
- Tests use Pester; quality tools commonly include PSScriptAnalyzer and repository formatting rules.
- Windows-only modules/providers require appropriate hosts; do not claim cross-platform support from parser success.

## Inspect-first files

- Read `#requires`, module manifests, functions/classes, format/type data, Pester config/tests, analyzer settings, module lock/bootstrap scripts, CI, and signing policy.
- Identify parameter sets, pipeline input/output types, providers/drives, remoting, credentials, preference variables, native command calls, and destructive cmdlets.

## Build, test, lint, and format

- Parse/import in the intended host and run Pester through the configured version, commonly `Invoke-Pester`.
- Run `Invoke-ScriptAnalyzer` with repository settings. Build/package/sign/publish only through project tasks and never publish for validation.
- Use `-WhatIf`/`-Confirm` only for cmdlets that implement `ShouldProcess`; these flags do not make arbitrary native commands safe.

## Implementation idioms

- Use advanced functions with typed/validated parameters, approved verbs, pipeline semantics, explicit output, and `SupportsShouldProcess` for mutations.
- Prefer splatting/argument arrays and cmdlets over string commands. Separate success output from verbose/debug/information/error streams.
- Use `try`/`catch` with `-ErrorAction Stop` where non-terminating errors must be handled; restore preference/global state.

## Debugging workflow

- Reproduce in exact edition/OS with one Pester case. Inspect `$PSVersionTable` selectively, `$Error[0]`/inner exceptions, streams, invocation info, and `$LASTEXITCODE`.
- Use breakpoints, `Set-PSDebug` cautiously, verbose/debug streams, transcript only after secret review, and module-resolution commands.
- Distinguish PowerShell errors from native process exit codes and encoding.

## Concurrency, memory, and performance

- Understand jobs, thread jobs, runspaces, remoting sessions, pipeline streaming, serialization boundaries, and shared-state safety.
- Bound parallel work, dispose runspaces/sessions, wait/receive jobs, and propagate cancellation/errors.
- Avoid repeated remoting/module imports and accidental full materialization of pipelines; measure before parallelizing.

## Security hazards

- Avoid `Invoke-Expression`, interpolated native command lines, insecure credential conversion/storage, permissive remoting, and disabled TLS checks.
- Validate provider paths, registry/file operations, deserialized objects, script blocks, and module provenance/signatures.
- Redact secure inputs; transcripts, verbose output, history, command lines, and CLIXML can expose secrets.

## Interoperability

- Define object versus text output, stream usage, exit codes, encoding, newline/path behavior, and native argument passing for the target PowerShell version.
- Remoting serializes objects and removes live methods; verify version/module availability on remote hosts.
- Test Windows registry/COM/.NET and POSIX tool boundaries separately.

## Common failure modes

- 5.1/7 syntax or module mismatch; non-terminating error bypasses catch; stale `$LASTEXITCODE`; pipeline unrolls arrays.
- String interpolation/quoting changes native arguments; output contaminates API result; deserialized remote type surprises; case/path differences.

## Verification checklist

- [ ] Confirm PowerShell edition/version, OS, modules, privileges, and providers.
- [ ] Run parser/import, focused Pester, ScriptAnalyzer, and packaging check.
- [ ] Test parameter sets, pipeline/object output, errors, and native exit codes.
- [ ] Exercise `WhatIf`/confirmation, idempotency, remoting, and cleanup.
- [ ] Verify secret handling, cross-platform behavior, and signed/module consumers.
