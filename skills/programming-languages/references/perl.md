# Perl

## Ecosystem detection

- Confirm `.pl`, `.pm`, `.t`, Perl shebang, `Makefile.PL`, `Build.PL`, `cpanfile`, `META.*`, or Carton/Carmel files.
- Determine Perl version, threaded/non-threaded build, system versus local library, and application framework.

## Canonical toolchains

- Use the repository's cpanm/Carton/Carmel/Dist::Zilla/ExtUtils::MakeMaker/Module::Build workflow.
- Tests use TAP via `prove`, `make test`, `Build test`, or framework commands.
- Quality tools may include Perl::Critic, Perl::Tidy, Test::Perl::Critic, Devel::Cover, and static/type helpers when configured.

## Inspect-first files

- Read dependency/build metadata, lock/snapshot files, `lib/`, `t/`, test helpers, `.perl-version`, `PERL5LIB` setup scripts, tidy/critic config, XS files, and CI.
- Identify pragmas (`strict`, `warnings`, feature/version), encoding, taint expectations, globals, dynamic loading, and generated files.

## Build, test, lint, and format

- Use the selected environment manager, then run `prove -lr t`, focused `prove -lv t/file.t`, or distribution-native `perl Makefile.PL && make test`/`perl Build.PL && ./Build test`.
- Syntax-check with `perl -c <file>` under the same include paths; run configured `perlcritic` and `perltidy --profile=...` check workflow.
- Do not regenerate manifests/releases or update dependency snapshots unless the change requires it.

## Implementation idioms

- Keep `strict`/`warnings`, lexical variables, explicit argument validation, consistent OO style, and context (scalar/list/void) semantics.
- Preserve reference ownership, localization (`local`) versus lexical state (`my`/`state`), Unicode decoding boundaries, and exception conventions.
- Avoid symbolic references, implicit globals, clever regex side effects, and source filters unless established.

## Debugging workflow

- Reproduce with exact Perl and `-I` paths. Use `perl -d`, `Carp`, verbose TAP, `Devel::Trace`, profiling, or module-version inspection.
- Inspect `$@`, `$!`, capture variables, context, and encoding layers immediately; they can be overwritten.
- Diagnose missing modules through `@INC`/local-lib selection without dumping secret environment.

## Concurrency, memory, and performance

- Understand process forking, interpreter threads, event frameworks, signal safety, copy-on-write, and shared-state limitations.
- Reap children, close duplicated descriptors, bound async callbacks/queues, and avoid mutable package globals in persistent workers.
- Profile before optimizing; watch regex backtracking, repeated compilation, large hashes, reference cycles, slurped files, and XS transitions.

## Security hazards

- Use taint-aware validation where applicable. Avoid string-form `system`/backticks, two-argument `open`, unsafe eval, untrusted regex/code, SQL interpolation, and path traversal.
- Decode and validate external text once; constrain uploads, archive paths, and deserialization.
- Never expose secrets via diagnostics, process lists, or environment dumps.

## Interoperability

- For XS/FFI, verify Perl ABI, threading, reference counts, mortal values, ownership, compiler, and architecture.
- Define JSON blessed-object handling, Unicode/byte boundaries, numeric precision, database encodings, and subprocess protocols.

## Common failure modes

- Wrong Perl or `@INC`; missing local-lib; scalar/list context surprise; capture variable overwritten; encoding double-decode.
- Regex catastrophic backtracking; autovivification; aliasing through `@_`; package global leakage; XS binary mismatch.

## Verification checklist

- [ ] Confirm Perl build/version, library paths, dependency snapshot, and threading.
- [ ] Run focused TAP, suite, syntax, critic, and formatting checks.
- [ ] Test scalar/list context, Unicode/bytes, errors, and malformed input.
- [ ] Check child/signal/resource cleanup and persistent-worker state.
- [ ] Verify XS/FFI and wire/database boundaries.
