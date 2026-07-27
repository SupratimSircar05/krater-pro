# Assembly and WebAssembly

## Ecosystem detection

- Assembly: confirm `.s`/`.S`/`.asm`, assembler syntax/directives, architecture, object format, ABI, linker script, and compiler-generated integration.
- WebAssembly: confirm `.wat`/`.wasm`, WASI/component/WIT config, wasm target flags, Emscripten/wasm-bindgen/AssemblyScript/toolchain artifacts.
- Never infer ISA, syntax, feature set, memory model, or host ABI from extension alone.

## Canonical toolchains

- Assembly may use GNU `as`, LLVM integrated assembler, NASM/YASM, MASM, vendor/embedded assemblers, compiler drivers, linkers, and emulators.
- WebAssembly may use WABT, Binaryen, Wasmtime/Wasmer/Node/browser, WASI SDK, Emscripten, wasm-tools, or language-native generators.
- Tests use repository build/emulator/hardware/host harnesses; format/lint and verification tools vary by syntax and target.

## Inspect-first files

- Read build/toolchain files, assembler/compiler flags, target triples/features, calling convention, linker scripts/map files, symbol exports/imports, generated-source policy, host bindings, WIT/interface files, and CI.
- Trace registers/stack alignment, callee/caller saves, sections/relocations, unwind/debug info, atomic/fence use, linear-memory ownership, table/function references, and sandbox capabilities.

## Build, test, lint, and format

- Build through the configured compiler/build system; a standalone assembler command may omit preprocessing, ABI flags, includes, link scripts, or target features.
- Run target/emulator/host tests and compare disassembly/symbols with `objdump`/`llvm-objdump` or wasm tools selected by the project.
- Validate WAT/wasm, optimize only through configured Binaryen/toolchain steps, and test debug plus optimized artifacts. Never flash hardware merely to validate without authorization.

## Implementation idioms

- Follow exact ABI for registers, stack alignment, red zone/shadow space, return values, unwind metadata, and symbol visibility.
- Preserve flags and registers across calls, make memory bounds/alignment/endianness explicit, and document instruction-set feature requirements.
- For Wasm, validate every offset/length into linear memory, define allocator/free ownership, and keep host imports/capabilities minimal.

## Debugging workflow

- Reproduce with exact architecture/features/linker/host. Use disassembly, symbol/relocation tables, debugger/emulator, register/memory traces, core dumps, and differential tests against a high-level implementation.
- Compare generated machine code only after confirming source/preprocessor/link configuration.
- For Wasm traps, inspect stack trace, import signatures, memory/table bounds, start function, WASI permissions, and host runtime version.

## Concurrency, memory, and performance

- Use ISA/Wasm memory-model atomics and fences; ordinary loads/stores do not create synchronization.
- Check stack/heap/linear-memory bounds, reentrancy, interrupt/signal safety, shared-memory feature support, and host callback lifetime.
- Benchmark on representative hardware/runtime. Measure alignment, cache/branch behavior, SIMD features, code size, host crossings, memory growth, and bounds-check effects.

## Security hazards

- Prevent arbitrary memory access, stack corruption, integer overflow in address calculation, speculative/side-channel leaks, unsafe self-modifying code, and missing control-flow protections.
- Wasm sandboxing does not make dangerous host imports safe; enforce capability, path, network, time, and memory limits.
- Validate binaries/toolchains, avoid exposing secrets in dumps, and treat JIT/native extensions as executable supply-chain inputs.

## Interoperability

- Define ISA ABI, object format, relocation/PIC, symbol naming, calling convention, unwind/debug metadata, data layout, and CPU features.
- For Wasm, align import/export signatures, canonical ABI/component model/WIT, WASI version, string/list encoding, memory ownership, and JS BigInt/number behavior.
- Test both sides of every host/foreign call and every supported architecture/runtime.

## Common failure modes

- Wrong assembler syntax/architecture mode; stack misalignment; clobbered callee-saved register; relocation/PIC or linker-script error.
- Optimized-only failure due to ABI/undefined behavior; unsupported CPU instruction; Wasm import signature mismatch; stale JS glue; out-of-bounds/trap; WASI preview mismatch.

## Verification checklist

- [ ] Confirm ISA/syntax/features, ABI/object format/linker, or Wasm/WASI/component runtime.
- [ ] Build debug/optimized, run target/host tests, and inspect symbols/disassembly/validation.
- [ ] Test bounds/alignment, calls, unwinding, errors/traps, and concurrency.
- [ ] Benchmark representative hardware/runtime and check feature fallback.
- [ ] Verify all foreign/host bindings and sandbox capabilities.
