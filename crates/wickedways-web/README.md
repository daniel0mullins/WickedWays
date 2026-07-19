# wickedways-web

The Dioxus **web** client (Phase 2c, sub-project D). See the design
([`docs/superpowers/specs/2026-07-14-rust-phase-2c-d-dioxus-web-client-design.md`](../../docs/superpowers/specs/2026-07-14-rust-phase-2c-d-dioxus-web-client-design.md))
and plan ([`docs/superpowers/plans/2026-07-19-rust-phase-2c-d-dioxus-web-client.md`](../../docs/superpowers/plans/2026-07-19-rust-phase-2c-d-dioxus-web-client.md)).

## Status: slice 0 — the CSS-carryover spike + skeleton

This crate currently holds the program-mandated **spike**: a small CRT screen proving the three
things D's toolchain hinges on, before any real surface work.

- **Dioxus compiles to `wasm32-unknown-unknown`** here (and to the host target, so it is a safe
  workspace member).
- **Campaign CRT theming carries from Lit to RSX.** The housing/monitor/screen/scanline CSS from
  `packages/play-surface/src/crt` (`assets/crt.css`) rides on CSS custom properties set on the root;
  swapping the theme reskins the whole terminal with no framework-specific machinery. Validated by
  rendering the equivalent DOM in headless Chromium (Phosphor + Amber presets).
- **`wickedways-core` links directly and runs on wasm** — the "GM: nextPlayer" button builds a real
  `sync::Command` and serializes it with `serde_json`, all native Rust in the browser (no wasm-pack/JS
  boundary for the engine).

`src/main.rs` is a throwaway spike; slice 2 renders the CRT surface for real.

## Build

```bash
cargo build -p wickedways-web --target wasm32-unknown-unknown
```

## Bundling (decided in slice 1)

The final bundle (wasm + JS glue + `index.html` + assets) needs a wasm-bindgen step. This environment
has **`wasm-pack`** but no `dx` (dioxus-cli) or standalone `wasm-bindgen` CLI. The plan's direction is
to serve the bundle from the **C axum binary** on one port (same-origin `wss://…/ws`, the fullstack
target). Two concrete paths, to pick in slice 1:

1. `cargo install wasm-bindgen-cli` pinned to the exact `wasm-bindgen` version Dioxus 0.6 uses, then a
   static build served by axum; or
2. restructure the entry as a `cdylib` with a `#[wasm_bindgen(start)]` and reuse **wasm-pack** (already
   in CI) to emit the JS/wasm, served by axum.

`index.html` is the mount host page for either path.
