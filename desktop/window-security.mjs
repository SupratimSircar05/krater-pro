import { isLocalAppUrl, isSafeExternalUrl } from "./runtime.mjs";

export function browserWindowOptions({
  icon,
  platform = process.platform,
  devTools = false,
}) {
  return {
    title: "Krater Pro",
    width: 1480,
    height: 940,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#0b0c0f",
    show: false,
    autoHideMenuBar: platform !== "darwin",
    icon,
    webPreferences: {
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      safeDialogs: true,
      spellcheck: true,
      devTools,
      // No "persist:" prefix: cookies, cache, and localStorage disappear when
      // the app exits. A pasted Krater key remains renderer memory only.
      partition: "krater-pro",
    },
  };
}

export function hardenWebContents({
  webContents,
  appUrl,
  openExternal,
}) {
  const openInSystemBrowser = (candidate) => {
    if (!isSafeExternalUrl(candidate)) return;
    Promise.resolve(openExternal(candidate)).catch(() => {
      // Opening a system browser is best-effort and must not crash the IDE.
    });
  };

  webContents.setWindowOpenHandler(({ url }) => {
    openInSystemBrowser(url);
    return { action: "deny" };
  });

  webContents.on("will-navigate", (event, url) => {
    if (isLocalAppUrl(url, appUrl)) return;
    event.preventDefault();
    openInSystemBrowser(url);
  });

  webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });

  webContents.session.setPermissionRequestHandler(
    (_requestingWebContents, _permission, callback) => callback(false),
  );
  webContents.session.setPermissionCheckHandler(() => false);
  webContents.session.on("will-download", (event) => {
    event.preventDefault();
  });
}
