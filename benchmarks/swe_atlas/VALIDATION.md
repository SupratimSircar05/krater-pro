# SWE-Atlas adapter validation

Validation snapshot: 2026-07-27

## Confirmed offline

- Official SWE-Atlas checkout:
  `6de82c3603fb9e254170b440d7560441eb257176`.
- Official task inventory: 124 Q&A + 90 Test Writing + 70 Refactoring =
  284 tasks.
- Every one of the 284 task directories was copied and its rewritten TOML was
  parsed successfully.
- Every rewritten `[agent]` policy is `network_mode = "allowlist"` and contains
  `api.krater.ai` exactly once.
- All 90 Test Writing tasks retain their 15 official package/toolchain hosts,
  producing a 16-host allowlist after Krater is added.
- All Q&A and Refactoring tasks have only `api.krater.ai` during the agent
  phase because those upstream tasks declare no narrower agent allowlist.
- `bash benchmarks/swe_atlas/test_offline.sh`: 25/25 tests passed through
  Harbor v0.18.0's own Python runtime.
- All shell entry points pass `bash -n`.
- All Python modules pass `py_compile`.
- `payload_verify.mjs` passes `node --check`; its positive/negative fixture test
  accepts an intact payload and rejects a modified skills file.
- The verifier also accepted the complete current 43-file skills payload with
  the bundle and skills digests recorded below.
- A real temporary Git repository confirmed that submission capture includes
  committed edits plus untracked files, while the Q&A contract accepts the
  pristine base and rejects a tracked-file edit.
- The complete Krater Pro project passes `npm run typecheck` and `npm run build`.

## Confirmed with official Harbor

- Harbor `0.18.0` was installed from the official v0.18.0 checkout.
- `KraterProAtlasAgent` imports through the official custom-agent API.
- Harbor model metadata resolves to provider `moonshotai`, model `kimi-k3`.
- Agent construction and its mocked `setup()` / `run()` lifecycle succeeded
  through Harbor's actual `BaseInstalledAgent`, `BaseEnvironment.exec` contract,
  `ExecResult`, and `AgentContext`.
- The sentinel API key was present only in the host process and uploaded
  temporary-file bytes. It was absent from every executed command, every
  per-command environment, every config, and payload metadata.
- Supplying `KRATER_API_KEY` through `AgentConfig.env` is explicitly rejected.
- `qa.yaml`, `tw.yaml`, and `rf.yaml` each pass
  `harbor run --print-config`; none contains an agent `env` block.

## Bundle smoke

`build_bundle.sh` completed and the resulting bundle:

- executed `--version` successfully (`0.1.0`);
- was 340,199 bytes for this snapshot;
- uses the key-file-only benchmark entrypoint rather than the general CLI;
- kept the sentinel credential out of every generated shell command and
  process environment.

The SHA-256 recorded during this snapshot was
`cf605a941564bee10abc425b2d874753d83308b1d572bbf0627ac468a7707e50`.
The skills payload contained 43 regular files totaling 181,890 bytes, with
deterministic tree SHA-256
`74143dfe4a8e098ede055bd6afd2f508d230856747cf3223dc5e223c87189e4a`.
Each real Harbor trial writes both current identities plus the file-level
manifest under `agent/setup/` and verifies them inside the task image before
inference, so future builds remain attributable without depending on these
snapshot hashes.

## Not claimed by this snapshot

No benchmark image was pulled, no task container was started, no model or judge
request was made, and no SWE-Atlas reward was produced during this hardening
pass. The Docker allocation available during development remained below the
16,384 MiB requested by official tasks. An official score must come from
completed Docker/Harbor trials; the smoke and full-category commands in
`README.md` are the reproducible next steps.
