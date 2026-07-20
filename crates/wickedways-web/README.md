# wickedways-web

The Dioxus **web** client (Phase 2c, sub-project D). See the design
([`docs/superpowers/specs/2026-07-14-rust-phase-2c-d-dioxus-web-client-design.md`](../../docs/superpowers/specs/2026-07-14-rust-phase-2c-d-dioxus-web-client-design.md))
and plan ([`docs/superpowers/plans/2026-07-19-rust-phase-2c-d-dioxus-web-client.md`](../../docs/superpowers/plans/2026-07-19-rust-phase-2c-d-dioxus-web-client.md)).

## Status: slice 1 — the multiplayer transport + shell

The client now drives the **real multiplayer loop** end-to-end against the C axum server:

- **`mirror`** — the warm local mirror (log/head/snapshot + gap-buffer), the browser-free heart of the
  transport, ported from `websocket-transport.ts` and unit-tested on the host.
- **`transport`** — the `web-sys` `WebSocket` transport wrapping the mirror: handshake (getSnapshot →
  seed → join → awaitHead), an async `submit_async`, and the synchronous `SyncTransport` reads a
  `SyncCoordinator` uses. Reconciles B's sync trait with an async socket — only submit is async.
- **`src/main.rs`** — a bare Dioxus shell: on mount it connects, seeds a `SyncCoordinator`, and lets
  the GM submit `nextPlayer`, showing the head advance. Reuses the slice-0 CRT CSS (the full surface is
  slice 2). Configured from `?ws=&campaign=&token=`.

Verified end-to-end in a real browser against a live `wickedways-server` (see `e2e/`): the wasm app
connects, seeds the replica from the genesis (2 characters), and a GM `nextPlayer` commits to `seq 1`
with the local head advancing to 1.

Slice 0 (the CSS-carryover spike) proved: Dioxus compiles to `wasm32` (and host, so it is a safe
workspace member); the campaign CRT theming carries from Lit to RSX via CSS custom properties; and
`wickedways-core` links directly and runs on wasm (no wasm-pack/JS boundary for the engine).

## Browser e2e

`e2e/run.sh` bundles the client, starts an ephemeral `wickedways-server` on the `demo` genesis, serves
the bundle, and drives it in a browser (`e2e/multiplayer-loop.mjs`) — asserting the loop. Requires the
bundler (below), `python3`, and `node` + `playwright`. Not wired into CI (it needs a browser + server
orchestration the current jobs don't set up); slice 5 re-points the repo's Playwright harness here.

## Build

```bash
cargo build -p wickedways-web --target wasm32-unknown-unknown
```

## Bundling (settled)

`build-web.sh` produces the bundle: `cargo → wasm32 → wasm-bindgen (--target web) → dist/`, a static
directory (`wickedways-web.js` + `wickedways-web_bg.wasm` + `index.html`) that the **C axum binary** (or
any static server) serves same-origin alongside `/ws` — the fullstack one-port target. No `dx`/`trunk`;
the only extra tool is `wasm-bindgen`, pinned to the version `Cargo.lock` resolves:

```bash
cargo install wasm-bindgen-cli --version <the version in Cargo.lock>   # once
crates/wickedways-web/build-web.sh                                     # → crates/wickedways-web/dist/
```

Verified end-to-end: the bundle loads and the Dioxus app renders + is interactive in headless Chromium.
`dist/` is gitignored (build output). `index.html` is the mount host page.
