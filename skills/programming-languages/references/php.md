# PHP

## Ecosystem detection

- Confirm `.php`, `composer.json`/lock, PHP shebang, framework CLI, or extension build files.
- Determine PHP version/extensions, CLI versus FPM/Apache, framework/CMS, and platform requirements from Composer, containers, and CI.

## Canonical toolchains

- Use Composer with its lock and repository scripts. Framework commands may use Symfony console, Laravel Artisan, PHPUnit/Pest, or CMS tooling.
- Static/quality tools commonly include PHPStan, Psalm, PHP-CS-Fixer, PHP_CodeSniffer, Rector, and framework analyzers when configured.
- For extensions, use the specified phpize/C toolchain and ABI.

## Inspect-first files

- Read `composer.json`, `composer.lock`, `phpunit.xml*`, static-analysis/style config, `php.ini` overrides, framework routes/config/container, migrations, autoload section, and CI.
- Trace web entry points, middleware, templates, sessions, queues, transactions, and environment loading without printing secrets.

## Build, test, lint, and format

- Install with `composer install` using lock-respecting repository flags; do not run `composer update` to fix setup.
- Use `vendor/bin/phpunit`, `vendor/bin/pest`, or Composer/framework scripts; narrow by file/filter.
- Run `php -l` for syntax, configured PHPStan/Psalm and code-style check mode, then framework cache/container and package build checks.

## Implementation idioms

- Preserve strict-types policy, typed properties, nullability, value objects, exceptions, dependency injection, and framework lifecycle.
- Use explicit comparison and array/key semantics; avoid variable variables, dynamic properties, globals, and business logic in templates.
- Treat request input as untrusted and distinguish absent, empty string, zero, and `null`.

## Debugging workflow

- Reproduce with the same SAPI/config and one test/request. Inspect exception chains, PHP error log, framework logs, and Composer platform checks.
- Use Xdebug/step debugging, stack traces, profiler, query logs, or container inspection as needed.
- Diagnose class errors through Composer autoload/PSR naming and cache state before adding manual requires.

## Concurrency, memory, and performance

- Traditional requests are isolated; workers/event-loop servers retain state. Reset request-scoped data and close resources in long-lived processes.
- Bound queues, retries, upload/body sizes, database pools, and external calls.
- Profile opcode/cache, allocations, autoload, serialization, template work, and N+1 database queries with representative production settings.

## Security hazards

- Prevent SQL/command injection, XSS with context escaping, CSRF, SSRF, path traversal, file-upload execution, session fixation, open redirect, and object injection.
- Avoid `unserialize` on untrusted data, `eval`, dynamic includes, weak password/token handling, and exposed debug pages.
- Keep secrets outside web roots/logs and validate proxy/header/cookie/TLS settings.

## Interoperability

- Check Composer package API/PHP constraints, extension ABI, FFI safety, JSON numeric/string/null behavior, date/timezone, and database encoding.
- Preserve framework route/schema/session/job compatibility and generated API contracts.

## Common failure modes

- CLI and FPM use different PHP/config/extensions; Composer platform mismatch; stale framework cache; autoload case mismatch on Linux.
- Loose-comparison bug; headers already sent; session lock; long-lived worker retains state; timezone/encoding drift; missing extension.

## Verification checklist

- [ ] Confirm PHP/SAPI, extensions, Composer lock, and framework environment.
- [ ] Run focused tests, syntax, static analysis, and style checks.
- [ ] Boot through the actual web/worker/CLI path and production cache mode.
- [ ] Test validation, auth, escaping, uploads, transactions, and retries.
- [ ] Verify database/wire/extension compatibility and secret-free errors.
