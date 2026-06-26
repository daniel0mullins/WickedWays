# Fog-of-war map for the play surface — design

**Date:** 2026-06-26
**Package:** `@wickedways/play` (`packages/play`)
**Status:** Approved (brainstorming); pending implementation plan

## Goal

Add a **map** to the browser play surface: a `map` verb opens a vector (SVG)
overlay drawn **inside the CRT screen**, showing the part of the house the player
has explored. The map is **fog-of-war** — it fills in as the player moves, built
entirely from data the play surface already sees (no engine changes). Any keypress
dismisses it.

## Constraints (from the codebase)

- The play surface's `ViewModel` exposes only the **current room** plus its exits,
  not the whole house and **no room coordinates**:
  - `room: { id, name, description, isLit }`
  - `exits: { dir: Direction; toName: string }[]` — passable exits (and the name
    of the room each leads to)
  - `lockedDoors: { name: string; dir: Direction }[]`
  - `occupants: { …; defeated: boolean }[]` — defeated mobs linger as remains
- `Direction` is one of `north | south | east | west | northeast | northwest |
  southeast | southwest`.
- A move intent carries its `dir`; in `handle()` the before/after `view()` give the
  source and destination room ids. So every traversal yields a `(fromId, dir, toId)`
  edge — the basis for placing rooms on a grid.
- The map is derived purely from directions; **no engine changes** (the engine is
  `wickedways/lib`). The map persists with save/restore by riding along in the play
  package's own save envelope — see Persistence.
- Save/restore today: `session.save(slot)` serializes the campaign and calls
  `SaveStore.save(slot, snapshot, savedAt)`; `LocalStorageSaveStore` wraps it in an
  `Envelope { savedAt, snapshot }` under one localStorage key. `SaveStore` and
  `GameSession` are **play-package** code, so they may carry play-surface state.
- Test environment is **node** (no DOM/SVG) → pure layout logic is unit-tested; the
  SVG-DOM emitter and overlay are browser-only (manual / optional e2e).
- CRT overlays are z-index 5–6, game content 1–2; the map overlay sits at ~3–4 so
  the scanlines/glow read over it.

## Architecture

Two new units plus UI wiring, mirroring the audio feature's pure-core / thin-DOM split.

| File | Responsibility | Tested |
|------|----------------|--------|
| `core/map-model.ts` | The explored graph (fog-of-war state). Accumulates rooms, coords, edges, unexplored stubs, and remains as the player moves. Pure data + update methods. | unit |
| `text/map-view.ts` | `layoutMap(model)` — **pure** → positioned shapes (boxes, connection lines, locked-door lines, unexplored stubs, you-are-here highlight, remains markers). `renderMapSvg(layout)` — thin, builds the `<svg>` DOM. | layout unit-tested |
| `text/ui.ts` (mod) | `map` verb handling, the in-CRT overlay element, any-key dismiss, and per-turn `MapModel` updates. | e2e / manual |
| `text/parser.ts` + `parser.test.ts` (mod) | the `map` verb (`meta: "map"`). | unit |
| `text/narrator.ts` (mod) | add `map` to the `help` line. | (covered) |
| `core/savestore.ts` (mod) | save envelope carries an optional play-surface `surface` payload (`{ map?: MapSnapshot }`) beside the campaign snapshot. | unit |
| `core/session.ts` (mod) | `save(slot, surface?)` passes the payload through; `restore` returns it for the UI to hydrate. Treats it opaquely. | unit |

### `MapModel`

Room ids are plain `string`s (the play `ViewModel` exposes `room.id: string`).

State:
- `rooms: Map<string, { id; name; coord: {x,y}; hasRemains: boolean }>`
- `edges: { a: string; b: string; dir: Direction; locked: boolean }[]` (deduped by
  unordered room pair)
- `stubs: Map<string, { dir: Direction; locked: boolean }[]>` — per room, the exits
  seen but not yet traversed
- `currentId: string | null`

Updates (fed from `ui.ts` each turn):
- `observe(view)` — records/refreshes the current room: its `id`, `name`,
  `hasRemains` (`occupants.some(o => o.defeated)`), and its visible exits +
  lockedDoors as stubs. A stub is recorded for a direction only if that direction is
  **not already a traversed edge** from this room (so re-observing a room each turn
  doesn't resurrect a stub for a path you've already walked). Sets `currentId`. Seeds
  the origin `(0,0)` only for the very first room observed (when `rooms` is empty);
  every other room gets its coord from `recordMove`.
- `recordMove(fromId, dir, toId)` — adds/refreshes the `from↔to` edge; assigns
  `to.coord = from.coord + delta(dir)` if `to` has no coord yet; removes the matching
  stub from `from`. `delta`: north `(0,-1)`, south `(0,1)`, east `(1,0)`, west
  `(-1,0)`, diagonals combine (e.g. northeast `(1,-1)`).
- Conflict rule: a room's coord is assigned once (first-placement wins); a later edge
  implying a different coord is still drawn as a connection but does not move the box.
  (The Hollow House is grid-consistent; this only guards pathological authoring.)
- `serialize(): MapSnapshot` / `hydrate(snap)` — round-trip all state (rooms with
  coords + remains, edges, stubs, currentId) as plain JSON. `reset()` clears it (used
  on restart). `MapSnapshot` is a plain-data type (numbers/strings/booleans only).

Fog-of-war specifics:
- `ExitView.toName` is available but **deliberately unused** for stubs — unexplored
  exits render as `?`, preserving the mystery (the player doesn't currently see
  destination names anywhere else either).
- `hasRemains` reflects the **last time the player was in that room**; rooms left
  behind keep their last-seen state.

### `map-view.ts`

- `layoutMap(model): MapLayout` — pure. Computes the coord bounding box, places each
  room box at `(coord - min) * CELL`, and emits:
  - `boxes`: `{ x, y, w, h, label, current, remains }`
  - `links`: `{ x1, y1, x2, y2, locked }` between adjacent room-box centers
  - `stubs`: `{ x1, y1, x2, y2, locked }` — a short line from a box edge toward the
    unexplored direction, ending at a `?` glyph position
  - returns overall `width`/`height` for the `<svg>` viewBox
- `renderMapSvg(layout): SVGSVGElement` — thin browser emitter: `<rect>` boxes
  (current room box gets a glowing accent stroke), `<line>` links (locked = dashed +
  a small barred tick), stub lines + `<text>?</text>`, room-name `<text>` labels, and
  a small remains glyph (`✕`) on boxes with `remains`. Palette: `--color-accent`
  gold, phosphor glow, dim grid — consistent with the terminal.

### UI integration (`ui.ts`)

- **Verb:** parser returns `{ kind: "meta", meta: "map" }` for `map`. In `handle()`'s
  meta switch, a `map` case calls `openMap()` and returns (no turn, no `refresh`).
- **Model feeding:** `refresh()` calls `mapModel.observe(session.view())` each turn;
  the intent `move` branch in `handle()` calls `mapModel.recordMove(beforeId, dir,
  afterId)` (before the room re-render).
- **Overlay:** `openMap()` builds the SVG from `mapModel`, drops it into a
  `.map-overlay` `<div>` absolutely positioned inside `.screen` (z-index ~3, below the
  CRT overlays). A legend strip (open / locked / unexplored / remains / you-are-here)
  sits at the bottom.
- **Dismiss:** while open, a one-shot `keydown` listener (capture) closes the overlay,
  `preventDefault`s that key so it doesn't type into `#cmd`, and refocuses `#cmd`.
  Opening twice is harmless (idempotent). The map is only available once the game has
  started.
- **Save:** the `save` meta branch calls `session.save(slot, { map: mapModel.serialize() })`.
- **Restore:** the `restore` branch reads the returned `surface` and calls
  `mapModel.hydrate(surface.map)` (or leaves the map as-is if a legacy save has no
  payload), so the restored game shows the exploration as it was when saved.
- **Restart:** alongside the fresh `Narrator`, `mapModel.reset()` clears the map so the
  new playthrough re-explores from blank.

### Persistence

The save envelope carries the map beside the campaign snapshot, so one slot is one
complete save:
- `SaveStore.save(slot, snapshot, savedAt, surface?)` and
  `load(slot): { snapshot; surface? } | null`; `Envelope` gains `surface?: SurfaceState`.
  `SurfaceState = { map?: MapSnapshot }` (extensible for future play-surface state).
- `GameSession.save(slot, surface?: SurfaceState)` forwards the payload;
  `restore(slot): Promise<{ ok: boolean; surface?: SurfaceState }>` returns it (the
  session treats `surface` as opaque — it never reads the map).
- The play surface (`ui.ts`) is the only place that builds/consumes the `map` payload.
- **Backward compatibility:** a legacy save with no `surface` deserializes to
  `surface: undefined`; restore then leaves the live map untouched. New saves always
  include it.
- `undo` needs no map handling: fog-of-war never un-reveals, and the post-undo
  `refresh()→observe` moves the you-are-here marker to the reverted room.

### Data flow

```
each turn:  handle(move) → mapModel.recordMove(from, dir, to)
            refresh()    → mapModel.observe(view)              [rooms, remains, stubs]
`map` verb: handle → openMap() → layoutMap(mapModel) → renderMapSvg → .map-overlay
any keydown while open → close overlay, consume key, refocus #cmd
save:       handle → session.save(slot, { map: mapModel.serialize() })
restore:    handle → { ok, surface } = session.restore(slot) → mapModel.hydrate(surface.map)
restart:    handle → mapModel.reset()
```

## Error handling / edge cases

- **Before any move:** only the starting room box is drawn (with its stubs). Fine.
- **Coordinate conflict:** first-placement wins; connection still drawn (see rule).
- **Diagonals:** supported via combined deltas; links drawn between box centers.
- **Dark rooms:** the room id/name still arrive in the viewmodel, so the room is
  mapped normally.
- **Remains staleness:** last-seen per room, by fog-of-war design.
- **No SVG/DOM in tests:** layout is pure; the DOM emitter is browser-only.

## Testing

- `map-model.test.ts` — feed scripted `observe`/`recordMove` sequences; assert room
  set, coordinates (incl. a diagonal and a conflict), edges (open vs locked), stub
  add/removal on traversal, and `hasRemains` tracking.
- `map-view.test.ts` — given a small model, assert box positions, that traversed
  connections are links (locked flagged), unexplored exits are stubs, the current room
  is marked, and remains boxes are flagged; assert the computed `width`/`height`.
- `parser.test.ts` — `map` → `{ kind: "meta", meta: "map" }`.
- `map-model.test.ts` — `serialize` → `hydrate` round-trips an explored map to an
  identical model; `reset()` clears it.
- `savestore.test.ts` — the envelope round-trips the `surface` payload; a legacy
  envelope without `surface` loads as `surface: undefined`.
- `session.test.ts` — `save(slot, surface)` then `restore(slot)` returns the same
  `surface`; `restore` of a payload-less save returns `surface: undefined`.
- Manual / optional Playwright e2e: type `map`, assert `.map-overlay` appears, a
  keypress dismisses it.
- `pnpm checks` green.

## Documentation

Update `packages/play/README.md` (the `map` verb + fog-of-war map) and relevant
TSDoc, per the project's living-documentation convention.

## Out of scope (this iteration)

- Exposing the full house graph / revealing unexplored rooms.
- A persistent on-screen minimap or a bezel button (verb-only for now).
- Showing live (non-defeated) mobs or loot on the map — only mob *remains*.
- Persisting the map to a *bare page reload* with no save (it rebuilds as you move).
  Explicit save/restore **does** persist the map (see Persistence).
