# COBOL

## Ecosystem detection

- Confirm `.cob`/`.cbl`/`.cpy`, JCL, copybooks, CICS/IMS/DB2 directives, GnuCOBOL configs, or mainframe build metadata.
- Determine COBOL vendor/dialect/version, fixed/free/reference format, character set, decimal mode, platform, transaction monitor, database, and batch environment.

## Canonical toolchains

- Use the repository/mainframe pipeline and exact compiler: IBM Enterprise COBOL, Micro Focus/Visual COBOL, GnuCOBOL, Fujitsu, or another vendor.
- Tests may use zUnit/vendor frameworks, batch/JCL harnesses, golden files, service virtualization, or GnuCOBOL local tests.
- Formatting/static analysis, preprocessors, bind/link, CICS/DB2 translation, and copybook tools are vendor-specific.

## Inspect-first files

- Read compile listings/options, source format directives, copybook search/order and versions, JCL/procs, linkage sections, file definitions, data layouts, DB2/CICS/IMS metadata, test data, and deployment controls.
- Trace `REDEFINES`, `OCCURS DEPENDING ON`, packed decimal, sign/scale, record layouts, file status, return codes, paragraphs/sections, and encoding conversions.

## Build, test, lint, and format

- Invoke the declared build/compile/JCL pipeline; do not translate vendor flags to `cobc` unless GnuCOBOL compatibility is an explicit target.
- Compile with warning/listing/static-analysis options configured by the project and run focused batch/program/unit harnesses with disposable datasets.
- Verify DB2 bind/CICS translation/copybook generation through non-production pipelines. Never submit production jobs or mutate live datasets for validation.

## Implementation idioms

- Preserve data division layout, field lengths/scales/signs, copybook contracts, condition names, file status and return-code handling.
- Prefer structured scope terminators and explicit initialization within the project's supported standard; avoid unrelated modernization in a fix.
- Make date century/windowing, numeric rounding, truncation, overflow, and record boundaries explicit.

## Debugging workflow

- Reproduce with exact compiler/options/copybooks and minimal input record. Inspect compile listing, abend/message codes, dump offsets, file status, SQLCODE/CICS response, and job step return codes.
- Trace data definitions and raw bytes before business logic when numeric/encoding/record issues arise.
- Compare online versus batch transaction state and environment-specific dataset/catalog definitions.

## Concurrency, memory, and performance

- Understand CICS task reentrancy/thread safety, batch checkpoint/restart, record locking, DB2 isolation, IMS positioning, and shared working storage.
- Avoid hidden mutable program state in reusable/reentrant programs and long transactions/locks.
- Measure CPU/service units, EXCP/I/O, sort, SQL plans, record blocking, table access, and decimal conversions on representative volumes.

## Security hazards

- Enforce dataset/database authorization, input record validation, transaction auth, least privilege, and audit requirements.
- Prevent buffer/field truncation, unchecked numeric data, command/JCL/SQL injection, sensitive data in dumps/spools, and unsafe temporary datasets.
- Treat copybooks, job parameters, and external calls as trust boundaries.

## Interoperability

- Define copybook layout, encoding (EBCDIC/ASCII/Unicode), packed/zoned decimal, endian, sign, alignment, record framing, and null conventions.
- Verify linkage calling convention, parameter mode/length, LE/runtime, C/Java/.NET adapters, DB2 host variables, and generated schemas.
- Use contract tests with byte-level fixtures and actual producer/consumer codecs.

## Common failure modes

- Wrong dialect/source format/copybook version; column truncation; encoding drift; packed-decimal data exception.
- Uninitialized working storage; `REDEFINES`/record length mismatch; date-window bug; SQLCODE/file status ignored; JCL condition-code logic skips/continues wrong step.

## Verification checklist

- [ ] Confirm compiler/dialect/options, source format, copybooks, runtime, and environment.
- [ ] Compile with listings/static checks and run focused batch/online tests.
- [ ] Test record byte layouts, boundaries, decimal/date/error/status behavior.
- [ ] Verify restart/idempotency, transactions/locks, and representative volume.
- [ ] Contract-test mainframe/data/service consumers without touching production.
