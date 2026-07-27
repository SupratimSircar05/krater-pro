# Move

## Ecosystem detection

- Confirm `.move`, `Move.toml`, package lockfiles, named addresses, and Aptos/Sui/Movement/vendor CLI config.
- Identify the exact Move dialect/platform, compiler/CLI version, edition, network, framework revision, and object/account resource model. Commands and semantics differ across platforms.

## Canonical toolchains

- Use the platform CLI and package manager pinned by repository/CI (`aptos move`, `sui move`, or vendor equivalent).
- Tests include Move unit/scenario tests, transaction simulations, platform test validators, and Move Prover/formal specs where supported.
- Formatting/linting/coverage commands are platform/version-specific; discover from config and CLI help instead of translating flags between dialects.

## Inspect-first files

- Read `Move.toml`/lock, sources/tests/specs, named addresses, framework dependencies, package upgrade policy, deployment/publish scripts, object/resource capabilities, and CI.
- Trace entry/public functions, signer/capability checks, resource abilities, acquires/borrows, object ownership/sharing, events, dynamic fields/tables, and package compatibility.

## Build, test, lint, and format

- Use the selected CLI's build/test commands with local named addresses and locked dependencies; for example platform-prefixed `move build`/`move test`.
- Run prover, bytecode verifier, lint/format, coverage, upgrade compatibility, and gas checks only with syntax supported by the pinned platform.
- Use local simulation/testnet state explicitly. Never publish, upgrade, transfer assets, or sign a transaction for validation without authorization.

## Implementation idioms

- Encode assets/invariants as resources and capabilities; apply abilities (`key`, `store`, `copy`, `drop`) minimally.
- Enforce authorization at every public/entry boundary, preserve object/account ownership rules, and emit versioned events.
- Avoid exposing unrestricted capabilities, leaking resources through containers, or relying on caller-controlled generic types/addresses without checks.

## Debugging workflow

- Reproduce one unit/scenario test with exact CLI/framework version. Inspect abort code/location, transaction effects, events, object/resource changes, and gas.
- Reduce borrow/type/ability errors to the first diagnostic. Inspect fully qualified modules, named-address resolution, and dependency bytecode.
- For on-chain differences, simulate against a pinned state and distinguish protocol/framework version drift.

## Concurrency, memory, and performance

- Transactions are atomic, but shared objects/resources, optimistic execution, ordering, and retries can create contention or race-like economic behavior.
- Keep object/resource access sets narrow and avoid unbounded collections/loops or excessive dynamic-field/global storage operations.
- Measure gas/storage and contention with representative transaction sequences; preserve invariants across abort/retry.

## Security hazards

- Review signer/capability authorization, ownership transfer, shared-object access, resource leakage, generic type spoofing, reentrancy/callback features if platform supports them, oracle/price manipulation, and upgrade policy.
- Validate addresses, coin types, amounts, epochs/time, replay domains, and abort behavior.
- Protect private keys/profiles and never print CLI config/secrets or submit transactions accidentally.

## Interoperability

- Verify fully qualified type tags, BCS encoding, object/resource IDs, event schemas, transaction argument serialization, SDK-generated bindings, and network/framework versions.
- Preserve public module and package-upgrade compatibility; test existing resources against upgraded code.
- Align off-chain indexer expectations and finality/checkpoint semantics.

## Common failure modes

- Aptos/Sui dialect command/semantic mismatch; named-address error; framework revision drift; ability/borrow conflict.
- Missing capability check; object owned/shared incorrectly; BCS/type-tag mismatch; gas/storage blowup; incompatible package upgrade; test state unlike chain.

## Verification checklist

- [ ] Confirm platform/dialect, CLI/compiler, framework, edition, network, and addresses.
- [ ] Run focused/full tests, verifier/prover, lint/format, gas, and compatibility checks.
- [ ] Test unauthorized callers, wrong object/type/address, aborts, and invariant preservation.
- [ ] Verify existing-resource upgrade plus SDK/BCS/indexer boundaries.
- [ ] Simulate locally; require explicit authority for signing/publish/upgrade.
