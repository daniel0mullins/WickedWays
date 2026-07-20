# wickedways-web

The Dioxus **web** client (Phase 2c, sub-project D). See the design
([`docs/superpowers/specs/2026-07-14-rust-phase-2c-d-dioxus-web-client-design.md`](../../docs/superpowers/specs/2026-07-14-rust-phase-2c-d-dioxus-web-client-design.md))
and plan ([`docs/superpowers/plans/2026-07-19-rust-phase-2c-d-dioxus-web-client.md`](../../docs/superpowers/plans/2026-07-19-rust-phase-2c-d-dioxus-web-client.md)).

## Status: slice 3 (in progress) — the point-and-click surface

The point-and-click surface begins with its pure logic layer, the analog of the CRT `parser`:
**[`affordances`](src/affordances.rs)** (a 1:1 port of `pnc/affordances.ts`, unit-tested on the host)
derives what the player can click in a scene and which verbs each thing offers, straight from the
engine `ViewModel` — no framework, no DOM:

- `scene_hotspots(vm)` → the clickable elements in scene order (exits, locked doors, occupants, loot
  containers, floor items), each with its `ActionDescriptor` verbs. Verbs are capability-gated so the
  menu never offers a move the engine would reject: a defeated occupant loses Attack, only a
  `talkable` NPC gets Talk, only a *closed* container's contents stay hidden (opening it turns them
  into takeable floor items).
- `inventory_actions(item, equipped)` → an inventory item's verbs (Examine, Read if it has lore,
  Equip/Unequip by state, Use if usable, Drop unless it's a required quest item).

The PnC UI components (scene / action-menu / topbar / inventory / log) and their controller — which
turn these descriptors into DOM and drive the turn loop — are the remaining slice-3 work; they reuse
the already-ported [`narrator`](src/narrator.rs) and [`map`](src/map.rs).

## Slice 2 — the CRT game view + command parser + narrator + map

The client renders the **real engine `ViewModel`** the core projects from the replica — the room,
its exits and locked doors, the occupants (with health / defeated), the player's inventory, and the
turn/health/sanity HUD. `World::view()` is called on the `SyncCoordinator`'s replica after every
commit, so the terminal shows exactly what the authority sees; a GM `nextPlayer` flips the active
character and the whole view re-projects (occupant list, HUD) from the new perspective. Verified in a
real browser against a live server (see `e2e/`).

The **prompt** takes typed commands through the ported [`parser`](src/parser.rs) (a 1:1 port of
`crt/parser.ts`, unit-tested on the host): a line becomes an `Intent`, which the shell resolves into a
sync `Command` — a `move`'s compass direction becomes the destination room id via the replica's exit
graph — and submits; informational queries (`look`/`exits`/`inventory`/`help`) render locally against
the current view, and unresolved/denied input narrates back.

The **[`narrator`](src/narrator.rs)** (a 1:1 port of `shared/narrator.ts`, unit-tested on the host)
turns room entry, queries, examine, and resolved intents into prose: room header/description/occupant
lines, `look`/`inventory`/`exits`/`help` text, an examine blurb, and — synthesized from the before/after
`ViewModel` an intent produced, since the multiplayer sync layer doesn't carry `PresentationCue`s over
the wire (mirrors the TS transport, which doesn't either) — action confirmations like "You take the
…"/"You hit the … for N Health." `render_cues`/`render_mob_attacks` are ported and tested against the
engine's `PresentationCue`/`MobAttack` types for when a cue-carrying path (single-player's future
`World::submit`, or a widened wire protocol) feeds them real data.

The **[`map`](src/map.rs)** module ports `map-model.ts`'s `MapModel` (fog-of-war rooms/edges/stubs,
built incrementally from `observe`/`record_move`) and `map-view.ts`'s pure grid layout, plus a Dioxus
RSX SVG renderer styled via the `.map-*` CSS classes carried over from `crt-game.ts`. The `map` command
opens an overlay (mirroring `openMap`/`openHelp`); `help` opens the same overlay with the command list.
Dismissal is click-to-close (the Lit surface's "any key closes" isn't replicated — no global keydown
listener is wired up yet).

## Slice 1 — the multiplayer transport + shell

The client drives the **real multiplayer loop** end-to-end against the C axum server:

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
