# Programming-language skills

The built-in `programming-languages` skill is a structured router for
implementation, debugging, review, migration, performance, security,
interoperability, and native verification.

## Progressive loading protocol

The model follows three steps:

1. `list_skills` returns names and descriptions only.
2. `load_skill` loads `programming-languages/SKILL.md`.
3. The router selects only the relevant direct reference, for example
   `references/rust.md`.

Polyglot work can load multiple directly relevant references, such as TypeScript
plus SQL or Python plus C. Unrelated references should not be loaded.

## Reference contents

Each ecosystem reference is organized around:

- detection and source-of-truth files;
- pinned toolchain and package manager selection;
- canonical build, format, lint, typecheck, and test commands;
- debugging and smallest-reproduction workflow;
- language idioms and correctness traps;
- performance measurement and profiling;
- dependency, input, serialization, and secret security;
- interoperability and generated-code boundaries;
- common failure modes; and
- layered verification.

The router covers application, systems, scripting, data, functional, VM,
contract, legacy, hardware, infrastructure, and interface-definition
ecosystems. See [the reference directory](../skills/programming-languages/references/).

## Workspace skills

Add a project-specific skill at:

```text
.krater/skills/my-skill/SKILL.md
```

Required frontmatter:

```yaml
---
name: my-skill
description: State what it handles and when the agent should use it.
---
```

A workspace skill overrides a built-in skill with the same name. Skill names are
restricted to lowercase letters, digits, hyphens, and underscores. The loader
accepts only `SKILL.md` and direct Markdown files under `references/`, follows
real paths, blocks traversal/symlink escapes, rejects binaries, and enforces a
size limit.

`.krater/` is ignored by normal repository exploration and should not contain
credentials.
