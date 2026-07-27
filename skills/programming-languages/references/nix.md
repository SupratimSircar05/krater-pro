# Nix

## Ecosystem detection

- Confirm `.nix`, `flake.nix`, `flake.lock`, `shell.nix`, `default.nix`, NixOS modules/configuration, Home Manager, or derivation overlays.
- Determine Nix version, flakes setting, nixpkgs revision, platform/system, NixOS/Home Manager/Darwin context, and evaluator/build sandbox policy.

## Canonical toolchains

- Use pinned flakes/lock or repository channel/niv policy; do not mix channels and flakes silently.
- Validation may use `nix flake check`, `nix build`, `nix develop`, `nix eval`, NixOS tests, VM builds, statix, deadnix, alejandra/nixfmt, or deploy tools when configured.
- Building/evaluating can fetch and execute builders; deployment and system switching mutate hosts.

## Inspect-first files

- Read flake inputs/outputs/lock, overlays, modules/options, derivations, package definitions, dev shells, checks, supported systems, secrets integration, substituters/trusted keys, and CI.
- Trace purity/impurity, evaluation versus build time, module option merging, fixed-output hashes, platform guards, and generated files.

## Build, test, lint, and format

- Use repository-selected commands, commonly `nix flake check`, `nix build .#<attr>`, or checks for a specific system; legacy projects may require `nix-build`/`nix-shell`.
- Run configured formatter/statix/deadnix and NixOS/module VM tests.
- Avoid `--impure` unless the project requires and documents it. Never `nixos-rebuild switch`, `darwin-rebuild switch`, Home Manager switch, deploy, or update locks merely to validate.

## Implementation idioms

- Keep derivations pure and inputs explicit; use `lib` module combinators, option types/defaults, `callPackage`, and overlays consistently with the repository.
- Preserve laziness and avoid forcing huge attribute sets. Make supported systems/platform conditions explicit.
- Do not hide mutable host dependencies in derivations or leak secrets into store paths, which are broadly readable and immutable.

## Debugging workflow

- Separate parse/evaluation, infinite recursion, option merge, derivation/build, hash, substitute, sandbox, and runtime failures.
- Use `nix eval`, `nix repl`, `--show-trace`, derivation inspection, build logs, and minimal attribute builds; avoid verbose logs around secrets.
- Inspect the resolved lock/input and target system before changing hashes or platform conditions.

## Concurrency, memory, and performance

- Nix schedules derivations in parallel subject to jobs/cores/resources; builders must not race on external mutable state.
- Evaluation can consume memory through large recursive attribute sets/import-from-derivation and repeated system expansion.
- Measure evaluation/build closure size, cache hits, store paths, build parallelism, and image/closure output. Avoid gratuitous rebuilds from unstable inputs.

## Security hazards

- Never place secrets in derivation arguments, source files, command lines, environment captured by derivations, or generated store paths.
- Audit substituters/trusted keys, flake inputs, overlays, builders, sandbox escapes, unfree/insecure allowances, and remote builders.
- Avoid importing arbitrary fetched Nix without a pinned source/hash and review activation scripts before host mutation.

## Interoperability

- Define flake outputs, module options, overlays/package attributes, supported systems, runtime dependencies, and dev-shell environment contracts.
- Preserve lock/input compatibility across Nix versions and NixOS/Home Manager/Darwin module versions.
- Verify container/OCI outputs, language package locks, C libraries, and service units from the built closure.

## Common failure modes

- Wrong experimental features/Nix version/system; dirty tree changes source; lock/input drift; infinite recursion or missing option.
- Secret copied to store; hash mismatch papered over incorrectly; build works impurely only; overlay argument mismatch; package evaluates but runtime dependency missing.

## Verification checklist

- [ ] Confirm Nix version/features, lock/channels, system, target output, and sandbox/cache policy.
- [ ] Run format/lint, focused eval/build, flake checks, and module/VM tests.
- [ ] Inspect closure/runtime dependencies, supported systems, purity, and reproducibility.
- [ ] Scan for secrets/store leakage and review activation/deployment effects.
- [ ] Require explicit authorization before updating locks or switching/deploying a host.
