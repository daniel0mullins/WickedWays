# Rust Phase 2c — Sub-project D: the Dioxus web client (design)

**Date:** 2026-07-14
**Status:** design
**Program:** [`2026-07-14-rust-phase-2c-multiplayer-dioxus-program-design.md`](./2026-07-14-rust-phase-2c-multiplayer-dioxus-program-design.md) (sub-project **D**)
**Depends on:** B (the `SyncCoordinator`/`Replica`) and C (the axum server + `/ws`).
**Ports/replaces:** `packages/client/src/{websocket-transport,main}.ts` (multiplayer wiring);
`packages/play-surface/src/{crt,pnc,shared}` (~2500 LOC of **Lit** surfaces); `packages/play-runtime/src/*`
(launcher / session / viewmodel / savestore / audio / surface glue).
**Fullstack target:** [`2026-07-10-pr-preview-deployments-design.md`](./2026-07-10-pr-preview-deployments-design.md) (the axum binary serves this app + `/ws` on one port).

## Goal

Build the **Dioxus web** client: the player-facing app that renders a campaign and drives it, over both
the multiplayer transport (WebSocket → `SyncCoordinator`) and the single-player path. It reproduces the
two existing surfaces (the CRT terminal + point-and-click) at parity, retiring the Lit surfaces, and
carries the runtime glue (launcher, save, audio, themes). **Web-first; native desktop deferred** (the
program's scoping decision). The axum binary from C serves this app's bundled WASM + assets and the
`/ws` endpoint on one port, which also unblocks PR-preview deployments.

## Two halves

D is (1) the **multiplayer wiring** and (2) the **surface + runtime** re-render. They meet at a single
seam: a surface renders a `ViewModel` and emits `Intent`/`Command`s; whether those flow through an
in-process authority or a WebSocket is a transport detail.

### 1. Multiplayer wiring — port `websocket-transport.ts`

Reproduce `WebSocketTransport` as a Rust `SyncTransport` (B's trait) over a browser WebSocket
(`web-sys`), preserving its **warm-local-mirror** design so every synchronous read is served locally
and only `submit` awaits the server verdict:

- **Handshake** (`connect`): open → `getSnapshot` → seed head/snapshot → `join(fromSeq)` →
  `awaitHead(joined.head)`; a `denied` during handshake surfaces as an auth error.
- **Mirror**: `#log` + `#head` + `#snapshot`, fed by `entry`/`committed`; **gap-buffering**
  (`#buffer`, hold out-of-order seqs until the run is contiguous), `head`-waiters.
- **submit**: one in-flight `#pendingSubmit`; `committed` applies our own delta to the mirror then
  resolves `{ok, seq, delta}`; a `denied` resolves terminally.
- **Reconnect**: on socket close (not a deliberate `close()`), reopen → `join(head)` → resolve any lost
  in-flight submit as `"connection lost; resubmit"`; a revoked token stops the loop instead of busy-
  retrying.
- The `onPresence`/`onChat`/`onCall` callbacks route the non-game arms to the presence/chat/call UI
  (chat/call handling itself is **E**).

The Dioxus app drives a **`SyncCoordinator`** (B) over this transport; the coordinator owns the local
`Replica` and projects `ViewModel`s for the surface. Port `main.ts`'s wiring (coordinator.join +
transport.connect + presence) into idiomatic Dioxus state/hooks rather than imperative DOM.

### 2. Surface + runtime — reproduce `play-surface` + `play-runtime`

Port the runtime glue and re-render the surfaces in Dioxus (RSX + CSS), keeping **DOM/CSS** so the
campaign-owned theming survives (the reason Dioxus was chosen over egui):

- **`PlaySurface` seam** (port `surface.ts`) — a surface renders a session's `ViewModel` and owns
  input→intent, the turn loop, rendering, and its control UI; the runtime owns session, view models,
  cues, audio, save, and themes. The Dioxus analogue is a component contract (props = session handle +
  manifest + themes + audio + `on_exit`/`on_theme_change`).
- **CRT terminal surface** (`play-surface/src/crt`) — housing/welcome/game/bezel/transcript/prompt/hud/
  status, the parser, narrator, and map. Re-render as Dioxus components; carry the CSS/theme.
- **Point-and-click surface** (`play-surface/src/pnc`) — scene/menu/topbar/log + affordances. Same.
- **Shared** — the narrator and the SVG map view.
- **Runtime glue** (`play-runtime`) — `launcher` (URL-driven boot: `?campaign=`/`?surface=`/`?theme=`,
  menu → surface picker → start), `savestore` (LocalStorage → `web-sys`/`gloo-storage`), `audio`
  subtree (engine/ambient/tension/cue-sound/pack), `manifest`, `viewmodel`, `catalog`. How much of the
  audio subtree is ported vs. rebuilt is a slice-level call; the CRT/PnC **visual parity bar** is the
  acceptance constraint.

## Key design decision: unify single-player and multiplayer on the transport seam

Today the two paths differ structurally: single-player drives a `GameSession` over the WASM engine
`Authority` directly (`play-runtime/session.ts`), while multiplayer drives a `SyncCoordinator` over the
WebSocket. The master design points at unification — *"single-player is the authority role with an
`InProcessTransport`-equivalent wrapper; `GameSession` delegates to a local `Authority`."*

**Decision for D: unify on the `SyncTransport` seam.** Both modes drive a `SyncCoordinator`; they differ
only in the transport injected — `InProcessTransport` (wrapping a local `SyncAuthority`, single-player,
offline, LocalStorage saves) vs. `WebSocketTransport` (multiplayer). The surface and runtime become
transport-agnostic; single-player is just "multiplayer with one seat and an in-process authority." This
collapses two code paths into one and is the cleanest carry of the master design. (If a slice needs to
ship single-player first, the in-process path can land before the WebSocket one — same seam.)

## New-technology risks (call out for planning)

- **Dioxus + WASM engine init** — one-time async load of the `wickedways-core` WASM (`Replica`/
  `Authority`) before first render; the app boots behind that.
- **`web-sys` WebSocket** — the transport's event model (open/message/close/error) mapped to Rust; the
  warm-mirror + reconnect logic is the same, only the socket binding is new.
- **CSS/theme carryover** — the campaign theming is DOM/CSS; validate it survives the Lit→Dioxus RSX
  port (this is exactly what the throwaway **Dioxus spike** in the program design de-risks — one CRT
  screen, before D is built).
- **WebRTC** lives in **E**, not D, but shares the `web-sys` browser-binding risk.

## The oracle / gate

D has **no differential oracle** — it is UI. Correctness is:

1. **Visual + behavioral parity** vs. the Lit surfaces — the CRT and PnC surfaces render the same
   `ViewModel` to equivalent output; the turn loop, parser, narrator, and map behave identically.
2. **E2E** — the existing Playwright harness (`packages/play` `test:e2e`) re-pointed at the Dioxus app:
   boot a campaign, play through a scripted transcript, assert the rendered state — single-player (in-
   process) and multiplayer (two clients converging through the axum server).
3. **Same-origin fullstack smoke** — the app served by the axum binary opens `wss://<host>/ws`
   same-origin and reaches a live campaign (the PR-preview readiness check).

## Constraints held

- **Web-first** — native desktop packaging deferred; Dioxus keeps that door open but it is out of scope.
- **Campaign-owned theming preserved** — DOM/CSS carryover is a hard requirement (the surface CSS is
  authored per campaign).
- **Replica never resolves** — the client applies authoritative deltas only; no optimistic mutation
  (inherited from B's `SyncCoordinator`).
- **One binary, one port, same-origin WS** — the fullstack deployment shape from the PR-preview design.

## Sequencing

D follows C (needs `/ws`) and B (needs `SyncCoordinator`). Recommended slices: (1) the WASM init +
`WebSocketTransport` + a minimal Dioxus shell driving a `SyncCoordinator` (prove the multiplayer loop
end-to-end with a bare view); (2) the CRT surface at parity; (3) the PnC surface at parity; (4) the
launcher/save/audio/theme glue + the in-process single-player unification; (5) the Playwright e2e
re-point. The **Dioxus spike** (program design) should run before slice 1 to validate CSS carryover.

## Next step

Run the throwaway Dioxus spike (CSS carryover + WASM link) first; then plan D slice 1 (WASM init +
`WebSocketTransport` + Dioxus shell) once C's `/ws` exists. E's chat/AV UI mounts into this shell.
