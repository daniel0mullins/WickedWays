# Darkness mechanic

**Date:** 2026-06-15
**Status:** Approved, ready for planning

## Problem

The engine has no notion of light or visibility. Rooms are always fully
perceivable. We want darkness as an **exploration / concealment** mechanic: a
dark room hides what's in it until the party brings light, and a class of
**light-averse mobs** lurks in the dark and turns vulnerable when lit. Bringing
light is a real tactical decision, not a pure win.

## Core fantasy

- **Concealment is the spine.** A dark, unlit room conceals its mobs/occupants,
  its loot and material caches, and its descriptive detail. Exits stay visible
  so the party can always navigate.
- **Concealment blocks targeting, not movement.** You cannot loot, harvest, or
  attack what you cannot see, and attempting it throws `ProceduralViolation`.
  Movement, and any light-management action, always work — no softlock risk.
- **Creatures of darkness.** Light-averse mobs see in the dark (so they can act
  while the party is blind) and take amplified damage while their room is lit.
  "Thrives in darkness" is the emergent contrast: dangerous and untouchable in
  the dark, fragile once you light them up.

## Non-goals (explicitly out of scope)

- Torch burn-down / fuel / charges (light is persistent while active).
- Blocking or hiding exits.
- Dynamic dark↔lit *authoring* changes to a room (e.g. a scene snuffing the
  lights). Darkness is an author-time room property; only the presence of active
  light changes the live lit state.
- Darkness affecting encounter spawn rates.
- Player-side darkvision (only mobs see in the dark; players need light).
- A general "drop any item on the floor" system. Only light sources get a
  place/take seam.

## Design

### 1. Room darkness

`Room` gains an optional author-time `dark?: boolean` (default `false`),
constructor-set, stored in a private field, exposed read-only via `get dark()`.
There is no mutator — darkness is fixed at authoring.

### 2. Light sources & illumination

A light source is any item with a new optional `emitsLight?: boolean` on the
item shape (`IItem` / `Item`). A light source is **active** — actually shedding
light — in one of two states:

- **Carried:** equipped in a hand slot by an occupant of the room. Persistent
  (no burn-down); moves with the character, so the room goes dark again when
  that character leaves.
- **Placed:** resident in the room's light-source collection. Stays lit
  regardless of occupancy. This is the candle / oil-lamp fixture.

The same item works either way — a candle can be held (carried) or set down
(placed).

`Room` gains a dedicated `lightSources` collection (a `Map<ItemId, IItem>`,
parallel to `loot`/`materials`; **not** general loot, to keep it scoped and out
of the loot-concealment rules). Rooms may be **authored** with light sources
already present.

Two new **free, never-dark-blocked** character actions move an `emitsLight` item
between inventory and the room:

- `placeLight(item)` — moves the item from the character's inventory into
  `currentRoom.lightSources`. Ownership transfer goes through the existing
  symbol seams (`CLAIM` / `SET_ORIGIN`) so it isn't forgeable. Throws
  `ProceduralViolation` if the item is not an `emitsLight` item the character
  holds, or the character is not in a room.
- `takeLight(item)` — moves the item from `currentRoom.lightSources` back into
  the character's inventory. Throws `ProceduralViolation` if the item is not in
  the room's light sources.

`Room.lightSources` mutation is gated behind a symbol seam (following the
inventory.ts pattern) rather than a public setter, so only the place/take path
and authoring can change it.

### 3. Lit state

`Room.isLit: boolean` (getter):

- A non-`dark` room is always lit.
- A `dark` room is lit **iff** any non-broken item is in `lightSources`, **or**
  any occupant has an equipped, non-broken `emitsLight` item.

`Character` gains `get hasLight(): boolean` — "has an equipped, non-broken
`emitsLight` item" — used by `Room.isLit` to check occupants.

Because a placed or carried light glows, it reveals itself and the room; there
is no "hidden lit candle." `takeLight` of the room's only light (with no carried
light present) is what returns the room to darkness.

### 4. Vision and the targeting gate

`Character` gains `get seesInDark(): boolean`, default `false`. Light-averse mobs
override it to `true`.

The concealment rule, enforced by throwing `ProceduralViolation`:

> In a room where `isLit` is `false`, an actor may not **attack**, **loot**, or
> **harvest** unless its `seesInDark` is `true`.

Hook points:

- `Combatant.attack(target)` — gate at the top: if the attacker's
  `currentRoom` exists and `!room.isLit && !this.seesInDark`, throw.
- The loot pickup action — gate on the looting character's room lit state.
- The material-harvest action — same gate.

Consequence: a normal (non-light-averse) mob in a dark room also cannot attack —
only creatures of darkness operate blind, which reinforces the menace. Movement,
`equip`/`unequip`, `placeLight`/`takeLight` are never gated by darkness.

### 5. Light-averse mobs

A single mob trait `lightAverse` (constructor option on the mob, default
`false`) bundles both facets of a creature of darkness:

- **Sees in dark:** the mob's `seesInDark` getter returns `true`, so it can act
  and attack while the party is blind.
- **Weakened in light:** while the mob's `currentRoom.isLit` is `true`, incoming
  damage is amplified by a named constant `LIGHT_VULNERABILITY` (1.5). Applied
  in `Character.takeDamage` to the final damage, after the existing armor and
  stat mitigation, before the damage is applied to the stat. Base `Character`
  is never light-averse, so the multiplier only ever affects light-averse mobs.

No new RNG: darkness and light vulnerability are fully deterministic.

### 6. Presentation cues

Extend `PresentationCue` with a lightweight variant:

```ts
| { kind: "visibility"; room: EntityRef; lit: boolean }
```

Emitted via `campaign[EMIT_CUE]` when:

- a character enters a room and the room's `isLit` is `false` (cue with
  `lit: false`), and
- a light-management action (`equip`/`unequip` a light, `placeLight`/`takeLight`)
  flips a `dark` room's lit state (cue with the new `lit` value).

Concealing the room description and the occupant / loot lists for a renderer is
a **renderer concern driven by these cues** — the engine keeps its data model
intact (consistent with "block targeting, not hide data"). `Campaign.onCue` /
`offCue` already exist for subscribers.

## Conventions to follow

- **Symbol seams** for protected state: `Room.lightSources` writes and the
  ownership transfer in `placeLight`/`takeLight` go through symbols, not public
  setters (matches `CLAIM`, `EQUIP`, `SET_ORIGIN`, etc. in `inventory.ts`).
- **Illegal operations throw `ProceduralViolation`** (targeting in darkness,
  placing a non-light item, taking a light that isn't there).
- **Action budget:** `placeLight` / `takeLight` are **free** actions (no budget
  tick, no history), like `equip`/`unequip`. Preserve that.
- **No `Math.random`:** nothing here is randomized; no `rng` threading needed.
- **Branded IDs:** `lightSources` is keyed by `ItemId`.

## Files touched

- `src/lib/room.ts` — `dark` flag, `lightSources` collection + symbol-gated
  mutation, `isLit` getter, visibility cue on enter.
- `src/lib/inventory.ts` — `emitsLight?: boolean` on `IItem` / `Item`.
- `src/lib/character/character.ts` — `hasLight`, `seesInDark`, `placeLight`,
  `takeLight`, `takeDamage` light-vulnerability multiplier.
- `src/lib/character/combatant.ts` — attack targeting gate.
- The loot pickup and material-harvest actions — targeting gate.
- The mob class — `lightAverse` option → `seesInDark` override + light-averse
  flag read by `takeDamage`.
- `src/lib/presentation.ts` — `visibility` cue variant.
- `src/lib/campaign.ts` — emit path for the visibility cue (reuses `EMIT_CUE`).
- `README.md` — document the darkness mechanic.

## Testing

Co-located unit tests per file, plus one integration test.

- **Room:** `dark` default and getter; `isLit` true for non-dark; dark room
  unlit with nothing; lit by a placed light source; lit by an occupant's
  equipped light; goes dark again when the carried light's holder leaves;
  `lightSources` write guarded against direct assignment.
- **Light source item:** `emitsLight` exposed; a broken light source does not
  count toward `isLit`.
- **place/take:** `placeLight` moves inventory → room and flips a dark room lit;
  `takeLight` moves room → inventory and re-darkens; both throw
  `ProceduralViolation` for the illegal cases; both are free (no budget tick).
- **Vision gate:** in an unlit room, attack / loot / harvest throw
  `ProceduralViolation`; a `seesInDark` mob may attack; once lit, all allowed;
  movement and light actions never blocked.
- **Light-averse mob:** `seesInDark` is true; takes `LIGHT_VULNERABILITY`×
  damage while its room is lit; normal damage while dark; a non-light-averse
  defender is unaffected by room lit state.
- **Cues:** entering an unlit room emits `{ kind: "visibility", lit: false }`;
  placing/equipping a light in a dark room emits `{ lit: true }`.
- **Integration:** party enters an authored dark room holding a light-averse
  mob → cannot loot or attack (throws) → equips a torch (or places a candle) →
  room lit → mob targetable and takes amplified damage; full `npm run checks`
  green.
