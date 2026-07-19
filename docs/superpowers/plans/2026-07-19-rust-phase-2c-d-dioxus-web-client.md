# Rust Phase 2c — Sub-project D: the Dioxus web client — Plan

**Date:** 2026-07-19
**Design:** [`docs/superpowers/specs/2026-07-14-rust-phase-2c-d-dioxus-web-client-design.md`](../specs/2026-07-14-rust-phase-2c-d-dioxus-web-client-design.md)
**Prereqs (all merged):** B (`SyncCoordinator`/`Replica`/`SyncTransport`) and C (the axum server + `/ws`,
`crates/wickedways-server`). Both are on `main`.

## Goal

Build the **Dioxus web** client: the player-facing app that renders a campaign and drives it over both
the multiplayer transport (WebSocket → `SyncCoordinator`) and the single-player path, reproducing the
CRT terminal + point-and-click surfaces at parity and retiring the Lit surfaces. Web-first; native
desktop deferred. The axum binary from C serves the bundled WASM + assets and `/ws` on one port.

D has **no differential oracle** — it is UI. Correctness = visual/behavioral parity vs. the Lit
surfaces + a Playwright e2e (single-player in-process and two-client multiplayer through the axum
server) + a same-origin fullstack smoke.

## Toolchain de-risk (done — the one environment risk retired up front)

Verified in this environment before planning slices:

- `wasm32-unknown-unknown` target is installed.
- A minimal `dioxus = { version = "0.6", features = ["web"] }` app **compiles to wasm32** (~53s cold),
  pulling `dioxus-web` 0.6.3, `web-sys`, `wasm-bindgen-futures`, `serde-wasm-bindgen` — everything the
  WebSocket transport (`web-sys`) and engine JSON seam need. So **Dioxus 0.6 is the pin** (0.8 is
  alpha-only; 0.6.3 is the current stable).

**Engine linkage decision:** the Dioxus app is itself a Rust→wasm crate, so it depends on
`wickedways-core` **directly** (rlib) and uses `SyncAuthority`/`SyncCoordinator`/`Replica`/`Delta` as
native Rust — **no wasm-pack/JS boundary for the engine**. This is simpler than the TS client (which
crosses a JS↔wasm seam) and removes a whole class of interop. The existing `crates/wickedways-wasm`
(cdylib for the JS engine) is untouched and stays for the legacy TS surfaces until F.

**Open toolchain question for slice 1:** the final bundle (wasm + JS glue + `index.html` + assets).
Options: the `dx` CLI (dioxus-cli, the native path) vs. `wasm-bindgen` + a static `index.html` served
by the C axum binary. Lean toward serving from the axum binary (the fullstack one-port target); decide
the exact build step in slice 1. CI cannot gain a `.github/workflows` step from an OAuth push (hit
repeatedly this phase) — so D's build/test must ride an existing job or the user adds the CI line.

## New crate(s)

`crates/wickedways-web` — the Dioxus app (`crate-type` bin for `dx`, or a wasm bin). Depends on
`wickedways-core` (features = `["std"]` won't apply on wasm; use the default `alloc`/`std`-as-available
config the wasm engine already uses), `dioxus`/`dioxus-web`, `web-sys`, `wasm-bindgen`,
`wasm-bindgen-futures`, `serde`/`serde_json`. The **wire types** currently in
`crates/wickedways-server/src/transport.rs` get extracted to a shared `crates/wickedways-transport`
crate (server + web both depend on it) — the extraction the C plan deferred to "when D needs them." D
needs them now.

## Slices

### Slice 0 — the CSS-carryover spike (throwaway, program-mandated)
Reproduce **one CRT screen** (e.g. the prompt + transcript shell) in Dioxus RSX carrying the existing
campaign CSS, served locally, to validate the Lit→RSX DOM/CSS port keeps campaign-owned theming. This
is the program design's de-risk gate before real D work. Throwaway — its only output is a go/no-go on
CSS carryover and the bundling step. (Folds together with the crate skeleton + `dx`-vs-wasm-bindgen
decision.)

### Slice 1 — `wickedways-transport` extract + `WebSocketTransport` + a bare Dioxus shell
- Extract the wire types (`ClientMsg`/`ServerMsg`/`WireLogEntry`/`Actor`/presence/roster) from
  `wickedways-server` into `crates/wickedways-transport`; repoint the server at it (no behaviour
  change; the server's `transport` byte-shape tests move with it).
- Port `websocket-transport.ts` as a Rust `SyncTransport` over a `web-sys` WebSocket, preserving the
  **warm-local-mirror** design: handshake (`getSnapshot` → seed → `join(fromSeq)` → `awaitHead`), the
  `#log`/`#head`/`#snapshot` mirror fed by `entry`/`committed` with gap-buffering + head-waiters, a
  single in-flight `submit`, and reconnect (`join(head)`, resolve lost in-flight as "resubmit", stop on
  a revoked token). `onPresence`/`onChat`/`onCall` route to callbacks (chat/call handling is E).
- A **bare Dioxus shell** drives a `SyncCoordinator` over this transport and renders a minimal view
  (head + a submit button), proving the multiplayer loop end-to-end against the C server. This is D's
  "does the whole thing light up" slice.

### Slice 2 — the CRT terminal surface at parity
Port `play-surface/src/crt` (housing/welcome/game/bezel/transcript/prompt/hud/status + parser +
narrator + map) to Dioxus components, carrying the CSS/theme. Parity vs. the Lit CRT is the bar.

### Slice 3 — the point-and-click surface at parity
Port `play-surface/src/pnc` (scene/menu/topbar/log + affordances) + the shared narrator/SVG map. Same
parity bar.

### Slice 4 — runtime glue + single-player unification
- Port `play-runtime` — `launcher` (URL-driven boot: `?campaign=`/`?surface=`/`?theme=`), `savestore`
  (LocalStorage via `web-sys`/`gloo-storage`), the audio subtree (how much ported vs. rebuilt is a
  slice call), `manifest`/`viewmodel`/`catalog`.
- **Unify single-player on the transport seam:** both modes drive a `SyncCoordinator`; single-player
  injects an `InProcessTransport` wrapping a local `SyncAuthority` (offline, LocalStorage saves),
  multiplayer injects `WebSocketTransport`. Surface + runtime become transport-agnostic — "single-player
  is multiplayer with one seat and an in-process authority" (the master-design carry).

### Slice 5 — Playwright e2e re-point + same-origin fullstack
- Re-point the `packages/play` `test:e2e` harness at the Dioxus app: boot a campaign, play a scripted
  transcript, assert rendered state — single-player (in-process) and multiplayer (two clients
  converging through the axum server).
- **Same-origin smoke:** the app served by the C axum binary opens `wss://<host>/ws` same-origin and
  reaches a live campaign — the PR-preview readiness check.

## Finalize

- README: add a "Rust web client" note under Multi-client sync; point the fullstack section at the
  one-binary (axum serves the app + `/ws`).
- `cargo build -p wickedways-web --target wasm32-unknown-unknown`, `cargo clippy`, the e2e, `pnpm checks`
  unaffected (D is additive Rust + a new crate).
- Flag the CI step for D's wasm build (OAuth push can't touch workflows).

## Notes / gotchas

- **Replica never resolves optimistically** — the client applies authoritative deltas only (inherited
  from B's `SyncCoordinator`). No optimistic mutation in the surface.
- **CSS/theme carryover is a hard requirement** — validated by the slice-0 spike before real work.
- **`web-sys` WebSocket event model** (open/message/close/error) mapped to Rust; the warm-mirror +
  reconnect logic is a faithful port of `websocket-transport.ts`, only the socket binding is new.
- **Async `SyncTransport`** — B's trait is synchronous (in-process). The WebSocket transport is
  genuinely async; the same decision C's plan flagged. For the browser, `submit` returns a future and
  the coordinator awaits it; the in-process single-player path keeps the synchronous trait. Reconcile
  the trait shape in slice 1 (likely: an async `submit`, sync local reads).
- **Chat/AV UI is E** — leave mount points in the shell; `onChat`/`onCall` callbacks exist but route
  nowhere until E.
- **F (retire TypeScript)** deletes the Lit surfaces + `packages/*` only once D reaches parity and the
  Playwright e2e passes against Dioxus — never inside D.

## Next

Run slice 0 (the CSS-carryover spike + crate skeleton + bundling decision). Then slice 1 (transport
extract + `WebSocketTransport` + the bare shell), which is where the multiplayer loop first lights up
end-to-end against the C server.
