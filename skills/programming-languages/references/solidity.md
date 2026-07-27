# Solidity

## Ecosystem detection

- Confirm `.sol`, `pragma solidity`, Foundry/Hardhat/Truffle/Brownie/Ape config, dependency remappings, or deployment scripts.
- Determine exact compiler range/commit, EVM target, chain/fork, optimizer/via-IR settings, upgrade pattern, and testing/deployment framework.

## Canonical toolchains

- Use repository Foundry (`forge`/`anvil`/`cast`) or Hardhat/package-manager workflow; do not mix artifacts casually.
- Tests may include Solidity unit/fuzz/invariant tests, TypeScript tests, fork tests, and formal/property tools.
- Quality/security tools may include Slither, Mythril, Echidna, Medusa, Certora, solhint, gas snapshots, and compiler warnings when configured.

## Inspect-first files

- Read framework/compiler config, lockfiles/remappings, contracts/interfaces/libraries, tests/invariants, deployment and upgrade scripts, addresses/network config, ABI/artifacts policy, and CI.
- Trace storage layout, initializer/access control, proxy/delegatecall, external calls, token assumptions, oracle/bridge dependencies, signatures, and chain-specific behavior.

## Build, test, lint, and format

- Foundry: use configured `forge build`, focused `forge test --match-test ...`, fuzz/invariant tests, `forge fmt --check`, and gas/storage-layout checks.
- Hardhat: use locked package-manager scripts or configured `hardhat compile/test`; exact commands/plugins vary, so inspect scripts.
- Use local ephemeral chain or pinned read-only fork. Never broadcast, deploy, upgrade, or spend funds merely to validate code.

## Implementation idioms

- Follow checks-effects-interactions, explicit access control, pull/payment safety, custom errors/events, fixed compiler settings, and well-audited libraries.
- Preserve storage layout for upgradeable contracts; append fields according to framework rules and protect initializers.
- Specify units, rounding, token behavior, invariants, replay domains, and failure behavior. Treat external calls as adversarial.

## Debugging workflow

- Reproduce with exact compiler/EVM/fork block and one deterministic test. Inspect traces, revert data, events, storage slots, balances, calldata, and gas.
- Add fuzz/invariant counterexamples and shrink/minimize call sequences. Distinguish contract bug from RPC/fork state/compiler/plugin mismatch.
- Compare source maps and optimizer settings when traces or bytecode differ.

## Concurrency, memory, and performance

- EVM execution is serial per transaction, but adversaries control transaction ordering, callbacks, reentrancy, MEV, and cross-transaction state.
- Reason about gas, calldata/storage/memory expansion, loops bounded by attacker-controlled state, and denial-of-service paths.
- Measure gas on representative flows and compiler settings; never trade away safety/invariants for unmeasured savings.

## Security hazards

- Review reentrancy, authorization, initialization, delegatecall/storage collision, oracle manipulation, flash-loan economics, front-running, signature replay/malleability, rounding, overflow/unchecked blocks, and DoS.
- Avoid `tx.origin` authorization, unbounded external iteration, arbitrary call targets, weak randomness, unsafe selfdestruct assumptions, and unchecked token returns.
- Protect private keys/RPC secrets; simulation success does not authorize broadcast.

## Interoperability

- Verify ABI selectors/types, events, custom errors, proxy/admin interfaces, chain IDs, EIP domains, token decimals/return quirks, and off-chain encoding.
- Preserve deployed storage and interface compatibility; test old/new implementation through the actual proxy.
- Check L1/L2 bridge semantics, precompiles, finality, timestamp/block assumptions, and target EVM support.

## Common failure modes

- Compiler/optimizer mismatch; stale artifact/ABI; wrong fork block/chain; missing initializer; proxy storage corruption.
- Reentrancy or callback ordering; fee-on-transfer/rebasing token assumption; integer rounding leaks value; gas grows with state; signature domain/replay bug.

## Verification checklist

- [ ] Confirm compiler commit, optimizer/EVM, framework, chain, and fork block.
- [ ] Run unit, fuzz, invariant, negative auth, static/security, and gas checks.
- [ ] Verify storage layout, initializer, proxy, ABI, events, and old/new compatibility.
- [ ] Model adversarial ordering/callbacks/tokens/oracles and economic invariants.
- [ ] Use simulation only; require explicit authorization for any transaction/broadcast.
