import { createServer } from "node:net";
import { isAbsolute, resolve } from "node:path";

export const DESKTOP_HOST = "127.0.0.1";
export const DESKTOP_PORT_ENV = "KRATER_DESKTOP_PORT";
export const DESKTOP_WORKSPACE_ENV = "KRATER_DESKTOP_WORKSPACE";
export const DESKTOP_SMOKE_FLAG = "--krater-smoke-test";

function readOption(argv, name) {
  const exactIndex = argv.indexOf(name);
  if (exactIndex >= 0) {
    const value = argv[exactIndex + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${name} requires a value.`);
    }
    return value;
  }

  const prefix = `${name}=`;
  const inline = argv.find((argument) => argument.startsWith(prefix));
  if (!inline) return undefined;
  const value = inline.slice(prefix.length);
  if (!value) throw new Error(`${name} requires a value.`);
  return value;
}

export function parseDesktopPort(value) {
  if (value === undefined || value === "") return undefined;
  if (!/^\d+$/.test(value)) {
    throw new Error(
      `Invalid desktop port "${value}". Expected an integer from 1 to 65535.`,
    );
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      `Invalid desktop port "${value}". Expected an integer from 1 to 65535.`,
    );
  }
  return port;
}

export function parseDesktopLaunchOptions({
  argv = process.argv.slice(1),
  environment = process.env,
  defaultWorkspace,
  invocationDirectory = process.cwd(),
}) {
  if (!defaultWorkspace) {
    throw new Error("A default desktop workspace is required.");
  }

  const portText =
    readOption(argv, "--krater-port") ?? environment[DESKTOP_PORT_ENV];
  const workspaceText =
    readOption(argv, "--krater-workspace") ??
    environment[DESKTOP_WORKSPACE_ENV] ??
    defaultWorkspace;
  const workspace = isAbsolute(workspaceText)
    ? resolve(workspaceText)
    : resolve(invocationDirectory, workspaceText);

  return {
    host: DESKTOP_HOST,
    port: parseDesktopPort(portText),
    smokeTest: argv.includes(DESKTOP_SMOKE_FLAG),
    workspace,
    workspaceWasExplicit:
      readOption(argv, "--krater-workspace") !== undefined ||
      Boolean(environment[DESKTOP_WORKSPACE_ENV]),
  };
}

export async function findAvailableLoopbackPort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen({ host: DESKTOP_HOST, port: 0, exclusive: true }, () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        reject(new Error("Could not reserve a loopback port."));
        return;
      }
      const port = address.port;
      probe.close((error) => {
        if (error) reject(error);
        else resolvePort(port);
      });
    });
  });
}

export async function startOnLoopback({
  requestedPort,
  start,
  findPort = findAvailableLoopbackPort,
  maxAutomaticAttempts = 5,
}) {
  if (typeof start !== "function") {
    throw new TypeError("start must be a function.");
  }

  const attempts = requestedPort === undefined ? maxAutomaticAttempts : 1;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const port = requestedPort ?? (await findPort());
    try {
      const server = await start({ host: DESKTOP_HOST, port });
      return { ...server, host: DESKTOP_HOST, port };
    } catch (error) {
      lastError = error;
      if (
        requestedPort !== undefined ||
        /** @type {NodeJS.ErrnoException} */ (error).code !== "EADDRINUSE"
      ) {
        throw error;
      }
    }
  }
  throw lastError ?? new Error("Could not start the desktop loopback server.");
}

export function isLocalAppUrl(candidate, appUrl) {
  try {
    const parsed = new URL(candidate);
    const app = new URL(appUrl);
    return (
      parsed.protocol === "http:" &&
      parsed.hostname === DESKTOP_HOST &&
      parsed.origin === app.origin &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}

export function isSafeExternalUrl(candidate) {
  try {
    const parsed = new URL(candidate);
    return (
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}
