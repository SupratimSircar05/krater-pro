import type { ModelMessage, Usage } from "./types.js";

export const DEFAULT_CONTEXT_CHAR_BUDGET = 120_000;
export const DEFAULT_TOOL_OUTPUT_CHAR_BUDGET = 18_000;

export interface UsageTotals {
  requestCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
}

export interface PreparedContext {
  messages: ModelMessage[];
  omittedTurns: number;
  estimatedChars: number;
}

function messageCharacters(message: ModelMessage): number {
  let total = message.content?.length ?? 0;
  if (message.role === "assistant") {
    for (const call of message.tool_calls ?? []) {
      total += call.id.length + call.function.name.length + call.function.arguments.length;
    }
  }
  return total;
}

function groupConversationTurns(messages: ModelMessage[]): ModelMessage[][] {
  const groups: ModelMessage[][] = [];
  for (const message of messages) {
    if (message.role === "user" || groups.length === 0) groups.push([]);
    groups.at(-1)!.push(message);
  }
  return groups;
}

function skipControlSequence(value: string, start: number): number {
  let cursor = start;
  while (cursor < value.length) {
    const code = value.charCodeAt(cursor);
    if (code >= 0x40 && code <= 0x7e) return cursor + 1;
    if (code < 0x20 || code > 0x3f) return cursor;
    cursor += 1;
  }
  return cursor;
}

function skipStringControl(value: string, start: number): number {
  let cursor = start;
  while (cursor < value.length) {
    const code = value.charCodeAt(cursor);
    if (code === 0x07) return cursor + 1;
    if (
      code === 0x1b &&
      cursor + 1 < value.length &&
      value.charCodeAt(cursor + 1) === 0x5c
    ) {
      return cursor + 2;
    }
    cursor += 1;
  }
  return cursor;
}

function skipEscapeSequence(value: string, start: number): number {
  let cursor = start;
  while (cursor < value.length) {
    const code = value.charCodeAt(cursor);
    if (code >= 0x20 && code <= 0x2f) {
      cursor += 1;
      continue;
    }
    return code >= 0x30 && code <= 0x7e ? cursor + 1 : cursor;
  }
  return cursor;
}

function stripAnsiEscapes(value: string): string {
  const chunks: string[] = [];
  let chunkStart = 0;
  let cursor = 0;
  while (cursor < value.length) {
    const code = value.charCodeAt(cursor);
    if (code !== 0x1b && code !== 0x9b) {
      cursor += 1;
      continue;
    }

    chunks.push(value.slice(chunkStart, cursor));
    if (code === 0x9b) {
      cursor = skipControlSequence(value, cursor + 1);
    } else if (cursor + 1 >= value.length) {
      cursor += 1;
    } else {
      const introducer = value.charCodeAt(cursor + 1);
      if (introducer === 0x5b) {
        cursor = skipControlSequence(value, cursor + 2);
      } else if (
        introducer === 0x5d ||
        introducer === 0x50 ||
        introducer === 0x58 ||
        introducer === 0x5e ||
        introducer === 0x5f
      ) {
        cursor = skipStringControl(value, cursor + 2);
      } else {
        cursor = skipEscapeSequence(value, cursor + 1);
      }
    }
    chunkStart = cursor;
  }
  chunks.push(value.slice(chunkStart));
  return chunks.join("");
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(",")}}`;
}

export function compactToolOutput(value: string, maxChars: number): string {
  const cleaned = stripAnsiEscapes(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
  if (cleaned.length <= maxChars) return cleaned;

  const minimumBudget = 160;
  const budget = Math.max(minimumBudget, maxChars);
  const initialHead = Math.floor(budget * 0.62);
  const initialTail = Math.floor(budget * 0.28);
  const omitted = Math.max(0, cleaned.length - initialHead - initialTail);
  const marker = `\n\n… ${omitted.toLocaleString("en-US")} characters omitted by Krater Pro …\n\n`;
  const available = Math.max(40, budget - marker.length);
  const head = Math.floor(available * 0.68);
  const tail = available - head;
  return `${cleaned.slice(0, head)}${marker}${cleaned.slice(-tail)}`;
}

export function prepareContext(
  source: readonly ModelMessage[],
  contextCharBudget = DEFAULT_CONTEXT_CHAR_BUDGET,
  toolOutputCharBudget = DEFAULT_TOOL_OUTPUT_CHAR_BUDGET,
): PreparedContext {
  if (!source.length) return { messages: [], omittedTurns: 0, estimatedChars: 0 };
  const [first, ...rest] = source;
  const system =
    first.role === "system"
      ? first
      : ({
          role: "system",
          content: "Continue the current software-engineering task.",
        } as const);
  const body = first.role === "system" ? rest : source;
  const compacted = body.map((message): ModelMessage => {
    if (message.role !== "tool") return message;
    return {
      ...message,
      content: compactToolOutput(message.content, toolOutputCharBudget),
    };
  });
  const groups = groupConversationTurns(compacted);
  const selected: ModelMessage[][] = [];
  let used = messageCharacters(system);
  if (used > contextCharBudget) {
    throw new Error(
      `The system context (${used} estimated characters) exceeds the configured ` +
        `context budget (${contextCharBudget}). Increase KRATER_CONTEXT_CHARS.`,
    );
  }

  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    const size = group.reduce((sum, message) => sum + messageCharacters(message), 0);
    const omittedIfSelected = index;
    const omissionNoteSize =
      omittedIfSelected > 0
        ? messageCharacters({
            role: "system",
            content:
              `Context optimization omitted ${omittedIfSelected} older user turn(s). ` +
              "Do not claim to remember omitted details; re-inspect the workspace when needed.",
          })
        : 0;
    if (used + size + omissionNoteSize > contextCharBudget) {
      if (selected.length === 0) {
        throw new Error(
          `The newest conversation turn exceeds the configured context budget ` +
            `(${contextCharBudget} estimated characters). Shorten the request, reduce ` +
            `tool output, or increase KRATER_CONTEXT_CHARS.`,
        );
      }
      break;
    }
    selected.unshift(group);
    used += size;
  }

  const omittedTurns = groups.length - selected.length;
  const note: ModelMessage[] =
    omittedTurns > 0
      ? [
          {
            role: "system",
            content:
              `Context optimization omitted ${omittedTurns} older user turn(s). ` +
              "Do not claim to remember omitted details; re-inspect the workspace when needed.",
          },
        ]
      : [];
  const messages = [system, ...note, ...selected.flat()];
  const estimatedChars = messages.reduce(
    (sum, message) => sum + messageCharacters(message),
    0,
  );
  return {
    messages,
    omittedTurns,
    estimatedChars,
  };
}

export function emptyUsageTotals(): UsageTotals {
  return {
    requestCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
  };
}

export function addUsage(totals: UsageTotals, usage: Usage): UsageTotals {
  return {
    requestCount: totals.requestCount + (usage.providerRequests ?? 1),
    promptTokens: totals.promptTokens + (usage.promptTokens ?? 0),
    completionTokens: totals.completionTokens + (usage.completionTokens ?? 0),
    totalTokens: totals.totalTokens + (usage.totalTokens ?? 0),
    cachedTokens: totals.cachedTokens + (usage.cachedTokens ?? 0),
  };
}
