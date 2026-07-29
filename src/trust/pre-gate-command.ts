export const PRE_GATE_DISCOVERY_COMMANDS = [
  "cat",
  "du",
  "file",
  "find",
  "grep",
  "head",
  "ls",
  "pwd",
  "stat",
  "tail",
  "wc",
] as const;

export type PreGateDiscoveryCommand =
  (typeof PRE_GATE_DISCOVERY_COMMANDS)[number];

export type PreGateCommandDecision =
  | {
      effect: "allow";
      code: "read_only_discovery";
      command: PreGateDiscoveryCommand;
      arguments: readonly string[];
      reason: string;
    }
  | {
      effect: "deny";
      code:
        | "empty_command"
        | "shell_syntax"
        | "unsupported_command"
        | "unsafe_arguments";
      reason: string;
    };

const ALLOWED_COMMANDS = new Set<string>(PRE_GATE_DISCOVERY_COMMANDS);
const SHELL_CONTROL_CHARACTERS = new Set([
  ";",
  "&",
  "|",
  "<",
  ">",
  "(",
  ")",
  "{",
  "}",
  "`",
]);
const UNQUOTED_EXPANSION_CHARACTERS = new Set(["*", "?", "["]);
const FIND_MUTATION_ACTIONS = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-fls",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-ok",
  "-okdir",
]);

interface TokenizationResult {
  tokens?: string[];
  reason?: string;
}

/**
 * Parses one deliberately small, shell-like command line into literal argv.
 *
 * The returned argv is never sent back through a shell. Shell composition,
 * expansion, redirection, globbing, comments, and multiline input are rejected
 * so the host can execute a fixed discovery binary with exact arguments.
 */
function tokenizeLiteralCommand(command: string): TokenizationResult {
  const tokens: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: "'" | '"' | undefined;

  const finishToken = () => {
    if (!tokenStarted) return;
    tokens.push(token);
    token = "";
    tokenStarted = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (
      character === "\n" ||
      character === "\r" ||
      character === "\u2028" ||
      character === "\u2029"
    ) {
      return { reason: "Multiline commands are not allowed before the Action Gate." };
    }

    if (quote === "'") {
      if (character === "'") {
        quote = undefined;
      } else {
        token += character;
      }
      tokenStarted = true;
      continue;
    }

    if (quote === '"') {
      if (character === '"') {
        quote = undefined;
        tokenStarted = true;
        continue;
      }
      if (character === "$" || character === "`") {
        return {
          reason:
            "Shell expansion is not allowed before the Action Gate; pass a literal argument instead.",
        };
      }
      if (character === "\\") {
        const next = command[index + 1];
        if (next === undefined) {
          return { reason: "The command ends with an incomplete escape." };
        }
        if (next === "\n" || next === "\r") {
          return { reason: "Multiline commands are not allowed before the Action Gate." };
        }
        token += next;
        tokenStarted = true;
        index += 1;
        continue;
      }
      token += character;
      tokenStarted = true;
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (/\s/u.test(character)) {
      finishToken();
      continue;
    }
    if (
      SHELL_CONTROL_CHARACTERS.has(character) ||
      character === "$" ||
      character === "#"
    ) {
      return {
        reason:
          "Shell control, expansion, comments, and redirection are not allowed before the Action Gate.",
      };
    }
    if (UNQUOTED_EXPANSION_CHARACTERS.has(character)) {
      return {
        reason:
          "Shell glob expansion is not allowed before the Action Gate; use a literal path or a dedicated discovery tool.",
      };
    }
    if (character === "\\") {
      const next = command[index + 1];
      if (next === undefined) {
        return { reason: "The command ends with an incomplete escape." };
      }
      if (next === "\n" || next === "\r") {
        return { reason: "Multiline commands are not allowed before the Action Gate." };
      }
      token += next;
      tokenStarted = true;
      index += 1;
      continue;
    }
    token += character;
    tokenStarted = true;
  }

  if (quote) {
    return { reason: "The command contains an unterminated quoted argument." };
  }
  finishToken();
  return { tokens };
}

function unsafeFindReason(arguments_: readonly string[]): string | undefined {
  for (const argument of arguments_) {
    const normalized = argument.toLowerCase();
    if (FIND_MUTATION_ACTIONS.has(normalized)) {
      return `find action ${JSON.stringify(argument)} can mutate files or execute another program.`;
    }
  }
  return undefined;
}

/**
 * Conservatively recognizes a single bounded discovery command.
 *
 * An allow decision is only a classification. The caller must also execute the
 * exact binary and argv under verified read-only native containment.
 */
export function classifyPreGateCommand(
  command: string,
): PreGateCommandDecision {
  const parsed = tokenizeLiteralCommand(command.normalize("NFC").trim());
  if (!parsed.tokens) {
    return {
      effect: "deny",
      code: "shell_syntax",
      reason: parsed.reason ?? "The command uses unsupported shell syntax.",
    };
  }
  if (parsed.tokens.length === 0) {
    return {
      effect: "deny",
      code: "empty_command",
      reason: "The command is empty.",
    };
  }

  const [requestedCommand, ...arguments_] = parsed.tokens;
  if (!requestedCommand || !ALLOWED_COMMANDS.has(requestedCommand)) {
    return {
      effect: "deny",
      code: "unsupported_command",
      reason:
        `${JSON.stringify(requestedCommand ?? "")} is not in the fixed ` +
        `pre-gate discovery allowlist (${PRE_GATE_DISCOVERY_COMMANDS.join(", ")}).`,
    };
  }

  if (requestedCommand === "find") {
    const reason = unsafeFindReason(arguments_);
    if (reason) {
      return {
        effect: "deny",
        code: "unsafe_arguments",
        reason,
      };
    }
  }

  return {
    effect: "allow",
    code: "read_only_discovery",
    command: requestedCommand as PreGateDiscoveryCommand,
    arguments: arguments_,
    reason:
      "The command is one fixed discovery executable with literal arguments.",
  };
}
