#!/usr/bin/env bash
# Build the Claude Desktop extension (.mcpb) — a double-click install for
# colleagues who should not have to touch Node, git or a JSON config file.
#
# The server is bundled into a single file with esbuild rather than shipping
# node_modules: the MCP SDK pulls in express/hono/jose for HTTP transports this
# stdio server never uses, which is 26 MB across 3,630 files versus ~1.3 MB.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
OUT="$ROOT/build/mcpb"
VERSION="$(node -p "require('./package.json').version")"

echo "==> Type-checking and compiling"
npm run build

echo "==> Bundling server to a single file"
rm -rf "$OUT"
mkdir -p "$OUT/server"
npx esbuild src/index.ts \
  --bundle --platform=node --format=esm --target=node18 \
  --outfile="$OUT/server/index.js" --log-level=warning

echo "==> Writing manifest"
node "$ROOT/scripts/make-manifest.mjs" "$OUT"

echo "==> Packing"
rm -f "$ROOT/undp-open-data.mcpb"
npx --yes @anthropic-ai/mcpb pack "$OUT" "$ROOT/undp-open-data.mcpb"

echo
echo "Built: $ROOT/undp-open-data.mcpb ($(du -h "$ROOT/undp-open-data.mcpb" | cut -f1))"
