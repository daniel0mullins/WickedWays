#!/usr/bin/env bash
# Orchestrates the multiplayer-loop browser e2e (Phase 2c, sub-project D — slice 1):
# bundle the client → start wickedways-server (ephemeral, `demo` genesis) → serve the bundle →
# drive it in a browser (multiplayer-loop.mjs). Prints E2E_PASS on success.
#
# Env: PW_CHROME (optional Playwright executablePath, for images whose bundled browser build differs
# from Playwright's expected one). Requires: cargo, wasm-bindgen (see build-web.sh), python3, node +
# playwright. Not part of CI — see e2e/multiplayer-loop.mjs.
set -uo pipefail

crate_dir="$(cd "$(dirname "$0")/.." && pwd)"
repo_root="$(cd "$crate_dir/../.." && pwd)"
work="$(mktemp -d)"
sport=9000
aport=8090

cleanup() { kill "${SRV:-}" "${HTTPD:-}" 2>/dev/null; rm -rf "$work"; }
trap cleanup EXIT

echo "building server + bundle…"
cargo build --manifest-path "$repo_root/Cargo.toml" -p wickedways-server --bin wickedways-server -q
"$crate_dir/build-web.sh" "$work/dist" >/dev/null
mkdir -p "$work/genesis"
cp "$repo_root/conformance/fixtures/sync-move.genesis.json" "$work/genesis/demo.json"

GENESIS_DIR="$work/genesis" PORT="$sport" GM_IDENTITY=gm \
  "$repo_root/target/debug/wickedways-server" >"$work/server.log" 2>&1 &
SRV=$!
( cd "$work/dist" && python3 -m http.server "$aport" >/dev/null 2>&1 ) &
HTTPD=$!
sleep 2
echo "server: $(cat "$work/server.log")"

APP_URL="http://127.0.0.1:$aport/index.html?ws=ws://127.0.0.1:$sport/ws&campaign=demo&token=gm" \
  node "$crate_dir/e2e/multiplayer-loop.mjs"
