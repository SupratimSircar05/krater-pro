#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRODUCT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUTPUT="${1:-$SCRIPT_DIR/.artifacts/krater-pro.mjs}"

if [ ! -x "$PRODUCT_ROOT/node_modules/.bin/esbuild" ]; then
  echo "Missing esbuild. Run npm install in $PRODUCT_ROOT first." >&2
  exit 2
fi
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); const ok=(a===20&&b>=19)||(a===22&&b>=12)||a>22; if(!ok)process.exit(1)'; then
  echo "Krater Pro requires Node.js ^20.19.0 or >=22.12.0." >&2
  exit 2
fi

mkdir -p "$(dirname "$OUTPUT")"
OUTPUT="$(cd "$(dirname "$OUTPUT")" && pwd)/$(basename "$OUTPUT")"

(
  cd "$PRODUCT_ROOT"
  npm run build
  ./node_modules/.bin/esbuild benchmarks/swe_atlas/agent_entry.ts \
    --bundle \
    --platform=node \
    --format=esm \
    --target=node20.19 \
    --external:vite \
    --external:lightningcss \
    --external:fsevents \
    '--banner:js=import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' \
    --outfile="$OUTPUT"
)

node "$OUTPUT" --version
printf 'KRATER_PRO_BUNDLE=%s\n' "$OUTPUT"
