#!/usr/bin/env bash
# Bundle Campaign Studio as a static site: cargo → wasm32 → wasm-bindgen (--target web)
# → a static dist/ any static server can host. Same settled path as the play client's
# build-web.sh; the only extra tool is `wasm-bindgen` pinned to the version Cargo.lock
# resolves.
#
# Usage: crates/wickedways-studio/build-studio.sh [dist_dir]   (default: crates/wickedways-studio/dist)
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
cargo build -p wickedways-studio --bin wickedways-studio --target wasm32-unknown-unknown --"$profile"

wasm="$repo_root/target/wasm32-unknown-unknown/$profile/wickedways-studio.wasm"
mkdir -p "$dist"
echo "wasm-bindgen → $dist"
wasm-bindgen "$wasm" --out-dir "$dist" --target web --no-typescript
# index.html doubles as the dx-serve template, so it ships an empty <title> and no loader
# script; inject both for the static bundle here. The loader computes its base from the
# document URL instead of a bare relative import, so the bundle also boots when a host
# serves index.html at a slash-less mount path (e.g. `/studio`) where `./x.js` would
# resolve against the parent — a directory pathname without its trailing slash is
# treated as the directory.
loader='<script type="module">const p=location.pathname;const base=p.endsWith("/")?p:(p.split("/").pop().includes(".")?p.replace(/[^/]*$/,""):p+"/");const{default:init}=await import(base+"wickedways-studio.js");await init();</script>'
sed -e 's|<title></title>|<title>WickedWays Campaign Studio</title>|' \
    -e "s|</body>|  ${loader}\n  </body>|" \
  "$crate_dir/index.html" > "$dist/index.html"
echo "done: serve $dist (index.html loads ./wickedways-studio.js)"
