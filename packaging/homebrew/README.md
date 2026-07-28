# Homebrew packaging

This directory contains deterministic renderers and a complete local scaffold
for `github.com/SupratimSircar05/homebrew-tap`. Nothing here publishes a tap,
creates a repository, reads a Krater API key, or mutates Homebrew.

## Release inputs

The CLI formula consumes:

```text
https://github.com/SupratimSircar05/krater-pro/releases/download/v<VERSION>/krater-pro-cli-<VERSION>.tgz
```

The release build stages only npm-publishable application files, removes
workspace/development lifecycle hooks, adds `npm-shrinkwrap.json`, validates a
locked production install, generates an SPDX 2.3 dependency SBOM, and packs the
same staged tree twice. A byte mismatch blocks the release.

Build it locally without publishing:

```sh
npm run build
npm run release:cli
```

The formula installs locked production dependencies with `npm ci
--omit=dev --ignore-scripts`, creates Node 22 wrappers for both commands, and
installs completions and `krater(1)`.

## Render one package definition

Render the CLI formula:

```sh
node packaging/homebrew/render-formula.mjs \
  --version 0.2.0 \
  --sha256 <64-lowercase-hex-characters> \
  --output /path/to/homebrew-tap/Formula/krater-pro.rb
```

`--url` may override the versioned GitHub Release URL. Only HTTPS URLs without
credentials, query strings, or fragments are accepted.

Render the desktop cask only after both matching DMGs are Developer-ID signed
and notarized:

```sh
node packaging/homebrew/render-cask.mjs \
  --version 0.2.0 \
  --arm64-sha256 <arm64-dmg-sha256> \
  --x64-sha256 <x64-dmg-sha256> \
  --output /path/to/homebrew-tap/Casks/krater-pro-app.rb
```

## Prepare an exact tap update

The preferred renderer verifies each required file against the signed release
checksum manifest before writing either package definition:

```sh
node packaging/homebrew/prepare-tap.mjs \
  --assets /path/to/downloaded/release-assets \
  --output /path/to/homebrew-tap \
  --version 0.2.0
```

It writes:

- `Formula/krater-pro.rb`;
- `Casks/krater-pro-app.rb`;
- `.krater-pro/release-<VERSION>.json`; and
- `.krater-pro/pr-body.md`.

A checksum mismatch, missing architecture, malformed version, credential-bearing
URL, or unresolved template marker stops generation.

## Scaffold the tap repository

Create a local, non-published tap checkout:

```sh
node packaging/homebrew/scaffold-tap.mjs \
  --output /path/to/homebrew-tap
```

The scaffold includes Homebrew's current `brew test-bot` pattern for macOS
Intel, macOS ARM64, and Linux bottle builds; a separate signed/notarized cask
launch check; and a manual `brew pr-pull` workflow. Bottle publication requires
the exact reviewed pull-request head SHA and approval through the
`bottle-publication` environment.

The Linux BrewTestBot container is pinned by OCI digest. Refresh that digest
only in a reviewed scaffold change after validating the new Homebrew image;
do not silently switch it back to the mutable `main` tag.

The main Krater release workflow opens a dedicated tap PR only after the stable
GitHub Release exists. It never merges the PR. Reviewers should wait for all
native formula, bottle, cask, and launch checks before merge, then manually run
the tap's `brew pr-pull` workflow with the reviewed head SHA.

## Local checks

```sh
ruby -c /path/to/homebrew-tap/Formula/krater-pro.rb
ruby -c /path/to/homebrew-tap/Casks/krater-pro-app.rb
brew audit --strict /path/to/homebrew-tap/Formula/krater-pro.rb
brew install --build-from-source /path/to/homebrew-tap/Formula/krater-pro.rb
brew test krater-pro
brew audit --cask --strict /path/to/homebrew-tap/Casks/krater-pro-app.rb
```

Do not install the cask from an unpublished or ad-hoc-signed candidate. The
template intentionally contains no API key, authorization header, signing
secret, or credential URL. Its formula test removes `KRATER_API_KEY` and
expects offline doctor to return the documented `setup_required` status.

Homebrew tap formulae are executable Ruby. Users should install with the fully
qualified name and review the formula when deciding whether to trust a
third-party tap.
