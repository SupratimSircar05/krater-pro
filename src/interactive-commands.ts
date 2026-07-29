export type InteractiveCommand =
  | "assumptions"
  | "clear"
  | "contract"
  | "evidence"
  | "exit"
  | "help"
  | "plan"
  | "publish"
  | "rollback"
  | "ship"
  | "watch"
  | "why";

const INTERACTIVE_COMMAND_ALIASES = new Map<string, InteractiveCommand>([
  ["/assumptions", "assumptions"],
  ["/clear", "clear"],
  ["/contract", "contract"],
  ["/understood", "contract"],
  ["/evidence", "evidence"],
  ["/proof", "evidence"],
  ["/exit", "exit"],
  ["/quit", "exit"],
  ["/help", "help"],
  ["/plan", "plan"],
  ["/publish", "publish"],
  ["/rollback", "rollback"],
  ["/undo", "rollback"],
  ["/ship", "ship"],
  ["/watch", "watch"],
  ["/why", "why"],
]);

export function resolveInteractiveCommand(
  input: string,
): InteractiveCommand | undefined {
  return INTERACTIVE_COMMAND_ALIASES.get(input.trim().toLowerCase());
}
