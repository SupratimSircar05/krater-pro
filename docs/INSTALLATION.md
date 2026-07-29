# CLI installation and first run

Krater Pro's CLI is local-first. It needs Node.js `^20.19.0 || >=22.12.0`
and a Krater-issued API key for inference. Interactive setup and the optional
live doctor check validate access with authenticated model discovery. Offline
doctor never makes that request.

## Install from a source checkout

```sh
git clone https://github.com/SupratimSircar05/krater-pro.git
cd krater-pro
npm install
npm run build
npm link
```

This installs equivalent `krater` and `krater-pro` commands. To run without a
global link:

```sh
node dist/cli.js --help
```

## Homebrew installation

The supported 1.0 installation command is prepared but must not be advertised
as live until the `SupratimSircar05/homebrew-tap` repository exists and its
native formula/cask checks pass:

```sh
brew install SupratimSircar05/tap/krater-pro
krater setup
krater doctor
```

The desktop application is a separate cask:

```sh
brew install --cask SupratimSircar05/tap/krater-pro-app
```

The formula downloads the immutable CLI archive from the matching GitHub
Release, verifies its SHA-256, installs dependencies with the release's
`npm-shrinkwrap.json`, and exposes `krater` and `krater-pro`. It also installs
the manual page and Bash, Zsh, and Fish completions. Homebrew supplies the
formula's Node.js 22 dependency; a preinstalled system Node is not required.

Until the public tap and exact release assets exist, the command above will not
work. Use the source-checkout installation instead. Packaging operators should
follow [`packaging/homebrew/README.md`](../packaging/homebrew/README.md).

Common lifecycle commands after the tap is published:

```sh
brew update
brew upgrade krater-pro
brew reinstall krater-pro
brew pin krater-pro
brew unpin krater-pro
brew uninstall krater-pro
brew uninstall --cask krater-pro-app
```

Homebrew verifies the archive checksum before installation. Release operators
also publish a detached signature for `SHA256SUMS.txt` and GitHub artifact
attestations. Verification commands and signer expectations are documented in
[DESKTOP.md](DESKTOP.md). A tap formula is executable Ruby; review the
fully-qualified formula before trusting a third-party tap.

## Configure a workspace

Run setup from the project you want Krater Pro to work on:

```sh
cd /path/to/project
krater setup
```

In an interactive terminal, setup opens Krater's official developer page,
accepts the key without terminal echo, and validates API/model access before
persistence. It then recommends macOS Keychain or Linux Secret Service. The key
travels to the credential backend through standard input, never command
arguments or logs; no credential marker or encrypted blob is written into the
workspace.

If the backend is unavailable or declined, setup explains that `.env` is
plaintext and requires a separate yes/no decision. The explicit equivalent is:

```sh
krater setup --env-fallback
```

That fallback writes an owner-only file:

```dotenv
KRATER_API_KEY=kr_live_your_key_here
KRATER_MODEL=auto
```

Prefer the OS credential store over `.env`. A carefully scoped
`KRATER_API_KEY` is appropriate for ephemeral CI. Avoid `--api-key`, which can
remain in shell history and process listings. Confirm `.env` is ignored in your
own project before choosing the fallback.

For headless validation with no persistence:

```sh
KRATER_API_KEY=... krater setup --non-interactive --no-open
```

To create only an empty owner-private template:

```sh
krater setup --create-env --non-interactive --no-open
```

Rotate a stored key without deleting the working value first:

```sh
krater setup --replace
```

The replacement is validated before the selected backend is updated.

## Validate the installation

Doctor performs offline checks by default:

```sh
krater doctor
krater doctor --json
```

It reports the runtime, selected workspace, configuration state, credential
source, `.env` permissions, Git availability, fail-closed sandbox posture,
whether ProofGraph/ProofPatch storage has been initialized, and completion
generation readiness. It never prints the credential, labels a configured key
as unverified, and does not claim existing evidence artifacts are healthy.
On macOS it executes the native containment probes and reports the adapter,
control matrix, and deny-only/no-fork limitation. Linux currently reports
native containment as unverified; unattended model commands remain fail-closed,
while exact attended approvals remain available.

Live credential verification is deliberately opt-in:

```sh
krater doctor --live
krater doctor --live --json
```

That form calls authenticated model discovery and marks the report scope and
verification result explicitly. A failed live check exits `1`.

Exit codes:

- `0`: locally ready;
- `4`: setup is required, normally because no key is configured; and
- `1`: a runtime, workspace, or configuration issue needs attention.

Use `krater models` or a real task only when live Krater API verification is
needed.

## Manual shell completions

Homebrew installs completions automatically. For another installation method,
generate the script locally:

```sh
# Bash
krater completion bash > ~/.local/share/bash-completion/completions/krater

# Zsh
mkdir -p ~/.zfunc
krater completion zsh > ~/.zfunc/_krater
# Add `fpath=(~/.zfunc $fpath)` before `compinit` in ~/.zshrc.

# Fish
krater completion fish > ~/.config/fish/completions/krater.fish
```

Review a generated script before sourcing it if the executable did not come
from a trusted release.

## Start the products

```sh
# Interactive CLI
krater

# One task
krater "Review the current diff"

# Local web IDE
krater web
```

The web IDE listens on loopback by default. Native desktop downloads and
platform trust guidance are documented in [DESKTOP.md](DESKTOP.md).

## Update or remove

For a source-linked installation:

```sh
cd /path/to/krater-pro
git pull --ff-only
npm install
npm run build
npm link
```

Remove the global link with `npm unlink -g krater-pro`. Removing the executable
does not delete project-local `.krater/` history, `.krater-intent/`, or `.env`;
review and remove those separately if they are no longer needed.

Homebrew uninstall has the same data boundary: it removes the installed
program, not project-local evidence, intent, configuration, or API credentials.
Delete those only after reviewing the exact workspace and credential-store
entry.
