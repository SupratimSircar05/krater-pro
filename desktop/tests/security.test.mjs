import assert from "node:assert/strict";
import { test } from "vitest";
import {
  browserWindowOptions,
  hardenWebContents,
} from "../window-security.mjs";

test("BrowserWindow is sandboxed without Node or a persistent partition", () => {
  const options = browserWindowOptions({
    icon: "/tmp/icon.png",
    platform: "win32",
  });
  assert.equal(options.title, "Krater Pro");
  assert.equal(options.webPreferences.nodeIntegration, false);
  assert.equal(options.webPreferences.nodeIntegrationInWorker, false);
  assert.equal(options.webPreferences.contextIsolation, true);
  assert.equal(options.webPreferences.sandbox, true);
  assert.equal(options.webPreferences.webSecurity, true);
  assert.equal(options.webPreferences.allowRunningInsecureContent, false);
  assert.equal(options.webPreferences.devTools, false);
  assert.ok(!options.webPreferences.partition.startsWith("persist:"));
  assert.equal(JSON.stringify(options).includes("apiKey"), false);
});

test("web contents deny popups, webviews, downloads, and permissions", async () => {
  const handlers = new Map();
  let windowOpenHandler;
  let permissionRequestHandler;
  let permissionCheckHandler;
  const opened = [];
  const webContents = {
    setWindowOpenHandler(handler) {
      windowOpenHandler = handler;
    },
    on(name, handler) {
      handlers.set(name, handler);
    },
    session: {
      setPermissionRequestHandler(handler) {
        permissionRequestHandler = handler;
      },
      setPermissionCheckHandler(handler) {
        permissionCheckHandler = handler;
      },
      on(name, handler) {
        handlers.set(`session:${name}`, handler);
      },
    },
  };
  hardenWebContents({
    webContents,
    appUrl: "http://127.0.0.1:4317",
    openExternal: async (url) => opened.push(url),
  });

  assert.deepEqual(
    windowOpenHandler({ url: "https://krater.ai/developers" }),
    { action: "deny" },
  );
  assert.deepEqual(windowOpenHandler({ url: "javascript:alert(1)" }), {
    action: "deny",
  });
  await Promise.resolve();
  assert.deepEqual(opened, ["https://krater.ai/developers"]);

  const localEvent = { prevented: false, preventDefault() { this.prevented = true; } };
  handlers.get("will-navigate")(
    localEvent,
    "http://127.0.0.1:4317/ide",
  );
  assert.equal(localEvent.prevented, false);

  const remoteEvent = { prevented: false, preventDefault() { this.prevented = true; } };
  handlers.get("will-navigate")(remoteEvent, "https://github.com/example/repo");
  assert.equal(remoteEvent.prevented, true);
  await Promise.resolve();
  assert.deepEqual(opened, [
    "https://krater.ai/developers",
    "https://github.com/example/repo",
  ]);

  const webviewEvent = { prevented: false, preventDefault() { this.prevented = true; } };
  handlers.get("will-attach-webview")(webviewEvent);
  assert.equal(webviewEvent.prevented, true);

  let permissionAllowed;
  permissionRequestHandler({}, "notifications", (allowed) => {
    permissionAllowed = allowed;
  });
  assert.equal(permissionAllowed, false);
  assert.equal(permissionCheckHandler({}, "clipboard-read"), false);

  const downloadEvent = { prevented: false, preventDefault() { this.prevented = true; } };
  handlers.get("session:will-download")(downloadEvent);
  assert.equal(downloadEvent.prevented, true);
});
