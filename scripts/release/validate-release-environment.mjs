#!/usr/bin/env node

import process from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const stableRequirements = {
  mac: [
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "APPLE_API_KEY",
    "APPLE_API_KEY_ID",
    "APPLE_API_ISSUER",
  ],
  assemble: [
    "KRATER_RELEASE_GPG_KEY_ID",
    "KRATER_RELEASE_GPG_PASSPHRASE",
  ],
};

export function validateReleaseEnvironment({
  platform,
  stable,
  environment = process.env,
}) {
  if (!Object.hasOwn(stableRequirements, platform)) {
    throw new Error(`Unsupported release platform: ${platform}`);
  }
  if (!stable) return { stable: false, missing: [] };
  const missing = stableRequirements[platform].filter(
    (name) => !environment[name],
  );
  if (missing.length > 0) {
    throw new Error(
      `Stable ${platform} release is blocked because protected configuration is missing: ${missing.join(", ")}.`,
    );
  }
  return { stable: true, missing: [] };
}
function parseArguments(args) {
  const platformIndex = args.indexOf("--platform");
  const platform = platformIndex >= 0 ? args[platformIndex + 1] : undefined;
  if (!platform) throw new Error("--platform is required.");
  const supported = new Set(["--platform", "--stable"]);
  for (const argument of args) {
    if (argument.startsWith("--") && !supported.has(argument)) {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return { platform, stable: args.includes("--stable") };
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  try {
    const options = parseArguments(process.argv.slice(2));
    validateReleaseEnvironment(options);
    process.stdout.write(
      options.stable
        ? `Stable ${options.platform} release configuration is present.\n`
        : `Unsigned ${options.platform} candidate mode selected.\n`,
    );
  } catch (error) {
    process.stderr.write(`Release configuration invalid: ${error.message}\n`);
    process.exitCode = 1;
  }
}
