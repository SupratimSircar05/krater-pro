import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("Unsafe command reached child_process.spawn");
  }),
);

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { Workspace } from "./workspace.js";

const temporaryPaths: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "krater-command-security-"));
  temporaryPaths.push(path);
  return path;
}

beforeEach(() => {
  spawnMock.mockClear();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("destructive command guard", () => {
  it.each([
    "rm -fr /",
    "/bin/rm -rf /",
    "sudo /bin/rm -rf /",
    "rm --recursive --force /",
    "rm -rf -- /",
    'rm -rf "$HOME"',
    "rm -rf ${HOME}",
    "git clean --force -d",
    "git -C . reset --hard",
  ])("blocks common spelling bypass without spawning it: %s", async (command) => {
    const workspace = new Workspace(await temporaryDirectory());

    await expect(workspace.runCommand(command)).rejects.toThrow(
      /blocked because it can irreversibly destroy data/,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("handles long combined option tokens in linear time", async () => {
    const workspace = new Workspace(await temporaryDirectory());
    const command = `rm -${"r".repeat(50_000)}f /`;

    await expect(workspace.runCommand(command)).rejects.toThrow(
      /blocked because it can irreversibly destroy data/,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects null/control-byte bypasses and oversized commands before policy checks", async () => {
    const workspace = new Workspace(await temporaryDirectory());

    await expect(workspace.runCommand("r\0m -rf /")).rejects.toThrow(
      /null bytes or unsafe control characters/,
    );
    await expect(workspace.runCommand("printf safe\u001b")).rejects.toThrow(
      /null bytes or unsafe control characters/,
    );
    await expect(
      workspace.runCommand("x".repeat(128_001)),
    ).rejects.toThrow(/Command is too large/);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("command launch boundary", () => {
  it.runIf(process.platform !== "win32")(
    "refuses to spawn after the selected workspace root is replaced",
    async () => {
      const root = await temporaryDirectory();
      const outside = await temporaryDirectory();
      const workspace = new Workspace(root);
      await rm(root, { recursive: true, force: true });
      await symlink(outside, root, "dir");

      await expect(
        workspace.runCommand("pwd", 30_000, undefined, {
          authorization: "host_direct",
        }),
      ).rejects.toThrow(/workspace root changed|registered identity/i);
      expect(spawnMock).not.toHaveBeenCalled();
    },
  );

  it.runIf(process.platform !== "win32")(
    "sends the gate contract and approved script over distinct descriptors",
    async () => {
      const workspace = new Workspace(await temporaryDirectory());
      const command = 'printf "%s" safe | cat && printf done';
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdio: Array<
          | null
          | {
              on: ReturnType<typeof vi.fn>;
              end: ReturnType<typeof vi.fn>;
            }
        >;
        pid: undefined;
        kill: ReturnType<typeof vi.fn>;
      };
      const configInput = {
        on: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
      };
      const commandInput = {
        on: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
      };
      const controlInput = {
        on: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdio = [
        null,
        null,
        null,
        configInput,
        commandInput,
        controlInput,
      ];
      child.pid = undefined;
      child.kill = vi.fn();
      spawnMock.mockImplementationOnce(() => {
        queueMicrotask(() => child.emit("close", 0, null));
        return child;
      });

      await expect(workspace.runCommand(command)).resolves.toMatchObject({
        exitCode: 0,
        timedOut: false,
      });

      const [executable, argumentsList, options] = spawnMock.mock.calls[0]!;
      expect(executable).toBe(process.execPath);
      expect(executable).not.toContain(command);
      expect(argumentsList).not.toContain(command);
      expect(JSON.stringify(options.env)).not.toContain(command);
      expect(options).toMatchObject({
        shell: false,
        stdio: [
          "ignore",
          "pipe",
          "pipe",
          "pipe",
          "pipe",
          "pipe",
        ],
        detached: false,
      });
      expect(argumentsList.at(-1)).toMatch(/command-gate\.ts$/);
      const config = JSON.parse(configInput.end.mock.calls[0]![0]);
      expect(config).toMatchObject({
        mode: "shell-posix",
        expectedRoot: workspace.root,
      });
      expect(commandInput.end).toHaveBeenCalledTimes(1);
      expect(commandInput.end).toHaveBeenCalledWith(command);
      expect(controlInput.end).not.toHaveBeenCalled();
      expect(controlInput.destroy).toHaveBeenCalledTimes(1);
    },
  );

  it("sends Windows commands through the gate instead of argv or stdin", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const workspace = new Workspace(await temporaryDirectory());
    const command = "echo KRATER_WINDOWS_SCRIPT_SENTINEL";
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdio: Array<
        | null
        | {
            on: ReturnType<typeof vi.fn>;
            end: ReturnType<typeof vi.fn>;
            destroy: ReturnType<typeof vi.fn>;
          }
      >;
      pid: undefined;
      kill: ReturnType<typeof vi.fn>;
    };
    const configInput = {
      on: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    };
    const commandInput = {
      on: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    };
    const controlInput = {
      on: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdio = [
      null,
      null,
      null,
      configInput,
      commandInput,
      controlInput,
    ];
    child.pid = undefined;
    child.kill = vi.fn();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    });

    await expect(workspace.runCommand(command)).resolves.toMatchObject({
      exitCode: 0,
      timedOut: false,
    });

    const [executable, argumentsList, options] = spawnMock.mock.calls[0]!;
    expect(executable).toBe(process.execPath);
    expect(executable).not.toContain(command);
    expect(argumentsList).not.toContain(command);
    expect(JSON.stringify(options.env)).not.toContain(command);
    expect(options).toMatchObject({
      shell: false,
      stdio: [
        "ignore",
        "pipe",
        "pipe",
        "pipe",
        "pipe",
        "pipe",
      ],
    });
    expect(JSON.parse(configInput.end.mock.calls[0]![0])).toMatchObject({
      mode: "shell-windows",
      expectedRoot: workspace.root,
    });
    expect(commandInput.end).toHaveBeenCalledWith(command);
    expect(controlInput.destroy).toHaveBeenCalledTimes(1);
  });

  it("forwards a validated Windows command environment outside the C drive", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const previousComSpec = process.env.ComSpec;
    const previousPath = process.env.Path;
    const previousUpperPath = process.env.PATH;
    process.env.ComSpec = String.raw`D:\Windows\System32\cmd.exe`;
    process.env.Path = String.raw`D:\Tools;D:\Windows\System32`;
    delete process.env.PATH;
    const workspace = new Workspace(await temporaryDirectory());
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdio: Array<
        | null
        | {
            on: ReturnType<typeof vi.fn>;
            end: ReturnType<typeof vi.fn>;
            destroy: ReturnType<typeof vi.fn>;
          }
      >;
      pid: undefined;
      kill: ReturnType<typeof vi.fn>;
    };
    const configInput = {
      on: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    };
    const commandInput = {
      on: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    };
    const controlInput = {
      on: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdio = [
      null,
      null,
      null,
      configInput,
      commandInput,
      controlInput,
    ];
    child.pid = undefined;
    child.kill = vi.fn();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    });

    try {
      await workspace.runCommand("echo portable");
      expect(spawnMock.mock.calls[0]?.[0]).toBe(process.execPath);
      expect(spawnMock.mock.calls[0]?.[2].env).toMatchObject({
        Path: String.raw`D:\Tools;D:\Windows\System32`,
        ComSpec: String.raw`D:\Windows\System32\cmd.exe`,
      });
      expect(JSON.parse(configInput.end.mock.calls[0]![0])).toMatchObject({
        mode: "shell-windows",
      });
    } finally {
      if (previousComSpec === undefined) delete process.env.ComSpec;
      else process.env.ComSpec = previousComSpec;
      if (previousPath === undefined) delete process.env.Path;
      else process.env.Path = previousPath;
      if (previousUpperPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousUpperPath;
    }
  });

  it("closes the cancellation descriptor after a gate spawn error", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const workspace = new Workspace(await temporaryDirectory());
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdio: Array<
        | null
        | {
            on: ReturnType<typeof vi.fn>;
            end: ReturnType<typeof vi.fn>;
            destroy: ReturnType<typeof vi.fn>;
          }
      >;
      pid: undefined;
      kill: ReturnType<typeof vi.fn>;
    };
    const configInput = {
      on: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    };
    const commandInput = {
      on: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    };
    const controlInput = {
      on: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdio = [
      null,
      null,
      null,
      configInput,
      commandInput,
      controlInput,
    ];
    child.pid = undefined;
    child.kill = vi.fn();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => child.emit("error", new Error("spawn failed")));
      return child;
    });

    await expect(workspace.runCommand("echo cleanup")).rejects.toThrow(
      /spawn failed/,
    );
    expect(controlInput.destroy).toHaveBeenCalledTimes(1);
  });

  it("requests cancellation through fd 5 before force-killing the gate", async () => {
    const workspace = new Workspace(await temporaryDirectory());
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdio: Array<
        | null
        | {
            on: ReturnType<typeof vi.fn>;
            end: ReturnType<typeof vi.fn>;
            destroy: ReturnType<typeof vi.fn>;
          }
      >;
      pid: undefined;
      kill: ReturnType<typeof vi.fn>;
    };
    const configInput = {
      on: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    };
    const commandInput = {
      on: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    };
    const controlInput = {
      on: vi.fn(),
      end: vi.fn(() => {
        queueMicrotask(() => child.emit("close", 128, null));
      }),
      destroy: vi.fn(),
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdio = [
      null,
      null,
      null,
      configInput,
      commandInput,
      controlInput,
    ];
    child.pid = undefined;
    child.kill = vi.fn();
    spawnMock.mockImplementationOnce(() => child);

    await expect(
      workspace.runCommand("echo timeout", 100),
    ).resolves.toMatchObject({
      exitCode: 128,
      timedOut: true,
    });
    expect(controlInput.end).toHaveBeenCalledWith("cancel");
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("rejects workspace quotes instead of partially escaping Seatbelt regexes", async () => {
    const parent = await temporaryDirectory();
    const root = join(parent, 'quoted-"workspace');
    await mkdir(root);
    const workspace = new Workspace(root);
    const internals = workspace as unknown as {
      commandSandboxProfile(temporaryDirectory: string): string;
    };

    expect(() => internals.commandSandboxProfile(parent)).toThrow(
      /cannot contain quotes or control lines/,
    );
  });
});
