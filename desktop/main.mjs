import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeTheme,
  shell,
} from "electron";
import {
  parseDesktopLaunchOptions,
  startOnLoopback,
} from "./runtime.mjs";
import {
  browserWindowOptions,
  hardenWebContents,
} from "./window-security.mjs";

const APP_NAME = "Krater Pro";
const CREATOR_CREDIT = "Built by Supratim with ❤️";
const CREATOR_PROFILE = "https://www.linkedin.com/in/supratimsircar/";
const DESKTOP_SMOKE_PROOF = ".krater-desktop-smoke.json";
const currentDirectory = dirname(fileURLToPath(import.meta.url));
const applicationRoot = join(currentDirectory, "..");
const iconPath = join(currentDirectory, "assets", "icon.png");
const allowDevTools =
  !app.isPackaged && process.env.KRATER_DESKTOP_DEVTOOLS === "1";

let mainWindow;
let localServer;
let pendingLaunchUrl;
let shutdownPromise;
let shutdownComplete = false;
let quitting = false;

app.setName(APP_NAME);
app.enableSandbox();
if (process.platform === "win32") {
  app.setAppUserModelId("com.supratimsircar.kraterpro");
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

function assertProductionBuild() {
  const requiredFiles = [
    join(applicationRoot, "dist", "server.js"),
    join(applicationRoot, "dist", "config.js"),
    join(applicationRoot, "web", "dist", "index.html"),
  ];
  const missing = requiredFiles.filter((path) => !existsSync(path));
  if (missing.length > 0) {
    throw new Error(
      "The Krater Pro production assets are missing. Run `npm run build` before starting the desktop app.",
    );
  }
}

async function startIdeServer(options) {
  const [{ loadConfig }, { startServer }] = await Promise.all([
    import("../dist/config.js"),
    import("../dist/server.js"),
  ]);

  return startOnLoopback({
    requestedPort: options.port,
    start: async ({ host, port }) => {
      const config = loadConfig({
        cwd: options.workspace,
        host,
        port,
      });
      return startServer(config, { evidenceMode: true });
    },
  });
}

function buildApplicationMenu() {
  const applicationMenu =
    process.platform === "darwin"
      ? [
          {
            label: APP_NAME,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : [];

  const template = [
    ...applicationMenu,
    {
      label: "File",
      submenu: [
        process.platform === "darwin"
          ? { role: "close" }
          : { role: "quit", label: "Exit Krater Pro" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...(allowDevTools
          ? [{ type: "separator" }, { role: "toggleDevTools" }]
          : []),
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }],
    },
    {
      role: "help",
      submenu: [
        {
          label: CREATOR_CREDIT,
          click: () => shell.openExternal(CREATOR_PROFILE),
        },
        {
          label: "Krater API setup",
          click: () => shell.openExternal("https://krater.ai/developers"),
        },
        {
          label: "Krater Pro on GitHub",
          click: () =>
            shell.openExternal(
              "https://github.com/SupratimSircar05/krater-pro",
            ),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createMainWindow({ showWhenReady = true } = {}) {
  if (!localServer) {
    throw new Error("The local Krater Pro server is not ready.");
  }

  const window = new BrowserWindow(
    browserWindowOptions({
      icon: iconPath,
      platform: process.platform,
      devTools: allowDevTools,
    }),
  );
  hardenWebContents({
    webContents: window.webContents,
    appUrl: localServer.url,
    openExternal: (url) => shell.openExternal(url),
  });

  if (showWhenReady) {
    window.once("ready-to-show", () => {
      window.show();
    });
  }
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = undefined;
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    if (quitting || details.reason === "clean-exit") return;
    dialog.showErrorBox(
      "Krater Pro renderer stopped",
      "The IDE window stopped unexpectedly. Reopen Krater Pro to continue.",
    );
  });
  const launchUrl =
    pendingLaunchUrl ??
    (typeof localServer.createLaunchUrl === "function"
      ? localServer.createLaunchUrl()
      : localServer.launchUrl);
  pendingLaunchUrl = undefined;
  const loadPromise = window.loadURL(launchUrl);
  mainWindow = window;
  return { launchUrl, loadPromise, window };
}

function reopenMainWindow(options = {}) {
  if (!mainWindow && localServer) return createMainWindow(options);
  return undefined;
}

async function closeLocalServer() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    try {
      await localServer?.close();
    } finally {
      localServer = undefined;
      pendingLaunchUrl = undefined;
    }
  })();
  return shutdownPromise;
}

async function waitForSmokeLoad(loadPromise) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error("Desktop renderer smoke test timed out.")),
      30_000,
    );
    timeoutId.unref();
  });
  try {
    await Promise.race([loadPromise, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function bootstrapTokenFromLaunchUrl(launchUrl) {
  const token = new URLSearchParams(
    new URL(launchUrl).hash.slice(1),
  ).get("__krater_session");
  if (!token || !/^[A-Za-z0-9_-]{43}$/u.test(token)) {
    throw new Error("Desktop smoke launch URL did not contain a valid bootstrap.");
  }
  return token;
}

async function destroySmokeWindow(window) {
  if (window.isDestroyed()) return;
  await new Promise((resolve) => {
    window.once("closed", resolve);
    window.destroy();
  });
}

async function verifySmokeWindow({
  commandProof,
  launchUrl,
  loadPromise,
  window,
}) {
  await waitForSmokeLoad(loadPromise);
  const result = await window.webContents.executeJavaScript(
    `({
      title: document.title,
      rootChildren: document.querySelector("#root")?.childElementCount ?? 0
    })`,
    true,
  );
  if (
    result.rootChildren < 1 ||
    !String(result.title).toLowerCase().includes("krater pro")
  ) {
    throw new Error(
      "Desktop renderer loaded without the expected Krater Pro application root.",
    );
  }
  const bootstrapToken = bootstrapTokenFromLaunchUrl(launchUrl);
  const command = commandProof
    ? process.platform === "win32"
      ? `echo ${commandProof}`
      : `printf ${commandProof}`
    : null;
  const authenticated = await window.webContents.executeJavaScript(
    `(async () => {
      let localToken;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        localToken = sessionStorage.getItem("krater_pro_local_session");
        if (localToken) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!localToken) {
        return {
          status: 401,
          replayStatus: 0,
          terminal: null,
          body: { error: "local session unavailable" }
        };
      }
      const authenticatedHeaders = {
        "x-krater-local-token": localToken
      };
      const statusResponse = await fetch("/api/status", {
        cache: "no-store",
        headers: authenticatedHeaders
      });
      const status = await statusResponse.json();
      if (!statusResponse.ok) {
        return {
          status: statusResponse.status,
          replayStatus: 0,
          terminal: null,
          body: status
        };
      }
      const replayResponse = await fetch("/api/local-session", {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        headers: {
          "x-krater-bootstrap-token": ${JSON.stringify(bootstrapToken)}
        }
      });
      const command = ${JSON.stringify(command)};
      let terminal = null;
      if (command !== null) {
        const terminalResponse = await fetch("/api/ide/terminal", {
          method: "POST",
          headers: {
            ...authenticatedHeaders,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            projectId: status.projectId,
            command,
            timeoutMs: 15000
          })
        });
        terminal = {
          status: terminalResponse.status,
          body: await terminalResponse.json()
        };
      }
      return {
        status: statusResponse.status,
        replayStatus: replayResponse.status,
        terminal,
        body: status
      };
    })()`,
    true,
  );
  if (authenticated.status !== 200) {
    throw new Error(
      `Desktop renderer local-session smoke failed: ${JSON.stringify(authenticated)}`,
    );
  }
  if (authenticated.replayStatus !== 401) {
    throw new Error(
      `Desktop renderer launch bootstrap was reusable: ${authenticated.replayStatus}`,
    );
  }
  const terminal = authenticated.terminal;
  if (
    commandProof &&
    (terminal?.status !== 200 ||
      terminal.body?.exitCode !== 0 ||
      terminal.body?.timedOut !== false ||
      !String(terminal.body?.stdout).includes(commandProof))
  ) {
    throw new Error(
      `Packaged Electron command-gate smoke failed: ${JSON.stringify(terminal)}`,
    );
  }
}

async function runPackagedSmokeTest(workspace) {
  const commandProof = "KRATER_DESKTOP_GATE_OK";
  const first = createMainWindow({ showWhenReady: false });
  await verifySmokeWindow({ ...first, commandProof });
  await destroySmokeWindow(first.window);

  const reopened = reopenMainWindow({ showWhenReady: false });
  if (!reopened) {
    throw new Error("Desktop smoke could not reopen its main window.");
  }
  if (reopened.launchUrl === first.launchUrl) {
    throw new Error("Desktop reopen reused its consumed launch bootstrap.");
  }
  await verifySmokeWindow({ ...reopened, commandProof: undefined });

  await destroySmokeWindow(reopened.window);
  await closeLocalServer();
  shutdownComplete = true;
  await writeFile(
    join(workspace, DESKTOP_SMOKE_PROOF),
    `${JSON.stringify({
      architecture: process.arch,
      commandGate: true,
      platform: process.platform,
      renderer: true,
      reopened: true,
      schemaVersion: 1,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  const markers =
    `KRATER_DESKTOP_SMOKE_OK ${process.platform} ${process.arch}\n` +
    `${commandProof} ${process.platform} ${process.arch}\n` +
    `KRATER_DESKTOP_REOPEN_OK ${process.platform} ${process.arch}\n`;
  await new Promise((resolve) => {
    process.stdout.write(markers, resolve);
  });
  app.exit(0);
}

async function launch() {
  assertProductionBuild();
  nativeTheme.themeSource = "dark";

  const defaultWorkspace = join(
    app.getPath("documents"),
    "Krater Pro Workspace",
  );
  const options = parseDesktopLaunchOptions({
    argv: process.argv.slice(1),
    environment: process.env,
    defaultWorkspace,
  });

  if (!options.workspaceWasExplicit) {
    await mkdir(options.workspace, { recursive: true });
  }
  localServer = await startIdeServer(options);
  pendingLaunchUrl = localServer.launchUrl;

  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    version: app.getVersion(),
    copyright: CREATOR_CREDIT,
    credits: `${CREATOR_CREDIT}\n${CREATOR_PROFILE}`,
    iconPath,
  });
  if (options.smokeTest) {
    await runPackagedSmokeTest(options.workspace);
    return;
  }
  buildApplicationMenu();
  createMainWindow();
}

app.whenReady().then(launch).catch((error) => {
  const message =
    error instanceof Error ? error.message : "Unknown desktop startup failure.";
  process.stderr.write(`Krater Pro desktop startup failed: ${message}\n`);
  dialog.showErrorBox("Krater Pro could not start", message);
  app.exit(1);
});

app.on("activate", () => {
  reopenMainWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  quitting = true;
  if (shutdownComplete || !localServer) return;
  event.preventDefault();
  void closeLocalServer().finally(() => {
    shutdownComplete = true;
    // The original quit request has already closed the BrowserWindow. Calling
    // app.quit() again can leave Electron's macOS main process alive after its
    // loopback listener and renderer are gone. Server cleanup is complete here,
    // so terminate the native event loop deterministically.
    app.exit(0);
  });
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    quitting = true;
    app.quit();
  });
}
