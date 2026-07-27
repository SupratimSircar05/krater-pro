#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRODUCT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
KIND="${1:-}"

if [[ "$KIND" != "qa" && "$KIND" != "tw" && "$KIND" != "rf" ]]; then
  echo "Usage: $0 {qa|tw|rf}" >&2
  exit 2
fi
if [ "${SWE_ATLAS_CONFIRM_FULL:-}" != "YES" ]; then
  echo "A full category uses substantial model, judge, image, and compute resources." >&2
  echo "Set SWE_ATLAS_CONFIRM_FULL=YES to acknowledge the cost." >&2
  exit 2
fi

: "${SWE_ATLAS_ROOT:?Set SWE_ATLAS_ROOT to the official SWE-Atlas checkout.}"
: "${KRATER_API_KEY:?Set KRATER_API_KEY in the environment.}"
: "${KRATER_PRO_BUNDLE:?Run build_bundle.sh and export KRATER_PRO_BUNDLE.}"
: "${OPENAI_API_KEY:?Set OPENAI_API_KEY for the official SWE-Atlas judge.}"
: "${OPENAI_API_BASE:?Set OPENAI_API_BASE for the official SWE-Atlas judge.}"

HARBOR_BIN="${HARBOR_BIN:-harbor}"
if ! command -v "$HARBOR_BIN" >/dev/null 2>&1; then
  echo "Harbor is not installed. Install official Harbor v0.18.0." >&2
  exit 2
fi
if [[ "$("$HARBOR_BIN" --version 2>&1)" != *"0.18.0"* ]]; then
  echo "This adapter requires Harbor v0.18.0." >&2
  exit 2
fi

cd "$PRODUCT_ROOT"
python3 -m benchmarks.swe_atlas.prepare_task \
  --source-root "$SWE_ATLAS_ROOT" \
  --output-root "$SCRIPT_DIR/.work/$KIND" \
  --kind "$KIND" \
  --all \
  --clean-output \
  --overwrite

export PYTHONPATH="$PRODUCT_ROOT${PYTHONPATH:+:$PYTHONPATH}"
"$HARBOR_BIN" run \
  -c "$SCRIPT_DIR/config/$KIND.yaml" \
  -n "${HARBOR_CONCURRENCY:-1}" \
  --job-name "krater-pro-kimi-k3-swe-atlas-$KIND" \
  -y
