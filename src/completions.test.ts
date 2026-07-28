import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  generateCompletion,
  isCompletionShell,
  SUPPORTED_COMPLETION_SHELLS,
} from "./completions.js";

describe("shell completions", () => {
  it("recognizes only supported shells", () => {
    expect(SUPPORTED_COMPLETION_SHELLS).toEqual(["bash", "zsh", "fish"]);
    expect(isCompletionShell("bash")).toBe(true);
    expect(isCompletionShell("powershell")).toBe(false);
  });

  it.each(SUPPORTED_COMPLETION_SHELLS)(
    "generates deterministic %s completions for onboarding and evidence commands",
    (shell) => {
      const output = generateCompletion(shell);

      expect(output.endsWith("\n")).toBe(true);
      expect(output).toContain("setup");
      expect(output).toContain("doctor");
      expect(output).toContain("completion");
      expect(output).toContain("task");
      expect(output).toContain("proof");
      for (const command of ["plan", "approve", "verify", "watch"]) {
        expect(output).toContain(command);
      }
      expect(output).not.toContain("KRATER_API_KEY=");
      expect(generateCompletion(shell)).toBe(output);
    },
  );

  it.each(["bash", "zsh"] as const)(
    "emits syntax accepted by %s when that shell is installed",
    (shell) => {
      const result = spawnSync(shell, ["-n"], {
        encoding: "utf8",
        input: generateCompletion(shell),
      });
      if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        return;
      }
      expect(result.status, result.stderr).toBe(0);
    },
  );
});
