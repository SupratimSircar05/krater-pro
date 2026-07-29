import { win32 } from "node:path";
import { describe, expect, it, vi } from "vitest";

const observedLaunches = vi.hoisted(() => ({
  asynchronous: [] as Array<{
    executable: string;
    args: readonly string[];
    options: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      shell?: boolean;
      windowsHide?: boolean;
    };
  }>,
  synchronous: [] as Array<{
    executable: string;
    args: readonly string[];
    options: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      shell?: boolean;
      windowsHide?: boolean;
    };
  }>,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");

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
      },
    ) => {
      observedLaunches.asynchronous.push({ executable, args, options });
      const child = new EventEmitter();
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      Object.assign(child, {
        stdin,
        stdout,
        stderr: null,
        kill: () => true,
      });
      stdin.once("finish", () => {
        queueMicrotask(() => child.emit("exit", 0, null));
      });
      return child;
    },
    spawnSync: (
      executable: string,
      args: readonly string[],
      options: {
        cwd?: string;
        env?: NodeJS.ProcessEnv;
        shell?: boolean;
        windowsHide?: boolean;
      },
    ) => {
      observedLaunches.synchronous.push({ executable, args, options });
      return {
        pid: 1,
        output: [null, "", ""],
        stdout: "",
        stderr: "",
        status: 2,
        signal: null,
      };
    },
  };
});

import {
  inspectCredentialStore,
  readStoredCredentialSync,
} from "./credential-store.js";
import { windowsSystemExecutable } from "./windows-system-executable.js";

describe("Windows credential executable launch", () => {
  it.runIf(process.platform === "win32")(
    "uses canonical PowerShell without caller-controlled environment",
    async () => {
      observedLaunches.asynchronous.length = 0;
      observedLaunches.synchronous.length = 0;
      const expected = windowsSystemExecutable("powershell.exe");
      const previous = new Map(
        [
          "KRATER_API_KEY",
          "GITHUB_TOKEN",
          "PATH",
          "SystemRoot",
          "WINDIR",
          "ComSpec",
          "PSModulePath",
          "USERPROFILE",
          "APPDATA",
          "LOCALAPPDATA",
        ].map((name) => [name, process.env[name]]),
      );
      process.env.KRATER_API_KEY = "must-not-reach-child";
      process.env.GITHUB_TOKEN = "must-not-reach-child";
      process.env.PATH = String.raw`C:\attacker-controlled`;
      process.env.SystemRoot = String.raw`C:\attacker-controlled`;
      process.env.WINDIR = String.raw`C:\attacker-controlled`;
      process.env.ComSpec = String.raw`C:\attacker-controlled\cmd.exe`;
      process.env.PSModulePath = String.raw`C:\attacker-controlled\modules`;
      process.env.USERPROFILE = String.raw`C:\Users\krater-ci`;
      process.env.APPDATA = String.raw`C:\Users\krater-ci\AppData\Roaming`;
      process.env.LOCALAPPDATA = String.raw`C:\Users\krater-ci\AppData\Local`;

      try {
        await expect(inspectCredentialStore()).resolves.toMatchObject({
          available: true,
          backend: "windows_dpapi",
        });
        expect(
          readStoredCredentialSync(String.raw`C:\krater-launch-observer`),
        ).toBeUndefined();

        expect(expected).toMatch(
          /^[a-z]:\\.+\\system32\\windowspowershell\\v1\.0\\powershell\.exe$/i,
        );
        expect(observedLaunches.asynchronous).toHaveLength(1);
        expect(observedLaunches.synchronous).toHaveLength(1);
        for (const launch of [
          observedLaunches.asynchronous[0],
          observedLaunches.synchronous[0],
        ]) {
          expect(launch?.executable).toBe(expected);
          expect(launch?.options.cwd).toBe(win32.dirname(expected));
          expect(launch?.options.shell).toBe(false);
          expect(launch?.options.windowsHide).toBe(true);
          expect(launch?.options.env).not.toHaveProperty("KRATER_API_KEY");
          expect(launch?.options.env).not.toHaveProperty("GITHUB_TOKEN");
          expect(launch?.options.env).not.toHaveProperty("PATH");
          expect(launch?.options.env).toEqual({});
        }
      } finally {
        for (const [name, value] of previous) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    },
  );
});
