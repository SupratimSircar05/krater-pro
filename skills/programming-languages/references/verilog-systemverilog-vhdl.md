# Verilog, SystemVerilog, and VHDL

## Ecosystem detection

- Confirm `.v`, `.sv`/`.svh`, `.vhd`/`.vhdl`, file lists, package/include/library declarations, simulator/synthesis/project files, and constraints.
- Identify language revision, simulator, synthesizer, FPGA/ASIC target, formal tool, UVM/VUnit/cocotb harness, timescale, and mixed-language support.

## Canonical toolchains

- Use repository-selected Icarus/Verilator/GHDL/NVC or commercial Questa/VCS/Xcelium/Riviera tools for simulation, and vendor/ASIC tools for synthesis/place-route.
- Tests may use native testbenches, UVM, cocotb, VUnit, OSVVM, assertions, coverage, or formal tools such as SymbiYosys.
- Lint/format/CDC/RDC/equivalence commands are vendor- and configuration-specific; mirror project scripts.

## Inspect-first files

- Read file lists/order, packages/includes/libraries, top/testbench, parameters/generics, clock/reset definitions, constraints, IP manifests, generated files, simulator/synthesis flags, waiver files, and CI.
- Trace clock domains, reset crossings, combinational/sequential processes, blocking/nonblocking or signal/variable semantics, widths/signedness, initialization, and synthesizability.

## Build, test, lint, and format

- Invoke repository simulation targets with fixed seeds plus randomized/regression seeds. Compile/elaborate using exact file order, defines, libraries, standard, and top.
- Run configured lint, assertions, coverage, formal, CDC/RDC, synthesis, and timing checks. Open-source syntax success is not proof of commercial synthesis equivalence.
- Do not program hardware or submit expensive remote runs merely to validate source without authorization.

## Implementation idioms

- Use `always_comb`/`always_ff` and nonblocking sequential assignments in SystemVerilog where supported; provide complete combinational assignments.
- In VHDL, distinguish signals/variables, use `numeric_std`, explicit widths/types, and clocked process templates accepted by target tools.
- Synchronize asynchronous controls/data appropriately, encode reset/latency/handshake invariants, and use assertions at interfaces.

## Debugging workflow

- Reproduce with exact seed/tool and smallest failing test. Inspect compile/elaboration first, then assertion time, waveform, unknown/high-impedance propagation, drivers, delta cycles, and transactions.
- Compare simulation and synthesis interpretations for latches, initial values, delays, unsized literals, case completeness, and unsupported constructs.
- For timing failures, inspect path, clock relation, constraints/exceptions, CDC, fanout, and physical mapping before RTL micro-optimization.

## Concurrency, memory, and performance

- HDL concurrency models hardware, not software threads. Reason cycle-by-cycle about combinational paths, registers, handshakes, pipelines, arbitration, and backpressure.
- Avoid unintended latches, combinational loops, clock gating, unsynchronized crossings, metastability assumptions, and unbounded testbench processes/queues.
- Measure frequency/slack, area/resources, power, latency, throughput, simulator runtime, and formal state space on the actual target flow.

## Security hazards

- Review debug/test ports, privilege/secure-boot state, fault injection, side channels, information-flow leakage, unsafe default states, and uninitialized/X-dependent control.
- Constrain all clocks/I/O correctly; prevent CDC-induced corruption, width truncation, counter overflow, and maliciously triggered deadlock.
- Treat third-party/generated IP, bitstreams/netlists, and vendor scripts as trusted executable/sensitive artifacts.

## Interoperability

- Define interface protocol, widths, signedness, endianness/bit order, clock/reset domain, latency, valid/ready behavior, burst/error semantics, and register map.
- For mixed-language/DPI/VPI/cocotb, align time units, four-state encoding, array layout, ownership, simulator ABI, and callback phases.
- Verify firmware/drivers against generated headers/register models and hardware revision.

## Common failure modes

- Wrong compile order/library/standard/top; width/signedness truncation; blocking/nonblocking race; inferred latch.
- Simulation-synthesis mismatch; X optimism/pessimism; reset deassertion CDC; bad timing exception; multiple drivers; off-by-one pipeline/handshake.

## Verification checklist

- [ ] Confirm language revisions, tools, target, file order/defines, top, clocks, and constraints.
- [ ] Run focused/regression simulation with assertions/seeds and lint/formal/CDC as configured.
- [ ] Check synthesis, timing, area/power, and simulation-synthesis equivalence where required.
- [ ] Verify reset, X behavior, crossings, backpressure, overflow, and error paths.
- [ ] Contract-test mixed-language, register, firmware, and physical interfaces.
