export const SUPPORTED_COMPLETION_SHELLS = [
  "bash",
  "zsh",
  "fish",
] as const;

export type CompletionShell =
  (typeof SUPPORTED_COMPLETION_SHELLS)[number];

const globalOptions = [
  "--api-key",
  "--base-url",
  "--model",
  "--cwd",
  "--yes",
  "--context-chars",
  "--tool-output-chars",
  "--response-style",
  "--max-steps",
  "--max-output-tokens",
  "--session-token-budget",
  "--assurance",
  "--max-cost-usd",
  "--max-time",
  "--assume",
  "--json",
  "--help",
  "--version",
];

const topLevelCommands = [
  "setup",
  "doctor",
  "completion",
  "models",
  "task",
  "proof",
  "policy",
  "debug",
  "lab",
  "cache",
  "intent",
  "auth",
  "web",
];

const nestedCommands: Readonly<Record<string, readonly string[]>> = {
  task: [
    "run",
    "list",
    "show",
    "plan",
    "approve",
    "verify",
    "watch",
    "resume",
    "cancel",
    "publish",
    "rollback",
  ],
  proof: ["show", "verify", "export"],
  policy: ["simulate", "explain"],
  debug: ["causal", "causal-live"],
  lab: ["replay", "calibrate"],
  cache: ["stats", "prune"],
  intent: ["init", "check", "add", "retire"],
  auth: ["login", "status"],
  completion: [...SUPPORTED_COMPLETION_SHELLS],
};

export function isCompletionShell(value: string): value is CompletionShell {
  return (SUPPORTED_COMPLETION_SHELLS as readonly string[]).includes(value);
}

function bashCompletion(): string {
  const commandCases = Object.entries(nestedCommands).map(
    ([command, values]) =>
      `    ${command}) candidates="${values.join(" ")}" ;;`,
  );
  return [
    "# Bash completion for Krater Pro.",
    "_krater_completion() {",
    "  local cur command candidates",
    '  cur="${COMP_WORDS[COMP_CWORD]}"',
    '  command="${COMP_WORDS[1]}"',
    `  candidates="${topLevelCommands.join(" ")}"`,
    '  if [[ "$cur" == -* ]]; then',
    `    candidates="${globalOptions.join(" ")}"`,
    "  else",
    '    case "$command" in',
    ...commandCases,
    "    esac",
    "  fi",
    '  COMPREPLY=( $(compgen -W "$candidates" -- "$cur") )',
    "}",
    "complete -F _krater_completion krater krater-pro",
    "",
  ].join("\n");
}

function zshCompletion(): string {
  const commandDescriptions = [
    "setup:prepare local credential configuration",
    "doctor:check local installation and configuration",
    "completion:print a shell completion script",
    "models:list available Krater model IDs",
    "task:run and inspect evidence-native tasks",
    "proof:inspect and verify evidence artifacts",
    "policy:simulate or explain context policy",
    "debug:run recorded or verified-sandbox causal debugging",
    "lab:replay local reliability evaluations",
    "cache:inspect or prune verified work cache",
    "intent:manage living intent records",
    "auth:open or inspect Krater account setup",
    "web:start the local Krater Pro GUI",
  ];
  const nestedCases = Object.entries(nestedCommands).flatMap(
    ([command, values]) => [
      `      ${command})`,
      `        _values '${command} command' ${values.map((value) => `'${value}'`).join(" ")}`,
      "        ;;",
    ],
  );
  return [
    "#compdef krater krater-pro",
    "# Zsh completion for Krater Pro.",
    "_krater_completion() {",
    "  local -a commands",
    "  commands=(",
    ...commandDescriptions.map((entry) => `    '${entry}'`),
    "  )",
    "",
    "  _arguments -C \\",
    "    '(-k --api-key)'{-k,--api-key}'[one-invocation Krater API key]:key:' \\",
    "    '--base-url[Krater-compatible API base URL]:url:' \\",
    "    '(-m --model)'{-m,--model}'[model ID or auto]:model:' \\",
    "    '(-C --cwd)'{-C,--cwd}'[workspace directory]:directory:_directories' \\",
    "    '(-y --yes)'{-y,--yes}'[approve protected task actions]' \\",
    "    '--assurance[evidence assurance]:level:(fast standard high)' \\",
    "    '--assume[ambiguity behavior]:mode:(ask best)' \\",
    "    '--json[emit machine-readable output]' \\",
    "    '1:command:->command' \\",
    "    '*::argument:->arguments'",
    "",
    "  case $state in",
    "    command)",
    "      _describe 'krater command' commands",
    "      ;;",
    "    arguments)",
    "      case ${words[2]} in",
    ...nestedCases,
    "      esac",
    "      ;;",
    "  esac",
    "}",
    "_krater_completion \"$@\"",
    "",
  ].join("\n");
}

function fishCompletionFor(commandName: string): string[] {
  const descriptions: Readonly<Record<string, string>> = {
    setup: "Prepare local credential configuration",
    doctor: "Check local installation and configuration",
    completion: "Print a shell completion script",
    models: "List available Krater model IDs",
    task: "Run and inspect evidence-native tasks",
    proof: "Inspect and verify evidence artifacts",
    policy: "Simulate or explain context policy",
    debug: "Run recorded causal debugging adapters",
    lab: "Replay local reliability evaluations",
    cache: "Inspect or prune verified work cache",
    intent: "Manage living intent records",
    auth: "Open or inspect Krater account setup",
    web: "Start the local Krater Pro GUI",
  };
  const lines = [
    `complete -c ${commandName} -f`,
    `complete -c ${commandName} -n '__fish_use_subcommand' -l help -s h -d 'Show help'`,
    `complete -c ${commandName} -n '__fish_use_subcommand' -l version -s V -d 'Show version'`,
  ];
  for (const command of topLevelCommands) {
    lines.push(
      `complete -c ${commandName} -n '__fish_use_subcommand' -a '${command}' -d '${descriptions[command]}'`,
    );
  }
  for (const [parent, values] of Object.entries(nestedCommands)) {
    for (const value of values) {
      lines.push(
        `complete -c ${commandName} -n '__fish_seen_subcommand_from ${parent}' -a '${value}'`,
      );
    }
  }
  lines.push(
    `complete -c ${commandName} -l cwd -s C -r -d 'Workspace directory'`,
    `complete -c ${commandName} -l model -s m -r -d 'Model ID or auto'`,
    `complete -c ${commandName} -l assurance -r -a 'fast standard high'`,
    `complete -c ${commandName} -l assume -r -a 'ask best'`,
    `complete -c ${commandName} -l json -d 'Emit machine-readable output'`,
  );
  return lines;
}

function fishCompletion(): string {
  return [
    "# Fish completion for Krater Pro.",
    ...fishCompletionFor("krater"),
    ...fishCompletionFor("krater-pro"),
    "",
  ].join("\n");
}

export function generateCompletion(shell: CompletionShell): string {
  if (shell === "bash") return bashCompletion();
  if (shell === "zsh") return zshCompletion();
  return fishCompletion();
}
