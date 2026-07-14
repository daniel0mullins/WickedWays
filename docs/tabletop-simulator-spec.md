# `@wickedways/tabletop` — Simulator Surface Spec (P1)

> Companion to [`tabletop-display-design.md`](./tabletop-display-design.md). That doc is the
> "why" and the concept survey; this is the "how" for the first buildable slice: a
> hardware-free, CI-testable **simulator surface** that proves cue/view → tiles and
> piece-drag → intent entirely in the browser.

## Context

We want to drive a physical e-ink tabletop from the engine. The design doc established that
a tabletop is *just another `PlaySurface`* — the browser play stack is a pull-model surface
contract with `Intent` in and `PresentationCue[]` + `ViewModel` out, and `MapModel` already
derives a 2D grid from the compass graph. P1 builds the surface + a swappable **transport**
whose first implementation is a browser tile grid, so all the bridge logic (view→tiles,
drag→intent, cue→effects) is provable before any firmware exists. The *same* surface later
drives real tiles by swapping the transport.

## Scope & assumptions (P1)

- **Single player.** `GameSession.start` boots exactly one `PlayerCharacter`
  (`packages/play-runtime/src/session.ts:74`). So P1 = **one draggable PC piece** plus
  **engine-driven mob pieces** (rendered, not dragged). Multi-piece / multi-seat play is a
  separate engine question (see design doc "Who is the GM") and is explicitly out of scope.
- **Reference campaign: Hollow House** (`packages/campaigns/src/hollow-house`) — it has dark
  rooms, a keyed door, a resident mob, and a **status-bar mechanic** (needed for the PC
  self-stats dashboard; see the status-cue note below).
- **No engine changes.** P1 rides the existing `PlaySurface` seam. The two engine gaps from
  the design doc (`placeLight` intent, dice-supply rng seam) are **not** P1 work.

## The seams we build on (verified signatures)

- **`PlaySurface`** (`packages/play-runtime/src/surface.ts:64`): `{ id, label, description?,
  defaultTheme, mount(args: MountArgs): SurfaceHandle }`. `MountArgs` gives `app: HTMLElement`,
  `session: GameSession`, `manifest`, `themes`, `audio`, `onExit()`, theme hooks. The surface
  owns input→intent, the turn loop, and rendering; the runtime owns the session/audio.
- **`GameSession`** (`packages/play-runtime/src/session.ts`) — the *only* engine handle, all
  pull:
  - `execute(intent): { cues: PresentationCue[]; mobAttacks?: MobAttack[]; error?: string }`
  - `view(): ViewModel` (overlays host-side room/occupant images)
  - `takeStartupCues(): PresentationCue[]` (boot/round-0 reveals)
  - `read(itemId)`, `examine(targetId)` — free, cue-producing
  - `save(slot, surface?: SurfaceState)`, `restore(slot): { ok, surface? }`, `undo()`,
    `restart()`, `finished`, `outcome`
- **`Intent`** (`packages/play-runtime/src/intent.ts`): kinds `move / take / drop / use /
  attack / wait / talk / equip / unequip / open`. Time-advancing = `move take drop use attack
  wait` (`isTimeAdvancing`). Observed shapes (from `pnc/affordances.ts`): `{kind:"move", dir}`,
  `{kind:"attack", targetId}`, `{kind:"talk", npcId}`, `{kind:"open", targetId}`,
  `{kind:"take"|"drop"|"equip"|"unequip"|"use", targetId}`.
- **`ViewModel`** (`packages/play-runtime/src/viewmodel.ts`): `room {id, name, description,
  isLit, image?}`, `occupants: ScopeEntity[]`, `scope: ScopeEntity[]`, `loot: LootView[]`,
  `inventory {items, keys, slots}`, `exits: ExitView[]` (`{dir, toName}` — **direction +
  destination *name* only, no dest id**), `lockedDoors: LockedDoorView[]` (`{dir, name}`),
  `status: StatusView {turn, maxTurns, …}`, `outcome`. `ScopeEntity`: `{id, name, aliases,
  kind, health?, image?, equippable?, usable?, hasLore?, droppable?, defeated?, talkable?}`.
- **`MapModel`** (`packages/play-runtime/src/map-model.ts`): `observe(view)`,
  `recordMove(fromId, dir, toId)`, `rooms()/edges()/stubsFor()`, `serialize()/hydrate()/
  reset()`, `currentId`, and the exported `DIRECTION_DELTA` (compass → `{dx,dy}`).
- **`layoutMap(model)`** (`packages/play-surface/src/shared/map-view.ts:15`): pure grid→pixel
  layout (`{width, height, boxes, links, stubs}`) — reused for tile placement.

## Reuse (do not re-implement)

- **`sceneHotspots(vm)` and `inventoryActions(item, equipped)`** from
  `packages/play-surface/src/pnc/affordances.ts` — these already turn a `ViewModel` into the
  exact set of legal actions + their `Intent`s (exits→move, occupant→attack/talk, loot→open,
  floor item→take, inventory→equip/use/drop). The simulator's per-tile action buttons come
  straight from these; **no new capability-gating logic**.
- **`MapModel` + `DIRECTION_DELTA` + `layoutMap`** for placement.
- **The controller turn-loop *order*** from `packages/play-surface/src/{crt,pnc}/controller.ts`:
  skim `status` cues into the HUD, hold `resolution` cues until *after* mob attacks, play
  cue audio via `audio.playCue`. We mirror this ordering.
- **`audio: AudioRuntime`** from `MountArgs` — call `playCue(cue)` / `playMobAttack(...)`;
  the whole procedural audio layer is free.

## Architecture

```
TabletopSurface (implements PlaySurface)
  ├─ owns the turn loop + MapModel + last-ViewModel
  ├─ TileMapper      ViewModel + MapModel → TileState[] (+ collision resolution)
  ├─ ViewDiffer      (before, after) ViewModel → DeviceCommand[] deltas
  ├─ IntentResolver  DeviceEvent (directional piece drag) → Intent | reject
  └─ DeviceTransport (the swappable boundary)
        ├─ SimulatorTransport   DOM tile grid + draggable PC piece  ← P1
        └─ Serial/WebSocketTransport   same protocol → firmware      ← P2/P3
```

The **transport** is the whole point: `TabletopSurface` never touches the DOM or a serial
port directly — it emits `DeviceCommand`s and consumes `DeviceEvent`s. P1 ships
`SimulatorTransport` (renders into `MountArgs.app`); hardware later swaps in a different
transport with zero surface-logic change.

### The protocol (`protocol.ts`)

```ts
// Surface → device
type DeviceCommand =
  | { kind: "tile";      tileId: string; roomId: string; label: string; image?: string; lit: boolean; concealed: boolean }
  | { kind: "tileLamp";  tileId: string; on: boolean }              // dark-room reveal
  | { kind: "led";       tileId: string; effect: "encounter" | "combat" | "reject" | "off" }
  | { kind: "piece";     pieceId: string; tileId: string | null; glow?: "normal" | "fear" | "panic" | "ko" }
  | { kind: "dashboard"; seat: string; fields: StatusField[]; turn: number; maxTurns: number }
  | { kind: "sound";     ref: string }                              // resolved cue audio
  | { kind: "resolution"; outcome: string };
// Device → surface
type DeviceEvent =
  | { kind: "pieceDrag";   pieceId: string; dir: Direction }        // directional drag off current tile
  | { kind: "tileAction";  entityId: string; action: Intent }       // action button on a tile/entity
  | { kind: "lantern";     tileId: string; placed: boolean };       // future: light prop
```

Design notes:
- **Input is *directional*, not tile-to-tile.** Exits are keyed by `Direction`, and
  `ExitView` has no destination id — the dest tile may not exist yet (unexplored stub). So a
  piece drag resolves to the nearest compass `Direction`; `IntentResolver` checks it against
  `vm.exits`/`vm.lockedDoors` and emits `{kind:"move", dir}`. The destination tile id is
  learned *after* execution from the new `view().room.id`.
- **`led "reject"`** is the physical "you can't do that" — fired when the engine returns
  `result.error` (e.g. locked door, dark-room targeting gate).

### `IntentResolver`

- `deltaToDirection(dx, dy): Direction | null` — invert `DIRECTION_DELTA` (unit steps only).
- On `pieceDrag{dir}`: reject unless `vm.exits.some(e => e.dir === dir)`. A `dir` that is only
  in `vm.lockedDoors` → still emit `{kind:"move", dir}` and let the **engine** reject
  (surfacing `led "reject"`), so lock logic stays authoritative in the core.
- `tileAction` carries a ready `Intent` (built by `sceneHotspots`), passed through as-is.

### `TileMapper` + collision resolution

- Placement comes from `MapModel` grid coords. **Known imperfection:** compass-delta placement
  can drop two rooms on one cell. `resolveCollisions(rooms: MapRoom[]): Map<roomId,{col,row}>`
  nudges a colliding room to the nearest free cell, deterministic by discovery order, keeping
  traversed-edge adjacency best-effort. Log any nudge (no silent overlap).
- Per tile, `TileMapper` emits a `tile` command with `lit = vm.room.isLit` and
  `concealed = room.dark && !isLit`. A concealed tile hides label/occupants (mirror the
  Narrator's dark short-circuit) until a `visibility {lit:true}` flips it.

### `ViewDiffer`

Terse cues mean meaning lives in the view delta (same trick as `Narrator.renderAction`). Diff
`before`/`after` `ViewModel`s to emit: piece moves (PC + mobs by `scope`/`occupants` id set),
`tileLamp` on room-lit change, `led "encounter"` when a live non-defeated occupant appears,
`piece glow` from status thresholds, loot-opened reveals. Cue kinds map alongside:
`visibility`→`tileLamp`, `encounter`→`led`+`sound`, `status`→`dashboard`, `resolution`→
`resolution` (held until after `mobAttacks`), `action`→`sound`.

### The turn loop (`TabletopSurface`)

1. **Mount:** `takeStartupCues()` → transport (initial reveals/audio); `view()` seeds
   `MapModel.observe` + initial `tile` commands + PC `piece` placement + `dashboard`.
2. **On `pieceDrag`:** resolve → `Intent{move,dir}`. `before = view()`; `execute(intent)`.
   - `result.error` → `led "reject"`, snap piece back, stop.
   - else `after = view()`; `mapModel.recordMove(before.room.id, dir, after.room.id)`;
     `mapModel.observe(after)`; `ViewDiffer(before, after)` → commands; play cue audio;
     apply `mobAttacks`; then flush `resolution`.
3. **On `tileAction`:** same execute→diff pipeline (covers attack/take/open/equip/use so the
   sim exercises the full engine, not just movement).
4. **Persistence:** `save(slot, surfaceState)` / `restore` carry a
   `TabletopSurfaceState { map: MapSnapshot; tiles: {tileId, roomId}[]; piece: {tileId} }`
   in the existing `SurfaceState` payload — same mechanism the browser map uses today.

### PC self-stats note (dependency to surface honestly)

The PC's own Health/Sanity/Energy are **not** in the `ViewModel` directly (occupants/scope are
*others*). They arrive via the **`status` cue**, emitted by a campaign's status mechanic. So
the seat dashboard is populated by skimming `status` cues (like `absorbStatusCues`); a campaign
without a status mechanic shows only `vm.status` (turn/location). This is why P1 tests against
Hollow House (which has the status-bar mechanic) — and it's a real constraint to document, not
paper over.

## Package skeleton

`packages/tabletop/` following the `packages/campaigns` convention exactly:
- `package.json`: `"@wickedways/tabletop"`, `version 0.0.1`, `private`, `type module`,
  `exports { "./*": "./src/*/index.ts" }`, `scripts.typecheck = "tsc --noEmit"`; deps
  `wickedways`, `@wickedways/play-runtime`, `@wickedways/play-surface` (all `workspace:*`);
  devDep `@types/node`.
- `tsconfig.json`: copy `packages/campaigns/tsconfig.json` verbatim (`lib` includes `DOM`,
  which `SimulatorTransport` needs).
- Source: `src/surface.ts` (`TabletopSurface`), `src/protocol.ts`, `src/transport.ts`
  (interface), `src/simulator-transport.ts`, `src/tile-mapper.ts`, `src/view-differ.ts`,
  `src/intent-resolver.ts`, plus `src/index.ts` re-exporting `tabletopSurface`.
- Picked up automatically by the `packages/*` workspace glob and the root vitest runner.

## Verification

- **Unit (`*.test.ts`, colocated):** `deltaToDirection` inversion; `IntentResolver`
  (directional drag → intent, non-exit direction rejected, locked-door direction still emits +
  engine rejects); `resolveCollisions` (two rooms one cell → distinct cells, edge adjacency
  kept); `ViewDiffer` against fixture before/after ViewModels; protocol message shape.
- **Integration:** a `FakeTransport` (records `DeviceCommand`s, scripts `DeviceEvent`s) drives
  `TabletopSurface` against a **real `GameSession`** booted on Hollow House. Assert: startup
  reveal commands; a move emits `move` intent + a `tile`/`tileLamp` reveal on entering a lit
  room; a dark room stays `concealed` until a light action; encounter → `led`+`sound`; an
  illegal move → `led "reject"` and piece snap-back; `save`→`restore` round-trips the
  `MapSnapshot` + tile assignments via `SurfaceState`.
- **End-to-end / DOM:** mount `SimulatorTransport` (Playwright, the repo's existing `e2e` job)
  and drag the PC piece through one reveal; keep this thin — logic is covered by `FakeTransport`.
- `pnpm checks` green (lint + typecheck + test). Update `README.md` to document the new
  surface once it lands (repo convention).

## Wiring to run it

Register `tabletopSurface` in the `surfaces` array passed to `bootLauncher`
(`packages/play/src/main.ts`) and add a `SurfaceChoice { id: "tabletop-sim" }` to a campaign
`manifest.surfaces` (Hollow House for the demo). A minimal Vite dev entry (mirroring
`packages/play`) mounts it standalone for iteration.

## Out of scope (later phases)

- P2: `SerialTransport` to one ESP32 + one e-ink tile.
- P3: N tiles + NFC piece/lantern sensing; the `placeLight` intent + dice-supply rng seam
  decisions; multi-seat / multi-piece (needs the engine's GM-model work).
