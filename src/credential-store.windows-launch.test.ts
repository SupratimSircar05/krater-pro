import { describe, expect, it, vi } from "vitest";

const observedLaunches = vi.hoisted(() => ({
  asynchronous: [] as string[],
  synchronous: [] as string[],
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");

  return {
    ...actual,
    spawn: (executable: string) => {
      observedLaunches.asynchronous.push(executable);
      const process = new EventEmitter();
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      Object.assign(process, {
        stdin,
        stdout,
        stderr: null,
        kill: () => true,
      });
      stdin.once("finish", () => {
        queueMicrotask(() => process.emit("close", 0, null));
      });
      return process;
    },
    spawnSync: (executable: string) => {
      observedLaunches.synchronous.push(executable);
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
    "passes the same canonical PowerShell path to async and sync adapters",
    async () => {
      observedLaunches.asynchronous.length = 0;
      observedLaunches.synchronous.length = 0;
      const expected = windowsSystemExecutable("powershell.exe");

      await expect(inspectCredentialStore()).resolves.toMatchObject({
        available: true,
        backend: "windows_dpapi",
      });
      expect(readStoredCredentialSync("C:\\krater-launch-observer")).toBeUndefined();

      expect(expected).toMatch(
        /^[a-z]:\\.+\\system32\\windowspowershell\\v1\.0\\powershell\.exe$/i,
      );
      expect(observedLaunches.asynchronous).toEqual([expected]);
      expect(observedLaunches.synchronous).toEqual([expected]);
    },
  );
});
