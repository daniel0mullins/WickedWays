#!/usr/bin/env bash
# Bundle the Dioxus web client (Phase 2c, sub-project D). Settled bundling path:
# cargo → wasm32 → wasm-bindgen (--target web) → a static dist/ the C axum binary
# (or any static server) serves same-origin alongside /ws. No dx / trunk needed;
# the only extra tool is `wasm-bindgen` pinned to the version Cargo.lock resolves.
#
# Usage: crates/wickedways-web/build-web.sh [dist_dir]   (default: crates/wickedways-web/dist)
set -euo pipefail

crate_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$crate_dir/../.." && pwd)"
dist="${1:-$crate_dir/dist}"
profile="release"

# The wasm-bindgen CLI must match the wasm-bindgen crate version in Cargo.lock.
wb_ver="$(grep -A1 '^name = "wasm-bindgen"$' "$repo_root/Cargo.lock" | sed -n 's/^version = "\(.*\)"/\1/p' | head -1)"
have_ver="$(wasm-bindgen --version 2>/dev/null | awk '{print $2}' || true)"
if [ "$have_ver" != "$wb_ver" ]; then
  echo "wasm-bindgen $wb_ver required (have '${have_ver:-none}'):" >&2
  echo "  cargo install wasm-bindgen-cli --version $wb_ver" >&2
  exit 1
fi

echo "building wasm ($profile)…"
cargo build -p wickedways-web --bin wickedways-web --target wasm32-unknown-unknown --"$profile"

wasm="$repo_root/target/wasm32-unknown-unknown/$profile/wickedways-web.wasm"
mkdir -p "$dist"
echo "wasm-bindgen → $dist"
wasm-bindgen "$wasm" --out-dir "$dist" --target web --no-typescript
cp "$crate_dir/index.html" "$dist/index.html"
echo "done: serve $dist (index.html loads ./wickedways-web.js)"
