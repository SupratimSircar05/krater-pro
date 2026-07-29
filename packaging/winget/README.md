# WinGet packaging

Krater Pro's native Windows package is distributed through WinGet. Homebrew is
the supported package manager for macOS, Linux, and the CLI inside WSL 2; it
does not install the native Windows desktop application.

The generator deliberately accepts no caller-supplied download URL or digest.
It derives the only accepted installer name and GitHub Release URL from the
reviewed version:

```text
Krater-Pro-Setup-<version>-x64.exe
https://github.com/SupratimSircar05/krater-pro/releases/download/v<version>/Krater-Pro-Setup-<version>-x64.exe
```

Before rendering, it requires the protected Windows release job's
version-specific Authenticode receipt and verifies that the receipt, release
tag, actual installer bytes, and SHA-256 all agree. The receipt is useful
pipeline evidence, not a replacement for checking the executable's
Authenticode signature or GitHub artifact attestation.

Stable release automation runs:

```sh
node packaging/winget/prepare-winget.mjs \
  --assets release-assets \
  --output release-assets \
  --version <version>
```

The command writes the three WinGet 1.12 multi-file manifests without
overwriting existing files. Before any community-repository submission, copy
the three files into one empty directory on Windows and run:

```powershell
winget validate .\manifest-directory
winget install --manifest .\manifest-directory
```

Review the installed publisher, version, uninstall entry, silent install, and
upgrade behavior. Submission to `microsoft/winget-pkgs` is a separate,
human-reviewed action. This repository never submits or publishes a WinGet
manifest merely because a release build ran.
