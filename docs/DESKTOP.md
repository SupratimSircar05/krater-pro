# Desktop applications

Krater Pro 0.1.0 ships the same local agentic IDE as native, self-contained
applications for macOS, Windows, and Linux. The desktop shell starts the
production Krater Pro server on `127.0.0.1`, chooses an available port, and
closes that server when the app exits.

Built by [Supratim](https://www.linkedin.com/in/supratimsircar/) with ❤️.

## Download and verify

GitHub Release assets are built natively on GitHub-hosted runners:

| Platform | Assets |
| --- | --- |
| macOS Apple silicon | `Krater-Pro-0.1.0-arm64.dmg` and `.zip` |
| macOS Intel | `Krater-Pro-0.1.0-x64.dmg` and `.zip` |
| Windows x64 | NSIS setup and portable `.exe` |
| Linux x64 | `.AppImage` and Debian `.deb` |

Every stable release also includes SPDX dependency SBOMs, a source-bound release
manifest, `SHA256SUMS.txt`, detached signatures for the integrity files, and
GitHub artifact attestations. Verify the download before opening it:

```sh
# macOS or Linux, from the download directory
shasum -a 256 -c SHA256SUMS.txt

# With the documented public release-signing key imported:
gpg --verify SHA256SUMS.txt.asc SHA256SUMS.txt

# Online GitHub provenance check:
gh attestation verify Krater-Pro-0.1.0-arm64.dmg \
  --repo SupratimSircar05/krater-pro
```

On Windows PowerShell, compare the value for the downloaded file:

```powershell
Get-FileHash .\Krater-Pro-Setup-0.1.0-x64.exe -Algorithm SHA256
```

## Install

### macOS

Choose `arm64` for Apple silicon or `x64` for Intel. Open the DMG and drag
Krater Pro to Applications, or extract the ZIP.

The 0.1.0 community build is unsigned and not notarized. macOS may block the
first launch. If the checksum matches this repository's GitHub Release, use
Finder's **Open** action or the app entry under **System Settings → Privacy &
Security** to approve it. Do not disable Gatekeeper globally.

### Windows

Use the NSIS setup for a normal per-user installation, or the portable
executable without installing. The 0.1.0 community build is unsigned, so
Microsoft Defender SmartScreen may show an unknown-publisher warning. Proceed
only after verifying the release checksum and repository source.

### Linux

Install the Debian package:

```sh
sudo apt install ./Krater-Pro-0.1.0-x64.deb
```

Or run the AppImage:

```sh
chmod +x Krater-Pro-0.1.0-x64.AppImage
./Krater-Pro-0.1.0-x64.AppImage
```

Electron's renderer sandbox remains enabled. Linux distributions that disable
unprivileged user namespaces must enable a supported Chromium sandbox instead
of launching Krater Pro with `--no-sandbox`.

## Workspace and API key

On the first app launch, Krater Pro creates `Krater Pro Workspace` in the
user's Documents folder. Use the project selector to register another absolute
local folder, clone a public GitHub repository, or create an isolated scratch
workspace.

Krater Pro resolves the API key on the desktop host, in the same order described
in [AUTHENTICATION.md](AUTHENTICATION.md). The safest desktop options are:

- add `KRATER_API_KEY=...` to the launch workspace's ignored `.env`; or
- paste a key into Settings for the current app session only.

The Electron renderer cannot read process environment variables or Node APIs.
The browser partition is memory-only, and a pasted key is not stored in
localStorage, cookies, an Electron credential store, logs, crash metadata, or
release artifacts. The server-side key is never returned by the status API.

For controlled launches, the desktop shell also accepts:

```sh
# macOS
open -a "Krater Pro" --args \
  --krater-workspace /absolute/path/to/project \
  --krater-port 4317

# Linux
krater-pro --krater-workspace /absolute/path/to/project --krater-port 4317
```

Windows accepts the same two options on `KraterPro.exe`. The corresponding
environment variables are `KRATER_DESKTOP_WORKSPACE` and
`KRATER_DESKTOP_PORT`. The host is always fixed to `127.0.0.1`; a desktop
option cannot expose it to the network. Without a selected port, the launcher
chooses an available ephemeral port and retries a bind race safely.

## Build locally

Requirements are Node.js 22, npm, and the platform's normal native packaging
tools:

```sh
npm ci
npm run desktop:test
npm run desktop:dev
```

Build installers for the current platform:

```sh
npm run desktop:dist:mac -- --arm64
npm run desktop:dist:win -- --x64
npm run desktop:dist:linux -- --x64
```

`npm run desktop:prepare` rebuilds the web/server application, regenerates
icons from the canonical Krater Pro SVG, and runs the desktop security tests.
Outputs go to `release/`.

## GitHub release automation

[`.github/workflows/desktop-release.yml`](../.github/workflows/desktop-release.yml)
runs the full source gate, creates the CLI archive twice and compares its bytes,
builds on native macOS ARM64, macOS Intel, Windows x64, and Linux x64 runners,
launches the packaged renderer, produces normalized SPDX dependency SBOMs,
attests artifacts, signs the release receipt, publishes a matching GitHub
Release, and opens a Homebrew tap update PR.

Manual workflow dispatch is a non-publishing release-candidate path. It permits
ad-hoc/unsigned candidates, labels them as candidates, and uploads CI artifacts
only. A tag is the stable path and fails closed when any required protected
capability is missing. The tag must exactly match `package.json`; for 0.1.0:

```sh
git tag v0.1.0
git push origin v0.1.0
```

## Signing and notarization

Configure the `production-release` GitHub environment with required reviewers
and these secrets:

| Capability | Secret |
| --- | --- |
| macOS Developer ID | `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` |
| Apple notarization | `APPLE_API_KEY_P8_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` |
| Windows Authenticode | `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` |
| Detached receipt signature | `RELEASE_GPG_PRIVATE_KEY_BASE64`, `RELEASE_GPG_KEY_ID`, `RELEASE_GPG_PASSPHRASE` |
| Homebrew tap PR | `HOMEBREW_TAP_TOKEN` |

Stable packaging refuses to fall back to ad-hoc signing. It verifies macOS
codesign, Gatekeeper assessment, and notarization staples; verifies every
Windows executable's Authenticode status; and verifies detached signatures
immediately after creating them. The Apple key and imported signing material
exist only on the protected runner and are removed after use. Krater API keys
are neither required nor available in release jobs.

An unsigned local or manually dispatched macOS candidate remains ad-hoc signed
after Electron fuses are applied so Apple silicon validates executable pages.
That establishes bundle integrity, not publisher identity, and is never
eligible for stable publication or the Homebrew cask.

Before a Developer ID release, review whether every dependency can run without
`disable-library-validation`; the V8 JIT entitlements remain required by
Electron. Never commit certificates, private keys, passwords, notarization
credentials, or API keys.

GitHub attestations bind subjects to the workflow, repository, ref, and commit;
they are not a guarantee that an artifact is safe. Consumers must verify them
against the expected repository and release policy.
