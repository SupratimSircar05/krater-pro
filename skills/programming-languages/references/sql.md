# SQL

## Ecosystem detection

- Identify the actual database/dialect from connection drivers, migration config, schema files, containers, CI, and query syntax.
- Distinguish PostgreSQL, MySQL/MariaDB, SQLite, SQL Server, Oracle, BigQuery/Snowflake/warehouse SQL, and ORM query languages; never assume portable semantics.
- Determine server version, extensions, collation, timezone, transaction mode, and read/write environment.

## Canonical toolchains

- Use the repository migration/query tool and a disposable/local database matching production where possible.
- Native clients (`psql`, `mysql`, `sqlite3`, `sqlcmd`, etc.), schema diff tools, ORM CLIs, and test containers are dialect-specific.
- Use `EXPLAIN`/query plans safely; `EXPLAIN ANALYZE` executes the statement and can mutate or be expensive.

## Inspect-first files

- Read schema and ordered migrations, ORM models/config, seeds/fixtures, database version/extension config, query builder code, connection/transaction settings, and CI.
- Check constraints, indexes, triggers, functions, views/materialized views, row-level security, grants, generated columns, and data-volume assumptions.

## Build, test, lint, and format

- Run migrations and tests only against an explicitly non-production database. Prefer repository commands and transactional test harnesses.
- Use dialect-specific parse/lint/format/schema validation already configured. Avoid claiming validity from a generic SQL parser.
- Compare migration up/down or forward-only policy, schema snapshot, and ORM generated-code diff. Run query plans with representative statistics/data.

## Implementation idioms

- Use parameter binding, explicit columns, deterministic ordering, correct null/three-valued logic, and constraints as invariants.
- Choose joins, CTEs, windows, isolation, locks, and upserts according to the exact dialect/version.
- Make migrations backward-compatible for rolling deploys; separate expand, backfill, and contract when needed.

## Debugging workflow

- Reproduce with minimal schema/data and the same dialect/version. Inspect error code, transaction state, bound parameter types, and query plan.
- Compare estimated versus actual rows where safe, indexes/statistics, lock waits, deadlocks, and application-generated SQL.
- Diagnose correctness before optimization; a faster wrong query is not a fix.

## Concurrency, memory, and performance

- Reason about isolation anomalies, MVCC/locking, lock order, retries, idempotency, connection pools, statement timeouts, and long transactions.
- Measure plans with realistic cardinality/distribution. Watch full scans, bad join order, implicit casts, non-sargable predicates, sorts/spills, N+1 calls, and over-indexing.
- Avoid holding transactions open across network/user work.

## Security hazards

- Parameterize values and safely allowlist identifiers/order clauses; escaping is dialect/context-specific.
- Enforce least-privilege roles, tenant/RLS boundaries, encrypted connections, safe backups, and redacted query logs.
- Guard destructive migrations, dynamic SQL, definer-rights routines, unsafe search paths, and personally identifiable data.

## Interoperability

- Align driver parameter/return types, decimals, timestamps/timezones, UUIDs, JSON, binary, arrays, booleans, and nullability.
- Preserve schema/API compatibility across old/new application versions and CDC/replicas/analytics consumers.
- Verify identifier casing/quoting and encoding/collation behavior.

## Common failure modes

- Wrong dialect/version; `NULL` compared with `=`; missing deterministic order; implicit cast defeats index; timezone/collation drift.
- Migration locks table; connection pool exhaustion; retry duplicates side effects; ORM lazy N+1; test SQLite differs from production engine.

## Verification checklist

- [ ] Confirm dialect, version, extensions, role, and non-production target.
- [ ] Test query/migration on representative schema/data and both null/error cases.
- [ ] Inspect constraints, plan/cardinality, locks, and rollback/retry behavior.
- [ ] Run application integration tests with parameter binding and old/new versions.
- [ ] Review permissions, tenant isolation, logging, and deployment safety.
