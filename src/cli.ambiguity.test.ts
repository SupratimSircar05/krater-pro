import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { CLARIFICATION_REQUIRED_EXIT_CODE } from "./ambiguity-preflight.js";
import { readEvidenceTask } from "./evidence-runtime.js";

const execFileAsync = promisify(execFile);
const temporaryPaths: string[] = [];

async function temporaryWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "krater-cli-ambiguity-"));
  temporaryPaths.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("CLI ambiguity contract", () => {
  it("returns structured clarification JSON with a distinct noninteractive exit code", async () => {
    const workspace = await temporaryWorkspace();
    let stdout = "";
    let exitCode: number | undefined;
    try {
      await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          resolve("src/cli.ts"),
          "--cwd",
          workspace,
          "--json",
          "--assume",
          "ask",
          "Use either SQLite or JSON.",
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, KRATER_API_KEY: "" },
        },
      );
    } catch (error) {
      const failure = error as {
        code?: number;
        stdout?: string;
        stderr?: string;
      };
      exitCode = failure.code;
      stdout = failure.stdout ?? "";
      expect(failure.stderr ?? "").toBe("");
    }

    expect(exitCode).toBe(CLARIFICATION_REQUIRED_EXIT_CODE);
    const output = JSON.parse(stdout) as {
      type: string;
      exitCode: number;
      taskId: string;
      clarification: { interpretations: string[] };
    };
    expect(output).toMatchObject({
      type: "clarification_required",
      exitCode: CLARIFICATION_REQUIRED_EXIT_CODE,
      clarification: { interpretations: ["SQLite", "JSON"] },
    });
    const detail = await readEvidenceTask(workspace, "cli", output.taskId);
    expect(detail.task.state).toBe("clarification");
    expect(detail.contract.interpretations.every((item) => !item.selected)).toBe(
      true,
    );
  });
});
