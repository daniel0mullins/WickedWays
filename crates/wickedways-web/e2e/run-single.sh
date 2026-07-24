#!/usr/bin/env bash
# Orchestrates the single-player browser e2e (offline CRT surface): bundle the client → serve the
# static bundle → drive it through the Hollow House flow (singleplayer.mjs). No server needed —
# single-player runs a local in-process authority. Prints E2E_PASS on success.
#
# Env: PW_CHROME (optional Playwright executablePath, for images whose bundled browser build differs
# from Playwright's expected one). Requires: cargo, wasm-bindgen (see build-web.sh), python3, node +
# playwright. Not part of CI — see e2e/singleplayer.mjs.
set -uo pipefail

crate_dir="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
aport=8091

cleanup() { kill "${HTTPD:-}" 2>/dev/null; rm -rf "$work"; }
trap cleanup EXIT

echo "building bundle…"
"$crate_dir/build-web.sh" "$work/dist" >/dev/null
( cd "$work/dist" && python3 -m http.server "$aport" >/dev/null 2>&1 ) &
HTTPD=$!
sleep 2

APP_URL="http://127.0.0.1:$aport/index.html?campaign=hollow-house&surface=crt-terminal&mode=single" \
  node "$crate_dir/e2e/singleplayer.mjs"
