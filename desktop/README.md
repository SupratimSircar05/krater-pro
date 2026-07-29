# Krater Pro desktop shell

This directory contains the hardened Electron shell and native packaging for
Krater Pro 0.1.0.

- `main.mjs` owns the Electron and local-server lifecycle.
- `runtime.mjs` parses launch options and selects a loopback port.
- `window-security.mjs` enforces the renderer/navigation boundary.
- `electron-builder.yml` defines macOS and Linux artifacts.
- `scripts/generate-icons.mjs` derives every native icon from the canonical
  Krater Pro SVG.
- `tests/` covers launcher behavior, renderer hardening, and release config.

The desktop shell deliberately has no preload bridge. It does not read or
forward API keys to the renderer. See [the desktop guide](../docs/DESKTOP.md)
for installation, local builds, release automation, and unsigned-build
warnings.

Built by [Supratim](https://www.linkedin.com/in/supratimsircar/) with ❤️.
