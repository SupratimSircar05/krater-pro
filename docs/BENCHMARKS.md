# Benchmark status

Krater Pro has two distinct benchmark layers:

1. its own 100-task expert catalog, which can be validated offline and run
   selectively with independent fixture checkers; and
2. adapters for DeepSWE, SWE-bench Pro-os, and SWE-Atlas, whose official
   containers and evaluators determine correctness.

Adapter tests, container startup, model completion, and evaluator reward are
separate gates. Passing an earlier gate is never reported as a solved benchmark
task.

## Official benchmark matrix

Status observed on 2026-07-27:

| Suite | Adapter/infrastructure | Official task result | Current limitation or next step |
| --- | --- | --- | --- |
| [DeepSWE](../benchmarks/deep_swe/README.md) | Offline adapter suite passed. The official task catalog and Pier contract were prepared and validated. | Not run; no reward produced. | Selected tasks request 8 GiB, while the available Docker VM exposes about 7.75 GiB. Increase Docker memory before starting an official container. |
| [SWE-Atlas](../benchmarks/swe_atlas/README.md) | Offline adapter suite passed; all three category configurations initialized and the bundle smoke passed. | Not run; no Harbor reward produced. | Official tasks request 16 GiB, while the available Docker VM exposes about 7.75 GiB. Increase Docker memory substantially before running a trial. |
| [SWE-bench Pro-os](../benchmarks/swe_pro/README.md) | The bounded infrastructure-only container path passed. | **Failed 0/1** on the first exact `moonshotai/kimi-k3` attempt: the submitted patch passed 11 of 14 official tests. A second attempt did not yield a score because the provider stream ended before a complete response. | Diagnose the incomplete stream, rerun one bounded task, and accept a pass only from the official evaluator. |

These results do **not** show that all benchmarks pass. They establish working
adapters and infrastructure within the available machine limits, plus one
officially evaluated SWE-bench Pro-os failure that remains a product-quality
input.

## Interpreting the SWE-bench Pro-os attempts

The first run completed far enough to produce a patch and invoke the official
evaluator. Its result is `0/1`; “11/14 tests” is diagnostic evidence, not a
partial pass or a rounded score.

The second run failed during inference because Krater returned an incomplete
provider stream. It has no correctness result and must not replace, improve, or
average the first score. A future rerun should retain the raw agent and
evaluator evidence while keeping credentials out of artifacts.

## Resource gates

The Docker VM reported about 7.75 GiB of memory. Krater Pro refuses to describe
an unstarted task as a smoke pass when the official task's requested memory
cannot be met:

- DeepSWE requires 8 GiB for the selected official tasks.
- SWE-Atlas requires 16 GiB.
- The bounded SWE-bench Pro-os infrastructure path fits within the current VM.

Lowering an official task's declared memory merely to force startup would make
the run non-comparable and is not used as benchmark evidence.

## Krater Pro 100-task catalog

Offline validation checks the exact task count, schema, selectors, scoring
metadata, checker trust gates, redaction, and isolated-workspace policy:

```sh
npm run benchmark:validate
npm run benchmark -- --list
```

An offline-valid catalog measures harness integrity, not model correctness. A
paid run is opt-in and must name one task/category or explicitly request all
tasks. Independent executable checks are the correctness authority; the model's
own answer and completion status are not.

```sh
npm run benchmark -- --live --task KC-001 \
  --model moonshotai/kimi-k3
```

Review the command, expected cost, fixture, checker source, and checker SHA-256
before running. The runner keeps the Krater key out of the agent workspace,
checker environment, command arguments, and generated reports.

- Catalog: [../benchmarks/TASKS.md](../benchmarks/TASKS.md)
- Methodology: [../benchmarks/REPORT.md](../benchmarks/REPORT.md)
- Tuning record: [../benchmarks/TUNING.md](../benchmarks/TUNING.md)
