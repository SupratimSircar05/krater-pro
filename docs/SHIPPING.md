# Structured shipping adapters

Krater Pro's GitHub and Cloudflare adapters turn an already approved
`ExternalEffectPlan` into a narrowly typed provider operation. They do not
grant a model general HTTP, shell, Git, or deployment access.

This is an implementation-status document. It does not claim that every
provider feature or every release gate is complete.

## Explicit host setup

The local server remains fail-closed by default. It does not discover GitHub
or Cloudflare environment variables, browser sessions, CLI logins, or personal
tokens. `createApp` and `startServer` accept a `StructuredShippingService` only
through the explicit `ServerOptions.structuredShipping` embedding seam.

A trusted host can build that service with:

```ts
import {
  createProviderShippingService,
  type HostShippingArtifactResolver,
  type HostShippingCredentialResolver,
} from "krater-pro/dist/shipping/index.js";

const shipping = createProviderShippingService({
  stateRoot: "/protected/project/.krater/shipping",
  github: { credentialResolver },
  cloudflare: { credentialResolver, artifactResolver },
});

await startServer(config, { evidenceMode: true, structuredShipping: shipping });
```

`credentialResolver` receives only a validated handle such as
`credential:github:release-bot`. It resolves the value inside the host for one
provider call. The value is never included in a task plan, URL, request body,
receipt, compensation handle, ProofGraph record, error, or exported evidence.
Krater Pro deliberately provides no static-token resolver.

The persistent factory stores:

- SHA-256 idempotency claims;
- external-effect, confirmation, and receipt digests; and
- bounded opaque compensation handles.

It does not store credential values or artifact bytes.

## GitHub

The adapter uses fixed `https://api.github.com` REST endpoints. Every push
preflight verifies:

- the exact owner, repository, and full branch name;
- the current branch object ID, including the expected absence of a new ref;
- the existence and exact identifier of the source commit; and
- a host-side credential handle for GitHub.

Execution repeats those checks immediately before mutation. Existing refs use
the non-force update endpoint. New refs use the create-ref endpoint. A
compensation can delete only the exact ref Krater created, or restore the
prepared prior commit only while the remote still points at Krater's pushed
commit. Restoring an older commit necessarily uses GitHub's force flag, but
only inside that digest-bound compensation path.

Pull-request preflight verifies the exact head and base object IDs and refuses
to create a duplicate open PR for the same head/base pair. Creation disables
`maintainer_can_modify` so the submitted head is not silently altered through
the PR API. Compensation closes only the exact open PR whose head/base still
match its receipt.

Provider contract references:
[Git references](https://docs.github.com/en/rest/git/refs) and
[pull requests](https://docs.github.com/en/rest/pulls/pulls).

Limitations:

- The REST ref update can only publish a commit already present in the target
  GitHub repository. This adapter does not upload Git objects from a local
  repository.
- `sourceDigest` is the Proof Lease subject supplied by the verified local
  workflow. The adapter verifies the explicit Git object ID but cannot derive
  the caller's whole-workspace digest from GitHub's commit response.
- Cross-repository PRs assume the head repository has the same repository name
  because the current effect schema has no separate `headRepository`.
- GitHub does not document an idempotency header for these endpoints. Krater's
  persistent local ledger prevents ordinary replay. A process loss after the
  provider mutation but before receipt persistence is reported as unknown and
  requires reconciliation; it is never retried blindly.
- Merge, release creation, tag mutation, workflow dispatch, branch deletion
  outside exact compensation, and arbitrary API requests are unsupported.

## Cloudflare Pages

Pages preflight lists deployments through the fixed Cloudflare API account and
project path, filters to the exact environment and branch, and binds the first
matching deployment digest.

Execution accepts only a `cloudflare_pages_manifest` artifact returned by the
host resolver. Krater recomputes its canonical digest, validates every path and
content hash, and submits that exact manifest with the prepared branch.
Production compensation uses Cloudflare's rollback endpoint only when a
successful prior deployment was observed. Preview compensation deletes only
the exact deployment Krater created and reconciles the prior preview.

Provider contract reference:
[Pages deployments](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/).

Limitations:

- The manifest references content hashes already uploaded to Pages. Asset
  upload sessions are not implemented in this adapter. A trusted artifact
  builder/uploader must populate Cloudflare and expose the exact manifest
  through the host resolver.
- `_headers`, `_redirects`, Pages Functions, `_worker.js`, and bundle upload
  fields are not yet supported.
- A successful create response proves that Cloudflare accepted the manifest
  and returned the bound deployment ID. Readiness and reachability remain
  separate production observations.
- A first production deployment has no safe rollback target and therefore
  receives no compensation handle or clean Proof Lease from the current
  shipping service.

## Cloudflare Workers

The initial Workers adapter supports production module Workers only. The host
resolver returns named modules, content types, bytes, optional compatibility
date, and compatibility flags. Krater:

1. recomputes the artifact digest from module hashes and metadata;
2. uploads a new inactive Worker Version;
3. deploys exactly that version at 100 percent traffic without `force`; and
4. records the returned version and deployment identifiers.

Compensation is available only when the prior deployment had one version at
100 percent. It first verifies that Krater's deployment is still active, then
creates a deployment routing 100 percent back to the exact prior version.

Provider contract references:
[upload a Worker Version](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/create/)
and
[create a Worker deployment](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/create/).

Limitations:

- Named/non-production Wrangler environments, service-worker syntax,
  traffic-split deployments, bindings, secrets, migrations, dispatch
  namespaces, static assets, routes, and custom domains are unsupported.
- If version upload succeeds but traffic deployment fails, the inactive
  version can remain in Cloudflare. The receipt is
  `partially_succeeded`, no Proof Lease is issued, and provider-side cleanup is
  a documented gap.
- A first Worker deployment has no safe prior version, so it has no automated
  compensation path.

## Errors and receipts

Provider errors retain only provider, typed operation, HTTP status, and a
retryable flag. Response bodies, request headers, and credentials are
discarded. Mutation failures crossing the shipping-service boundary become a
generic failed receipt so a provider response cannot become exported evidence
by accident.

Provider receipts are host-safe opaque handles. ProofGraph persists their
digests, exact preflight/confirmation records, result evidence IDs, and
reconciliation status. A result is not a production-health assertion; that
requires a later `ProductionObservation`.
