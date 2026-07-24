#!/usr/bin/env bash
# Orchestrates the crafting browser e2e: bundle the client → start wickedways-server seeded with the
# Covenant genesis AND catalog (so the authority resolves the ward-charm recipe) → serve the bundle →
# drive the harvest→craft loop (crafting.mjs). Prints E2E_PASS on success.
#
# Env: PW_CHROME (optional Playwright executablePath). Requires: cargo, wasm-bindgen (see
# build-web.sh), python3, node + playwright. Not part of CI — see e2e/crafting.mjs.
set -uo pipefail

crate_dir="$(cd "$(dirname "$0")/.." && pwd)"
repo_root="$(cd "$crate_dir/../.." && pwd)"
work="$(mktemp -d)"
sport=9005
aport=8096

cleanup() { kill "${SRV:-}" "${HTTPD:-}" 2>/dev/null; rm -rf "$work"; }
trap cleanup EXIT

echo "building server + bundle…"
cargo build --manifest-path "$repo_root/Cargo.toml" -p wickedways-server --bin wickedways-server -q
"$crate_dir/build-web.sh" "$work/dist" >/dev/null
mkdir -p "$work/genesis"
# The Covenant ships its own catalog beside its genesis — the server resolves `<id>.catalog.json`.
cp "$repo_root/conformance/fixtures/covenant.genesis.json" "$work/genesis/covenant.json"
cp "$repo_root/conformance/fixtures/covenant.catalog.json" "$work/genesis/covenant.catalog.json"

GENESIS_DIR="$work/genesis" PORT="$sport" GM_IDENTITY=gm \
  "$repo_root/target/debug/wickedways-server" >"$work/server.log" 2>&1 &
SRV=$!
( cd "$work/dist" && python3 -m http.server "$aport" >/dev/null 2>&1 ) &
HTTPD=$!
sleep 2
echo "server: $(cat "$work/server.log")"

APP_URL="http://127.0.0.1:$aport/index.html?ws=ws://127.0.0.1:$sport/ws&campaign=covenant&token=gm&surface=crt-terminal" \
  node "$crate_dir/e2e/crafting.mjs"
