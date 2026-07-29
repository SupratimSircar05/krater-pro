import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const observed = vi.hoisted(() => ({
  asynchronous: [] as Array<{
    executable: string;
    args: readonly string[];
    options: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      shell?: boolean;
      windowsHide?: boolean;
      stdio?: readonly string[];
    };
  }>,
  synchronous: [] as Array<{
    executable: string;
    args: readonly string[];
    options: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      killSignal?: NodeJS.Signals | number;
    };
  }>,
  mode: "exit" as "exit" | "close" | "hang" | "pipe-error" | "early-pipe-error",
  signals: [] as Array<NodeJS.Signals | number | undefined>,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (
      executable: string,
      args: readonly string[],
      options: {
        cwd?: string;
        env?: NodeJS.ProcessEnv;
        shell?: boolean;
        windowsHide?: boolean;
        stdio?: readonly string[];
      },
    ) => {
      observed.asynchronous.push({ executable, args, options });
      const child = new EventEmitter();
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      Object.assign(child, {
        stdin,
        stdout,
        stderr: null,
        kill: (signal?: NodeJS.Signals | number) => {
          observed.signals.push(signal);
          if (signal === "SIGTERM" && observed.mode === "pipe-error") {
            queueMicrotask(() =>
              stdin.emit("error", new Error("simulated broken pipe")),
            );
          }
          return true;
        },
      });
      stdin.once("finish", () => {
        if (observed.mode === "exit") {
          queueMicrotask(() => child.emit("exit", 0, null));
        } else if (observed.mode === "close") {
          queueMicrotask(() => child.emit("close", 0, null));
        } else if (observed.mode === "early-pipe-error") {
          queueMicrotask(() =>
            stdin.emit("error", new Error("simulated early broken pipe")),
          );
        }
      });
      return child;
    },
    spawnSync: (
      executable: string,
      args: readonly string[],
      options: {
        cwd?: string;
        env?: NodeJS.ProcessEnv;
        killSignal?: NodeJS.Signals | number;
      },
    ) => {
      observed.synchronous.push({ executable, args, options });
      return {
        pid: 1,
        output: [null, "", ""],
        stdout: "",
        stderr: "",
        status: 0,
        signal: null,
      };
    },
  };
});

import {
  inspectCredentialStore,
  readStoredCredentialSync,
} from "./credential-store.js";

describe("credential helper launch boundary", () => {
  beforeEach(() => {
    observed.asynchronous.length = 0;
    observed.synchronous.length = 0;
    observed.signals.length = 0;
    observed.mode = "exit";
  });

  it("uses the fixed macOS helper, trusted cwd, and a minimal environment", async () => {
    const previousApiKey = process.env.KRATER_API_KEY;
    const previousGithubToken = process.env.GITHUB_TOKEN;
    const previousPath = process.env.PATH;
    process.env.KRATER_API_KEY = "must-not-reach-child";
    process.env.GITHUB_TOKEN = "must-not-reach-child";
    process.env.PATH = "/attacker-controlled";
    try {
      await expect(
        inspectCredentialStore({ platform: "darwin" }),
      ).resolves.toMatchObject({
        available: true,
        backend: "macos_keychain",
      });
      expect(
        readStoredCredentialSync("/tmp/krater-helper-test", {
          platform: "darwin",
        }),
      ).toBeUndefined();

      expect(observed.asynchronous).toHaveLength(1);
      expect(observed.synchronous).toHaveLength(1);
      for (const launch of [
        observed.asynchronous[0],
        observed.synchronous[0],
      ]) {
        expect(launch?.executable).toBe("/usr/bin/security");
        expect(launch?.options.cwd).toBe("/usr/bin");
        expect(launch?.options.env).not.toHaveProperty("KRATER_API_KEY");
        expect(launch?.options.env).not.toHaveProperty("GITHUB_TOKEN");
        expect(launch?.options.env).not.toHaveProperty("PATH");
        expect(launch?.options.env).not.toHaveProperty("USERPROFILE");
        expect(launch?.options.env).not.toHaveProperty("APPDATA");
      }
      expect(observed.asynchronous[0]?.options).toMatchObject({
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      });
      expect(observed.synchronous[0]?.options.killSignal).toBe("SIGKILL");
    } finally {
      if (previousApiKey === undefined) delete process.env.KRATER_API_KEY;
      else process.env.KRATER_API_KEY = previousApiKey;
      if (previousGithubToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previousGithubToken;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it("escalates a stuck helper from SIGTERM to SIGKILL and fails closed", async () => {
    observed.mode = "hang";
    vi.useFakeTimers();
    try {
      const pending = inspectCredentialStore({ platform: "darwin" });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(observed.signals).toEqual(["SIGTERM"]);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toEqual({
        available: false,
        backend: "macos_keychain",
        reason: "/usr/bin/security is unavailable.",
      });
      expect(observed.signals).toEqual(["SIGTERM", "SIGKILL"]);
    } finally {
      observed.mode = "exit";
      vi.useRealTimers();
    }
  });

  it("force-kills a timed-out helper even when its pipe fails first", async () => {
    observed.mode = "pipe-error";
    vi.useFakeTimers();
    try {
      const pending = inspectCredentialStore({ platform: "darwin" });
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(pending).resolves.toMatchObject({
        available: false,
        backend: "macos_keychain",
      });
      expect(observed.signals).toEqual(["SIGTERM", "SIGKILL"]);
    } finally {
      observed.mode = "exit";
      vi.useRealTimers();
    }
  });

  it("force-kills a helper when a pipe fails before the timeout", async () => {
    observed.mode = "early-pipe-error";
    await expect(
      inspectCredentialStore({ platform: "darwin" }),
    ).resolves.toMatchObject({
      available: false,
      backend: "macos_keychain",
    });
    expect(observed.signals).toEqual(["SIGKILL"]);
  });
});
