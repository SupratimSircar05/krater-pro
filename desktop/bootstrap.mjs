const COMMAND_GATE_FLAG = "--krater-internal-command-gate";

if (process.platform === "win32") {
  process.stderr.write(
    "Krater Pro desktop supports macOS and Linux only; Windows support has been removed.\n",
  );
  process.exit(1);
} else if (process.argv.includes(COMMAND_GATE_FLAG)) {
  const { assertTrustedCommandGateParent } = await import(
    "./command-gate-parent.mjs"
  );
  try {
    assertTrustedCommandGateParent();
  } catch {
    process.stderr.write(
      "Krater internal command gate refused an untrusted parent process.\n",
    );
    process.exit(126);
  }
  await import("../dist/command-gate.js");
  const { app } = await import("electron");
  app.exit(process.exitCode ?? 0);
} else {
  await import("./main.mjs");
}
