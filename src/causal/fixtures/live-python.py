import os
import sys

mode = os.environ.get("KRATER_CAUSAL_MODE", "broken")

if mode == "safe":
    sys.stdout.write("mode:safe\n")
    raise SystemExit(0)

sys.stderr.write("mode:broken\n")
raise SystemExit(7)
