import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const unusedPermissionKeys = [
  "NSAudioCaptureUsageDescription",
  "NSBluetoothAlwaysUsageDescription",
  "NSBluetoothPeripheralUsageDescription",
  "NSCameraUsageDescription",
  "NSMicrophoneUsageDescription",
];

export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appPath = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  const infoPath = join(appPath, "Contents", "Info.plist");
  await execFileAsync("/usr/bin/plutil", [
    "-replace",
    "NSAppTransportSecurity.NSAllowsArbitraryLoads",
    "-bool",
    "NO",
    infoPath,
  ]);

  for (const key of unusedPermissionKeys) {
    try {
      await execFileAsync("/usr/bin/plutil", ["-remove", key, infoPath]);
    } catch (error) {
      if (error.code === 1) continue;
      throw error;
    }
  }

  // Canonical source assets can carry Finder/resource-fork xattrs from a
  // developer checkout. They are not application content and make both the
  // fuse signature reset and the final codesign pass fail. Clear them only
  // from electron-builder's generated app bundle.
  await execFileAsync("/usr/bin/xattr", ["-cr", appPath]);

  const { stdout } = await execFileAsync("/usr/bin/plutil", [
    "-extract",
    "NSAppTransportSecurity.NSAllowsArbitraryLoads",
    "raw",
    "-o",
    "-",
    infoPath,
  ]);
  if (stdout.trim() !== "false") {
    throw new Error("Krater Pro macOS packaging must not allow arbitrary loads.");
  }
}
