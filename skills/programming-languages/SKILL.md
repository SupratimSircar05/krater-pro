---
name: programming-languages
description: Route implementation, debugging, testing, build, review, migration, performance, security, and interoperability work to the correct programming-language ecosystem and its native toolchain. Use for repositories, snippets, compiler or runtime errors, failing tests, dependency and build problems, polyglot systems, infrastructure code, schemas, smart contracts, scientific code, hardware-description languages, or requests to write, run, diagnose, optimize, or explain code in a supported language.
---

# Programming Languages

Use this skill as a router. Load only the reference files relevant to the task, then follow the repository's own instructions and pinned toolchain.

## 1. Establish scope and instructions

1. Identify the workspace root and the files the user placed in scope.
2. Read applicable instruction files before editing: `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING*`, `README*`, and tool-specific configuration. Apply the closest nested instruction file to each edited file.
3. Inspect version-control status. Preserve unrelated and user-owned changes.
4. Determine whether the request is to explain, diagnose, review, or change code. Do not turn a read-only request into an implementation.
5. Locate secrets, generated files, vendored code, migrations, deployment manifests, and destructive scripts before running commands. Never print credentials or silently modify generated/vendor output.

## 2. Detect the ecosystem

Use evidence in this order:

1. Repository manifests, lockfiles, workspace files, compiler configs, and CI commands.
2. File extensions, shebangs, imports, language pragmas, and entry points.
3. Version managers, containers, dev shells, and environment files.
4. Existing build artifacts only as corroboration; they can be stale.

Do not infer a tool solely from an extension when alternatives exist. Prefer the toolchain pinned by a lockfile, wrapper, version file, or CI. In a polyglot repository, identify:

- the language owning the failing or requested behavior;
- boundary languages involved in serialization, FFI, RPC, build generation, or deployment;
- generated versus source-of-truth files;
- the narrowest package or module that can reproduce the issue.

If evidence conflicts, report the conflict and use the least invasive read-only probe (`--version`, manifest inspection, or a package-scoped dry run) before proceeding.

## 3. Load the right references

Read every reference that directly controls the task, but avoid loading unrelated ecosystems. Each reference contains detection, toolchain selection, commands, idioms, debugging, performance, security, interoperability, failure modes, and verification.

### Application and systems languages

- [Python](references/python.md)
- [JavaScript and TypeScript](references/javascript-typescript.md)
- [Java](references/java.md)
- [Kotlin](references/kotlin.md)
- [Scala](references/scala.md)
- [C](references/c.md)
- [C++](references/cpp.md)
- [C# and .NET](references/csharp.md)
- [Go](references/go.md)
- [Rust](references/rust.md)
- [Swift and Objective-C](references/swift-objective-c.md)
- [Dart and Flutter](references/dart-flutter.md)

### Dynamic, scripting, and data languages

- [Ruby](references/ruby.md)
- [PHP](references/php.md)
- [Perl](references/perl.md)
- [Lua](references/lua.md)
- [R](references/r.md)
- [Julia](references/julia.md)
- [MATLAB and Octave](references/matlab.md)
- [SQL](references/sql.md)
- [Shell and Bash](references/shell-bash.md)
- [PowerShell](references/powershell.md)

### Functional and VM ecosystems

- [Haskell](references/haskell.md)
- [OCaml](references/ocaml.md)
- [F#](references/fsharp.md)
- [Elixir](references/elixir.md)
- [Erlang](references/erlang.md)
- [Clojure](references/clojure.md)
- [Common Lisp and Scheme](references/common-lisp-scheme.md)
- [Groovy](references/groovy.md)

### Contracts, emerging systems, and legacy

- [Solidity](references/solidity.md)
- [Move](references/move.md)
- [Zig](references/zig.md)
- [Nim and Crystal](references/nim-crystal.md)
- [Fortran](references/fortran.md)
- [COBOL](references/cobol.md)
- [Assembly and WebAssembly](references/assembly-webassembly.md)

### Hardware, infrastructure, and interface definitions

- [Verilog, SystemVerilog, and VHDL](references/verilog-systemverilog-vhdl.md)
- [Terraform and HCL](references/terraform-hcl.md)
- [Nix](references/nix.md)
- [Protocol Buffers and GraphQL](references/protobuf-graphql.md)

For mixed tasks, combine references deliberately. Examples:

- Node service plus PostgreSQL query: read JavaScript/TypeScript and SQL.
- Rust service generated from protobuf: read Rust and Protocol Buffers/GraphQL.
- Python package wrapping C: read Python and C, then verify both sides of the ABI.
- Solidity deployment through a TypeScript tool: read Solidity and JavaScript/TypeScript.
- HDL testbench driven by Python: read the HDL reference and Python.

## 4. Reproduce before changing

1. Record the exact failure, command, exit status, relevant versions, and smallest input that triggers it.
2. Run the narrowest existing check first: one test, target, package, module, query plan, simulation, or typecheck.
3. Distinguish environment/setup failures from product defects. Check tool versions, architecture, environment variables by name only, dependency state, generated code freshness, and external-service availability.
4. Form a falsifiable hypothesis. Gather evidence with native diagnostics rather than speculative edits.
5. Add or identify a regression test when behavior should remain fixed.

Do not normalize a failing baseline away. If existing unrelated checks fail, preserve their output and isolate the task-specific result.

## 5. Implement with native conventions

1. Make the smallest coherent source change.
2. Match local style, public API, error model, ownership/lifetime rules, concurrency model, and dependency policy.
3. Prefer standard-library or already-pinned dependencies. Obtain authorization before adding a significant dependency or downloading a new toolchain.
4. Update source-of-truth schemas or generators, then regenerate through the repository command. Do not hand-edit generated output unless the repository explicitly requires it.
5. Validate inputs at trust boundaries, preserve parameterization for queries and commands, avoid unsafe deserialization, and keep secrets out of logs and source.
6. Treat warnings involving types, memory, races, undefined behavior, migrations, contracts, hardware timing, or infrastructure plans as meaningful.

## 6. Run safely

- Prefer repository wrappers and package-scoped commands.
- Inspect scripts before running unfamiliar install, deploy, migration, chain, synthesis, provisioning, or cleanup commands.
- Do not run destructive migrations, `apply`, deployment, wallet transactions, synthesis/programming, or production commands merely to validate local code.
- Use temporary directories for scratch artifacts; do not overwrite fixtures without intent.
- Bound long-running tests, fuzzers, benchmarks, watchers, simulations, and services. Clean up processes you start.
- Redact tokens, keys, connection strings, private inputs, and environment values from output.

## 7. Verify in layers

Run the strongest applicable layers, from narrow to broad:

1. Reproduction or regression test.
2. Formatter/check mode and static analysis.
3. Typecheck, compile, elaboration, validation, or query parse/plan.
4. Package or module tests.
5. Integration and boundary tests.
6. Repository-wide tests/build when proportionate.
7. Runtime smoke test of the user-visible path.
8. Targeted benchmark, race detector, sanitizer, fuzzing, simulation, formal check, or security scanner when risk warrants it.

Verify both success and failure paths. For interoperability changes, test both producers and consumers and check version compatibility. For performance work, compare repeatable before/after measurements in equivalent conditions; do not claim improvement from intuition.

## 8. Report evidence

State:

- what changed or what caused the failure;
- which ecosystem/toolchain and pinned version evidence were used;
- exact checks run and their outcomes;
- any checks not run and why;
- remaining risks, external prerequisites, or baseline failures.

Do not call a task complete when compilation passed but the requested runtime behavior remains untested.
