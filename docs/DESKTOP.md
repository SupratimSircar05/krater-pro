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

Every release also includes `SHA256SUMS.txt`. Verify the download before
opening it:

```sh
# macOS or Linux, from the download directory
shasum -a 256 -c SHA256SUMS.txt
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

## GitHub Release automation

[`.github/workflows/desktop-release.yml`](../.github/workflows/desktop-release.yml)
runs the complete test/typecheck/build gate, builds on each native operating
system, generates a combined SHA-256 manifest, and creates a GitHub Release when
a `v*` tag is pushed. The tag must exactly match `package.json`; for 0.1.0:

```sh
git tag v0.1.0
git push origin v0.1.0
```

A manual workflow dispatch builds downloadable CI artifacts but deliberately
does not create a public Release.

## Signing and notarization

The current pipeline assumes no private signing material and produces unsigned
artifacts. On macOS, the unsigned community build is still ad-hoc signed after
Electron fuses are applied so Apple silicon can validate every executable page.
Its explicit hardened-runtime entitlements allow Electron's V8 JIT and disable
library validation because ad-hoc nested frameworks have no common Developer
ID team identifier. This establishes bundle integrity, not publisher identity.
Never commit certificates, passwords, API keys, or notarization credentials.

Future maintainers can enable signing through protected GitHub Actions
environments and repository secrets:

- macOS signing: `CSC_LINK`, `CSC_KEY_PASSWORD`
- Apple notarization: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
  `APPLE_TEAM_ID`
- Windows code signing: `CSC_LINK`, `CSC_KEY_PASSWORD`
- optional Linux detached signatures: `GPG_PRIVATE_KEY`, `GPG_PASSPHRASE`

Apple notarization still requires an explicit reviewed `mac.notarize`
configuration. Before a Developer ID release, review whether all dependencies
can run without `disable-library-validation`; the V8 JIT entitlements remain
required by Electron. Linux GPG signing requires an explicit release step.
Rotate any credential that is ever printed in CI and keep pull-request
workflows unable to read release secrets.
