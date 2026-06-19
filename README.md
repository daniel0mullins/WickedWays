# Wicked Ways

![Wicked Ways](src/assets/images/wicked+ways.png)

A type-safe, turn-based tabletop RPG engine written in TypeScript. Wicked Ways models
a party-based horror campaign: a Game Master and player characters take turns across a
procedurally generated dungeon, fighting mobs, looting containers, talking to NPCs, and
accumulating damage across three interlocking stats. Game rules are enforced both by the
type system (branded IDs, hidden state) and at runtime (lifecycle guards that throw on
illegal moves).

## Documentation site

Full docs are published to GitHub Pages at
**<https://daniel0mullins.github.io/WickedWays/>** — a prose guide (this README,
rendered) plus an API reference generated from the source TSDoc. The site is
built with VitePress + TypeDoc and lives in `docs-site/`. Work on it locally with:

```bash
pnpm docs:dev       # serve the site with hot reload
pnpm docs:build     # production build into docs-site/.vitepress/dist
```

It deploys automatically on every push to `main` via `.github/workflows/docs.yml`.

## Core concepts

### Campaign

[`Campaign`](src/lib/campaign.ts) drives the turn loop and owns the campaign lifecycle:

- It tracks a `party` of player characters, a `gm` (always one of the party members), the
  current `round`, and `maxRounds` (default `100`).
- **Lifecycle:** `beginCampaign()` validates that the party is non-empty and that the GM is
  a member, then starts the campaign; `endCampaign()` finishes it. `nextPlayer()` advances
  the active character and ends the round once everyone has acted; the campaign auto-finishes
  when `round` reaches `maxRounds`.
- **Membership:** `addPlayer()` and `leaveCampaign()` adjust the party during play (the GM
  cannot leave), and `transfer()` hands the GM role to another member mid-campaign.
- The `gm` may only be assigned during setup; once the campaign has begun, the GM can only be
  changed via `transfer()`.
- Every illegal operation (acting before `beginCampaign()`, beginning twice, a GM leaving,
  etc.) throws a `ProceduralViolation`.

### Characters

The character hierarchy is layered so shared behavior lives in one place:

```
Character
├── Combatant (abstract)        adds attack()
│   ├── PlayerCharacter         joinCampaign, loot interaction, move action
│   └── Mob                     drops, escape()
└── NonPlayerCharacter          dialogue trees
```

- [`Character`](src/lib/character/character.ts) is the base: it holds `stats`, an `inventory`,
  a `campaign` reference, the current room, status effects, and the action-budget machinery.
  It implements the item-holder contract (`addToInventory` / `removeFromInventory`),
  `move(room)`, `takeDamage(...)`, crafting and gear (`craft`, `repair`, `equip`, `unequip`),
  the keyring (`transferKey`, `consumeKey`), and the turn lifecycle (`startTurn` / `endTurn`).
- [`Combatant`](src/lib/character/combatant.ts) adds `attack(target)` (see Combat below) and
  is shared by player characters and mobs.
- [`PlayerCharacter`](src/lib/character/player-character.ts) adds `joinCampaign()` and
  co-located loot interaction: `openLootBox`, `takeFromLootBox`, `putInLootBox`.
- [`Mob`](src/lib/character/mob.ts) is an enemy with a smaller default budget (2 actions,
  2 inventory slots), a `drops` list, and `escape()` — a Health-gated roll (see Mob encounters
  below). It also tracks an `origin` (`"room"` / `"campaign"` / `"unbound"`) that controls
  whether it drops key items on defeat.
- [`NonPlayerCharacter`](src/lib/character/non-player-character.ts) stays on `Character`
  directly and exposes `dialogue(prompt?)` over a list of dialogue blocks.

### Character archetypes

Player characters choose an [`Archetype`](src/lib/archetype.ts) during setup. Archetypes are
authored, declarative descriptors registered on the campaign via `Campaign.registerArchetype`
(idempotent by id, like recipes), and a character adopts one with
`PlayerCharacter.selectArchetype(id)`. Selecting an archetype modifies the character's baseline
exactly once: `statModifiers` are added to the base stats, `inventorySlots` adjusts inventory
capacity (floored at 0), and `immunities` become a standing passive trait — a new source unioned
with equipped-gear immunities (Panic/Fear/Confused only; KO is never immunizable).

Selection is **once-only** and **setup-only** (it throws after the campaign begins), and
`Campaign.beginCampaign()` throws unless **every** party member has chosen an archetype — the same
shape as the existing GM-membership requirement.

### Rooms, the map, and scenes

- A [`Room`](src/lib/room.ts) has a description, a `loot` map, an `exits` map keyed by compass
  `Direction`, occupants, and a `spawnModifier` (default 1; 0 = never spawns) that scales the
  campaign's base encounter chance. `Room.placeMob` seats a mob as a room-attached resident
  (origin `"room"`), enabling key-item drops on defeat. Entering or exiting a room fires any
  [`Scene`](src/lib/scene.ts) registered for that phase.
- [`buildMap(rooms, options)`](src/utils/build-map.ts) wires a list of rooms into a connected
  dungeon via a randomized **spanning tree** (every room reachable, `n - 1` edges). Exits are
  bidirectional (north↔south, etc.), a room is never connected to itself, and no room exceeds
  8 exits. `extraConnections` adds loops/shortcuts (an absolute count, or a fraction of `n - 1`
  when between 0 and 1), `requiredConnections` pins specific room pairs as direct neighbors
  before the tree is laid down (best-effort: an impossible pair is skipped), and an injectable
  `rng` makes generation deterministic.
- A `Scene` runs its `script(room, state)` only when the trigger phase (`"enter"` / `"exit"`)
  matches **and** all of its `preconditions` pass — preconditions short-circuit on the first
  failure. Each scene owns a private, typed **state bag** (seeded by `initialState`, empty by
  default) that persists across room visits for the life of the scene: the `script` may mutate
  it and `preconditions` read it (read-only), enabling fire-once events, world-state flags, and
  visit counters. The state is internal to the scene — nothing outside reads it.

### Darkness & light

- A [`Room`](src/lib/room.ts) can be authored **dark** (the trailing `dark` constructor flag,
  fixed at authoring; non-dark rooms are always lit). A dark room conceals its contents until lit,
  but its **exits stay visible** — navigation always works, so a party is never trapped by the
  dark.
- A **light source** is any [`Item`](src/lib/inventory.ts) with `emitsLight`. A light is active
  either **carried** (equipped in a hand by an occupant) or **placed** in the room
  (`Room.lightSources`, managed through the `ADD_LIGHT_SOURCE` / `REMOVE_LIGHT_SOURCE` seams).
  Lights are **persistent** — there is no fuel or burn-down; a placed light keeps a room lit
  regardless of occupancy.
- `Character.placeLight(item)` moves a held light into the room; `takeLight(item)` returns a placed
  light to inventory. Both are **free** actions (no budget tick, no history). `Room.isLit` is
  derived, not stored: a non-dark room is always lit; a dark room is lit iff it holds a non-broken
  placed light **or** an occupant carries an equipped, non-broken light.
- **The targeting gate.** In an unlit room, `attack`, `takeFromLootBox` (looting), and `harvest`
  throw [`ProceduralViolation`](src/lib/util.ts) (via `requireVisibleTarget`) — you can't hit, loot,
  or mine what you can't see — *unless* the actor `seesInDark`. Movement and the light actions
  themselves are **never** gated, and `openLootBox` (merely viewing contents) is **not** gated:
  concealment of the description / occupant / loot lists is a **renderer** concern driven by the
  `visibility` cue, while the underlying data model stays fully intact.
- **Light-averse mobs** (`lightAverse`) thrive in darkness: their `seesInDark` is true (so the gate
  never blocks them, even in the pitch dark), but they take `LIGHT_VULNERABILITY` (×1.5) amplified
  damage while their room is lit. Lighting a dark room therefore both *enables* the party to target
  the mob and *punishes* the mob for being in the light.
- A `visibility` presentation cue (`{ room, lit }`) fires when a character enters an unlit room, and
  when a light action flips a dark room's lit state. See **Presentation assets & cues** below.
- **Non-goals:** no torch fuel or burn-down (lights are permanent); exits are never hidden; there is
  no player-side darkvision (only `lightAverse` mobs see in the dark); and darkness does not affect
  encounter spawn rates.

### Presentation assets & cues

The engine is pure logic, but it carries optional hooks for a host renderer/audio layer
(a "Play Surface"). Every presentable entity — characters, [`Room`](src/lib/room.ts),
[`Item`](src/lib/inventory.ts), [`Loot`](src/lib/loot.ts), and material caches — accepts an
optional [`Presentation`](src/lib/presentation.ts) descriptor (`{ image?, sound? }`, where each
value is an opaque host-interpreted `AssetRef`). The host reads `presentation.image` when it
draws an entity.

Sounds are delivered as a push **cue stream**: subscribe with `Campaign.onCue(handler)` (and
`offCue`). The engine emits an `action` cue for every recorded action (move, pickUp, attack, …),
an `encounter` cue the first time a character meets a given mob (once per character/mob pair,
covering both spawned and resident mobs), and a `visibility` cue (`{ room, lit }`) when a character
enters an unlit room or a light action (`equip`/`unequip`/`placeLight`/`takeLight`) flips a dark
room's lit state — the renderer uses it to reveal or conceal the room's contents (the data model is
never hidden). The `action` and `encounter` cues carry a pre-resolved `sound`: the involved
entity's sound wins (a chest's coins on a loot pickup, a hobgoblin's growl on encounter), falling
back to the campaign's `actionSounds` default for that action kind (e.g. `move → marching`), else
none. The `visibility` cue carries no `sound` (it drives reveal/conceal, not audio). Subscriber
errors are isolated so a faulty handler can't disrupt the turn loop.

### Loot and inventory

- [`Loot`](src/lib/loot.ts) is a fixed-capacity container (default: initial contents + 2 slots).
  `stowItem` throws `ContainerFullException` once full; `removeItems` extracts items by id.
- [`Item`](src/lib/inventory.ts) carries a type (weapon, armor, accessory, consumable,
  throwable, key), recipe, modifier, target stat, and properties
  (equippable/equipped/destroyable/usable), plus actions: `pickUp`, `equip`, `unequip`,
  `transfer`, `use`, `destroy`. Optional authored fields layer on behaviour: `maxDurability`
  (gear that wears), `slot` / `twoHanded` (equipment slots and handedness), `keyCode` /
  `consumeOnUse` (keys), and `teaches` (a recipe imparted to the party on pickup).
- Both characters and loot boxes are **item holders**. State that must not be forged is
  symbol-keyed: ownership through `HELD_BY` (read-only) and `CLAIM`, durability through
  `SET_DURABILITY`, and equip/unequip through `EQUIP` / `UNEQUIP` — so external code can't
  silently re-point a holder, refill durability, or bypass slot capacity.

### Codex

The **Codex** is a party-wide record of every distinct kind of thing the party has
encountered: mobs, items, keyring keys, rooms, recipes, and material types. It is owned by
the campaign and consultable at any time by any player via [`campaign.codex`](src/lib/codex.ts)
(read-only); recording costs no action — it is a passive side-effect of play.

Each entry stores a **frozen snapshot** of the thing's stable, descriptive fields (including
any `presentation` image/sound, so a host can render it without the live entity) plus a
**first-seen stamp**: the round, the party character who first encountered it, and the room
where (some discoveries are non-spatial). Entries are tracked by *kind*, not by instance —
every "Goblin" is one mob entry, every "Rusty Sword" one item entry — and are first-write-wins,
so the original first-seen stamp survives re-encounter. Mob entries carry full stats (a
bestiary); keys are tracked separately from regular items.

Encounters are recorded at the natural moments: entering a room (the room, plus any active
mobs in it), picking up or being handed an item or key, discovering a recipe, and gaining
materials by harvesting a cache or defeating a mob that drops them. A mob material drop with
no resolvable defeater is attributed to the party (no character). Only party player characters
populate the Codex; recording is silent and never throws (a non-party or repeat encounter is a
no-op), so it can never break the turn loop. Recipes passed to the `Campaign` constructor's
`knownRecipes` are seeded the same way, so they appear in `codex.recipes` from the start as
round-0, party-attributed entries (no character/room) — the Codex can be non-empty before play.

Read it via `campaign.codex`: `mobs`, `items`, `keys`, `rooms`, `recipes`, `materials` (each
sorted by name), `all` (every entry, discovery order), `get(kind, key)` (a single entry), and
`size`. Recording is gated behind the `RECORD_ENCOUNTER` symbol seam so scene/external code
cannot forge entries. Discovery/completion tracking (e.g. "12 of 30 materials found") is
intentionally **not** part of the Codex — it is left to a separate future achievements feature,
which can read the Codex's structured entries.

## Key mechanics

### Action budget

Each character has an `actionsPerRound` budget (default 3 for player characters, 2 for mobs).
Only methods registered in the character's `isActionMap` count against it — methods register
themselves by identity (e.g. `move`, `attack`, `escape`, `addToInventory`,
`removeFromInventory`). `recordAction(fn)` ignores unregistered functions and, once the budget
is spent, automatically calls `endTurn()`. Notably, `takeDamage` is **not** a recordable
action — taking a hit never consumes your turn.

### Stats and damage mitigation

Characters have three stats — **Health**, **Sanity**, and **Energy** — and each is mitigated by
another in a cycle:

| Damaged stat | Mitigated by |
|--------------|--------------|
| Health       | Sanity       |
| Sanity       | Energy       |
| Energy       | Health       |

Equipped, intact armor whose `stat` matches the attacked stat first subtracts its `modifier`
from the incoming strength (floored at 0); the remainder is then scaled by the *mitigating* stat
(max value 10):

```
mitigated   = max(0, attackStrength − armorModifiers)
finalDamage = mitigated × (10 − mitigator) × 0.2
```

So a fully-rested mitigator (10) absorbs all damage, while a depleted one (0) doubles it. Each
armor piece that absorbs a hit loses 1 durability and stops mitigating once it breaks (see
Durability below).

### Status effects

Statuses are triggered by stat thresholds (using effective stats — base plus any equipped-accessory bonuses):

- **KO** — Health ≤ 0
- **Panic** — Sanity ≤ 0
- **Fear** — 0 < Sanity < 5
- **Confused** — Energy ≤ 0 (with a (0, 1] hysteresis band so it does not flicker at the boundary)

A character with no active afflictions reports `isNormal === true`.

#### Consequences

Once triggered, statuses impose hard rules enforced by [`Afflictions.gate`](src/lib/character/afflictions.ts)
inside `Character.attemptAction`:

| Status | Allowed | Blocked |
|--------|---------|---------|
| **KO** | nothing — every gated action throws; `use` also throws | everything |
| **Panic** | `move`, `use` | all other actions |
| **Fear** | everything except `move` | `move` |
| **Confused** | all actions — but each has a 50 % chance to **fizzle** | — |

A **fizzle** (Confused) means the action has no effect but the attempt still consumes a budget slot and is
recorded in history as a `fumble`. Free actions (craft, equip, repair …) that fizzle return `null` / void
and still record a `fumble` to history — they just do not consume a budget slot. KO supersedes all other
statuses: when Health drops to ≤ 0 the engine clears Panic, Fear, and Confused immediately so only KO
remains active.

#### Self-clearing

Panic, Fear, and Confused are *latched* — they persist even if the stat that triggered them recovers
partially. Each status has two clearing paths:

1. **Stat recovery:** when the effective stat rises back above its threshold (e.g. Health above 0),
   `applyFromStats` clears the status immediately.
2. **Early shake-off (per-turn roll):** at the start of each of the character's turns,
   [`Afflictions.onTurnStart`](src/lib/character/afflictions.ts) rolls a
   [`roll(100, rng)`](src/lib/dice.ts) d100 against an escalating threshold:

   | Status | 1st turn | 2nd turn | 3rd turn | Guaranteed by |
   |--------|----------|----------|----------|---------------|
   | Fear | 40 % | 70 % | 100 % | turn 3 |
   | Panic | 20 % | 40 % | 60 % | turn 5 |
   | Confused | 15 % | 30 % | 45 % | turn 7 |

   A successful roll marks the status *shaken off* for the rest of that depressed episode; it does not
   re-trigger until the stat recovers past the threshold and drops again. Confused separately rolls its
   50 % per-action fizzle chance independently of the turn-start shake-off.

Status lifecycle is managed by the [`Afflictions`](src/lib/character/afflictions.ts) unit, which
`Character` delegates to. All randomness goes through the injected `rng` (a `() => number` constructor
option); passing a seeded RNG makes every roll deterministic for tests.

#### Immunity

Passive and timed immunity both cover Panic, Fear, and Confused only — KO can never be immunized:

- **Passive (equipped item):** an [`IItem`](src/lib/inventory.ts) with an `immunities?: Status[]` field
  confers immunity to those statuses while the item is equipped and intact. Consulted on every
  `applyFromStats` reconciliation, exactly like the accessory effectiveStat bonuses.
- **Timed (consumable):** an `IItem` with a `grantsImmunity?: { statuses: Status[]; turns: number }` field
  grants immunity for `turns` of the holder's turns when the item is used. The grant goes through the
  [`GRANT_IMMUNITY`](src/lib/inventory.ts) symbol seam (unforgeable by stray code); the timer ticks down
  in `Afflictions.onTurnStart` and the active status is cleared on grant.

Both fields are plain declarative `Item` descriptor fields — no factory or subclass required.

### Combat

`Combatant.attack(target)` collects the attacker's *equipped weapons*, sums each weapon's
modifier onto the stat it targets, and applies the result to the defender via `takeDamage`
(which runs the mitigation above). With no equipped weapon, an attack deals 1 point of
unarmed Health damage. Because weapons occupy hand slots (see Equipment below), an attacker
fields at most two one-handed weapons — or one two-handed — so the summed modifier is
naturally bounded.

### Mob encounters & loot

#### Mob origin

A mob's **origin** (`"room"` | `"campaign"` | `"unbound"`) gates which drops it releases on
defeat. Room-attached mobs (seated via `Room.placeMob`, which sets origin `"room"`) may drop
key items; campaign-roving mobs (spawned by the encounter table, origin `"campaign"`) never do.
A freshly constructed mob starts as `"unbound"` until the engine sets its origin.

#### Drop-on-defeat

When a mob's Health hits 0, its `onKnockOut` hook fires exactly once:

1. **Material drops** — any `materialDrops` in the mob's options are deposited into the
   campaign's shared material pool via `DEPOSIT_MATERIALS`.
2. **Item loot box** — held items are relinquished and placed into a fresh `Loot` box
   (named `"<mob>'s remains"`) which is added to the mob's current room. If the mob has
   no items and no keys to drop, no box is created.
3. **Key items** — if the mob is room-attached (`origin === "room"`), keys on its keyring
   are also stashed into the box via the `STASH_DROP` seam (past normal capacity, bypassing
   the key-exclusion guard on regular `stowItem`). Campaign-roving mobs never drop keys.

#### Escape

`Mob.escape()` is a budgeted action gated by Health. The success threshold is:

```
threshold = clamp(baseEscapeChance + effectiveStat(Health), 0, 100)
```

`baseEscapeChance` defaults to 50. A `roll(100)` at or below the threshold — **and** at
least one exit present — counts as a successful escape; the mob then moves through a randomly
chosen exit (gating suppressed, so the move does not consume a second action). Whether the
escape succeeds or fails, the action is recorded and the budget ticks.

#### Roving formations and the encounter table

`Campaign.addFormation` registers a weighted [`Formation`](src/lib/encounter-table.ts) — a
named factory (`build`) and a positive `weight`. The table rejects any formation whose mobs
carry key-item drops (roving mobs may not drop keys). `Campaign` is constructed with an
optional `baseEncounterChance` (default 20, on a 0–100 scale) and an injectable `rng`.

When a player character moves into a room, `PlayerCharacter.move` calls `Campaign.maybeSpawn`.
The spawn check runs only on the **first visit** to each room (the room is marked visited
regardless of outcome) and is suppressed when an active (non-KO) mob is already present. If
the check proceeds:

```
threshold = clamp(baseEncounterChance × room.spawnModifier, 0, 100)
roll(100) <= threshold  →  weighted formation chosen  →  mobs built + placed (origin "campaign")
```

A room with `spawnModifier = 0` can never spawn an encounter. Blocked or fizzled moves (e.g.
a Confused character whose move fizzles) do not reach the destination room and therefore do
not trigger a spawn check.

### Materials and crafting

Crafting components are pooled at the **campaign** level and shared party-wide, not held per
character. The pool ([`MaterialMap`](src/lib/inventory.ts)) is fed only through sanctioned paths
— destroying (scrapping) an item deposits its `recipe`, harvesting a material cache, and one-time
`Campaign.claimMaterials(claimId, …)` grants (idempotent by `claimId`, so a cache can't be
farmed). `Campaign.materials` exposes a read-only copy; `canAfford` / `withdrawMaterials` gate
spending, and a component is deleted from the pool when it reaches zero. All deposits go through
the `DEPOSIT_MATERIALS` symbol.

`Character.craft(recipeId)` turns a known recipe into an item and is a **free** action (no budget
tick, no history); it returns `null` if the attempt fizzles while the character is Confused. A
[`CraftingRecipe`](src/lib/inventory.ts) is discriminated into two tracks: a
**materials** recipe withdraws from the pool, while a **keys** recipe consumes keys by code
(validated atomically — every code must be fully available before any key is spent). Recipe
knowledge is party-wide: picking up an item whose `teaches` field names a recipe calls
`Campaign.discoverRecipe()` (idempotent by id), so the whole party can then craft it.

### Durability and repair

Gear authored with `maxDurability` wears with use. Armor loses 1 durability each time it absorbs
a hit and stops mitigating once `isBroken` (durability 0). Durability is read publicly but written
only through the `SET_DURABILITY` symbol, which clamps to `[0, maxDurability]`. `Character.repair(item)`
restores a held, damaged item to full for a material cost proportional to the missing fraction —
`ceil(recipe[c] × missing ∕ maxDurability)` per component — drawn from the campaign pool. Repair is
**free** and throws if the item is unheld, has no durability, is already full, or the party can't
afford it.

### Equipment slots and handedness

Equipping is bounded by named anatomy rather than an unlimited flag. An item declares a slot
**kind** ([`SlotKind`](src/lib/equipment.ts): hand, finger, wrist, head, torso, legs, feet); a
character has discrete, single-occupancy **named slots** ([`EquipmentSlot`](src/lib/equipment.ts))
— head/torso/legs/feet, two wrists, two hands, and two ring fingers per hand.
`Character.equip(item, targetSlot?)` validates that the item is held, equippable, and has a slot
kind, then fills the first free named slot of that kind (or an explicit `targetSlot`),
**auto-swapping** the occupant when none is free. A `twoHanded` weapon spans both hand slots, and
equipping a one-handed weapon displaces a worn two-hander; `Character.unequip(item)` clears every
slot the item occupies. Both are **free** and leave displaced items in inventory, unequipped.

Occupancy lives in the character's slot map but mirrors `properties.equipped`, so the combat
filters are unchanged — and now naturally capped. The item's own `actions.equip` routes a slotted
item through `Character.equip` (finishing via the `EQUIP` / `UNEQUIP` symbols), so slot capacity
can't be bypassed even through the item's own API.

### Keys

Keys ([`createKey`](src/lib/inventory.ts)) are a distinct item type that lives on a character's
keyring rather than in inventory slots. A key carries a `keyCode` matched by scene/lock gates and a
`consumeOnUse` flag. Keys are **transfer-only**: the generic drop path rejects them, so the only way
a key changes hands is `Character.transferKey(key, recipient)` (recorded as a pickup on the
recipient). `Character.consumeKey(key)` spends a key — removing it from the keyring and unhoming it
— used by scene scripts when a `consumeOnUse` gate is satisfied.

### Dialogue

`NonPlayerCharacter.dialogue(prompt)` returns the concatenated responses of every matching
dialogue block. Blocks match either **exactly** (case-insensitive whole-prompt match) or
**fuzzily** (every word in the trigger set appears somewhere in the prompt), and each block may
carry a `precondition(character)` gate. With no prompt it returns the NPC's initial line.

### Serialization (save/load)

A whole in-play campaign round-trips through a plain-data `CampaignSnapshot`
([`src/lib/serialization/`](src/lib/serialization/)). `serializeCampaign(campaign)` walks the live
object graph — the party plus every room reachable from a party member's `currentRoom` via `exits`
(BFS), and those rooms' occupants, loot, material caches, and all characters' inventory/keyring/
equipment items — and emits a self-contained, JSON-friendly snapshot (`schemaVersion`, campaign
core state, rooms, characters, items, loot, material caches, codex). Each entity exposes a gated
`[SERIALIZE]` seam; a non-key item lacking a registered behavior key throws there, so an
unrestorable snapshot fails fast at save time. (Rooms that no party member occupies and that
nothing links to are not captured — reachable-from-party is the playable world for save/load.)
Affliction state (active statuses, per-status turn counters, shaken-off set, and immunity stacks)
is captured in full; a restored campaign is indistinguishable mid-turn from the original.

**Behavior keys.** Closures can't be serialized; instead, every `Scene`, non-key `Item`,
`CraftingRecipe`, and `EncounterTable` formation carries a `behaviorKey` — a stable string that
maps back to its author-supplied constructor at restore time. Key items (`keyCode` set) are exempt:
they are rebuilt from their stored `name`/`keyCode`/`consumeOnUse` fields via `createKey` without
a registry lookup.

**`CampaignRegistry`** is the author-side lookup table that `deserializeCampaign` requires. It
holds four namespaces registered before the first `deserializeCampaign` call:

| Method | What it registers |
|---|---|
| `registerScene(key, behavior)` | `SceneBehavior` (preconditions + script) |
| `registerRecipe(key, recipe)` | `CraftingRecipe` |
| `registerFormation(key, behavior)` | `FormationBehavior` (mob-spawning factory) |
| `registerItem(key, factory)` | `() => Item` factory |

`deserializeCampaign(data, { registry, rng })` rebuilds the campaign in **two passes**. The
`rng` is re-injected fresh (never serialized); defaults to `Math.random` if omitted. Pass 1
constructs and indexes every entity with placeholder references (campaign shell → archetype/recipe
catalog → items → loot → caches → rooms → characters); pass 2 wires all cross-references through a
`HydrateContext` id→instance index. The catalog is restored before characters hydrate so a player
can resolve its archetype. Fail-fast throughout: an unknown `schemaVersion` is rejected by
`migrate`, and any dangling id reference throws from the `HydrateContext` resolvers. A restored
campaign keeps playing identically — the same turn position, acted-this-round set, materials,
claims, codex, and encounter table.

```ts
// 1. Register every behavior key before deserializing.
const registry = new CampaignRegistry();
registry.registerItem("sword", () => createSword());
registry.registerScene("ambush", ambushBehavior);
registry.registerFormation("wolf-pack", wolfPackFormation);
registry.registerRecipe("sword-recipe", swordRecipe);

// 2. Serialize an in-play campaign to a plain-data snapshot.
const snap = serializeCampaign(campaign); // throws if any behaviorKey is missing
const json = JSON.stringify(snap);

// 3. Deserialize — supply the same registry and a fresh rng.
const snap2 = JSON.parse(json) as CampaignSnapshot;
const restored = deserializeCampaign(snap2, { registry });
// restored is a live Campaign, identical to campaign at the moment of save.
```

## Multi-client sync

The same snapshot format powers multiplayer over an ordered, compare-and-swap log
([`src/lib/sync/`](src/lib/sync/)). Each client runs a `SyncCoordinator`, the seam that owns the
local campaign and is the only unit that changes for a future authoritative-server topology.

`coordinator.submit(command)` orchestrates: `Resolver.authorize` (lifecycle/turn/GM gate) → on pass,
snapshot `before` and build an `EntityIndex` from the same walk → `Resolver.apply` mutates the local
campaign (an illegal engine transition throws `ProceduralViolation`, which rebuilds `local` from
`before` and returns `{ rejected: true }`) → `DeltaComputer.diff(before, after)` → CAS
`transport.append({ seq, baseSeq, command, delta })`. On a stale base the append is rejected
(`{ conflict: true }`); the coordinator rebuilds from `before`, re-syncs to the new head, and the
caller retries. On success it returns `{ ok: true, seq, delta }`.

**Reject ≠ fizzle.** A rejection (`{ ok: false, rejected: true }`) means the command was illegal
(wrong turn, bad lifecycle state, or an engine constraint thrown by `ProceduralViolation`). A fizzle
is a legal action that simply had no mechanical effect (e.g. an attack that dealt 0 damage) — those
are accepted, produce a delta, and propagate normally.

Inbound, `start()` subscribes from `lastApplied + 1`; remote entries already incorporated (including
the client's own just-appended seq — `submit` advances `lastApplied` *before* the CAS append, so the
synchronous self-notification is genuinely skipped rather than relying on idempotency) are skipped,
the next in-order delta is applied to the replica via
`DeltaApplier` (which patches state and **never draws rng or runs game logic**, so replicas converge
deterministically with zero determinism burden), and gaps heal via `entriesSince`.
`SyncCoordinator.join(...)` brings a late client up to date from the transport's latest checkpoint
plus the deltas since.

Because a rejection or conflict swaps in a freshly deserialized `Campaign`, consumers must always read
state through `coordinator.campaign` and never cache the reference across a `submit`.

**`SyncTransport` seam.** The sync core depends only on the `SyncTransport` interface (append, head,
subscribe, loadSnapshot, putSnapshot). `InProcessTransport` drives tests. A real backend
(Firestore, WebSockets, etc.) and the authoritative-server topology are deferred — they are a thin
adapter behind this interface.

```ts
const transport = new InProcessTransport();
const host = new SyncCoordinator({ campaign, registry, transport });
host.start();
const result = host.submit({ kind: "move", actorId: active.id, roomId: dest.id });

// elsewhere / another client:
const replica = SyncCoordinator.join({ registry, transport });
replica.start();
```

## Notable patterns

- **Branded ID types** ([`brand.d.ts`](src/lib/brand.d.ts)) give `CampaignId`, `CharacterId`,
  `RoomId`, `ItemId`, `LootId`, `SceneId`, etc. distinct compile-time identities at zero runtime
  cost, so one kind of id can't be passed where another is expected.
- **Lifecycle guards** throw `ProceduralViolation` to keep the game in a legal state.
- **Hidden state** — item holders, status maps, and campaign progress are exposed through
  getters and symbol-keyed accessors rather than mutable public fields.
- **Turn events** — [`CharacterEvents`](src/lib/character/events.ts) lets handlers hook
  `onTurnStart` / `onTurnEnd` for future passive effects.

## Tech stack & workflow

- **Language:** TypeScript in `strict` mode with `NodeNext` module resolution and the extra
  `noUncheckedIndexedAccess` / `noImplicitOverride` guards.
- **Tests:** [Vitest](https://vitest.dev) — 446 tests across 20 files, including an end-to-end
  [`src/integration.test.ts`](src/integration.test.ts) that wires up a full campaign and runs
  the turn loop. Shared helpers live in [`src/test-utils.ts`](src/test-utils.ts).
- **Linting:** ESLint flat config with type-aware `typescript-eslint`.
- **Dependencies:** `uuid` for id generation; `type-fest` for utility types.

### pnpm scripts

| Script | Description |
|--------|-------------|
| `pnpm test` | Run the test suite once (`vitest run`) |
| `pnpm test:watch` | Run tests in watch mode |
| `pnpm test:coverage` | Run tests with coverage over `src/**` |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` / `pnpm lint:fix` | Lint (and autofix) |
| `pnpm checks` | Lint + typecheck + test, in sequence |
| `pnpm build` | Compile to `dist/` via `tsconfig.build.json` |

## Multiplayer client (comms sub-spec 3a)

The repo is a pnpm workspace. The pure engine lives at the root (`src/`); three
packages under `packages/` add real-time multiplayer:

- **`@wickedways/transport-shared`** — the engine-free WebSocket wire protocol
  (message types + validators). `command`/`delta`/`snapshot` payloads are opaque.
- **`@wickedways/server`** — a self-hosted WebSocket room server. Each campaign is
  a `Table` (the server-side coordinator: an ordered compare-and-swap log + the
  latest snapshot + connected participants + broadcast). The server orders and
  relays; it never runs game logic.
- **`@wickedways/client`** — a `WebSocketTransport` implementing the engine's
  `SyncTransport` over the server, plus a minimal dev harness.

A client resolves commands locally via `SyncCoordinator` (from the engine's sync
layer) and appends `{command, delta}` to its `Table` under compare-and-swap;
replicas apply the broadcast deltas. This is the **client-resolves** topology —
the server is a dumb relay, built so the authoritative-server promotion (moving
the resolver into `Table`) is a later, contained change.

### Running it

```bash
pnpm install
pnpm --filter @wickedways/server start      # ws://127.0.0.1:8787
pnpm --filter @wickedways/client dev        # http://localhost:5173
```

Open `http://localhost:5173/?c=demo` in two tabs. Act in one (e.g. **nextPlayer**);
both converge on identical state over the wire.

### Not yet included (later sub-specs)

Seat-ownership / network auth & presence (3b), text chat (3c), and A/V over WebRTC
(3d) all build on this backend. 3a is the transport-agnostic foundation: it does no
seat validation (trusted peers) and keeps no durable state across a server restart.
