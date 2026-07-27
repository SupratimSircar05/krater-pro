# Krater Pro Benchmark-Guided Tuning

This document maps the 100-task expert benchmark to the capabilities currently
implemented in Krater Pro. It is a gap analysis and tuning roadmap, not a claim
that Krater Pro passes the tasks or is “perfect.”

## Evidence boundary

- The catalog was validated offline with
  `node --import tsx benchmarks/run.ts --validate`: **100 tasks, 10 declared
  categories, and 10 tasks per category**.
- The analysis below is based on the task definitions in
  [`tasks.json`](./tasks.json), the runner methodology in
  [`REPORT.md`](./REPORT.md), and the implementation and tests under
  [`../src`](../src).
- No paid or live Krater API benchmark was run for this analysis.
- The catalog contains prompts, acceptance criteria, withheld-check
  descriptions, and hazards. It does not contain the seed repositories or
  independent checkers needed to measure solution correctness.
- A runner execution score measures session completion, runtime errors, and tool
  reliability. It must not be presented as task accuracy.

## Coverage matrix

All ten categories contain ten expert tasks. “Current support” describes the
agent harness, not the selected model's domain knowledge.

| Category | Tasks | What the tasks stress | Current Krater Pro support | Material gap |
| --- | ---: | --- | --- | --- |
| Concurrency and Distributed Systems | KC-001–010 | Leases, backpressure, Raft membership, sagas, clocks, snapshots, lock-free structures, CRDTs, schedulers, and rebalancing | **Partial.** The agent can inspect code, edit text, run repository tests/simulators, preserve tool failures, and load guidance for the relevant language. | No concurrency-specific instrumentation, schedule exploration, model checker, race detector integration, or deterministic virtual-time controller. Multiple model-requested tool calls execute sequentially. |
| Compilers and Static Analysis | KC-011–020 | Incremental parsing, type inference, SSA, taint analysis, source maps, bytecode verification, macros, incremental graphs, exhaustiveness, and formatting | **Partial.** Search, line-bounded reads, exact replacement, project mapping, and language skills support source-oriented work. Arbitrary repository commands can invoke existing compiler test suites. | No AST/CST, symbol, call-graph, LSP, binary-inspection, or semantics-aware patch tool. Full-file writes and literal replacements are fragile for large transformations. |
| Databases and Data Integrity | KC-021–030 | Serializable invariants, online migrations, MVCC, reservations, CDC, storage recovery, tenant isolation, bitemporality, merges, and shard splits | **Partial.** Krater Pro can inspect migrations, edit application code, and run a repository's database tests when its dependencies already exist. Secret files are excluded from model tools and command environments. | No database connector, schema introspection, transaction trace, migration dry run, fixture lifecycle, or built-in isolation/fault harness. The agent cannot independently establish data invariants from prose. |
| Security and Authentication | KC-031–040 | OAuth/OIDC, JWT, WebAuthn, capability sandboxes, webhook signing, redaction, safe extraction, policy engines, recovery, and SSRF/DNS rebinding | **Partial, with useful guardrails.** Workspace confinement, secret-path blocking, reduced command environment, loopback-only GUI binding, approvals, destructive-command rejection, and the additional macOS command sandbox address part of the threat surface. | Command policy is regex-based rather than parser- and capability-based; tool output is not a hardened untrusted-data channel; there is no cross-platform OS sandbox or formal authorization engine. Krater Pro currently exposes an API-key handoff, not an official Krater OAuth flow, and intentionally does not scrape browser cookies or private session tokens. |
| Performance and Memory | KC-041–050 | Zero-copy parsing, leak repair, cache locality, tail latency, arenas, ropes, TinyLFU, external sort, SIMD, and linear-time matching | **Partial.** Commands can run repository-provided benchmarks and profilers. Tool output and context are bounded; identical read-only tool calls are cached within one user turn. | No profiler, heap snapshot, flamegraph, benchmark-regression, hardware-counter, or resource-budget tool. Output compaction can hide a diagnostically important middle section. |
| Frontend and Accessibility | KC-051–060 | Virtualized grids, focus/inertness, keyboard drag/drop, optimistic state, forms, canvas alternatives, bidi/i18n, offline queues, tokens, and streaming UI | **Partial.** TypeScript/JavaScript guidance, source tools, command execution, streaming events, and the Krater Pro GUI support code-level iteration. | The coding agent has no DOM, screenshot, browser automation, Playwright, axe-core, screen-reader, or network-throttling tool. A polished GUI does not itself validate accessibility or user flows in target repositories. |
| Build, Monorepo, and Tooling | KC-061–070 | Hermetic caching, dual packages, boundaries, affected tests, provenance, codemods, lockfiles, ABIs, process launch, and watch races | **Moderate.** `workspace_map`, bounded traversal, `git_status`, `git_diff`, language skills, shell execution, and mutation-aware cache invalidation provide a useful repository loop. | No structured patch application, rename/delete operation, dependency graph, package-manager abstraction, artifact verifier, hermetic execution environment, or cross-platform test farm. |
| Networking and Protocols | KC-071–080 | HTTP/2, WebSockets, DNS, QUIC, TCP half-close, multipart, SSE, gRPC retries, binary negotiation, and resumable upload | **Partial.** Krater's provider path exercises streamed SSE and cancellation, and repository commands can run existing protocol tests or fuzzers. | No packet capture, socket simulator, traffic fault injection, binary viewer, network namespace, fuzz corpus manager, or protocol-aware parser. Network access and external services remain environment-dependent. |
| Reliability and Debugging | KC-081–090 | Replay, circuit breakers, shutdown, live config, durable queues, time zones, tracing, poison messages, brownout, and cross-layer faults | **Partial.** Failed tool results are returned to the model, requests are cancellable, command timeouts terminate process groups on Unix, and the step bound stops unbounded loops. | No persistent checkpoint/resume, process-tree supervision on every platform, trace/log correlation, fault-injection controller, virtual clock, invariant monitor, or crash-recovery state machine for the agent itself. |
| Agent Safety and Repository Operations | KC-091–100 | Dirty trees, shell policy, secret-safe indexing, TOCTOU, atomic refactors, prompt injection, worktrees, scoped approval, completion evidence, and bounded autonomy | **Strongest relative coverage, still partial.** Dirty-tree inspection, workspace/symlink/hard-link checks, protected secrets, mutation approvals, destructive-command blocks, reduced environments, bounded output, cache invalidation, maximum steps, and macOS command confinement directly address several tasks. The benchmark runner adds isolated copies and optional external checks. | No atomic multi-file transaction or rollback, structured shell parser, cross-platform OS sandbox, prompt-injection isolation, worktree planner, durable audit log, capability-scoped approval token, or evidence-backed completion gate. Filesystem identity checks reduce but cannot formally eliminate every race. |

## Implemented tuning mapped to benchmark needs

### High-signal repository orientation

`workspace_map` summarizes manifests, dominant file types, and top-level
structure before broad exploration. Deterministic listings, literal search,
line-bounded reads, and read limits reduce blind or wasteful inspection.

This directly helps the repository-indexing and bounded-controller concerns in
KC-093, KC-099, and KC-100, and reduces setup cost across all categories. It
does not replace a semantic index.

### Progressive language guidance

`SkillRegistry` lists only skill metadata until the model selects a relevant
skill. The programming-language skill then routes to one of 41 focused
ecosystem references. Workspace skills can override built-ins, while resource
paths and sizes are constrained.

This supports the heterogeneous stacks in the catalog without inserting every
language guide into every prompt. It is especially relevant to compiler,
database, systems, frontend, build, and protocol tasks. Selection is still
model-directed; Krater Pro does not yet infer and preload the most likely
reference from repository manifests.

### Bounded context and tool output

Krater Pro:

- keeps a stable system prefix;
- groups history by complete user turns before omitting old context;
- avoids orphaning tool results when context is reduced;
- strips terminal escapes and redundant blank lines;
- preserves the head and tail of oversized tool results with an explicit
  omission marker; and
- reports request and session token totals, including provider-reported cached
  prompt tokens.

These changes target resource budgeting in KC-041–050 and bounded autonomy in
KC-100. They reduce cost and context pressure but do not prove semantic
equivalence: omitted history or a truncated middle section can contain a
critical constraint.

### Session-local read reuse

Identical successful results from `workspace_map`, file listing/reading/search,
Git inspection, and skill loading are cached by a stable argument
serialization. Any mutating tool call that reaches execution clears the cache
first, including a failed execution. A denied request does not clear it because
no workspace state changed.

This is useful for incremental-analysis and cache-correctness themes in KC-018,
KC-032, KC-038, KC-047, KC-061, and KC-093. The cache is intentionally
conservative, process-local, and non-persistent; it is not content-addressed.

### Repository and credential guardrails

Current defenses include:

- lexical and physical workspace confinement;
- rejection of paths that resolve through a symlink outside the workspace;
- blocked access to `.env`, repository internals, credential files, and common
  private-key formats;
- reduced environments for model-requested commands so provider credentials
  are not inherited;
- explicit approval for file writes, literal replacements, and shell commands;
- hard rejection of several destructive command forms even under automatic
  approval;
- bounded file sizes, search breadth, command output, command duration, and
  agent steps; and
- loopback-only hosting for the GUI that exposes workspace tools.

These are concrete responses to KC-036, KC-037, and KC-091–100. They are
defense in depth, not a complete sandbox or proof against adversarial shell and
filesystem races.

### Recoverable model/tool loop

Malformed tool arguments and failed tool executions are sent back as explicit
results rather than silently treated as success. Denials are represented as
denials, cancellation is propagated, tool loops have a configurable step
ceiling, and the same session can be reused after a bounded-loop failure.

This helps error recovery, lifecycle, and bounded-execution requirements across
KC-002, KC-069, KC-081–090, and KC-100. It does not provide a durable workflow
checkpoint after process termination.

### Benchmark safety and evidence separation

The runner validates the full catalog before any selection or API setup. Live
execution requires an explicit task/category selector, and running all 100
requires `--all`. A supplied fixture is copied into an isolated temporary
workspace without symlinks, dependencies, Git internals, or common secret
paths. Hidden-check descriptions are withheld from the model. The benchmark
approval handler automatically permits only `write_file` and `replace_in_file`
inside that isolated workspace; model-requested `run_command` calls are denied.

Independent fixture checkers, when supplied, are copied outside the agent's
workspace and run after the session without the Krater API key—but only after
the operator also supplies `--trust-checkers` with `--live` and `--workspace`.
Merely supplying a workspace never discovers, copies, or runs checker code. A
checker is a separate trusted process, not an auto-approved model command, and
must be reviewed before opt-in. Its source-relative path and copied-file SHA-256
are displayed before execution and retained as report evidence. Reports keep
execution behavior, external checks, and unverified rubric items separate.

This is the correct foundation for KC-090 and KC-099. At present it is a
foundation only: the catalog ships no executable fixture/checker suite, so it
cannot yet produce correctness pass rates.

## Remaining limitations

1. **The benchmark is not yet a measured benchmark.** The 100 task definitions
   are broad and difficult, but without seed repositories and independent
   checkers they are evaluation specifications. A generated dossier invites an
   implementation attempt but cannot establish correctness.
2. **Completion is model-declared.** The normal agent has no acceptance-criteria
   ledger, test-evidence graph, stale-evidence invalidation, or independent
   verifier. A fluent final answer can still be wrong.
3. **Editing is not transactional.** `write_file` overwrites a file and
   `replace_in_file` performs literal replacement. There is no patch preview,
   atomic multi-file commit, rollback journal, safe rename/delete, or recovery
   after a partial refactor.
4. **Shell authorization is coarse.** Approval covers a command string, and the
   hard safety layer recognizes patterns instead of fully parsing shell syntax,
   wrappers, redirections, substitutions, environment expansion, executable
   identity, and resolved targets.
5. **Execution confinement is platform-dependent.** On macOS with
   `/usr/bin/sandbox-exec`, a permitted command gets a private temporary home,
   workspace-scoped writes, bounded system/toolchain reads, and explicit secret
   denials. Other supported systems retain the environment, timeout, process,
   workspace, and command guards but do not have an OS sandbox. The macOS
   profile still allows network access and does not impose CPU or memory quotas;
   it is defense in depth rather than a proof that untrusted project code is
   safe.
6. **Prompt-injection resistance is incomplete.** Terminal escapes are removed
   and outputs are bounded, but repository text and command output are still
   passed to the model as ordinary tool content. There is no instruction/data
   provenance or policy gate for instructions found in untrusted files.
7. **Context compaction is heuristic.** Character counts are not the provider's
   tokenizer, older turns are omitted rather than semantically checkpointed,
   and a very large newest turn can exceed the requested budget.
8. **Tool caching is narrow.** It lasts only for the current agent session, has
   no file-content dependency graph, and clears globally on mutations. It
   cannot reuse verified results between sessions or distinguish unaffected
   files.
9. **Specialized validation is delegated to repository commands.** There are no
   first-class AST, database, browser/accessibility, packet, profiler, fuzzing,
   race, model-checking, or observability tools.
10. **Parallelism is not exploited safely.** The provider may emit parallel tool
    calls, but Krater Pro executes them one by one and has no read/write conflict
    scheduler.
11. **Sessions are memory-only.** Conversation, approvals, tool evidence, and
    recovery state do not survive a CLI or GUI server restart.
12. **Authentication must follow a provider-supported protocol.** The reviewed
    implementation does not claim Krater OAuth/OIDC support and does not extract
    browser session cookies or private tokens. Supporting free and paid
    browser-login users safely requires official Krater authorization/token
    endpoints, client registration, scopes, PKCE, and documented API access for
    both account classes.
13. **Outcome quality remains model- and environment-dependent.** A stronger
    harness cannot substitute for a model's domain reasoning or for missing
    compilers, services, credentials, datasets, and platform-specific test
    environments.

## Prioritized recommendations

### P0 — required before reporting benchmark accuracy

1. **Build executable fixtures and independent checkers.** Start with one
   representative task per category, then expand to all 100. Check observable
   behavior, adversarial schedules, cleanup, and invariants; do not merely grep
   for expected code. Version fixture commits and checkers independently from
   prompts.
2. **Create an evidence-backed completion gate.** Convert acceptance criteria
   into a task ledger. Require each claimed result to reference a fresh command,
   diff, or checker record; invalidate evidence when dependent files change.
   Mark unsupported or unchecked criteria explicitly.
3. **Add transactional editing.** Introduce structured patch previews, baseline
   hashes, dirty-tree awareness, atomic multi-file publication where possible,
   rollback journals, and conflict detection before writes. This is the core
   gap behind KC-091, KC-094, KC-095, and KC-099.
4. **Replace regex shell policy with structured execution.** Prefer executable
   plus argument arrays over a general shell. Resolve executable and path
   targets, classify capabilities, preview effects, bind approvals to the
   canonical operation, record an audit event, and execute in a resource- and
   network-constrained sandbox.
5. **Harden the tool-output trust boundary.** Label repository and process output
   as untrusted data, preserve provenance, detect instruction-like injection and
   secret patterns, and prevent tool content from changing authorization policy.
   Add adversarial regression fixtures for KC-093 and KC-096.

### P1 — largest expected capability gains

6. **Add semantic repository tools.** Provide symbol search, references,
   definition lookup, AST-aware edits, diagnostics, dependency graphs, and safe
   rename/move/delete operations. Keep text tools as a fallback. This improves
   compiler, codemod, monorepo, and large-refactor tasks.
7. **Add durable task checkpoints.** Persist goals, selected skills, plans,
   approvals, file baselines, tool evidence, and pending verification. Resume
   only after reconciling the current workspace with the checkpoint.
8. **Use real token accounting and durable summaries.** Integrate
   model/tokenizer-aware budgets, checkpoint older constraints into a
   reviewable structured summary, and make the newest-turn overflow explicit.
   Add content-addressed read caching keyed by file hashes and tool version.
9. **Provide opt-in specialist harnesses.** Detect existing project tooling and
   expose structured adapters for race detectors, property/fuzz tests,
   databases, profilers, Playwright/axe, packet simulators, and fault injection.
   Preserve an explicit approval and sandbox boundary for each adapter.
10. **Implement only official browser login.** If Krater publishes OAuth/OIDC for
    third-party clients, use Authorization Code with PKCE, strict redirect/state
    validation, least-privilege scopes, secure OS credential storage, refresh
    rotation, revocation, and a documented fallback to API keys. Do not automate
    extraction of cookies or hidden tokens from an existing browser session.

### P2 — scale, efficiency, and evaluation quality

11. **Schedule independent read-only tools concurrently.** Build a dependency
    graph for tool calls, parallelize only conflict-free reads, serialize
    mutations, and invalidate caches by affected path rather than globally.
12. **Expand resource-aware execution.** Capture CPU, memory, file, network, and
    child-process budgets in tool results. Make timeout escalation and process
    cleanup consistent across supported platforms.
13. **Adopt a defensible evaluation protocol.** Maintain development, validation,
    and sealed holdout fixtures; run repeated trials; report external-check pass
    rate, variance, token/cost totals, wall time, unsafe-action rate, and
    intervention rate. Never optimize prompts against hidden checks and then
    report the same checks as unseen performance.
14. **Tune from failures, not task titles.** For each failed external checker,
    classify the cause as model reasoning, missing context, tool limitation,
    policy block, environment failure, or verifier defect. Change the smallest
    responsible layer and rerun both the failing fixture and a regression set.

## Readiness statement

Krater Pro now has a credible safe coding-agent core, broad language guidance,
cost controls, and a carefully designed benchmark harness. The strongest
implemented area is bounded, secret-aware repository operation. The largest
unclosed risks are correctness verification, transactional editing, shell and
prompt-injection isolation, durable recovery, and specialist runtime
instrumentation.

The next meaningful milestone is not “perfection.” It is a reproducible external
pass rate on isolated fixtures, with failures and unsupported criteria reported
as plainly as successes.
