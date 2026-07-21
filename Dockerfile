# Multi-stage image for the WickedWays **Dioxus** web client + room server: one
# binary serves the bundled Dioxus app (static WASM + assets) AND the multiplayer
# `/ws` endpoint on one port, so a deploy is a single Coolify resource / preview URL.
#
# Build context MUST be the repo root. The Dioxus bundle and the server binary are
# compiled inside the image (the client derives its socket URL same-origin, so no
# host/port is baked in). The store is ephemeral by default (no DB_PATH / volume).
#
# (The legacy TypeScript SPA image lives at packages/play/Dockerfile; this one
#  supersedes it for the Rust stack.)

# ---- builder: Rust toolchain → Dioxus wasm bundle + server binary ----
FROM rust:1-slim-bookworm AS builder
WORKDIR /app

# Prebuilt wasm-bindgen CLI (release tarball beats `cargo install` by minutes); the
# version MUST match the `wasm-bindgen` crate in Cargo.lock (build-web.sh asserts it).
# gcc is for rusqlite's bundled SQLite (the `cc` crate compiles it in-tree).
ARG WASM_BINDGEN_VERSION=0.2.126
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates gcc \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL "https://github.com/rustwasm/wasm-bindgen/releases/download/${WASM_BINDGEN_VERSION}/wasm-bindgen-${WASM_BINDGEN_VERSION}-$(uname -m)-unknown-linux-musl.tar.gz" \
    | tar -xz --strip-components=1 -C /usr/local/bin --wildcards '*/wasm-bindgen' \
 && wasm-bindgen --version \
 && rustup target add wasm32-unknown-unknown

# Rust sources only, so a docs/TS-only change never invalidates this (slow) stage.
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
# The web client bundles the demo/caretaker/facade/status-bar campaigns via
# `include_str!("../../../conformance/fixtures/*.json")`, so those files must be present at compile
# time (not just in the runtime stage's genesis seed below).
COPY conformance/fixtures ./conformance/fixtures

# Bundle the Dioxus web client (cargo → wasm32 → wasm-bindgen --target web → /app/dist),
# then build the room server that serves it. `--locked` pins the committed Cargo.lock.
RUN crates/wickedways-web/build-web.sh /app/dist
RUN cargo build -p wickedways-server --release --locked

# ---- runtime: slim glibc base ----
FROM debian:bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/wickedways-server /usr/local/bin/wickedways-server
COPY --from=builder /app/dist ./dist
# Seed the ephemeral multiplayer demo campaign (the client's default `?campaign=demo`).
# Single-player campaigns are bundled in the client and need no server-side genesis.
COPY conformance/fixtures/sync-move.genesis.json ./genesis/demo.json
# The Covenant — the co-op multiplayer campaign (`?campaign=covenant`). Ships its own catalog beside
# the genesis so the server resolves its `twin-wards-held` victory (a scripted behavior); the server's
# `catalog_for` picks up `<id>.catalog.json` automatically.
COPY conformance/fixtures/covenant.genesis.json ./genesis/covenant.json
COPY conformance/fixtures/covenant.catalog.json ./genesis/covenant.catalog.json

# PORT is injected by the platform (Coolify); the rest wire the one-binary topology.
# No DB_PATH → the store is ephemeral (a clean slate per deploy).
ENV PORT=8080 \
    WEB_DIR=/app/dist \
    GENESIS_DIR=/app/genesis \
    GM_IDENTITY=gm
EXPOSE 8080
CMD ["wickedways-server"]
