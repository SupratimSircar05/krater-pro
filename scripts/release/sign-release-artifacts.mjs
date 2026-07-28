#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

function parseArguments(args) {
  const parsed = { directory: "release-assets", required: false };
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--required") {
      parsed.required = true;
      continue;
    }
    if (option !== "--directory") throw new Error(`Unknown option: ${option}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${option} requires a value.`);
    }
    parsed.directory = value;
    index += 1;
  }
  return parsed;
}

export function signingPlan({
  required,
  keyId,
  passphrase,
  directory,
  manifestName = "krater-pro.release-manifest.json",
}) {
  const configured = Boolean(keyId && passphrase);
  if (required && !configured) {
    throw new Error(
      "Stable release signing requires KRATER_RELEASE_GPG_KEY_ID and KRATER_RELEASE_GPG_PASSPHRASE.",
    );
  }
  if (!configured) {
    return { status: "unsigned_candidate", commands: [] };
  }
  const files = ["SHA256SUMS.txt", manifestName];
  return {
    status: "configured",
    commands: files.map((name) => {
      const input = join(directory, name);
      return {
        input,
        output: `${input}.asc`,
        arguments: [
          "--batch",
          "--yes",
          "--armor",
          "--detach-sign",
          "--local-user",
          keyId,
          "--pinentry-mode",
          "loopback",
          "--passphrase-fd",
          "0",
          "--output",
          `${input}.asc`,
          input,
        ],
      };
    }),
  };
}

async function runGpg(arguments_, stdin) {
  const child = spawn("gpg", arguments_, {
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (stdin !== undefined) child.stdin.end(`${stdin}\n`);
  else child.stdin.end();
  const code = await new Promise((resolveCode, reject) => {
    child.once("error", reject);
    child.once("exit", resolveCode);
  });
  if (code !== 0) throw new Error(`gpg exited with status ${code}.`);
}

export async function signReleaseArtifacts({
  directory,
  required,
  keyId = process.env.KRATER_RELEASE_GPG_KEY_ID,
  passphrase = process.env.KRATER_RELEASE_GPG_PASSPHRASE,
}) {
  const absoluteDirectory = resolve(directory);
  const manifest = (await readdir(absoluteDirectory)).find((name) =>
    /^krater-pro-.+\.release-manifest\.json$/u.test(name),
  );
  if (!manifest) throw new Error("Release manifest is missing.");
  const plan = signingPlan({
    required,
    keyId,
    passphrase,
    directory: absoluteDirectory,
    manifestName: manifest,
  });
  if (plan.status === "unsigned_candidate") {
    process.stdout.write("Release candidate is intentionally unsigned.\n");
    return plan;
  }
  for (const command of plan.commands) {
    await access(command.input);
    await runGpg(command.arguments, passphrase);
    await runGpg(["--batch", "--verify", command.output, command.input]);
    if ((await readFile(command.output)).length === 0) {
      throw new Error(`gpg created an empty signature for ${command.input}.`);
    }
  }
  process.stdout.write(
    `Signed ${plan.commands.length} release integrity files.\n`,
  );
  return plan;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  const options = parseArguments(process.argv.slice(2));
  signReleaseArtifacts(options).catch((error) => {
    process.stderr.write(`Release signing failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
