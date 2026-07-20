# wickedways-web

The Dioxus **web** client (Phase 2c, sub-project D). See the design
([`docs/superpowers/specs/2026-07-14-rust-phase-2c-d-dioxus-web-client-design.md`](../../docs/superpowers/specs/2026-07-14-rust-phase-2c-d-dioxus-web-client-design.md))
and plan ([`docs/superpowers/plans/2026-07-19-rust-phase-2c-d-dioxus-web-client.md`](../../docs/superpowers/plans/2026-07-19-rust-phase-2c-d-dioxus-web-client.md)).

## Status: slice 4 (in progress) — runtime glue + single-player unification

Single-player runs on the transport seam that unifies it with multiplayer: **"single-player is
multiplayer with one seat and an in-process authority."** [`single_player`](src/single_player.rs)'s
`SinglePlayerTransport` wraps a local `SyncAuthority` and exposes the *same* seam the surfaces drive —
the synchronous `SyncTransport` reads the coordinator drains, plus an async `submit_async` matching
`WsTransport`'s signature. [`driver::AppTransport`](src/driver.rs) selects between them from
`?mode=` — `?mode=single` builds the offline authority from a bundled genesis (`Catalog::default()`,
exactly what the demo server uses), anything else opens a WebSocket — and both surfaces
(`crt_app`/`pnc_app`) drive it through one transport-agnostic loop (`AppTransport::connect` →
`SyncCoordinator::join` → `submit_async` → `sync`), so nothing above the transport knows the mode.

Verified offline in a real browser with **no server**: `?surface=pnc&mode=single` boots the local
authority, renders the scene from the bundled genesis, commits a GM `nextPlayer`, and opens an
occupant's action menu — all in-process. The transport itself is host-tested for offline commit +
replica convergence + denial.

**Save / restore / restart** (single-player) share one rebuild seam. `driver::rebuild_single(snapshot)`
builds a fresh offline transport + a joined coordinator from any authoritative snapshot — the local
analog of the room server's "reset the authority to a snapshot" — and boot, `restore`, and `restart`
all go through it. [`savestore`](src/savestore.rs) persists a `SaveBlob` (the `CampaignSnapshot` + the
fog-of-war `MapSnapshot`) to `localStorage` under a slot key. The CRT `save`/`restore`/`restart` verbs
are wired: `save` serializes the coordinator snapshot + map; `restore` rebuilds from the saved snapshot
and hydrates the saved map; `restart` rebuilds from the pristine bundled genesis and resets the map /
narrator / transcript. All three are gated to single-player (multiplayer state lives on the server).
Verified offline in a browser: save → move → `restore` reverts, and move → `restart` returns to the
start. The `SaveBlob` JSON format is host-tested.

Both surfaces expose the lifecycle verbs: the CRT via its `save`/`restore`/`restart` commands, the PnC
via a single-player-only **settings menu** (the ⚙ topbar button) whose Save/Restore/Restart route
through the same seam. Verified offline in a browser on both surfaces.

The launcher's **`?theme=`** picks a built-in palette per surface ([`theme`](src/theme.rs)): the CRT
gets `green` (default) / `amber` / `ice` via the `.backdrop` `--color-*` vars; the PnC gets its
parchment default / `green` / `ice` via `--pnc-*` overrides on `.pnc-app`. Pure string lookups
(host-tested), read once from the URL. Verified in a browser: `?theme=amber` recolors the CRT,
`?theme=green` recolors the PnC.

The launcher's **`?campaign=`** selects among bundled campaigns ([`driver::bundled_campaign`](src/driver.rs)):
`demo` (the pre-`started`, catalog-free Crypt), `caretaker` (an NPC/dialogue campaign), and
`facade-free-vs-advancing` — each a genesis snapshot + its authored catalog. `driver::boot` builds the
offline authority and auto-`BeginCampaign`s a non-`started` genesis (single-player is the sole GM),
returning the campaign catalog the surface then **projects with** (so authored items/NPCs/locked doors
resolve — `project(coord, &catalog)` now threads the session catalog through every projection;
multiplayer still projects with the default, since the server owns the real catalog). `restart` reboots
the same campaign; `restore` reuses its catalog with the saved snapshot. An unknown id falls back to the
default. Host-tested (each bundled campaign boots, begins, and projects) and verified in a browser:
`?mode=single&campaign=caretaker` boots the Foyer with its Caretaker NPC + cellar door,
`facade-free-vs-advancing` boots the Hall with its Lurker + chest.

The **audio subtree** begins with its pure mapping layer, the analog of the affordances/scene logic:
[`audio`](src/audio.rs) (a 1:1 port of `audio/cue-sound.ts`) turns an engine `PresentationCue` /
`MobAttack` into a backend-agnostic `SynthVoice` (waveform-or-noise + freq glide + gain envelope) —
attack/takeDamage/pickUp/drop/move/encounter/visibility/win/loss, plus a deterministic per-actor
pitch jitter (`detune_factor`, byte-faithful to the TS hash).

[`audio_engine`](src/audio_engine.rs) (a port of `audio/engine.ts`) is the **Web Audio renderer** that
turns a `SynthVoice` into sound: a lazily-created `AudioContext` (built on the first `resume`, a user
gesture), an oscillator (or a white-noise buffer) through a gain node with a linear-attack /
exponential-decay envelope, and `resume`/`suspend`/`close` lifecycle. Best-effort throughout (a failed
node call never crashes the game). The pure pseudo-noise fill is host-tested; the `web-sys` calls are
exercised by the wasm build.

The **runtime / director layer** ties the four layers together (`AudioDirector → SoundPack → SoundSpec
→ AudioBackend`). [`audio_pack`](src/audio_pack.rs) (ports `contracts.ts` + `default-pack.ts` +
`tension.ts`) holds the pure brains: an `AudioDirector` turns a `PresentationCue` into discrete
`AudioCue`s and reads continuous **tension** (0–1) off the `ViewModel` DTO, and a `SoundPack` maps an
`AudioCue` to a `SoundSpec` (or silence) and tension to an ambient directive. The shipped
`default_chiptune_pack` covers every base cue by reusing the `audio` voices (timbre unchanged); the
`sanity_director` normalizes sanity against a session high-water mark (calm at the top, tense as it
drains), the analog of hollow-house's director — `wickedways_campaign_audio()` wires it for the bundled
campaigns. All host-tested (every base cue voices; tension clamps and tracks its high-water mark).

[`ambient`](src/ambient.rs) (ports `ambient.ts`) is the **sanity-reactive drone**: two detuned sawtooth
oscillators through a fixed dark low-pass + gain. Dread is expressed purely as BEAT RATE — the partner
oscillator drifts further from the fundamental as tension rises, so the pulse quickens (slow calm throb
→ anxious throb) while loudness and timbre stay fixed. [`audio_runtime`](src/audio_runtime.rs) (ports
`audio-runtime.ts`) is the session-lived orchestrator that owns the engine + bed + active director/pack:
`set_enabled` resumes the engine and starts the bed on the same context, `play_cue` routes cue → director
→ pack → engine, `update(view)` drives the bed's tension, `reset` rebuilds the director on restart, and
`note_error`/`play_mob_attack` are the fixed voices. Its disabled-gating / soundpack-list / dispose paths
are host-tested; the `web-sys` glue is browser-verified.

**Both surfaces play sound** through the runtime. The CRT `audio` command (the Enter keypress is the user
gesture) and the PnC topbar 🔊 toggle (the button click is the gesture) each `set_enabled` the shared
`AudioRuntime`. While enabled, committed action intents voice through director → pack (the wire doesn't
carry cues, so `cue_for_intent` in [`audio`](src/audio.rs) reconstructs a `PresentationCue::Action` from
the intent: attack/move/take/drop), a denied command (or, on the CRT, an unparseable one) buzzes the
error voice, and every view change drives the ambient bed. Verified offline in a browser on **both**
surfaces: enabling opens one `AudioContext` and starts the drone (two oscillators through a biquad
low-pass), a committed move fires SFX and drives another tension ramp, and toggling off suspends without
recreating the context (re-enabling resumes it and restarts the bed) — all with no page error. Still to
come (deferred, architecture-only): sampled/scored audio (the `SoundSpec::Sample` arm) and a multi-pack
soundpack switcher (the runtime already carries the list; the surface shows it only at ≥ 2 packs).

## Status: slice 3 — the point-and-click surface

The client now has **two surfaces**, chosen by `?surface=` ([`driver::read_surface`](src/driver.rs)):
the CRT terminal (default) and the point-and-click surface ([`pnc::pnc_app`](src/pnc.rs)). Both drive
the same multiplayer loop through the shared [`driver`](src/driver.rs) (connect → project →
`intent_to_command` → submit → narrate → map), extracted from the CRT `main.rs` so the two can't drift.

The PnC surface's pure logic landed first, the analog of the CRT `parser`:

- **[`affordances`](src/affordances.rs)** — `scene_hotspots(vm)` derives the clickable elements in
  scene order (exits, locked doors, occupants, loot, floor items), each with capability-gated
  `ActionDescriptor` verbs (a defeated occupant loses Attack, only a `talkable` NPC gets Talk, a
  *closed* container's contents stay hidden until opened); `inventory_actions(item, equipped)` derives
  an item's verbs (Examine, Read if lore, Equip/Unequip, Use, Drop unless a required quest item).
- **[`scene_layout`](src/scene_layout.rs)** — `dir_position`/`body_position`/`partition_hotspots`: the
  perimeter-by-bearing + central-band placement the scene renders (the scene analog of `layout_map`).

The **[`pnc`](src/pnc.rs)** Dioxus surface wires these into DOM: a topbar (room name + map), the scene
(clickable hotspots + a contextual action menu — a lone move fires immediately, otherwise a verb menu
opens at the click point), a sidebar (status projected from the `ViewModel` · a tabbed inventory ·
the running log), a map overlay, and a welcome screen. A click becomes an `Intent`, resolves to a sync
`Command`, and commits over the same transport as the CRT; the narrator prints the outcome and the map
records moves. Verified in a real browser against a live server: the scene projects the room and its
occupant/exit hotspots, clicking an occupant opens `Examine`/`Attack`, and choosing a verb runs it.

Parity gaps carried to slice 4 (runtime glue): the audio / soundpack / theme controls and the
save-restore / undo / restart menu (they need the audio runtime + savestore), the campaign manifest
title/intro/themes (the launcher), and the richer campaign `StatusField` readout + per-entity
examine/read lore (they ride `PresentationCue`s the multiplayer wire doesn't carry yet — the CRT
surface has the same gap). The `pnc-scene`'s procedural room art is carried; the CSS reproduces the
Lit component sheets in light DOM.

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
