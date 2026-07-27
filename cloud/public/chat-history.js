const encoder = new TextEncoder();

export const MAX_SAVED_MESSAGES = 24;
export const MAX_SAVED_MESSAGE_BYTES = 20 * 1024;
export const MAX_SAVED_MESSAGES_BYTES = 64 * 1024;
export const MAX_CHAT_PROMPT_BYTES = 20 * 1024;

export function utf8ByteLength(value) {
  return encoder.encode(String(value)).byteLength;
}

function validMessage(value, role) {
  if (
    !value ||
    typeof value !== "object" ||
    value.role !== role ||
    typeof value.content !== "string" ||
    value.content.length < 1 ||
    utf8ByteLength(value.content) > MAX_SAVED_MESSAGE_BYTES
  ) {
    return null;
  }
  return { role, content: value.content };
}

export function pruneChatHistory(value) {
  const source = Array.isArray(value) ? value : [];
  const turns = [];
  let pendingUser = null;
  let discarded = !Array.isArray(value);

  for (const message of source) {
    if (message?.role === "user") {
      if (pendingUser) discarded = true;
      pendingUser = validMessage(message, "user");
      if (!pendingUser) discarded = true;
      continue;
    }
    if (message?.role === "assistant") {
      const assistant = validMessage(message, "assistant");
      if (pendingUser && assistant) {
        turns.push([pendingUser, assistant]);
      } else {
        discarded = true;
      }
      pendingUser = null;
      continue;
    }
    discarded = true;
  }
  if (pendingUser) discarded = true;

  const keptNewestFirst = [];
  let count = 0;
  let bytes = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const turnBytes = utf8ByteLength(turn[0].content) + utf8ByteLength(turn[1].content);
    if (count + 2 > MAX_SAVED_MESSAGES || bytes + turnBytes > MAX_SAVED_MESSAGES_BYTES) {
      discarded = true;
      break;
    }
    keptNewestFirst.push(turn);
    count += 2;
    bytes += turnBytes;
  }

  const messages = keptNewestFirst.reverse().flat();
  return {
    messages,
    trimmed: discarded || messages.length !== source.length,
    bytes,
  };
}

export function isChatPromptWithinLimit(value) {
  return typeof value === "string" && value.length > 0 && utf8ByteLength(value) <= MAX_CHAT_PROMPT_BYTES;
}
