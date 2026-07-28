const mode = process.env.KRATER_CAUSAL_MODE ?? "broken";

if (mode === "safe") {
  process.stdout.write("mode:safe\n");
  process.exit(0);
}

process.stderr.write("mode:broken\n");
process.exit(7);
