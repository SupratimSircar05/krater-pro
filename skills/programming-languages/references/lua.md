# Lua

## Ecosystem detection

- Confirm `.lua`, Lua shebangs, rockspecs, `lua_modules`, embedded host code, or framework configs.
- Determine Lua 5.1/5.2/5.3/5.4, LuaJIT, Luau, OpenResty, game-engine, Redis, Neovim, or embedded dialect; APIs and bytecode differ.

## Canonical toolchains

- Use the pinned interpreter and LuaRocks/tree or host application. Do not assume standalone Lua can reproduce embedded behavior.
- Tests may use busted, luaunit, host-specific harnesses, or custom scripts.
- Formatting/static tools may include Stylua, luacheck, Selene, Teal, or EmmyLua annotations when configured.

## Inspect-first files

- Read rockspecs/lockfiles, `.luacheckrc`, `stylua.toml`, package path setup, host/plugin manifest, test config, native modules, version pins, and CI.
- Trace module-loading conventions, globals/environment, coroutine/event lifecycle, userdata ownership, and generated code.

## Build, test, lint, and format

- Install through the repository LuaRocks tree or host workflow. Run configured `busted`, `lua test.lua`, or host test command with the same interpreter.
- Use `luac -p <file>` for compatible syntax checking, configured `luacheck`, and `stylua --check .`.
- For native rocks, build with the host ABI/compiler; avoid compiling against a different Lua version.

## Implementation idioms

- Prefer local variables/modules, explicit tables, consistent metatable/prototype style, and returned error conventions.
- Preserve array indexing, length behavior, multiple returns, `nil` deletion semantics, and host callback contracts.
- Avoid implicit globals, mutation during iteration, ambiguous truthiness assumptions, and loading source/bytecode from untrusted input.

## Debugging workflow

- Reproduce in the actual host/interpreter. Use tracebacks, `debug` hooks, host console/logging, busted filters, and package-path/module-version inspection.
- Check the first error plus coroutine boundary; stack traces may be lost across callbacks/yields.
- For native crashes, use host/native debugger and validate ABI before changing Lua logic.

## Concurrency, memory, and performance

- Lua states are generally not safely shared across threads without host synchronization. Understand coroutines versus OS threads and host event-loop rules.
- Close resources explicitly or through host-supported finalization; do not rely on unpredictable GC timing.
- Profile table allocation, string concatenation, metamethods, FFI crossings, regex/pattern work, and per-frame/per-request callbacks.

## Security hazards

- Never run untrusted `load`/`loadstring`/bytecode or expose the full standard library as a sandbox.
- Prevent command/SQL/path injection, unsafe module paths, denial via unbounded tables/recursion/patterns, and secrets in logs.
- Lua sandboxes require host-level resource and capability controls, not merely a restricted environment table.

## Interoperability

- Verify C API stack balance, registry/reference lifetime, longjmp/error boundaries, callbacks, allocator, and exact Lua ABI.
- For LuaJIT FFI, match C layout/calling convention and keep referenced memory alive.
- Define table/JSON array-map and `nil`/null conversions across hosts.

## Common failure modes

- Version/dialect mismatch; module found in wrong `package.path`; accidental global; `#table` on sparse array; lost multiple return.
- Coroutine yield across non-yieldable boundary; userdata finalized too early; C stack imbalance; LuaJIT-specific behavior.

## Verification checklist

- [ ] Confirm interpreter/dialect, host, package paths, and native ABI.
- [ ] Run focused host tests, syntax, lint, and format checks.
- [ ] Test coroutine/callback errors, cleanup, and resource limits.
- [ ] Exercise malformed data and sandbox/capability boundaries.
- [ ] Verify C/FFI and serialization behavior in the real host.
