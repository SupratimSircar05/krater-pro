import {
  HttpError,
  fitProviderReply,
  type ChatMessage,
} from "./security";

const KRATER_MODELS_URL = "https://api.krater.ai/v1/models";
const KRATER_CHAT_URL = "https://api.krater.ai/v1/chat/completions";
export const CLOUD_MODEL = "moonshotai/kimi-k3";
const MAX_UPSTREAM_BYTES = 1024 * 1024;
const MAX_KRATER_REDIRECTS = 3;
const decoder = new TextDecoder("utf-8", { fatal: true });

async function readBoundedResponse(response: Response): Promise<unknown> {
  if (!response.body) {
    throw new HttpError(502, "provider_error", "Krater returned an empty response.");
  }
  const declared = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > MAX_UPSTREAM_BYTES) {
    throw new HttpError(502, "provider_error", "Krater returned an invalid response.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_UPSTREAM_BYTES) {
      await reader.cancel();
      throw new HttpError(502, "provider_error", "Krater returned an invalid response.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    throw new HttpError(502, "provider_error", "Krater returned an invalid response.");
  }
}

function isRedirectStatus(status: number): boolean {
  return status === 301
    || status === 302
    || status === 303
    || status === 307
    || status === 308;
}

function isTrustedKraterUrl(url: URL): boolean {
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  return url.protocol === "https:"
    && !url.username
    && !url.password
    && (url.port === "" || url.port === "443")
    && (hostname === "krater.ai" || hostname.endsWith(".krater.ai"));
}

function canFollowRedirect(method: string, status: number): boolean {
  return method === "GET"
    || method === "HEAD"
    || status === 307
    || status === 308;
}

async function discardResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The redirect response body is never exposed to callers.
  }
}

async function kraterFetch(
  url: string,
  key: string,
  init?: Omit<RequestInit, "headers"> & { headers?: HeadersInit },
): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${key}`);
  headers.set("Accept", "application/json");
  const method = init?.method?.toUpperCase() ?? "GET";
  const signal = AbortSignal.timeout(
    url === KRATER_CHAT_URL ? 60_000 : 15_000,
  );
  let currentUrl = new URL(url);

  for (let redirects = 0; redirects <= MAX_KRATER_REDIRECTS; redirects += 1) {
    let response: Response;
    try {
      response = await fetch(currentUrl.toString(), {
        ...init,
        headers,
        redirect: "manual",
        signal,
      });
    } catch {
      throw new HttpError(
        502,
        "provider_unavailable",
        "Krater is temporarily unavailable.",
      );
    }

    if (!isRedirectStatus(response.status)) return response;
    const location = response.headers.get("Location");
    if (!location || redirects === MAX_KRATER_REDIRECTS) {
      await discardResponse(response);
      throw new HttpError(
        502,
        "provider_error",
        "Krater returned an invalid redirect.",
      );
    }

    let nextUrl: URL;
    try {
      nextUrl = new URL(location, currentUrl);
    } catch {
      await discardResponse(response);
      throw new HttpError(
        502,
        "provider_error",
        "Krater returned an invalid redirect.",
      );
    }
    if (
      !isTrustedKraterUrl(nextUrl)
      || !canFollowRedirect(method, response.status)
    ) {
      await discardResponse(response);
      throw new HttpError(
        502,
        "provider_error",
        "Krater returned an unsafe redirect.",
      );
    }
    await discardResponse(response);
    currentUrl = nextUrl;
  }

  throw new HttpError(
    502,
    "provider_error",
    "Krater returned an invalid redirect.",
  );
}

function isAuthFailure(status: number): boolean {
  return status === 401 || status === 403;
}

export async function validateKraterKey(key: string): Promise<boolean> {
  const response = await kraterFetch(KRATER_MODELS_URL, key, { method: "GET" });
  if (isAuthFailure(response.status)) return false;
  if (!response.ok) {
    throw new HttpError(502, "provider_error", "Krater could not validate the API key.");
  }
  const payload = await readBoundedResponse(response);
  if (!payload || typeof payload !== "object") return false;
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return false;
  return data.some(
    (item) => item
      && typeof item === "object"
      && (item as { id?: unknown }).id === CLOUD_MODEL,
  );
}

interface ChatResult {
  reply: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

function safeTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, 10_000_000)
    : 0;
}

export async function chatWithKrater(
  key: string,
  messages: ChatMessage[],
): Promise<ChatResult> {
  const response = await kraterFetch(KRATER_CHAT_URL, key, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: CLOUD_MODEL,
      stream: false,
      max_tokens: 4096,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: "You are Krater Pro, an expert coding assistant. Give accurate, secure, concise help. This cloud demo has no filesystem, shell, or Git access.",
        },
        ...messages,
      ],
    }),
  });
  if (isAuthFailure(response.status)) {
    throw new HttpError(401, "invalid_api_key", "Krater rejected the API key.");
  }
  if (!response.ok) {
    throw new HttpError(502, "provider_error", "Krater could not complete the request.");
  }
  const payload = await readBoundedResponse(response);
  if (!payload || typeof payload !== "object") {
    throw new HttpError(502, "provider_error", "Krater returned an invalid response.");
  }
  const choices = (payload as { choices?: unknown }).choices;
  const first = Array.isArray(choices) ? choices[0] : undefined;
  const message = first && typeof first === "object"
    ? (first as { message?: unknown }).message
    : undefined;
  const reply = message && typeof message === "object"
    ? (message as { content?: unknown }).content
    : undefined;
  if (
    typeof reply !== "string"
    || reply.length < 1
  ) {
    throw new HttpError(502, "provider_error", "Krater returned an invalid response.");
  }
  const usage = (payload as { usage?: unknown }).usage;
  const usageObject = usage && typeof usage === "object"
    ? usage as Record<string, unknown>
    : {};
  const promptTokens = safeTokenCount(usageObject.prompt_tokens);
  const completionTokens = safeTokenCount(usageObject.completion_tokens);
  const reportedTotal = safeTokenCount(usageObject.total_tokens);
  return {
    reply: fitProviderReply(reply),
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: reportedTotal || promptTokens + completionTokens,
    },
  };
}
