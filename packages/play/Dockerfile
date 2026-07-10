# Multi-stage image for the @wickedways/play browser SPA.
#
# The build context MUST be the repo root (in Coolify: Base Directory = "/",
# Dockerfile Location = "/packages/play/Dockerfile"). The SPA runs the engine as
# WebAssembly compiled from the Rust core, and `packages/play-runtime`'s browser
# entrypoint imports `crates/wickedways-wasm/pkg-web` by path. That directory is
# a build artifact and is never committed, so the image compiles it itself in
# the `wasm` stage before the bundler runs.

# ---- wasm stage: compile the Rust core to WebAssembly ----
FROM rust:1-slim-bookworm AS wasm
WORKDIR /app

# wasm-pack publishes statically-linked musl binaries for both linux arches, so
# the release tarball beats `cargo install wasm-pack` (minutes of compilation).
# `uname -m` already spells the arch the way the asset names do.
ARG WASM_PACK_VERSION=0.15.0
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL "https://github.com/rustwasm/wasm-pack/releases/download/v${WASM_PACK_VERSION}/wasm-pack-v${WASM_PACK_VERSION}-$(uname -m)-unknown-linux-musl.tar.gz" \
    | tar -xz --strip-components=1 -C /usr/local/bin --wildcards '*/wasm-pack' \
 && wasm-pack --version
RUN rustup target add wasm32-unknown-unknown

# Only the Rust sources, so a TypeScript-only change never invalidates this
# (slow) stage.
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
# Mirrors the root `wasm:build:web` script; `--locked` pins to the committed
# Cargo.lock so the image can't silently resolve different crate versions.
RUN wasm-pack build crates/wickedways-wasm --target bundler --out-dir pkg-web -- --locked

# ---- build stage ----
FROM node:22-alpine AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@9.15.6 --activate
WORKDIR /app

# Install against the full workspace, then build only the play package. The SPA
# bundles the `wickedways` engine's TypeScript types straight from source
# through the pnpm workspace, so the whole workspace must be present.
COPY . .
COPY --from=wasm /app/crates/wickedways-wasm/pkg-web ./crates/wickedways-wasm/pkg-web
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @wickedways/play build

# ---- serve stage ----
FROM nginx:alpine AS serve
COPY packages/play/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/packages/play/dist /usr/share/nginx/html

# Pre-compress at max level so `gzip_static` can serve the .gz sibling with no
# per-request CPU. Vite's assets are content-hashed and immutable, so this is
# pure win. Fonts are excluded: woff2/woff are already internally compressed.
RUN find /usr/share/nginx/html -type f \
      \( -name '*.js' -o -name '*.css' -o -name '*.wasm' \
         -o -name '*.html' -o -name '*.svg' -o -name '*.json' \) \
      -exec sh -c 'gzip -9 -c "$1" > "$1.gz"' _ {} \;

EXPOSE 80
# nginx:alpine's default CMD already runs `nginx -g 'daemon off;'`.
