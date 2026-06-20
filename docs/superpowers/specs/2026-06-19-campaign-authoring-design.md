# Campaign Authoring — Design

> Phase 1 of a campaign-authoring program. A fluent, type-safe builder for
> authoring reusable campaign **templates**, plus the thin orchestration that
> turns a template into a playable **instance** the existing comms/persistence
> layers run.

**Status:** approved (pending user review), ready for implementation planning
**Date:** 2026-06-19
**Builds on:** the engine entity constructors + `CampaignRegistry`, the
serialization layer (`serializeCampaign`/`deserializeCampaign`, `CampaignSnapshot`),
the authoritative server (`genesisFor`, the `joinCampaign`/`beginCampaign`
commands), and durable persistence (`CampaignStore`).

---

## Goal

Replace hand-written, raw-constructor campaign construction with a fluent,
type-safe builder that authors a reusable, **player-less campaign template**, and
add the thin orchestration that **instantiates** a template into a playable
campaign genesis — so the existing self-service join + GM-begin commands carry the
session, persisted by `CampaignStore`.

## Background

Today campaign content is built imperatively with raw constructors — see
`packages/seed/src/index.ts` `buildSeedCampaign()`: `new Campaign`, `new Room` +
`addExit`, `new PlayerCharacter` + `joinCampaign`/`selectArchetype`/`move`,
`discoverRecipe`, `claimMaterials`, `campaign.gm = …`, `beginCampaign()`. That is
verbose, error-prone (dangling exits, wrong ids surface only at runtime), and
conflates two very different things:

- **Template** — the reusable *world* (a module/adventure): rooms, exits, mobs,
  world-placed items, loot, material caches, the archetypes players may pick,
  known recipes, codex, and campaign metadata. Authored once, run many times.
- **Instance / session** — a specific playthrough: *players* who join (bringing
  their own character + chosen archetype), a designated GM, and a started,
  authoritative, persisted game.

A template carries **no players, no GM, and is not begun**. Those are session
concerns, and the comms layer already implements them as authoritative commands
(`joinCampaign{character}` self-service join, `beginCampaign` GM command).

## Decisions (locked during brainstorming)

1. **Fluent builder over the real constructors.** The builder accumulates a named
   description; `.build(registry)` constructs actual engine instances in the
   required order, resolving references by name, and returns a **live, player-less,
   not-begun `Campaign`** (valid by construction). Genesis = `serializeCampaign`.
   It does *not* emit snapshot JSON directly.
2. **Templates, not instances.** The builder authors a template (world +
   archetypes + recipes + codex + metadata). `.player`/`.gm`/`.begin` are **not**
   builder methods.
3. **Thin orchestration:** `instantiate(template) → CampaignSnapshot` (instance
   genesis, fresh campaign id) + a `startSession(template, {players, gm})` helper
   that scripts the existing join/begin engine APIs (for fixtures + the demo).
4. **Behaviors stay code.** Item factories (`() => Item`), recipe `create()`
   functions, scenes, and formations remain hand-written in a `CampaignRegistry`
   passed to `.build(registry)`; the builder references them **by key** and the
   assembler validates the keys exist. **Archetypes are pure data** and are
   authored inline (`.archetype({id,name,statModifiers,…})`).
5. **Validate-all, then construct.** `.build` collects *every* validation problem
   and throws one `AuthoringError` listing them (good authoring DX), before
   constructing anything.
6. **Top-level chaining with named references** in each entity's options (not
   nested sub-builders) — fully type-checked, no nested-builder typing complexity.
7. **The builder becomes the canonical constructor** — the seed (and, where clean,
   the engine's `buildStartedCampaign` fixture) are rebuilt on it.
8. **Deferred:** the YAML/JSON declarative format (phase 2 over this same model),
   a UI (phase 3), live authoring-commands through the Authority, procedural
   generation, and authoring the registry *behaviors* themselves.

---

## Architecture

```
authorTemplate(...)            fluent builder (TS, compile-time)
   .room/.exit/.mob/.item/.loot/.cache/.archetype/.recipe/.codex/.startRoom
   .build(registry)            → assembler: validate-all → construct in order → resolve names→instances
                               → live player-less, not-begun Campaign
   serializeCampaign(it)       → TEMPLATE snapshot (CampaignSnapshot)

instantiate(template)          → INSTANCE genesis (fresh campaign id) → genesisFor / CampaignStore
startSession(template, {...})  → (instantiate + join players + select archetypes + set gm + begin) → started Campaign

play: joinCampaign / beginCampaign  ← EXISTING authoritative + persisted commands
```

New engine module `src/lib/authoring/`:
- `template-builder.ts` — the fluent `authorTemplate(...)` API + its accumulated description types.
- `assembler.ts` — validate-all + ordered construction + name→instance resolution (`build`).
- `errors.ts` — `AuthoringError` (aggregates validation problems).
- `orchestration.ts` — `instantiate(template)` + `startSession(template, opts)`.

Exposed via the engine's `wickedways/lib/authoring/*` export so `packages/seed`
and the server harness can consume it.

### The template builder API

Top-level chaining; references by name in options; ordering-agnostic at author
time (the assembler imposes the construction order). Example — the seed's world as
a template:

```ts
const template = authorTemplate("Crypt", { rng: () => 0.5, maxRounds: 10 })
  .archetype({ id: "delver", name: "Delver", statModifiers: { [StatType.Health]: 2 } })
  .room("start", { description: "the entrance" })
  .room("next",  { description: "an adjoining chamber", dark: true })
  .startRoom("start")                                   // where joining players enter
  .exit("start", Directions.North, "next")              // refs by name → resolved at build()
  .mob("goblin", { stats: gobStats, room: "next", drops: ["coin"] })
  .item("coin", { from: "coin-item" })                  // `from` = registry factory key
  .item("gem",  { from: "gem-item" })                   // each item name = ONE instance
  .loot("chest", { room: "next", items: ["gem"] })      // a loot box holding items (places "gem")
  .cache("vein", { room: "next", materials: { metal: 2 } })
  .recipe("widget")                                      // discover a registry recipe
  .materials("seed", { metal: 2 })                       // claimMaterials (crafting economy)
  .codex({ /* lore entry */ })
  .build(buildSeedRegistry());                           // → live player-less Campaign
```

**Vocabulary** (each maps to real constructor params from the construction map):
- `authorTemplate(title, { rng?, maxRounds?, baseEncounterChance?, actionSounds? })`
- `.archetype({ id, name, statModifiers?, inventorySlots?, immunities? })` — pure data, `campaign.registerArchetype`.
- `.room(name, { description, dark?, spawnModifier?, presentation?, lights? })` — `lights` are item names placed as the room's light sources.
- `.startRoom(name)` — designates the entry room for joining players (used by `startSession`).
- `.exit(fromRoomName, direction, toRoomName)` — one-way; call twice for bidirectional.
- `.mob(name, { stats, room?, inventorySlots?, actionsPerRound?, drops?, baseEscapeChance?, materialDrops?, lightAverse? })` — `drops` are item names.
- `.item(name, { from })` — **defines** one item instance; `from` is a registry item-factory key (`registry.item(from)()`). An item is **placed** by being referenced from exactly one container — a `loot`'s `items`, a `mob`'s `drops`, or a `room`'s `lights`. Validation flags an item referenced by **no** container (unplaced) or **more than one** (double-placed) — each name is a single instance.
- `.loot(name, { room, items, description?, presentation? })` — a loot box; `items` are item names (placing those items).
- `.cache(name, { room, materials, presentation? })` — a harvestable `MaterialCache`.
- `.materials(source, MaterialMap)` — `campaign.claimMaterials` (directly-available crafting materials, distinct from placed caches).
- `.recipe(key)` — discover a registry recipe (`knownRecipes`/`discoverRecipe`).
- `.codex(entry)` — a codex entry.
- `.build(registry): Campaign` — validate-all, construct, return the live player-less Campaign. `.toSnapshot(registry): CampaignSnapshot` is a convenience wrapper (`serializeCampaign(build(registry))`).

### The assembler (`.build(registry)`)

**Pass 1 — validate (collect all, then throw `AuthoringError`):** unknown or
duplicate entity names; an `exit`/`room`/`loot`/`cache`/`mob.room`/`startRoom`
referencing an undefined room; a `loot.items`/`mob.drops`/`room.lights` entry
referencing an undefined item name; an item referenced by **no** container
(unplaced) or by **more than one** (double-placed); an item `from`-key or `recipe`
key **missing from the supplied `registry`**; a mob/loot/cache placed in no room.
If any problem exists, throw `AuthoringError` with the full list — no construction
happens.

**Pass 2 — construct in the engine's required order**, resolving names→instances
through an internal `Map<name, instance>`:
1. `new Campaign(title, maxRounds, [], { rng, baseEncounterChance, … })`.
2. `campaign.registerArchetype(...)` for each archetype.
3. Items — `registry.item(from)()` for each, indexed by name.
4. Loot boxes — `new Loot(description, [resolved items])`, indexed by name.
5. Material caches — `new MaterialCache(materials)`, indexed by name.
6. Mobs — `new Mob(campaign, name, stats, slots, apr, [resolved drops], opts)`, indexed by name.
7. Rooms — `new Room(name, description, [resolved loot], NO_EXITS, [resolved caches], spawnModifier, [], presentation, dark, [resolved light items])`, indexed by name.
8. Place mobs — `room.placeMob(mob)` for each mob with a `room`.
9. Wire exits — `fromRoom.addExit(direction, toRoom)`.
10. Recipes — `campaign.discoverRecipe(registry.recipe(key))` for each known recipe.
11. Materials — `campaign.claimMaterials(source, map)`.
12. Codex entries applied.

Return the live `Campaign` — **player-less, no GM, not begun**.

### Registry boundary

Firm: **content is authored; behaviors are code.** The `CampaignRegistry` (item
factories, recipes' `create()` functions, scenes, formations) stays hand-written
and is passed to `.build(registry)`; the builder references behaviors by key and
the assembler validates the keys resolve. Archetypes (pure data) are the one thing
authored inline. The builder never authors behavior code.

### Orchestration

**`instantiate(template: CampaignSnapshot, opts?): CampaignSnapshot`** — clones the
template snapshot and assigns a fresh campaign-core id, returning an **instance
genesis** (still player-less, not begun). Entity ids are left unchanged — each
instance is an isolated campaign (its own `CampaignStore` record, its own
`Authority` + entity index), so ids cannot collide across instances. One template →
many independent instances. The host wires it into `genesisFor`:
`genesisFor: (campaignId) => templateFor(campaignId) && instantiate(templateFor(campaignId))`.

**`startSession(template, { players, gm, rng? }): Campaign`** — a convenience that
scripts the existing engine APIs for fixtures + the demo: `instantiate` (or
`deserializeCampaign` of the template) → for each `players[i]`
(`{ name, stats, archetype }`): `new PlayerCharacter` → `joinCampaign()` →
`selectArchetype(archetype)` → `move(startRoom)` → set `campaign.gm = players[gm]`
→ `campaign.beginCampaign()`. Returns the started live `Campaign`. It uses the same
engine methods the authoritative `joinCampaign`/`beginCampaign` commands call, so
the started session is faithful to a real network play start.

### Genesis / persistence / demo wiring

An instance genesis flows straight into the durability layer: `genesisFor` returns
`instantiate(template)`, the server builds its `Authority` from it (seq 0), and
`CampaignStore` persists it — no new comms plumbing. Players then join via the
authoritative `joinCampaign` command (persisted), and the GM begins via
`beginCampaign` (persisted). The demo harness (`packages/server/src/main.ts`) is
updated to derive `genesisFor("demo")` from a demo *template* via `instantiate`.

### Reuse

- **`packages/seed`**: `buildSeedCampaign()` is rebuilt as
  `startSession(seedTemplate, { players: [{name:"Ada",…,archetype:"delver"}, {name:"Ben",…}], gm: 0 })`,
  where `seedTemplate = authorTemplate("Crypt", …)…build(buildSeedRegistry())`.
  This both DRYs the world construction and exercises the full
  template→instance→session path. A `demoTemplate()` export (the player-less
  template snapshot) is added for the server harness's `genesisFor`.
- **`src/lib/serialization/roundtrip.test-helpers.ts`**: `buildStartedCampaign`
  is migrated onto the builder + `startSession` **only if it preserves its output
  contract** (it is consumed by many engine tests); otherwise it is left as-is and
  the migration is noted as a follow-up. The builder's correctness is independently
  proven by its own tests + the seed rebuild regardless.

## Error handling

All authoring-time failures surface as a single `AuthoringError` from `.build`,
listing every problem (dangling reference, duplicate name, missing registry key,
unplaced entity) with the offending entity name — never a partial construction.
Engine-level illegal states (should not occur from a validated template) still
throw `ProceduralViolation` as usual.

## Testing

- **Builder/assembler unit tests:** each entity kind + placement + reference;
  forward references resolve regardless of author order; `.build` returns a
  player-less (`party` empty of PCs), not-begun campaign with the expected rooms /
  exits / mobs / items / loot / caches / archetypes / recipes.
- **Validation tests:** each error class (dangling room/item ref, duplicate name,
  missing `from`/`recipe` registry key, an item unplaced *and* an item
  double-placed, unplaced mob/loot/cache, unknown `startRoom`), and that *multiple*
  problems are collected into one `AuthoringError`.
- **Round-trip:** `authorTemplate(...).toSnapshot(registry)` →
  `deserializeCampaign` → `serializeCampaign` equals the template snapshot
  (the builder produces a faithfully serializable campaign).
- **Orchestration:** `instantiate` yields a fresh campaign id + an unchanged world;
  `startSession` yields a started campaign whose party = the given players with
  their archetypes, gm set, begun — and it converges with a real
  `joinCampaign`/`beginCampaign` sequence (same resulting state).
- **Reuse proof:** the rebuilt `buildSeedCampaign` keeps the client/seed tests
  green; if `buildStartedCampaign` is migrated, the full engine suite stays green.

## Explicitly out of scope (deferred)

- **YAML/JSON declarative format** (phase 2) over this same authoring model.
- **A UI** (phase 3) over the data.
- **Live authoring-commands** (mutating a running campaign through the `Authority`).
- **Procedural generation** (loops/computed content beyond what TS affords the
  builder caller).
- **Authoring the registry behaviors** (item/recipe/scene/formation *code* stays
  hand-written).
- **A template library / template store** (the host holds templates, as it holds
  `genesisFor` today).

## Files (anticipated)

- Create: `src/lib/authoring/{template-builder,assembler,errors,orchestration}.ts` (+ tests).
- Modify: `packages/seed/src/index.ts` (`buildSeedCampaign` on the builder; add `demoTemplate`).
- Modify: `packages/server/src/main.ts` (derive `genesisFor` from a demo template via `instantiate`).
- Modify (if contract-preserving): `src/lib/serialization/roundtrip.test-helpers.ts` (`buildStartedCampaign`).
- Update: `README.md` (campaign authoring: template builder + template→instance→session).
