import { assertSemver } from "../../scripts/release/release-utils.mjs";

export const packageIdentifier = "SupratimSircar05.KraterPro";
export const manifestVersion = "1.12.0";
export const releaseRepository =
  "https://github.com/SupratimSircar05/krater-pro";

const outputNames = {
  version: `${packageIdentifier}.yaml`,
  installer: `${packageIdentifier}.installer.yaml`,
  locale: `${packageIdentifier}.locale.en-US.yaml`,
};

export function windowsInstallerName(version) {
  assertSemver(version);
  return `Krater-Pro-Setup-${version}-x64.exe`;
}

export function windowsInstallerUrl(version) {
  const name = windowsInstallerName(version);
  return `${releaseRepository}/releases/download/v${version}/${name}`;
}

function replaceToken(template, token, value) {
  const marker = `{{${token}}}`;
  const occurrences = template.split(marker).length - 1;
  if (occurrences === 0) {
    throw new Error(`WinGet template is missing token ${marker}.`);
  }
  return template.replaceAll(marker, value);
}

function assertNoTemplateTokens(rendered) {
  const unresolved = rendered.match(/\{\{[A-Z0-9_]+\}\}/u);
  if (unresolved) {
    throw new Error(`Unresolved WinGet template token: ${unresolved[0]}`);
  }
}

export function renderWingetManifests(
  templates,
  { version, installerSha256 },
) {
  assertSemver(version);
  if (!/^[a-f0-9]{64}$/u.test(installerSha256 ?? "")) {
    throw new Error("WinGet installer SHA-256 must be lowercase hexadecimal.");
  }
  for (const key of Object.keys(outputNames)) {
    if (typeof templates?.[key] !== "string" || templates[key].length === 0) {
      throw new Error(`Missing WinGet ${key} template.`);
    }
  }

  const replacements = {
    VERSION: version,
    INSTALLER_URL: windowsInstallerUrl(version),
    INSTALLER_SHA256: installerSha256,
  };
  const rendered = {};
  for (const [kind, template] of Object.entries(templates)) {
    let contents = template;
    for (const [token, value] of Object.entries(replacements)) {
      if (contents.includes(`{{${token}}}`)) {
        contents = replaceToken(contents, token, value);
      }
    }
    assertNoTemplateTokens(contents);
    rendered[outputNames[kind]] = contents.endsWith("\n")
      ? contents
      : `${contents}\n`;
  }
  return rendered;
}
