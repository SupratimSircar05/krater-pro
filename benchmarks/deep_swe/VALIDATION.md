# DeepSWE adapter validation

Validation snapshot: 2026-07-27

## Confirmed offline

- The adapter imports and runs against the installed
  `datacurve-pier==0.3.0` API.
- The official checkout was clean and pinned to
  `e016041a6ccf8da29906afc9a3f5a8df940a1f78`.
- `python benchmarks/deep_swe/run_deep_swe.py` completed its plan-only bundle
  build and `--version` smoke for
  `superjson-error-stack-serialization`.
- The printed Pier command contains the host-only `--env-file` input and no
  `--agent-env`, API-key name, or API-key value.
- The dedicated branch command force-resets `krater-pro-eval` to the captured
  task HEAD, requires a clean starting tree, and requires the final branch to
  descend from that starting revision.
- Runtime and host build gates implement the package engine range
  `^20.19.0 || >=22.12.0`.
- Generated result paths are covered by
  `benchmarks/deep_swe/.gitignore`.

## Tests

The actual Pier Python runtime reported:

```text
Ran 19 tests

OK
```

The tests include a sentinel credential. It exists only in the host environment
and uploaded temporary-file bytes, never in an executed command or per-command
environment. The adapter also rejects a credential supplied through Pier's
`agent.env` channel. A real temporary Git repository test also proves that an
existing `krater-pro-eval` branch is reset to the captured task revision and
that the final clean solution commit descends from that revision.

Python compilation, the self-contained bundle build, and the bundle's offline
`--version` execution also passed.

## Not claimed

This hardening pass did not pull a DeepSWE image, start a task container, make a
Krater request, run an official verifier, or produce a reward. Plan-only and
offline test success validate the adapter contracts; they are not an official
DeepSWE score.
