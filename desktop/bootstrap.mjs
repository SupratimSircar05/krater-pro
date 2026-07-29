const COMMAND_GATE_FLAG = "--krater-internal-command-gate";

if (process.argv.includes(COMMAND_GATE_FLAG)) {
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
