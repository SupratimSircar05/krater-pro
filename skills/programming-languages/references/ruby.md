# Ruby

## Ecosystem detection

- Confirm `.rb`, Ruby shebangs, `Gemfile`, `.gemspec`, `Gemfile.lock`, `.ruby-version`, Rails/Rake files, or Bundler config.
- Determine MRI/CRuby, JRuby, TruffleRuby, Rails, or standalone Ruby and use version-manager/CI evidence.

## Canonical toolchains

- Use Bundler with the locked Ruby and gems; do not run unlocked gem installs into a shared environment.
- Tests may use RSpec, Minitest, Cucumber, or Rails test. Builds/tasks use Rake, Bundler, Rails, or gem commands.
- Quality tools may include RuboCop, Standard, Sorbet, Steep, Brakeman, or bundler-audit when configured.

## Inspect-first files

- Read `Gemfile`, lockfile platforms/Bundler version, `.ruby-version`, gemspec, Rakefile, test helper, Rails routes/config/initializers, database schema/migrations, lint/type config, and CI.
- Trace autoload paths, monkey patches/refinements, callbacks, jobs, transactions, and native extensions.

## Build, test, lint, and format

- Install with the repository Bundler version and `bundle install`; prefer deployment/frozen settings when configured.
- Run `bundle exec rspec <path>:<line>`, `bundle exec ruby -Itest <test>`, `bin/rails test`, or configured Rake tasks.
- Use `bundle exec rubocop`, `standardrb`, type checks, `bundle exec rake build`, and Rails security/schema checks only when present.

## Implementation idioms

- Preserve duck-typed protocols, keyword argument behavior, blocks/enumerators, frozen/string conventions, and framework callback ordering.
- Prefer small objects/modules and explicit errors; avoid global monkey patches, hidden class-variable state, and metaprogramming without tests.
- In Rails, keep validation, authorization, transaction, job retry, and query-loading semantics explicit.

## Debugging workflow

- Reproduce through `bundle exec` with one example/test. Inspect the full exception cause/backtrace and loaded gem versions.
- Use `debug`/`byebug`, Rails console/log tags, SQL logs, stackprof/rbspy, memory profilers, or Bundler dependency reports.
- Diagnose autoload/constant issues by checking Zeitwerk naming/paths before adding requires.

## Concurrency, memory, and performance

- Account for runtime GVL, threads, fibers, Ractors, JRuby differences, connection pools, and job/process concurrency.
- Do not share mutable request state; make timeout/retry/idempotency behavior explicit and release pooled resources.
- Measure object allocation, GC, N+1 queries, callbacks, serialization, regex behavior, and boot/autoload cost.

## Security hazards

- Avoid `eval`, unsafe YAML/Marshal loading, shell-string execution, mass assignment, SQL interpolation, open redirects, SSRF, XSS, and path traversal.
- Enforce authorization separately from authentication; protect CSRF/session/cookie secrets and filter sensitive parameters.
- Treat dynamic constantization and deserialization of class names as code-selection boundaries.

## Interoperability

- Check native gem ABI/platform, JRuby Java boundaries, C-extension ownership/GVL, JSON symbol/string keys, time zones, and decimal precision.
- Preserve Rails API/job/schema compatibility and gem semantic-version/public method expectations.

## Common failure modes

- Wrong Ruby/Bundler; platform-specific lock drift; autoload naming mismatch; keyword-argument version break.
- N+1 query; callback recursion; transaction/job timing; mutable default/shared class state; flaky time/order tests; native gem compile failure.

## Verification checklist

- [ ] Confirm Ruby/runtime, Bundler, lock platforms, and framework environment.
- [ ] Run focused/full relevant tests plus configured lint/type/security checks.
- [ ] Build gem/assets/database checks where applicable.
- [ ] Exercise authorization, callbacks, jobs, transactions, and failure retries.
- [ ] Verify native/wire consumers and production-mode boot smoke.
