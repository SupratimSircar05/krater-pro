#!/usr/bin/env node

import { randomBytes } from "node:crypto";

const DEFAULT_BASE_URL = "http://127.0.0.1:8788";
const SESSION_COOKIE = "__Host-krater_session";
const EXPECTED_CHECKS = 25;
const REQUEST_TIMEOUT_MS = 30_000;

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("BASE_URL must be an absolute HTTP(S) URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error("BASE_URL must be a credential-free HTTP(S) URL.");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url;
}

const baseUrl = normalizeBaseUrl(process.env.BASE_URL ?? DEFAULT_BASE_URL);
const sameOrigin = baseUrl.origin;

class CookieJar {
  #cookies = new Map();

  absorb(headers) {
    const values = typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : [headers.get("set-cookie")].filter(Boolean);
    for (const value of values) {
      const sections = value.split(";").map((part) => part.trim());
      const separator = sections[0]?.indexOf("=") ?? -1;
      if (separator <= 0) continue;
      const name = sections[0].slice(0, separator);
      const cookieValue = sections[0].slice(separator + 1);
      const maxAge = sections
        .slice(1)
        .find((part) => part.toLowerCase().startsWith("max-age="))
        ?.slice("max-age=".length);
      if (cookieValue === "" || maxAge === "0") {
        this.#cookies.delete(name);
      } else {
        this.#cookies.set(name, cookieValue);
      }
    }
    return values;
  }

  header() {
    return [...this.#cookies.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  seed(cookieHeader) {
    this.#cookies.clear();
    for (const section of cookieHeader.split(";")) {
      const separator = section.indexOf("=");
      if (separator <= 0) continue;
      const name = section.slice(0, separator).trim();
      const value = section.slice(separator + 1).trim();
      if (name && value) this.#cookies.set(name, value);
    }
  }
}

class ApiClient {
  constructor() {
    this.cookies = new CookieJar();
  }

  async request(
    path,
    {
      method = "GET",
      body,
      origin = sameOrigin,
      cookieHeader,
      headers: extraHeaders,
    } = {},
  ) {
    const headers = new Headers(extraHeaders);
    headers.set("Accept", "application/json");
    headers.set("Cache-Control", "no-cache");
    if (origin !== null) headers.set("Origin", origin);
    if (body !== undefined) headers.set("Content-Type", "application/json");
    const cookies = cookieHeader ?? this.cookies.header();
    if (cookies) headers.set("Cookie", cookies);

    const endpoint = new URL(path, `${baseUrl.href}/`);
    const response = await fetch(endpoint, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const setCookies = this.cookies.absorb(response.headers);
    return { response, setCookies };
  }
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function expectStatus(response, expected) {
  ensure(
    response.status === expected,
    `expected HTTP ${expected}, received HTTP ${response.status}`,
  );
}

async function readJson(response) {
  ensure(
    response.headers.get("content-type")?.toLowerCase().includes("application/json"),
    "response was not JSON",
  );
  try {
    return await response.json();
  } catch {
    throw new Error("response body was not valid JSON");
  }
}

function expectError(body, code) {
  ensure(
    body?.error?.code === code,
    `expected the ${code} error contract`,
  );
}

function expectSessionCookie(setCookies, { cleared = false } = {}) {
  ensure(setCookies.length === 1, "expected one session cookie");
  const sections = setCookies[0].split(";").map((part) => part.trim());
  const [pair = "", ...attributes] = sections;
  const separator = pair.indexOf("=");
  ensure(separator > 0, "session cookie was malformed");
  const name = pair.slice(0, separator);
  const value = pair.slice(separator + 1);
  const normalized = new Set(attributes.map((attribute) => attribute.toLowerCase()));
  ensure(name === SESSION_COOKIE, "session cookie name was incorrect");
  ensure(cleared ? value === "" : value.length >= 40, "session cookie value was invalid");
  ensure(normalized.has("secure"), "session cookie was missing Secure");
  ensure(normalized.has("httponly"), "session cookie was missing HttpOnly");
  ensure(normalized.has("samesite=strict"), "session cookie was missing SameSite=Strict");
  ensure(normalized.has("path=/"), "session cookie was missing Path=/");
  ensure(
    !attributes.some((attribute) => attribute.toLowerCase().startsWith("domain=")),
    "session cookie must not set Domain",
  );
  const maxAge = attributes.find((attribute) =>
    attribute.toLowerCase().startsWith("max-age=")
  );
  ensure(Boolean(maxAge), "session cookie was missing Max-Age");
  const seconds = Number(maxAge.slice("max-age=".length));
  ensure(
    cleared ? seconds === 0 : Number.isInteger(seconds) && seconds > 0,
    "session cookie Max-Age was invalid",
  );
}

function randomAccount(label) {
  const nonce = `${Date.now().toString(36)}-${randomBytes(9).toString("hex")}`;
  return {
    label,
    email: `krater-e2e-${label}-${nonce}@example.invalid`,
    password: randomBytes(24).toString("base64url"),
    client: new ApiClient(),
    maybeExists: false,
    deleted: false,
    userId: undefined,
  };
}

async function cleanupAccount(account) {
  if (!account.maybeExists || account.deleted) return;

  let response = await account.client.request("/api/account", {
    method: "DELETE",
  });
  if (response.response.status === 200) {
    await response.response.arrayBuffer();
    account.deleted = true;
    return;
  }
  await response.response.arrayBuffer();

  response = await account.client.request("/api/auth/login", {
    method: "POST",
    body: { email: account.email, password: account.password },
  });
  if (response.response.status === 401) {
    await response.response.arrayBuffer();
    account.deleted = true;
    return;
  }
  if (response.response.status !== 200) {
    await response.response.arrayBuffer();
    throw new Error("unable to restore a cleanup session");
  }
  await response.response.arrayBuffer();

  response = await account.client.request("/api/account", {
    method: "DELETE",
  });
  if (response.response.status !== 200) {
    await response.response.arrayBuffer();
    throw new Error("account cleanup was rejected");
  }
  await response.response.arrayBuffer();
  account.deleted = true;
}

let passed = 0;
let currentCheck = "startup";

async function verify(label, action) {
  currentCheck = label;
  await action();
  passed += 1;
}

const first = randomAccount("a");
const second = randomAccount("b");
let failure;

try {
  await verify("health", async () => {
    const { response } = await first.client.request("/api/health", {
      origin: null,
    });
    expectStatus(response, 200);
    const body = await readJson(response);
    ensure(body.ok === true, "health response was not ready");
    ensure(
      Object.keys(body).length === 1,
      "health response exposed more than minimal readiness",
    );
  });

  await verify("first registration and secure cookie", async () => {
    first.maybeExists = true;
    const { response, setCookies } = await first.client.request("/api/auth/register", {
      method: "POST",
      body: { email: first.email, password: first.password },
    });
    expectStatus(response, 201);
    expectSessionCookie(setCookies);
    const body = await readJson(response);
    ensure(body.user?.email === first.email, "registered user identity was incorrect");
    ensure(typeof body.user?.id === "string", "registered user id was missing");
    first.userId = body.user.id;
  });

  await verify("second registration and secure cookie", async () => {
    second.maybeExists = true;
    const { response, setCookies } = await second.client.request("/api/auth/register", {
      method: "POST",
      body: { email: second.email, password: second.password },
    });
    expectStatus(response, 201);
    expectSessionCookie(setCookies);
    const body = await readJson(response);
    ensure(body.user?.email === second.email, "registered user identity was incorrect");
    ensure(typeof body.user?.id === "string", "registered user id was missing");
    second.userId = body.user.id;
  });

  await verify("first authenticated profile", async () => {
    const { response } = await first.client.request("/api/me");
    expectStatus(response, 200);
    const body = await readJson(response);
    ensure(body.user?.id === first.userId, "profile user id was incorrect");
    ensure(body.user?.email === first.email, "profile email was incorrect");
  });

  await verify("second authenticated profile", async () => {
    const { response } = await second.client.request("/api/me");
    expectStatus(response, 200);
    const body = await readJson(response);
    ensure(body.user?.id === second.userId, "profile user id was incorrect");
    ensure(body.user?.email === second.email, "profile email was incorrect");
    ensure(first.userId !== second.userId, "random accounts did not have distinct ids");
  });

  const marker = randomBytes(12).toString("hex");
  const initialSnapshot = {
    files: [{ path: "README.md", content: `initial-${marker}` }],
    messages: [{ role: "user", content: "Create a safe demo." }],
    activePath: "README.md",
  };
  const updatedSnapshot = {
    files: [
      { path: "README.md", content: `saved-${marker}` },
      { path: "src/index.js", content: "export const ready = true;\n" },
    ],
    messages: [
      { role: "user", content: "Create a safe demo." },
      { role: "assistant", content: "Progress saved." },
    ],
    activePath: "src/index.js",
  };
  const initialName = "E2E scratch project";
  const updatedName = "E2E saved project";
  let projectId;

  await verify("project creation", async () => {
    const { response } = await first.client.request("/api/projects", {
      method: "POST",
      body: { name: initialName, snapshot: initialSnapshot },
    });
    expectStatus(response, 201);
    const body = await readJson(response);
    ensure(typeof body.project?.id === "string", "created project id was missing");
    ensure(body.project?.name === initialName, "created project name was incorrect");
    ensure(
      JSON.stringify(body.project?.snapshot) === JSON.stringify(initialSnapshot),
      "created project snapshot was incorrect",
    );
    projectId = body.project.id;
  });

  await verify("project retrieval", async () => {
    const { response } = await first.client.request(`/api/projects/${projectId}`);
    expectStatus(response, 200);
    const body = await readJson(response);
    ensure(body.project?.id === projectId, "retrieved project id was incorrect");
    ensure(
      JSON.stringify(body.project?.snapshot) === JSON.stringify(initialSnapshot),
      "retrieved project snapshot was incorrect",
    );
  });

  await verify("project update", async () => {
    const { response } = await first.client.request(`/api/projects/${projectId}`, {
      method: "PUT",
      body: { name: updatedName, snapshot: updatedSnapshot },
    });
    expectStatus(response, 200);
    const body = await readJson(response);
    ensure(body.project?.name === updatedName, "updated project name was incorrect");
    ensure(
      JSON.stringify(body.project?.snapshot) === JSON.stringify(updatedSnapshot),
      "updated project snapshot was incorrect",
    );
  });

  await verify("project listing", async () => {
    const { response } = await first.client.request("/api/projects");
    expectStatus(response, 200);
    const body = await readJson(response);
    ensure(Array.isArray(body.projects), "project list was not an array");
    const project = body.projects.find((candidate) => candidate.id === projectId);
    ensure(project?.name === updatedName, "updated project was missing from the list");
    ensure(!Object.hasOwn(project, "snapshot"), "project list exposed full snapshot content");
  });

  await verify("saved progress reload", async () => {
    const reloaded = new ApiClient();
    reloaded.cookies.seed(first.client.cookies.header());
    const { response } = await reloaded.request(`/api/projects/${projectId}`);
    expectStatus(response, 200);
    const body = await readJson(response);
    ensure(body.project?.name === updatedName, "reloaded project name was incorrect");
    ensure(
      JSON.stringify(body.project?.snapshot) === JSON.stringify(updatedSnapshot),
      "saved project progress did not reload exactly",
    );
  });

  await verify("cross-user project read isolation", async () => {
    const { response } = await second.client.request(`/api/projects/${projectId}`);
    expectStatus(response, 404);
    expectError(await readJson(response), "not_found");
  });

  await verify("cross-user project update isolation", async () => {
    const { response } = await second.client.request(`/api/projects/${projectId}`, {
      method: "PUT",
      body: { name: "Unauthorized update", snapshot: initialSnapshot },
    });
    expectStatus(response, 404);
    expectError(await readJson(response), "not_found");
  });

  await verify("cross-user project delete isolation", async () => {
    const { response } = await second.client.request(`/api/projects/${projectId}`, {
      method: "DELETE",
    });
    expectStatus(response, 404);
    expectError(await readJson(response), "not_found");
  });

  await verify("project survives cross-user attempts", async () => {
    const { response } = await first.client.request(`/api/projects/${projectId}`);
    expectStatus(response, 200);
    const body = await readJson(response);
    ensure(
      JSON.stringify(body.project?.snapshot) === JSON.stringify(updatedSnapshot),
      "cross-user request changed saved progress",
    );
  });

  await verify("cross-origin mutation rejection", async () => {
    const { response } = await first.client.request(`/api/projects/${projectId}`, {
      method: "PUT",
      origin: "https://cross-origin.invalid",
      headers: { "Sec-Fetch-Site": "cross-site" },
      body: { name: "Cross-origin update", snapshot: initialSnapshot },
    });
    expectStatus(response, 403);
    expectError(await readJson(response), "forbidden");
  });

  await verify("project survives cross-origin attempt", async () => {
    const { response } = await first.client.request(`/api/projects/${projectId}`);
    expectStatus(response, 200);
    const body = await readJson(response);
    ensure(body.project?.name === updatedName, "cross-origin request changed project name");
    ensure(
      JSON.stringify(body.project?.snapshot) === JSON.stringify(updatedSnapshot),
      "cross-origin request changed saved progress",
    );
  });

  await verify("key validation requires visitor key", async () => {
    const { response } = await first.client.request("/api/key/validate", {
      method: "POST",
    });
    expectStatus(response, 400);
    expectError(await readJson(response), "invalid_api_key");
  });

  await verify("chat requires visitor key", async () => {
    const { response } = await first.client.request("/api/chat", {
      method: "POST",
      body: { messages: [{ role: "user", content: "Missing-key check only." }] },
    });
    expectStatus(response, 400);
    expectError(await readJson(response), "invalid_api_key");
  });

  let loggedOutCookie;
  await verify("logout cookie clearing", async () => {
    loggedOutCookie = first.client.cookies.header();
    ensure(Boolean(loggedOutCookie), "pre-logout session cookie was missing");
    const { response, setCookies } = await first.client.request("/api/auth/logout", {
      method: "POST",
    });
    expectStatus(response, 200);
    expectSessionCookie(setCookies, { cleared: true });
    const body = await readJson(response);
    ensure(body.ok === true, "logout response was not successful");
    ensure(first.client.cookies.header() === "", "logout did not clear the cookie jar");
  });

  await verify("logout server-side invalidation", async () => {
    const { response } = await first.client.request("/api/me", {
      cookieHeader: loggedOutCookie,
    });
    expectStatus(response, 401);
    expectError(await readJson(response), "unauthorized");
  });

  await verify("login after logout", async () => {
    const { response, setCookies } = await first.client.request("/api/auth/login", {
      method: "POST",
      body: { email: first.email, password: first.password },
    });
    expectStatus(response, 200);
    expectSessionCookie(setCookies);
    const body = await readJson(response);
    ensure(body.user?.id === first.userId, "login restored the wrong account");
  });

  let firstDeleteCookie;
  await verify("first account deletion", async () => {
    firstDeleteCookie = first.client.cookies.header();
    const { response, setCookies } = await first.client.request("/api/account", {
      method: "DELETE",
    });
    expectStatus(response, 200);
    first.deleted = true;
    expectSessionCookie(setCookies, { cleared: true });
    const body = await readJson(response);
    ensure(body.ok === true, "account deletion response was not successful");
  });

  await verify("first account session invalidation", async () => {
    const { response } = await first.client.request("/api/me", {
      cookieHeader: firstDeleteCookie,
    });
    expectStatus(response, 401);
    expectError(await readJson(response), "unauthorized");
  });

  let secondDeleteCookie;
  await verify("second account deletion", async () => {
    secondDeleteCookie = second.client.cookies.header();
    const { response, setCookies } = await second.client.request("/api/account", {
      method: "DELETE",
    });
    expectStatus(response, 200);
    second.deleted = true;
    expectSessionCookie(setCookies, { cleared: true });
    const body = await readJson(response);
    ensure(body.ok === true, "account deletion response was not successful");
  });

  await verify("second account session invalidation", async () => {
    const { response } = await second.client.request("/api/me", {
      cookieHeader: secondDeleteCookie,
    });
    expectStatus(response, 401);
    expectError(await readJson(response), "unauthorized");
  });

  ensure(passed === EXPECTED_CHECKS, "validation check count drifted");
} catch (error) {
  const detail = error instanceof Error ? error.message : "unexpected failure";
  failure = `${currentCheck}: ${detail}`;
} finally {
  const cleanupFailures = [];
  for (const account of [first, second]) {
    try {
      await cleanupAccount(account);
    } catch {
      cleanupFailures.push(account.label);
    }
  }
  if (cleanupFailures.length > 0) {
    failure = failure
      ? `${failure}; disposable account cleanup failed`
      : "disposable account cleanup failed";
  }
}

if (failure) {
  console.error(
    `Krater Pro cloud E2E: ${passed}/${EXPECTED_CHECKS} checks passed; ${failure}`,
  );
  process.exitCode = 1;
} else {
  console.log(`Krater Pro cloud E2E: ${passed}/${EXPECTED_CHECKS} checks passed`);
}
