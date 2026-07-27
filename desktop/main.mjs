import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
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
const APP_VERSION = "0.1.0";
const CREATOR_CREDIT = "Built by Supratim with ❤️";
const CREATOR_PROFILE = "https://www.linkedin.com/in/supratimsircar/";
const currentDirectory = dirname(fileURLToPath(import.meta.url));
const applicationRoot = join(currentDirectory, "..");
const iconPath = join(currentDirectory, "assets", "icon.png");
const allowDevTools =
  !app.isPackaged && process.env.KRATER_DESKTOP_DEVTOOLS === "1";

let mainWindow;
let localServer;
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
      return startServer(config);
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

function createMainWindow() {
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

  window.once("ready-to-show", () => {
    window.show();
  });
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
  void window.loadURL(localServer.url);
  mainWindow = window;
}

async function closeLocalServer() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    try {
      await localServer?.close();
    } finally {
      localServer = undefined;
    }
  })();
  return shutdownPromise;
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

  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: APP_VERSION,
    version: APP_VERSION,
    copyright: CREATOR_CREDIT,
    credits: `${CREATOR_CREDIT}\n${CREATOR_PROFILE}`,
    iconPath,
  });
  buildApplicationMenu();
  createMainWindow();
}

app.whenReady().then(launch).catch((error) => {
  const message =
    error instanceof Error ? error.message : "Unknown desktop startup failure.";
  dialog.showErrorBox("Krater Pro could not start", message);
  app.exit(1);
});

app.on("activate", () => {
  if (!mainWindow && localServer) createMainWindow();
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
