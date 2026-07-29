import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readWorkspacePreferences,
  workspacePreferencesPath,
  writeWorkspacePreferences,
} from "./preferences.js";

const temporaryPaths: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "krater-preferences-"));
  temporaryPaths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("workspace preferences", () => {
  it("writes and reads an owner-private strict assurance preference", async () => {
    const cwd = await temporaryDirectory();
    const path = await writeWorkspacePreferences(cwd, {
      schemaVersion: 1,
      defaultAssurance: "high",
    });

    expect(path).toBe(workspacePreferencesPath(cwd));
    expect(readWorkspacePreferences(cwd)).toEqual({
      schemaVersion: 1,
      defaultAssurance: "high",
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      schemaVersion: 1,
      defaultAssurance: "high",
    });
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it("refuses a symlinked preference target", async () => {
    if (process.platform === "win32") return;
    const cwd = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await writeWorkspacePreferences(cwd, {
      schemaVersion: 1,
      defaultAssurance: "standard",
    });
    await rm(workspacePreferencesPath(cwd));
    await symlink(
      join(outside, "preferences.json"),
      workspacePreferencesPath(cwd),
    );

    await expect(
      writeWorkspacePreferences(cwd, {
        schemaVersion: 1,
        defaultAssurance: "fast",
      }),
    ).rejects.toThrow(/symbolic link/i);
  });

  it("rejects unsupported fields instead of silently accepting them", async () => {
    const cwd = await temporaryDirectory();
    await expect(
      writeWorkspacePreferences(cwd, {
        schemaVersion: 1,
        defaultAssurance: "standard",
        extra: true,
      } as never),
    ).rejects.toThrow(/unsupported or invalid schema/i);
  });
});
