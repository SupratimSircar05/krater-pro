# Terraform and HCL

## Ecosystem detection

- Confirm `.tf`, `.tf.json`, `.hcl`, `.tfvars`, `.terraform.lock.hcl`, module layout, Terragrunt/OpenTofu config, or provider/plugin code.
- Determine Terraform versus OpenTofu and exact CLI version, backend/workspace, providers, module sources, target accounts/regions, and wrapper (Terragrunt/Terramate).
- HCL is a syntax/library; not every `.hcl` file accepts Terraform expressions or commands.

## Canonical toolchains

- Use the pinned Terraform/OpenTofu/wrapper and committed provider lock. Providers/modules are executable supply-chain dependencies.
- Validation may use `fmt`, `validate`, speculative `plan`, `terraform test`, Terratest, Checkov/tfsec/TFLint, OPA/Sentinel, and cost tools when configured.
- Remote backends/runs require explicit credentials and can affect locks/state even during planning.

## Inspect-first files

- Read required versions/providers, lockfile, backend config, modules, variables/outputs, locals, resources/data sources, imports/moved blocks, workspaces, wrapper config, policy checks, and CI.
- Identify secrets/sensitive outputs, state ownership, lifecycle rules, `for_each` keys, dependencies, provider aliases, drift, and deployment order.

## Build, test, lint, and format

- Run `terraform fmt -check -recursive` and `terraform validate` after `init` only in a safe isolated backend context; use OpenTofu/wrapper equivalents as selected.
- Generate a saved speculative plan only for an explicitly identified non-production workspace/account, with refresh behavior understood. Read plan actions and unknowns.
- Run configured lint/security/tests. Never `apply`, destroy, force-unlock, import, move state, or change a live workspace merely to validate.

## Implementation idioms

- Pin required provider ranges appropriately, type variables, validate inputs, mark sensitive outputs, and prefer stable `for_each` keys.
- Use explicit dependencies only when data references cannot express them; preserve lifecycle and moved/import blocks during refactors.
- Keep modules cohesive, outputs minimal, names deterministic, and provider configuration at the composition root unless provider design requires otherwise.

## Debugging workflow

- Separate parse/type/validation, provider schema, authentication, backend/state, graph, plan drift, and API failures.
- Inspect address changes, state versus config, provider aliases, unknown/sensitive values, dependency graph, and version lock.
- Use verbose logs only in a controlled environment because provider/debug output can contain credentials and resource data.

## Concurrency, memory, and performance

- Terraform parallelizes graph operations; provider APIs, quotas, eventual consistency, and shared resources can race.
- Use dependencies/timeouts/retries and reduced parallelism only with evidence. Avoid unnecessary data-source/resource fan-out and huge collection expressions.
- Evaluate plan/apply duration, API calls, state size, provider memory, and module graph; optimization must preserve drift detection.

## Security hazards

- State and plan files often contain plaintext secrets even when values are marked sensitive. Secure backend, local artifacts, logs, caches, and CI outputs.
- Enforce least-privilege provider identities, module/provider provenance, checksums, policy, encryption, network controls, and protected destructive changes.
- Do not interpolate secrets into commands/user data when safer secret services exist.

## Interoperability

- Preserve provider/module/state schema compatibility, resource addresses, import IDs, output contracts, remote-state consumers, and API eventual consistency.
- Coordinate expand/migrate/contract with applications, databases, DNS, IAM, and Kubernetes consumers.
- Verify Terraform/OpenTofu/provider feature compatibility rather than assuming fork parity.

## Common failure modes

- Wrong workspace/account/region; provider lock/platform mismatch; backend initialized to unintended state; unstable `for_each` keys recreate resources.
- Unknown values break count/validation; provider alias not passed; state drift/import mismatch; sensitive data exposed; plan differs at apply due to external change.

## Verification checklist

- [ ] Confirm CLI/fork/version, backend/workspace, account/region, provider lock, and wrapper.
- [ ] Run format, validate, configured lint/security/tests, and safe speculative plan.
- [ ] Review every create/update/replace/destroy, unknown, permission, and sensitive value.
- [ ] Verify state/address/moved/import and downstream output compatibility.
- [ ] Require explicit authorization and a reviewed saved plan before any apply.
