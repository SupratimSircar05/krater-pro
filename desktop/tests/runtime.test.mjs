import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  DESKTOP_HOST,
  findAvailableLoopbackPort,
  isLocalAppUrl,
  isSafeExternalUrl,
  parseDesktopLaunchOptions,
  parseDesktopPort,
  shouldQuitWhenAllWindowsClosed,
  startOnLoopback,
} from "../runtime.mjs";

test("desktop port validation accepts only TCP ports", () => {
  assert.equal(parseDesktopPort(undefined), undefined);
  assert.equal(parseDesktopPort("4317"), 4317);
  for (const invalid of ["0", "65536", "-1", "4.2", "abc"]) {
    assert.throws(() => parseDesktopPort(invalid), /Invalid desktop port/);
  }
});

test("launch options force loopback and prefer command options", async () => {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "krater-desktop-options-"),
  );
  const options = parseDesktopLaunchOptions({
    argv: [
      "--krater-port=49152",
      "--krater-workspace",
      "selected-project",
    ],
    environment: {
      KRATER_DESKTOP_PORT: "49153",
      KRATER_DESKTOP_WORKSPACE: "/ignored",
    },
    defaultWorkspace: "/default",
    invocationDirectory: temporaryDirectory,
  });
  assert.deepEqual(options, {
    host: DESKTOP_HOST,
    port: 49152,
    smokeTest: false,
    workspace: join(temporaryDirectory, "selected-project"),
    workspaceWasExplicit: true,
  });
});

test("packaged smoke mode is explicit and cannot be enabled by a value suffix", () => {
  const enabled = parseDesktopLaunchOptions({
    argv: ["--krater-smoke-test"],
    environment: {},
    defaultWorkspace: "/default",
  });
  const disabled = parseDesktopLaunchOptions({
    argv: ["--krater-smoke-test=true"],
    environment: {},
    defaultWorkspace: "/default",
  });
  assert.equal(enabled.smokeTest, true);
  assert.equal(disabled.smokeTest, false);
});

test("desktop window lifecycle preserves smoke-mode window turnover", () => {
  assert.equal(shouldQuitWhenAllWindowsClosed("darwin", false), false);
  assert.equal(shouldQuitWhenAllWindowsClosed("win32", false), true);
  assert.equal(shouldQuitWhenAllWindowsClosed("linux", false), true);
  assert.equal(shouldQuitWhenAllWindowsClosed("win32", true), false);
  assert.equal(shouldQuitWhenAllWindowsClosed("linux", true), false);
});

test("launch options reject missing values", () => {
  assert.throws(
    () =>
      parseDesktopLaunchOptions({
        argv: ["--krater-workspace"],
        environment: {},
        defaultWorkspace: "/default",
      }),
    /requires a value/,
  );
});

test("automatic launcher retries only address-in-use failures", async () => {
  let calls = 0;
  const server = await startOnLoopback({
    findPort: async () => 49_152 + calls,
    start: async ({ host, port }) => {
      calls += 1;
      assert.equal(host, DESKTOP_HOST);
      assert.ok(port > 0);
      if (calls === 1) {
        const error = new Error("busy");
        error.code = "EADDRINUSE";
        throw error;
      }
      return { url: `http://${host}:${port}`, close: async () => {} };
    },
  });
  assert.equal(calls, 2);
  assert.equal(server.host, DESKTOP_HOST);
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
});

test("an explicitly selected port is never silently changed", async () => {
  let calls = 0;
  await assert.rejects(
    startOnLoopback({
      requestedPort: 4317,
      start: async () => {
        calls += 1;
        const error = new Error("busy");
        error.code = "EADDRINUSE";
        throw error;
      },
    }),
    /busy/,
  );
  assert.equal(calls, 1);
});

test("the ephemeral port finder returns a loopback TCP port", async () => {
  try {
    const port = await findAvailableLoopbackPort();
    assert.ok(Number.isInteger(port));
    assert.ok(port >= 1 && port <= 65_535);
  } catch (error) {
    // Some code-execution sandboxes deny all socket binds. Native CI and the
    // packaged-app smoke test exercise the real bind path.
    if (error.code !== "EPERM") throw error;
  }
});

test("navigation policy accepts only the exact local app origin", () => {
  const appUrl = "http://127.0.0.1:4317";
  assert.equal(isLocalAppUrl(`${appUrl}/ide?file=README.md`, appUrl), true);
  assert.equal(isLocalAppUrl("http://127.0.0.1:4318", appUrl), false);
  assert.equal(isLocalAppUrl("http://localhost:4317", appUrl), false);
  assert.equal(isLocalAppUrl("https://127.0.0.1:4317", appUrl), false);
  assert.equal(isLocalAppUrl("javascript:alert(1)", appUrl), false);
});

test("external navigation permits credential-free HTTPS only", () => {
  assert.equal(isSafeExternalUrl("https://krater.ai/developers"), true);
  assert.equal(isSafeExternalUrl("https://github.com/example/repo"), true);
  assert.equal(isSafeExternalUrl("http://example.com"), false);
  assert.equal(isSafeExternalUrl("https://user:pass@example.com"), false);
  assert.equal(isSafeExternalUrl("file:///tmp/key"), false);
});
