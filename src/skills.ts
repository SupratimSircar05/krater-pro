import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isStableRegularFileIdentity } from "./file-identity.js";

const MAX_SKILL_BYTES = 256_000;
const SKILL_NAME = /^[a-z0-9][a-z0-9_-]*$/;

export interface SkillMetadata {
  name: string;
  description: string;
  source: "workspace" | "built-in";
}

interface SkillLocation extends SkillMetadata {
  directory: string;
}

function within(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function frontmatter(markdown: string): { name?: string; description?: string } {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};
  const result: { name?: string; description?: string } = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = unquote(line.slice(separator + 1));
    if (key === "name") result.name = value;
    if (key === "description") result.description = value;
  }
  return result;
}

export class SkillRegistry {
  private readonly roots: Array<{
    path: string;
    source: SkillMetadata["source"];
  }>;

  constructor(
    workspaceRoot: string,
    builtInRoot = fileURLToPath(new URL("../skills/", import.meta.url)),
  ) {
    this.roots = [
      { path: resolve(workspaceRoot, ".krater/skills"), source: "workspace" },
      { path: resolve(builtInRoot), source: "built-in" },
    ];
  }

  private async locations(): Promise<SkillLocation[]> {
    const found = new Map<string, SkillLocation>();
    for (const root of this.roots) {
      let physicalRoot: string;
      try {
        physicalRoot = await realpath(root.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const entries = await readdir(physicalRoot, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (!entry.isDirectory() || !SKILL_NAME.test(entry.name) || found.has(entry.name)) {
          continue;
        }
        const directory = resolve(physicalRoot, entry.name);
        const skillFile = resolve(directory, "SKILL.md");
        let physicalFile: string;
        try {
          physicalFile = await realpath(skillFile);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        if (!within(directory, physicalFile)) continue;
        let handle: Awaited<ReturnType<typeof open>> | undefined;
        let parsed: ReturnType<typeof frontmatter>;
        try {
          handle = await open(
            physicalFile,
            constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
          );
          const opened = await handle.stat({ bigint: true });
          const current = await lstat(physicalFile, { bigint: true });
          if (
            !isStableRegularFileIdentity(opened, current) ||
            opened.size > BigInt(MAX_SKILL_BYTES)
          ) {
            continue;
          }
          const content = await handle.readFile();
          if (content.byteLength > MAX_SKILL_BYTES) continue;
          parsed = frontmatter(content.toString("utf8"));
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "ELOOP") continue;
          throw error;
        } finally {
          await handle?.close().catch(() => undefined);
        }
        const name = parsed.name && SKILL_NAME.test(parsed.name) ? parsed.name : entry.name;
        if (found.has(name)) continue;
        found.set(name, {
          name,
          description: parsed.description ?? "No description provided.",
          source: root.source,
          directory,
        });
      }
    }
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async list(): Promise<SkillMetadata[]> {
    return (await this.locations()).map(({ directory: _directory, ...metadata }) => metadata);
  }

  async listForModel(): Promise<string> {
    const skills = await this.list();
    if (!skills.length) return "No skills are available.";
    return skills
      .map(
        (skill) =>
          `- ${skill.name} [${skill.source}]: ${skill.description}`,
      )
      .join("\n");
  }

  async load(name: string, resource = "SKILL.md"): Promise<string> {
    if (!SKILL_NAME.test(name)) throw new Error(`Invalid skill name: ${name}`);
    if (
      !resource ||
      isAbsolute(resource) ||
      resource.includes("\\") ||
      resource.split("/").includes("..") ||
      (resource !== "SKILL.md" &&
        !/^references\/[a-z0-9][a-z0-9._-]*\.md$/i.test(resource))
    ) {
      throw new Error(
        'Skill resource must be "SKILL.md" or a Markdown file directly under references/.',
      );
    }
    const location = (await this.locations()).find((skill) => skill.name === name);
    if (!location) throw new Error(`Unknown skill: ${name}`);
    const candidate = resolve(location.directory, resource);
    let physical: string;
    try {
      physical = await realpath(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Skill resource not found: ${name}/${resource}`);
      }
      throw error;
    }
    if (!within(location.directory, physical)) {
      throw new Error(`Skill resource resolves outside its skill directory: ${resource}`);
    }
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        physical,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const opened = await handle.stat({ bigint: true });
      const current = await lstat(physical, { bigint: true });
      if (!isStableRegularFileIdentity(opened, current)) {
        throw new Error(`Skill resource changed while it was opened: ${resource}`);
      }
      if (opened.size > BigInt(MAX_SKILL_BYTES)) {
        throw new Error(`Skill resource exceeds ${MAX_SKILL_BYTES} bytes: ${resource}`);
      }
      const content = await handle.readFile();
      if (content.byteLength > MAX_SKILL_BYTES) {
        throw new Error(`Skill resource exceeds ${MAX_SKILL_BYTES} bytes: ${resource}`);
      }
      if (content.includes(0)) throw new Error(`Skill resource is binary: ${resource}`);
      return content.toString("utf8");
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}
