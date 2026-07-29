#!/usr/bin/env node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../../dist/workspace.js";

const root = await mkdtemp(join(tmpdir(), "krater-command-smoke-"));

try {
  const workspace = new Workspace(root);
  const unicodeProof = "Krater_ಕನ್ನಡ_Résumé";
  const command =
    process.platform === "win32"
      ? `set /p "KRATER_READ="\r\necho SHOULD_RUN\r\necho ${unicodeProof}`
      : `read KRATER_READ\ncat\ncat <&3 2>/dev/null || :\necho SHOULD_RUN\necho ${unicodeProof}`;
  const result = await workspace.runCommand(
    command,
    30_000,
    undefined,
    { authorization: "host_direct" },
  );
  const stdout = result.stdout.replaceAll("\r\n", "\n");
  if (
    result.exitCode !== 0 ||
    result.timedOut ||
    !stdout.includes("SHOULD_RUN") ||
    !stdout.includes(unicodeProof)
  ) {
    throw new Error(
      `Workspace command smoke failed on ${process.platform}: ` +
        JSON.stringify({
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          stdout,
          stderr: result.stderr,
        }),
    );
  }

  let rejectedNull = false;
  try {
    await workspace.runCommand("r\0m -rf .", 30_000);
  } catch (error) {
    rejectedNull = /null bytes or unsafe control characters/i.test(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!rejectedNull) {
    throw new Error("Workspace command smoke did not reject a null-byte command.");
  }

  console.log(
    `KRATER_COMMAND_SMOKE_OK ${process.platform} ${process.arch}`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
