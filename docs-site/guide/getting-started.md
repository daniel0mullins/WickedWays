# Getting Started

This guide takes you from a fresh checkout to a running game. The engine and
the shipped web client are Rust; you need a [Rust toolchain](https://rustup.rs)
(the exact version is pinned by `rust-toolchain.toml`, rustup picks it up
automatically).

```bash
git clone https://github.com/daniel0mullins/WickedWays.git
cd WickedWays
```

## Run the test suite

The whole workspace — engine, author/assembler golden gates, sync gate, server,
and web-client host tests:

```bash
cargo test --workspace
```

## Run the web client

The Dioxus dev server gives you the game in a browser with auto-rebuild on
save:

```bash
cargo install dioxus-cli --version 0.6.3   # must match dioxus in Cargo.lock
cd crates/wickedways-web
dx serve
```

Then open the printed URL (default `http://127.0.0.1:8080`). The client bundles
its single-player campaigns; pick one from the launcher and play in the CRT
(text) or point-and-click surface.

## Run the full stack (multiplayer)

The room server serves the static bundle and the `/ws` multiplayer endpoint on
one port. The root `Dockerfile` builds exactly that:

```bash
docker build -t wickedways .
docker run --rm -p 8080:8080 wickedways
```

## Author a campaign

Campaigns are TOML files compiled by `wickedways-author` and assembled into a
genesis snapshot by `wickedways-assemble`. Start from the shipped campaign at
`campaigns/hollow-house.toml` and the [Architecture](./architecture)
page's author-format sections; the golden gates
(`cargo test -p wickedways-author --test gate`) validate a campaign compiles to
a stable description + catalog.
