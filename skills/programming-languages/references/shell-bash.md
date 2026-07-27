# Shell and Bash

## Ecosystem detection

- Read the shebang and invocation path; `.sh` does not guarantee Bash. Distinguish POSIX `sh`, Bash, dash, ksh, zsh, BusyBox/Almquist shells, and sourced files.
- Check `set` options, target OS/userland, CI/container image, ShellCheck directives, and minimum shell version.

## Canonical toolchains

- Execute with the declared shell, not the interactive default. Use ShellCheck and shfmt only when configured/compatible with the dialect.
- Tests may use Bats, ShellSpec, shUnit2, container fixtures, or repository scripts.
- For portable scripts, validate against each supported shell and userland rather than relying on Bash behavior.

## Inspect-first files

- Read shebang, sourced files, option/trap setup, environment contract, usage parser, destructive commands, path/glob handling, CI, service/scheduler unit, and test fixtures.
- Identify expected working directory, privilege level, stdin/TTY assumptions, secret inputs, and supported platforms.

## Build, test, lint, and format

- Parse-check with the declared shell (`bash -n`, `sh -n`, etc.) and run focused tests in an isolated temporary directory.
- Use configured `shellcheck` dialect flags and `shfmt -d`; suppress diagnostics only with a documented reason.
- Exercise repository test targets across supported shells/containers. Do not run install/deploy/cleanup scripts against live targets merely to test syntax.

## Implementation idioms

- Quote expansions by default, use arrays in Bash for argument lists, use `--` before untrusted path operands, and prefer `printf` over ambiguous `echo`.
- Check command statuses explicitly; understand `set -e` exceptions, pipeline status, subshell scope, traps, and word splitting.
- Use `mktemp -d`, restrictive permissions, reliable cleanup traps, and explicit paths. Avoid parsing `ls`.

## Debugging workflow

- Reproduce with the exact shell/environment in a disposable directory. Use syntax check and narrowly scoped `set -x`/`PS4` with secrets redacted.
- Inspect quoting, expansion order, IFS, globbing, pipeline/subshell behavior, working directory, and external command versions.
- Use ShellCheck findings as leads, not automatic rewrites across dialects.

## Concurrency, memory, and performance

- Track background PIDs, wait statuses, signal forwarding, job limits, FIFO/file descriptor cleanup, and atomic file operations.
- Avoid unbounded `xargs -P`/background loops and races on temp/state files; use locks appropriate to the target.
- Shell is poor for large in-memory/text-processing workloads; measure process spawning and move complex logic to a suitable existing runtime when justified.

## Security hazards

- Never `eval` or build command strings from untrusted text. Quote data, use argument arrays, and validate option-like inputs.
- Prevent command injection, path traversal, glob surprises, symlink/TOCTOU attacks, unsafe temp files, hostile environment variables, and secret tracing.
- Do not pipe remote content into a shell or run with elevated privileges without explicit authorization and inspection.

## Interoperability

- Define environment variables, exit codes, stdout/stderr, encoding, delimiters, and signal behavior as an API.
- Prefer NUL-delimited paths where tools support them. Account for GNU/BSD/BusyBox option differences and CRLF.
- Preserve subprocess cancellation and do not leak descriptors/secrets to children.

## Common failure modes

- Wrong shell; unquoted expansion; array used under POSIX sh; pipeline failure hidden; `set -e` misconception.
- Variable lost in subshell; glob matches nothing/dashes; whitespace/newline filenames; trap overrides earlier trap; GNU-only flag on macOS.

## Verification checklist

- [ ] Confirm shebang, shell version, OS/userland, privileges, and working directory.
- [ ] Run parse, ShellCheck/format, and isolated focused tests.
- [ ] Test spaces/newlines/dashes, empty values, command failures, and signals.
- [ ] Verify temp cleanup, idempotency, concurrency, and secret redaction.
- [ ] Exercise each supported shell/platform without touching production.
