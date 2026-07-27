# Protocol Buffers and GraphQL

## Ecosystem detection

- Protocol Buffers: confirm `.proto`, `buf.yaml`/lock/generation config, protoc plugins, gRPC/gateway code, descriptor sets, or generated markers.
- GraphQL: confirm `.graphql`/`.gql`, SDL/code-first schema, operations/fragments, codegen config, federation/subgraph/router config, persisted-query manifests, or generated clients.
- Identify schema source of truth, tool/plugin versions, consumers, transport, compatibility policy, and generated output ownership.

## Canonical toolchains

- Protobuf uses pinned `protoc` or Buf plus language plugins; validation may include `buf lint`, build, format, breaking checks, generated diff, and gRPC tests.
- GraphQL tooling is framework-specific: schema validation, GraphQL Code Generator/Apollo/Relay/vendor checks, operation validation, federation composition, and contract tests.
- Use repository wrappers/containers because generator versions and options materially change output.

## Inspect-first files

- Read schema roots/imports, Buf/protoc/codegen/plugin config and locks, GraphQL schema/codegen/client/router config, generated-code policy, compatibility baselines/registries, operations, resolvers, auth directives, and CI.
- Trace field/number reservations, oneofs/maps/presence, custom options, nullability, input/output evolution, IDs/scalars/enums/unions, pagination, errors, caching, subscriptions/streaming, and federation ownership.

## Build, test, lint, and format

- Run pinned lint/build/format and generation in check/diff mode. Typical Protobuf flow is repository `buf lint`, `buf build`, `buf breaking --against <declared-baseline>`, and `buf generate`.
- Run GraphQL schema/operation validation, codegen, resolver tests, and composition/contract checks through configured scripts; commands vary by server/client/vendor.
- Never publish schemas, push a registry check, or overwrite generated source without inspecting effects and authorization for external mutations.

## Implementation idioms

- Protobuf: never reuse field numbers; reserve removed numbers/names; add fields compatibly; use presence intentionally; avoid changing scalar/wire type, package, or service method semantics.
- GraphQL: evolve additively; nullable output and optional input are safest defaults; deprecate before removal; define custom scalar and pagination/error semantics.
- Keep schemas as contracts, generated code disposable/reproducible, and business authorization in resolvers/services rather than client-visible metadata alone.

## Debugging workflow

- Reproduce schema compile/validation first, then generated compile, transport call, serialization, and application behavior.
- Inspect descriptor/introspection/schema diff, exact plugin versions/options, operation variables, resolver path/error extensions, traces, and raw wire frames only with sensitive values redacted.
- Distinguish schema compatibility from semantic compatibility; a technically valid additive field can still overload or expose data.

## Concurrency, memory, and performance

- Bound message/query size, recursion/depth, repeated fields, streaming buffers, subscriptions, resolver fan-out, deadlines, cancellation, and backpressure.
- Avoid GraphQL N+1 via batching scoped correctly per request and Protobuf copying/materializing huge messages.
- Measure serialized size, parse/validation time, resolver/query plans, fan-out, cache behavior, stream flow control, and codegen/bundle size.

## Security hazards

- Enforce auth/authz at every field/RPC/resource, not just endpoint reachability. Protect introspection/registry/admin surfaces according to policy.
- Limit GraphQL depth/complexity/aliases/batches and Protobuf message/recursion sizes; validate uploads, URLs, enums, and custom scalars.
- Avoid sensitive schema descriptions/errors/logs, unsafe dynamic `Any`/custom scalar decoding, resolver injection, SSRF, and over-posting.

## Interoperability

- Verify generated clients/servers in every supported language, protoc/runtime plugin compatibility, gRPC status/deadline/metadata/compression, HTTP transcoding, and unknown-field behavior.
- For GraphQL, validate schema/client nullability, scalar mappings, enum/union exhaustiveness, persisted query IDs, federation ownership/entity keys, and cache normalization.
- Test rolling old/new producer-consumer combinations and preserve package/type/service/field identity.

## Common failure modes

- Protobuf field number/type reused, `optional` presence lost, generator/runtime skew, wrong import root, stale generated source, JSON mapping differs from binary.
- GraphQL nullable/non-null change breaks clients, resolver returns wrong shape, N+1/fan-out, operation not regenerated, federation composition conflict, auth missing on nested field.

## Verification checklist

- [ ] Confirm schema source, compiler/generator/runtime versions, locks, baseline, and consumers.
- [ ] Run lint/build/format, breaking/composition checks, regeneration diff, and generated compiles.
- [ ] Contract-test old/new clients and servers, presence/nullability, errors, deadlines, and streaming.
- [ ] Test auth, size/depth/complexity limits, malformed input, and sensitive errors.
- [ ] Measure wire/query performance and verify every generated language consumer.
