import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
