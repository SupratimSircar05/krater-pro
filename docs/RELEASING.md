# Verified release operations

This runbook prepares Krater Pro releases. It does not declare the current
`0.1.0` build to be 1.0, and none of these commands should be run until the
product acceptance gates have independent evidence.

The workflow pins Node.js `22.23.1`, npm `11.16.0`, every GitHub Action by full
commit, and the Linux Homebrew image by OCI digest. Updating any release tool
is a reviewed supply-chain change, not an automatic floating upgrade.

## Safety boundary

- Manual workflow dispatch builds a non-publishing release candidate.
- Only an exact `v<package.json version>` tag can enter stable publication.
- Stable publication is protected by the `production-release` environment.
- Missing signing, notarization, detached-signing, or tap-maintenance
  configuration blocks the stable build. It never falls back to unsigned
  publication.
- Release jobs have no Krater API key and must not perform model inference.
- Private keys are runner-only inputs. Public artifacts contain signatures,
  checksums, SBOMs, and public certificates/identities, never private material.

## One-time GitHub configuration

Create a `production-release` environment with required reviewers. Store:

| Name | Purpose |
| --- | --- |
| `MAC_CSC_LINK` | Base64 Developer ID Application certificate archive |
| `MAC_CSC_KEY_PASSWORD` | Certificate archive password |
| `APPLE_API_KEY_P8_BASE64` | Base64 App Store Connect API private key |
| `APPLE_API_KEY_ID` | App Store Connect key ID |
| `APPLE_API_ISSUER` | App Store Connect issuer ID |
| `WIN_CSC_LINK` | Base64 Windows Authenticode certificate archive |
| `WIN_CSC_KEY_PASSWORD` | Windows certificate password |
| `RELEASE_GPG_PRIVATE_KEY_BASE64` | Base64 detached-signing private key |
| `RELEASE_GPG_KEY_ID` | Exact signing-key fingerprint or long key ID |
| `RELEASE_GPG_PASSPHRASE` | Detached-signing key passphrase |
| `HOMEBREW_TAP_TOKEN` | Repository-scoped tap-maintenance token |

The Homebrew token should be restricted to
`SupratimSircar05/homebrew-tap` contents and pull requests. Do not reuse a
personal broad-scope token. Protect the tap's `bottle-publication` environment
with required review as well.

Publish the detached-signing public key and fingerprint through a reviewed,
stable channel before asking users to rely on it.

## Candidate

Run **Verified native release** with `workflow_dispatch`. This path:

1. runs source, test, benchmark-fixture, type, build, desktop, and cloud gates;
2. creates the CLI archive twice and requires byte equality;
3. builds on macOS ARM64, macOS Intel, Windows x64, and Linux x64;
4. launches each unpacked packaged application and waits for a mounted renderer;
5. emits normalized SPDX dependency SBOMs;
6. creates checksums and a source-bound release manifest; and
7. uploads Actions artifacts without a GitHub Release or tap mutation.

Candidate macOS apps are ad-hoc signed for bundle integrity. Candidate Windows
and Linux packages are unsigned. They are test artifacts, not public releases.

## Stable tag

Before tagging:

```sh
npm ci
npm run guard:secrets
npm test
npm run typecheck
npm run build
npm run desktop:test
npm run cloud:test
npm run benchmark:evidence:validate
npm run benchmark:evidence:smoke
git diff --check
```

Review the authoritative external benchmark output, accessibility acceptance,
platform hardware evidence, recovery drills, release notes, and current
version. Passing fixture smoke tests is not equivalent to passing external
benchmarks.

After the reviewed version exists in `package.json`, create a signed tag only
from the reviewed commit:

```sh
git tag -s v<VERSION> <FULL_REVIEWED_COMMIT>
git push origin v<VERSION>
```

The workflow then:

1. confirms tag/version equality;
2. waits for production-release approval and required capabilities;
3. signs and notarizes native packages on native runners;
4. verifies packaged launch and platform signatures;
5. creates GitHub artifact attestations;
6. creates and GPG-signs the checksum and release manifests;
7. publishes one immutable GitHub Release; and
8. opens, but does not merge, the checksum-derived Homebrew tap PR.

Do not replace an asset under an existing tag. Correct a defective release with
a new version and document the invalidated artifact.

## Verify the release

For every asset:

```sh
shasum -a 256 -c SHA256SUMS.txt
gpg --verify SHA256SUMS.txt.asc SHA256SUMS.txt
gh attestation verify <ASSET> --repo SupratimSircar05/krater-pro
```

Then review `krater-pro-<VERSION>.release-manifest.json` and verify its detached
signature. Confirm the recorded source commit, workflow path, tag, checksums,
and expected repository.

Platform checks:

- macOS ARM64 and Intel: `codesign --verify --deep --strict`, Gatekeeper
  assessment, notarization staple, application launch, renderer mount.
- Windows x64: Authenticode `Valid`, installer and portable launch smoke.
- Linux x64: checksum/attestation/signature verification, AppImage and DEB
  metadata, unpacked launch under the supported Chromium sandbox.

## Homebrew tap

The release workflow opens a PR containing exact formula/cask digests. The tap
CI uses `brew test-bot` to build bottles on macOS Intel, macOS ARM64, and Linux,
uploads bottle artifacts, and independently audits and launches both cask
architectures.

After reviewing the PR and exact head commit, manually run **brew pr-pull** in
the tap with:

- the PR number; and
- the full reviewed head SHA.

The workflow fails if the head changed. It publishes bottles to GitHub Packages
and updates the formula bottle block only after `bottle-publication` approval.

## Recovery

- A failed candidate has no public side effects; delete only its Actions
  artifacts if retention policy requires it.
- A stable job that fails before `publish` creates no GitHub Release or tap PR.
- If GitHub Release publication succeeds but tap PR creation fails, leave the
  signed release intact, fix only tap credentials/automation, and rerun the
  dedicated tap preparation against the same verified assets.
- If an uploaded artifact itself is wrong, do not overwrite it. Mark the
  release as affected, create a corrected version, and revoke or document the
  affected signing identity if compromise is suspected.
- Never delete or rewrite a public tag to conceal a failed release.

## Current external gates

Automation cannot supply:

- Apple and Windows publisher identities or notarization authority;
- the detached-signing identity and its independently published public key;
- Windows and Linux hardware/user acceptance beyond hosted-runner smoke;
- Homebrew tap repository/environment/token setup;
- accessibility review with VoiceOver, NVDA, and Orca users;
- official external benchmark scores and required large Docker capacity; or
- final human review of release notes, legal claims, and launch readiness.

Until those gates have evidence, the pipeline is release-ready automation, not
proof that Krater Pro 1.0 has launched.
