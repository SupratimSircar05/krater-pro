# Upstream reference and clean-room record

Krater Pro was requested as a Krater-powered product in the general category
of terminal coding agents. The public
[`anthropics/claude-code`](https://github.com/anthropics/claude-code)
repository was inspected only as a product-level reference.

## Reference snapshot

- Repository:
  [`anthropics/claude-code`](https://github.com/anthropics/claude-code)
- Commit:
  [`ac062f33ab0ca7c62b9df648d0f2027fa9b969f0`](https://github.com/anthropics/claude-code/tree/ac062f33ab0ca7c62b9df648d0f2027fa9b969f0)
- Inspection date: 2026-07-22

At that snapshot, the public repository did not contain the Claude Code CLI
source. It contained public-facing documentation and supporting materials, so
it was not a source-code base that could be cloned and modified into this
product.

The upstream
[`LICENSE.md`](https://github.com/anthropics/claude-code/blob/ac062f33ab0ca7c62b9df648d0f2027fa9b969f0/LICENSE.md)
states that Anthropic PBC reserves all rights and makes use subject to
Anthropic's Commercial Terms of Service. That license does not grant permission
to copy the product's code or assets.

## Krater Pro implementation

Krater Pro is a clean-room, original TypeScript implementation:

- No Claude Code source code was available from or copied out of the inspected
  repository.
- No Anthropic or Claude Code code, images, icons, animations, or other assets
  were copied into Krater Pro.
- The terminal agent, workspace tools, approval flow, Krater provider, local
  server, and web interface were implemented specifically for this project.
- Krater Pro connects to the official
  [Krater API](https://api.krater.ai/); it does not connect to or bundle
  Claude Code.

Krater Pro is not affiliated with, endorsed by, or sponsored by Anthropic.
“Anthropic,” “Claude,” and “Claude Code” are names or marks of their respective
owner. The upstream repository and its
[license](https://github.com/anthropics/claude-code/blob/ac062f33ab0ca7c62b9df648d0f2027fa9b969f0/LICENSE.md)
remain subject to Anthropic's terms.
