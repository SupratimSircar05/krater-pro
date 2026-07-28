import type { JsonObject, ToolDefinition } from "./types.js";
import type { SkillRegistry } from "./skills.js";
import { Workspace } from "./workspace.js";

export interface ToolExecution {
  output: string;
  ok: boolean;
}

export interface ToolExecutionOptions {
  commandAuthorization?:
    | "host_direct"
    | "approved_attended"
    | "verified_unattended";
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "record_action_gate",
      description:
        "Record the evidence-backed Action/Abstention Gate after bounded discovery and before any publishable file edit or final answer. Evidence references must be successful tool-call IDs from this task. A no-change decision is a valid outcome.",
      parameters: {
        type: "object",
        properties: {
          outcome: {
            type: "string",
            enum: [
              "change_required",
              "partial_fix_requires_change",
              "configuration_documentation_or_user_action",
              "already_satisfied_no_change",
              "cannot_establish_safely",
            ],
          },
          reasons: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 8,
          },
          evidenceRefs: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 16,
            description:
              "Successful discovery/reproduction tool-call IDs that support this classification.",
          },
        },
        required: ["outcome", "reasons", "evidenceRefs"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "workspace_map",
      description:
        "Return a compact, high-signal map of the repository: project manifests, dominant file types, and top-level structure. Prefer this as the first repository inspection.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description:
        "List files and directories in the workspace. Use this before assuming project structure.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative directory (default: .)" },
          maxDepth: {
            type: "integer",
            minimum: 0,
            maximum: 6,
            description: "How many directory levels to include (default: 3)",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_skills",
      description:
        "List available expert skills with descriptions. Metadata only; call load_skill only for a skill relevant to the current task.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "load_skill",
      description:
        'Load skill instructions on demand. Load SKILL.md first; then load only the relevant "references/<name>.md" resource it routes you to.',
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Skill name returned by list_skills" },
          resource: {
            type: "string",
            description: 'Optional SKILL.md or direct "references/<name>.md" path',
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file with line numbers.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          startLine: { type: "integer", minimum: 1 },
          endLine: { type: "integer", minimum: 1 },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Search text files recursively for a literal string.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          path: { type: "string", description: "Workspace-relative starting path" },
          caseSensitive: { type: "boolean" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create or completely overwrite a UTF-8 file. Requires explicit user approval.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "replace_in_file",
      description:
        "Replace exact text in an existing file. Include enough surrounding context for a unique match. Requires approval.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          search: { type: "string" },
          replacement: { type: "string" },
          replaceAll: { type: "boolean", description: "Replace every exact occurrence" },
        },
        required: ["path", "search", "replacement"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a shell command from the workspace. Use for builds, tests, git, and project tooling. Requires explicit user approval unless the host selected fail-closed unattended mode, which runs only with verified native containment.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeoutMs: {
            type: "integer",
            minimum: 1000,
            maximum: 600000,
            description: "Timeout in milliseconds (default: 120000)",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_status",
      description: "Show the current branch and concise working-tree status. Read-only.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "git_diff",
      description: "Show the current unstaged or staged git diff. Read-only.",
      parameters: {
        type: "object",
        properties: { staged: { type: "boolean" } },
        additionalProperties: false,
      },
    },
  },
];

export const MUTATING_TOOLS = new Set(["write_file", "replace_in_file", "run_command"]);
export const PUBLISHABLE_EDIT_TOOLS = new Set(["write_file", "replace_in_file"]);

function stringArg(args: JsonObject, name: string, required = true): string {
  const value = args[name];
  if (typeof value === "string") return value;
  if (!required && value === undefined) return "";
  throw new Error(`"${name}" must be a string.`);
}

function integerArg(
  args: JsonObject,
  name: string,
  fallback: number,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const value = args[name];
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `"${name}" must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return value;
}

function booleanArg(args: JsonObject, name: string, fallback = false): boolean {
  const value = args[name];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`"${name}" must be a boolean.`);
  return value;
}

function assertAllowedArgs(
  args: JsonObject,
  allowed: readonly string[],
  required: readonly string[] = [],
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(args).filter((key) => !allowedSet.has(key));
  if (unknown.length) {
    throw new Error(`Unknown tool argument(s): ${unknown.join(", ")}.`);
  }
  for (const name of required) {
    if (args[name] === undefined) throw new Error(`"${name}" is required.`);
  }
}

export function approvalReason(name: string, args: JsonObject): string {
  if (name === "run_command") return `Run shell command: ${String(args.command ?? "")}`;
  if (name === "write_file") {
    const content = String(args.content ?? "");
    const preview =
      content.length > 2_000
        ? `${content.slice(0, 1_200)}\n… ${content.length - 2_000} characters omitted …\n${content.slice(-800)}`
        : content;
    return (
      `Write file: ${String(args.path ?? "")} (${Buffer.byteLength(content)} bytes)\n` +
      `--- proposed content ---\n${preview || "(empty file)"}`
    );
  }
  if (name === "replace_in_file") {
    const search = String(args.search ?? "");
    const replacement = String(args.replacement ?? "");
    const bound = (value: string) =>
      value.length > 1_000
        ? `${value.slice(0, 700)}\n… ${value.length - 1_000} characters omitted …\n${value.slice(-300)}`
        : value;
    return (
      `Edit file: ${String(args.path ?? "")}\n` +
      `--- find ---\n${bound(search)}\n--- replace with ---\n${bound(replacement)}`
    );
  }
  return `Allow ${name}`;
}

export async function executeTool(
  workspace: Workspace,
  name: string,
  args: JsonObject,
  skills?: SkillRegistry,
  signal?: AbortSignal,
  options: ToolExecutionOptions = {},
): Promise<ToolExecution> {
  try {
    let output: string;
    switch (name) {
      case "workspace_map":
        assertAllowedArgs(args, []);
        output = await workspace.projectMap();
        break;
      case "list_files":
        assertAllowedArgs(args, ["path", "maxDepth"]);
        output = await workspace.listFiles(
          stringArg(args, "path", false) || ".",
          integerArg(args, "maxDepth", 3, 0, 6),
        );
        break;
      case "read_file":
        assertAllowedArgs(args, ["path", "startLine", "endLine"], ["path"]);
        output = await workspace.readFile(
          stringArg(args, "path"),
          integerArg(args, "startLine", 1, 1),
          args.endLine === undefined
            ? undefined
            : integerArg(args, "endLine", 400, 1),
        );
        break;
      case "search_files":
        assertAllowedArgs(
          args,
          ["query", "path", "caseSensitive"],
          ["query"],
        );
        output = await workspace.searchFiles(
          stringArg(args, "query"),
          stringArg(args, "path", false) || ".",
          booleanArg(args, "caseSensitive"),
        );
        break;
      case "write_file":
        assertAllowedArgs(args, ["path", "content"], ["path", "content"]);
        output = await workspace.writeTextFile(
          stringArg(args, "path"),
          stringArg(args, "content"),
        );
        break;
      case "replace_in_file":
        assertAllowedArgs(
          args,
          ["path", "search", "replacement", "replaceAll"],
          ["path", "search", "replacement"],
        );
        output = await workspace.replaceInFile(
          stringArg(args, "path"),
          stringArg(args, "search"),
          stringArg(args, "replacement"),
          booleanArg(args, "replaceAll"),
        );
        break;
      case "run_command": {
        assertAllowedArgs(args, ["command", "timeoutMs"], ["command"]);
        const result = await workspace.runCommand(
          stringArg(args, "command"),
          integerArg(args, "timeoutMs", 120_000, 1_000, 600_000),
          signal,
          {
            authorization:
              options.commandAuthorization ?? "host_direct",
          },
        );
        const pieces = [
          `Execution: ${result.execution.authorization} · ${result.execution.containment}\n${result.execution.summary}`,
          `Exit code: ${result.exitCode ?? "terminated"}${result.timedOut ? " (timed out)" : ""}`,
          result.stdout && `stdout:\n${result.stdout}`,
          result.stderr && `stderr:\n${result.stderr}`,
        ].filter(Boolean);
        output = pieces.join("\n\n");
        if (result.exitCode !== 0) return { output, ok: false };
        break;
      }
      case "git_status":
        assertAllowedArgs(args, []);
        output = await workspace.gitStatus();
        break;
      case "git_diff":
        assertAllowedArgs(args, ["staged"]);
        output = await workspace.gitDiff(booleanArg(args, "staged"));
        break;
      case "list_skills":
        assertAllowedArgs(args, []);
        if (!skills) throw new Error("Skill registry is unavailable.");
        output = await skills.listForModel();
        break;
      case "load_skill":
        assertAllowedArgs(args, ["name", "resource"], ["name"]);
        if (!skills) throw new Error("Skill registry is unavailable.");
        output = await skills.load(
          stringArg(args, "name"),
          stringArg(args, "resource", false) || "SKILL.md",
        );
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
    return { output, ok: true };
  } catch (error) {
    return { output: (error as Error).message, ok: false };
  }
}
