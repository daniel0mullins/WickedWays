# syntax=docker/dockerfile:1.7
# Multi-stage image for the WickedWays **Dioxus** web client + room server: one
# binary serves the bundled Dioxus app (static WASM + assets), Campaign Studio (the
# authoring app, under /studio) AND the multiplayer `/ws` endpoint on one port, so a
# deploy is a single Coolify resource / preview URL.
#
# Build context MUST be the repo root. The Dioxus bundle and the server binary are
# compiled inside the image (the client derives its socket URL same-origin, so no
# host/port is baked in). The store is ephemeral by default (no DB_PATH / volume).
# This is the only shipped image; the legacy TypeScript SPA (packages/play) was retired.

# ---- builder: Rust toolchain → Dioxus wasm bundle + server binary ----
FROM rust:1-slim-bookworm AS builder
WORKDIR /app

# Fully serialize cargo. The cold wasm compile of the full Dioxus tree is the most
# memory-hungry step of the build; parallel codegen has OOM-killed it on
# memory-constrained build hosts (the process dies mid-compile with no rustc error —
# most recently at jobs=2, ~10 min into a cold-cache preview build). Measured on the
# cold tree: jobs=2 peaks at ~1.0 GB of rustc RSS (two ~550 MB compiles overlap:
# web-sys, js-sys, wickedways-core, wickedways-web are all in that class); jobs=1
# bounds the peak to the single largest compile, ~0.67 GB, for ~2x the cold-build
# wall time. Warm rebuilds (BuildKit cache mounts below) recompile only the changed
# workspace crates, which build serially anyway, so this costs them almost nothing.
# Applies to both build steps below (wasm bundle + server binary).
ENV CARGO_BUILD_JOBS=1
# jobs=1 serializes CRATES, but within one crate rustc still runs up to
# codegen-units (default 16) parallel LLVM codegen threads — and a single big
# crate's codegen has now OOM-killed a deploy the same way (wickedways-studio,
# grown by the P3 batch, died mid-compile with no rustc error while a retry on a
# quieter host succeeded). Capping codegen-units bounds that within-crate
# parallelism to two LLVM threads; slightly slower codegen, marginally better
# optimization, and a build whose peak memory no longer scales with crate size × 16.
ENV CARGO_PROFILE_RELEASE_CODEGEN_UNITS=2

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
# `include_str!("../../../conformance/fixtures/*.json")`, and the studio bundles its
# templates via `include_str!("../../../../campaigns/*.toml")`, so both directories must be
# present at compile time (not just in the runtime stage's genesis seed below).
COPY conformance/fixtures ./conformance/fixtures
COPY campaigns ./campaigns

# Bundle the Dioxus web client (cargo → wasm32 → wasm-bindgen --target web → /app/dist),
# then build the room server that serves it. `--locked` pins the committed Cargo.lock.
#
# The cache mounts persist the cargo registry/git + the `target/` dir ACROSS builds (BuildKit), so a
# rebuild only recompiles the workspace crates that changed instead of the whole dependency tree.
# `sharing=locked` on `target` serializes the two build steps (they share one cache). Because a cache
# mount is NOT part of the image layer, the server binary is copied OUT of `target/` to a real path in
# the same step so the runtime stage can `COPY --from` it. `/app/dist` is already a real path.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/app/target,sharing=locked \
    crates/wickedways-web/build-web.sh /app/dist
# Campaign Studio (the authoring app): same cargo→wasm32→wasm-bindgen path, served
# by the same binary under /studio. Shares the cached target/ with the client build
# above, so the overlapping dependency tree (dioxus, web-sys, the engine crates)
# compiles once.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/app/target,sharing=locked \
    crates/wickedways-studio/build-studio.sh /app/studio-dist
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/app/target,sharing=locked \
    cargo build -p wickedways-server --release --locked \
 && cp target/release/wickedways-server /usr/local/bin/wickedways-server

# ---- runtime: slim glibc base ----
FROM debian:bookworm-slim AS runtime
WORKDIR /app
# curl is here for the HEALTHCHECK below (and any platform probe like Coolify's, which runs
# `curl`/`wget` *inside* the container) hitting the server's GET /healthz — the slim base ships
# neither, so without this the probe can't execute and the container is reported unhealthy despite
# a working app.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# The server binary was cp'd out of the cache-mounted `target/` to `/usr/local/bin` in the builder.
COPY --from=builder /usr/local/bin/wickedways-server /usr/local/bin/wickedways-server
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/studio-dist ./studio
# Seed the ephemeral multiplayer demo campaign (the client's default `?campaign=demo`).
# Single-player campaigns are bundled in the client and need no server-side genesis.
COPY conformance/fixtures/sync-move.genesis.json ./genesis/demo.json
# The Covenant — the co-op multiplayer campaign (`?campaign=covenant`). Ships its own catalog beside
# the genesis so the server resolves its `twin-wards-held` victory (a scripted behavior); the server's
# `catalog_for` picks up `<id>.catalog.json` automatically.
COPY conformance/fixtures/covenant.genesis.json ./genesis/covenant.json
COPY conformance/fixtures/covenant.catalog.json ./genesis/covenant.catalog.json
# The Dare at Solomon's Rest — the teens-versus-the-GM's-Sexton multiplayer campaign
# (`?campaign=solomons-rest`). Its catalog carries the authored behaviors the server resolves
# ([mapGen] at begin, the lone-prey compact, the night clock, the Sexton's cards).
COPY conformance/fixtures/solomons-rest.genesis.json ./genesis/solomons-rest.json
COPY conformance/fixtures/solomons-rest.catalog.json ./genesis/solomons-rest.catalog.json
# Campaign art: the `image` paths authored in campaigns/*.toml resolve under
# `/assets` (the ASSETS_DIR route). Ships even when empty (README only).
COPY campaigns/assets ./assets

# PORT is injected by the platform (Coolify); the rest wire the one-binary topology.
# No DB_PATH → the store is ephemeral (a clean slate per deploy).
ENV PORT=8080 \
    WEB_DIR=/app/dist \
    STUDIO_DIR=/app/studio \
    GENESIS_DIR=/app/genesis \
    ASSETS_DIR=/app/assets \
    GM_IDENTITY=gm
EXPOSE 8080

# Container-native liveness probe: hit the server's GET /healthz (200 "ok" while it's serving). Shell
# form so ${PORT} expands at runtime from the env above — or whatever the platform injects — rather
# than being frozen at build time. start-period covers the (near-instant) boot before the first probe.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -fsS "http://localhost:${PORT}/healthz" || exit 1

CMD ["wickedways-server"]
