#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRODUCT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
HARBOR_BIN="${HARBOR_BIN:-harbor}"

cd "$PRODUCT_ROOT"
if ! command -v "$HARBOR_BIN" >/dev/null 2>&1; then
  echo "Harbor is required for the actual custom-agent API tests." >&2
  exit 2
fi
if [[ "$("$HARBOR_BIN" --version 2>&1)" != *"0.18.0"* ]]; then
  echo "Offline adapter tests require Harbor v0.18.0." >&2
  exit 2
fi
HARBOR_PYTHON="${HARBOR_PYTHON:-$(
  python3 -c 'import os,sys; print(os.path.join(os.path.dirname(os.path.realpath(sys.argv[1])), "python"))' \
    "$(command -v "$HARBOR_BIN")"
)}"
if [ ! -x "$HARBOR_PYTHON" ]; then
  echo "Could not locate Harbor's Python runtime; set HARBOR_PYTHON." >&2
  exit 2
fi

"$HARBOR_PYTHON" -m unittest discover \
  -s benchmarks/swe_atlas/tests \
  -p 'test_*.py' \
  -v
"$HARBOR_PYTHON" -m py_compile \
  benchmarks/swe_atlas/agent_core.py \
  benchmarks/swe_atlas/krater_agent.py \
  benchmarks/swe_atlas/prepare_task.py
node --check benchmarks/swe_atlas/payload_verify.mjs
