import { spawn } from "node:child_process";

export const KRATER_ACCOUNT_URL = "https://krater.ai/";
export const KRATER_DEVELOPER_URL = "https://krater.ai/developers";

export interface BrowserAuthCapabilities {
  oauth: false;
  mode: "api-key-handoff";
  accountUrl: string;
  developerUrl: string;
  explanation: string;
}

export function browserAuthCapabilities(): BrowserAuthCapabilities {
  return {
    oauth: false,
    mode: "api-key-handoff",
    accountUrl: KRATER_ACCOUNT_URL,
    developerUrl: KRATER_DEVELOPER_URL,
    explanation:
      "Krater does not currently publish an OAuth/OIDC authorization flow for third-party API clients. Krater Pro will not read browser cookies or extract private session tokens.",
  };
}

export function browserOpenCommand(
  platform: NodeJS.Platform,
  url = KRATER_DEVELOPER_URL,
): { executable: string; args: string[] } {
  if (platform === "darwin") return { executable: "open", args: [url] };
  if (platform === "win32") {
    return {
      executable: "cmd",
      args: ["/d", "/s", "/c", `start "" "${url}"`],
    };
  }
  return { executable: "xdg-open", args: [url] };
}

export async function openKraterDeveloperPage(): Promise<void> {
  const command = browserOpenCommand(process.platform);
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command.executable, command.args, {
      detached: true,
      stdio: "ignore",
      shell: false,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolvePromise();
    });
  });
}
