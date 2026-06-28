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

Player characters may choose an [`Archetype`](src/lib/archetype.ts) during setup. Archetypes are
authored, declarative descriptors registered on the campaign via `Campaign.registerArchetype`
(idempotent by id, like recipes), and a character adopts one with
`PlayerCharacter.selectArchetype(id)`. Selecting an archetype modifies the character's baseline
exactly once: `baseStats` set the stats they name (a missing stat keeps its baseline of 10),
`inventorySlots` adjusts inventory capacity (floored at 0), and
`immunities` become a standing passive trait — a new source unioned
with equipped-gear immunities (Panic/Fear/Confused only; KO is never immunizable).

Selection is **once-only** and **setup-only** (it throws after the campaign begins). Whether an
archetype is required at `Campaign.beginCampaign()` depends on the campaign's catalog: with **none**
registered, archetypes are optional and a character with none keeps its base stats and slots; with
**exactly one** registered, it is auto-selected as the default for any member who hasn't chosen;
with **several** registered, every member must have chosen one explicitly or `beginCampaign()`
throws.

### Rooms, the map, and scenes

- A [`Room`](src/lib/room.ts) has a description, a `loot` map, an `exits` map keyed by compass
  `Direction`, occupants, and a `spawnModifier` (default 1; 0 = never spawns) that scales the
  campaign's base encounter chance. `Room.placeMob` seats a mob as a room-attached resident
  (origin `"room"`), enabling key-item drops on defeat. Entering or exiting a room fires any
  [`Scene`](src/lib/scene.ts) registered for that phase.
- A room's `loot` and `exits` are **optional at construction** (both default to none). Loot
  containers can be added or removed afterwards with `Room.addLoot` / `Room.removeLoot`, and a
  room authored without exits is wired up later by `buildMap`.
- [`buildMap(rooms, options)`](src/utils/build-map.ts) wires a list of rooms into a connected
  dungeon via a randomized **spanning tree** (every room reachable, `n - 1` edges). Exits are
  bidirectional (north↔south, etc.), a room is never connected to itself, and no room exceeds
  8 exits. `extraConnections` adds loops/shortcuts (an absolute count, or a fraction of `n - 1`
  when between 0 and 1), `requiredConnections` pins specific room pairs as direct neighbors
  before the tree is laid down (best-effort: an impossible pair is skipped), and an injectable
  `rng` makes generation deterministic. Connecting is best-effort, but reachability is enforced:
  if a room cannot be wired into the map (its component is fully saturated), `buildMap` throws a
  `ProceduralViolation` rather than leaving it stranded.
- A `Scene` runs its `script(room, state)` only when the trigger phase (`"enter"` / `"exit"`)
  matches **and** all of its `preconditions` pass — preconditions short-circuit on the first
  failure. Each scene owns a private, typed **state bag** (seeded by `initialState`, empty by
  default) that persists across room visits for the life of the scene: the `script` may mutate
  it and `preconditions` read it (read-only), enabling fire-once events, world-state flags, and
  visit counters. The state is internal to the scene — nothing outside reads it.
- An [`Exit`](src/lib/exit.ts) is a **first-class shared object** registered in _both_ rooms'
  `exits` maps under the appropriate compass directions. A single `Exit` instance represents both
  the north door in room A and the south door in room B — mutation (e.g. flipping `state.unlocked`)
  is visible from either side immediately.
  - **Traversal.** `Character.go(direction)` attempts the exit in that direction. If the exit's
    `preconditions` all pass, the character moves and any `passMessage` is emitted; if a precondition
    fails, movement is blocked and the exit's `failMessage` (if any) is emitted as a cue. A successful
    pass also runs the exit's optional `script(character, state)`, which may mutate the exit's persisted
    state and return a one-time narration line.
  - **Door behavior.** An exit can carry author-defined behavior: a list of `preconditions`, an optional
    `script`, and `passMessage`/`failMessage` strings. Doors that check for a matching key are a common
    pattern — the precondition checks the character's inventory (or the exit's own `state.unlocked` flag),
    and the script flips the flag permanently so subsequent characters pass without the key.
  - **Registry.** For serializable exits, register an [`ExitBehavior`](src/lib/exit.ts) under a stable
    key in the `CampaignRegistry` via `registry.registerExit(key, behavior)`, or via `defineRegistry`'s
    `exits` map. The `behaviorKey` is stored in the snapshot; on deserialization the preconditions and
    script re-bind from the registry (just as scenes do).
  - **Authoring.** When using [`authorTemplate`](src/lib/authoring/template-builder.ts) /
    [`TemplateBuilder`](src/lib/authoring/template-builder.ts), call
    `.exit(from, dir, to, { behaviorKey, name, initialState })` to wire a keyed door. The `name`
    field (e.g. `"Iron Door"`) is a display label readable by UIs; it survives serialize → deserialize.
    Plain exits (no `behaviorKey`) are just `.exit(from, dir, to)`.
  - **Serialization.** Exit state serializes natively — the persisted `state` object is included in
    the exit snapshot, so a door that was unlocked during play stays unlocked across save/reload.
    Exits without a `behaviorKey` carry an empty state and no behavior on restore.

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

The `@wickedways/play` browser surface builds a full procedural audio layer on this cue stream
(four SFX categories + a sanity-reactive ambient drone); see [`packages/play/README.md`](packages/play/README.md#audio).

### Loot and inventory

- [`Loot`](src/lib/loot.ts) is a fixed-capacity container (default: initial contents + 2 slots).
  `stowItem` throws `ContainerFullException` once full; `removeItems` extracts items by id.
- [`Item`](src/lib/inventory.ts) carries a type (weapon, armor, accessory, consumable,
  throwable, key), recipe, modifier, target stat, and properties
  (equippable/equipped/destroyable/usable), plus actions: `pickUp`, `equip`, `unequip`,
  `transfer`, `use`, `read`, `destroy`. Optional authored fields layer on behaviour: `maxDurability`
  (gear that wears), `slot` / `twoHanded` (equipment slots and handedness), `keyCode` /
  `consumeOnUse` (keys), `teaches` (a recipe imparted to the party on pickup), and `lore`
  (evocative backstory text).
- **Reading** is a first-class, non-consuming interaction. `Character.read(item)` is free
  (no budget tick, no history), emits the item's `lore` as a cue, and fires the item's
  optional `onRead` hook — so the item stays in inventory and can be read again. Unlike `use`
  (which always consumes), `read` is the seam for examinable flavour and for read-triggered
  side effects (e.g. a cursed tome that drains Sanity via `onRead`).
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
(which runs the mitigation above). With no equipped weapon, an attack falls back to the
combatant's **natural attack** — `naturalAttack: { stat, power }`, defaulting to a 1-point
Health jab. `Mob` exposes this as an authorable trait (`.mob(name, { …, naturalAttack })`),
so a resident horror can claw Sanity, batter Health, etc.; it is serialized with the mob.
Because weapons occupy hand slots (see Equipment below), an attacker fields at most two
one-handed weapons — or one two-handed — so the summed modifier is naturally bounded.

Note the mitigation interaction: a defender whose *mitigator* stat for the attacked stat is
≥ the cap fully absorbs the hit (multiplier `max(0, MAX_STAT − mitigator) × …` → 0). So a
natural attack only lands on a target with a sub-cap mitigator for that stat — power alone
can't punch through full mitigation.

### Custom mechanics

The custom-mechanics system lets a campaign author layer typed, namespaced game
rules on top of the core engine — a doom counter, a fire-ward, a sanity spiral —
without touching engine internals.

#### Hook taxonomy

Every mechanic implements the `Mechanic<S, Cfg, A>` interface. Hooks fall into two
categories:

- **Reducers** — `onRoundStart`, `onRoundEnd`, `onTurnStart`, `onTurnEnd`,
  `onAction` — react to lifecycle events and return an `Effect[]`. Effects are
  collected across all enabled mechanics and applied in a single pass after all
  reducers have run (collect-then-apply). Reducers may not observe each other's
  effects mid-event, so the order of application is deterministic.
  `onRoundEnd` observes `h.view.round` at its **pre-increment** value (round N);
  `resolveOutcome` runs afterward at N+1; `onRoundStart` for round 1 fires from
  `beginCampaign` while the round counter is still 0.
- **Transformers** — `modifyDamage(d: DamageView, h: HookCtx): TransformResult` —
  intercept an in-flight damage value before it reaches the character and return an
  adjusted amount. The transformer runs on every `takeDamage` call and may return
  either a plain `number` (pass-through to the next transformer) or
  `{ value, final: true }` to lock the amount, halt the chain, and emit a
  diagnostic cue.

A transformer's `final` short-circuit is the only reducer/transformer
short-circuit in v1; reducer pre-emption is deferred.

#### The `Effect` vocabulary (guardrail A)

Mechanics communicate intent through a **closed union** of five effect kinds — they
cannot reach raw setters:

| Kind | What it does |
|---|---|
| `{ kind: "damage"; target; amount }` | `Health −amount` (floored at 0) |
| `{ kind: "heal"; target; amount }` | `Health +amount` (floored at 0) |
| `{ kind: "adjustStat"; target; stat: "sanity"\|"energy"; delta }` | Sanity or Energy ±delta via `ADJUST_STAT` |
| `{ kind: "grantImmunity"; target; turns }` | Grant all-status immunity for `turns` rounds (floored at 0) |
| `{ kind: "cue"; cue }` | Emit a `{ kind: "mechanic", cue }` presentation cue |

All magnitude arguments are floored at 0 before being applied; `adjustStat` passes
the delta sign through unchanged (the stat accumulator floors separately).

#### Hook contexts

Every hook receives a `HookCtx<S>`:

- `state` — the mechanic's own `JsonObject` state; **mutate in place**
- `view` — a read-only `CampaignView` (round, maxRounds, party as `CharacterView[]`,
  rooms); no engine handles, no clock, no IO (guardrail B)
- `rng()` — the campaign's injected RNG function
- `roll(n)` — integer in `[1, n]` drawn from `rng`

`TurnCtx` adds `actor: CharacterView`. `ActionCtx` adds `action: ActionDetail`.
`CharacterView.hasEquipped(key)` returns `true` when an equipped item was
registered under the given registry key (matched via the item's `behaviorKey`).

#### Guardrails

Four guardrails protect engine integrity, in priority order:

- **A — Integrity:** the closed `Effect` union and clamping appliers route every
  state change through unforgeable symbol seams; mechanics can't reach raw setters.
- **B — Determinism:** hooks receive a read-only view projection with no engine
  handles, clock, or IO; all randomness flows through the injected `rng`.
- **D — Termination:** collect-then-apply (reducers can't observe each other's
  effects mid-event), a hard `MAX_EFFECTS_PER_EVENT = 64` cap per mechanic per
  event that throws `ProceduralViolation`, and non-re-entrancy (applying effects
  does not re-enter dispatch).
- **C — Balance:** advisory only; no runtime enforcement.

#### Opt-in and precedence

Mechanics are inert unless a campaign opts in via `.useMechanic(key, config?)` on
the `TemplateBuilder`. The opt-in list is static config fixed at authoring time —
it cannot change mid-play. **Opt-in order is precedence**: earlier mechanics' hooks
run first, so an earlier transformer's `{ value, final: true }` pre-empts all
later ones.

#### Custom actions

A mechanic may expose named actions via `actions: Record<A, CustomAction<S>>`.
Each `CustomAction` has a `run(h: ActionCtx<S>)` method and an optional `cost`
(default 1, reserved for future budget-multiplier support — in v1 every action
costs 1). A player character invokes them via
`character.useMechanicAction(mechanicKey, actionKey)`, which is a **budgeted**
action (counts against the per-round action budget by method identity) routed
through `Campaign[INVOKE_MECHANIC_ACTION]`.

#### Serialization (schema v5)

Only `{ key, state }` persists per mechanic — behavior is not serialized.
On hydrate, `registry.mechanic(key)` re-binds the behavior; if the key is absent
the deserializer throws `ProceduralViolation`. State is a `JsonObject`, namespaced
by key. A v4→v5 migration injects `mechanics: []` into old snapshots, so existing
saves round-trip cleanly.

#### v1 exclusions

> - **No reducer short-circuiting (deferred).** Reactive hooks are batched and
>   non-pre-emptive in v1; one reducer cannot cancel another's effects. Only
>   *transformers* may short-circuit (see Decisions). A concrete reducer pre-emption
>   case can revisit this later.
> - **No "break-glass" effects in v1.** The `Effect` vocabulary excludes granting/
>   destroying items, forging ownership, ending the campaign (victory conditions own
>   win/lose), spawning mobs (mob authoring owns that), and adding new `Status`
>   values (the `Status` enum stays fixed; mechanics influence afflictions only
>   indirectly via the existing stat-derivation).
> - **No second transformer beyond combat in v1.** The taxonomy leaves room for
>   `modifyMitigation` / `modifyLootRoll` / `modifyEncounterChance`, but only
>   `modifyDamage` ships now.
> - **No unified single-damage-pipeline refactor.** Routing *all* damage (normal
>   attacks included) through one effect-mediated chokepoint is a real engine
>   improvement but a separable follow-up spec; this design stays compatible with it.
> - **No mob-death / encounter-spawn hooks.** Those stay in mob authoring. (If they
>   are not fully expressible there today, that is a separate gap, out of scope here.)
> - **No hard determinism sandbox.** Purity is a *contract* (like conditions/scenes),
>   enforced by giving hooks everything they need on `h`, documentation, and the
>   existing ambient-randomness lint rule — not a runtime jail.
> - **No mid-play opt-in mutation.** The mechanic set is static config fixed at
>   authoring, like `rng` and the condition lists.

#### Authoring example

The following condensed example is distilled from the `describe("Custom mechanics", …)`
integration test (`src/integration.test.ts`), which is the ground-truth reference.

```ts
// Imports are repo-relative: the engine has no barrel export — import directly from src/lib/…
import type { JsonObject, Mechanic } from "./lib/mechanics/mechanic";
import { defineRegistry } from "./lib/authoring/registry";
import { authorTemplate } from "./lib/authoring/template-builder";
import { startSession } from "./lib/authoring/orchestration";

// 1. Typed state for the doom-clock mechanic
interface DoomState extends JsonObject {
  doom: number;
  doomAt: number;
}

// 2. Doom-clock: increments `doom` each round; emits a cue at the threshold
const doomMechanic: Mechanic<DoomState, { doomAt: number }> = {
  initialState: (cfg) => ({ doom: 0, doomAt: cfg.doomAt }),
  onRoundEnd(h) {
    h.state.doom += 1;
    const roll = h.roll(6);          // uses injected rng → deterministic
    if (h.state.doom >= h.state.doomAt) {
      return [{ kind: "cue", cue: { text: `Doom strikes! (roll: ${roll})` } }];
    }
  },
};

// 3. Fire-ward: if the damage target has the "ward" item equipped, zero the hit
//    and halt the transformer chain (no later mechanic sees the damage)
const fireWardMechanic: Mechanic<JsonObject, void> = {
  initialState: () => ({}),
  modifyDamage(d, h) {
    const target = h.view.party.find((p) => p.id === d.target);
    if (target?.hasEquipped("ward")) {       // "ward" is the item's behaviorKey
      return { value: 0, final: true };      // lock + halt
    }
    return d.amount;                         // pass through unchanged
  },
};

// 4. Register and opt in (order = precedence; fire-ward runs before doom)
const reg = defineRegistry({
  items:     { ward: () => makeWard() },
  mechanics: { "fire-ward": fireWardMechanic, doom: doomMechanic },
});

const campaign = startSession(
  authorTemplate("Crypt", reg, { maxRounds: 10 })
    .room("start", { description: "A cold crypt." })
    .startRoom("start")
    .useMechanic("fire-ward")              // opt in; runs first
    .useMechanic("doom", { doomAt: 3 }),   // opt in; runs second
  { players: [{ name: "Hero", archetype: "scout" }], gm: 0 },
);
```

After round 3 (`doomAt: 3`) the doom-clock emits its cue. When the Hero has the ward
equipped and takes damage, `modifyDamage` returns `{ value: 0, final: true }` — the
hit is zeroed and no further transformer runs. After a serialize/hydrate cycle the
doom counter is preserved (`snap.campaign.mechanics` contains `{ key: "doom", state:
{ doom: 2, doomAt: 3 } }`) and the mechanic continues firing from the restored state.

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

## Campaign authoring

The authoring layer lets you define a reusable campaign **template** — a complete
world with rooms, exits, mobs, loot, material caches, archetypes, and starting
recipes — and then turn it into a live, playable **instance** once players join. The
two-stage split means the same template can seed any number of parallel runs, and the
builder validates the whole description before constructing a single engine object.

### Templates vs. instances

A **template** is a player-less, not-yet-begun description of the game world. It is
author-controlled and reusable: no players are joined, `beginCampaign` has not been
called, and the state that exists (rooms, mobs, loot, caches, pre-seeded recipes and
materials) is stable and can be snapshotted to a `CampaignSnapshot` via `.toSnapshot()`.

An **instance** is a copy of that template world with a fresh campaign id (produced by
`instantiate`), ready to receive players. A **session** is an instance that has been
populated with players, had a GM assigned, and had `beginCampaign` called — i.e. it is
live and ticking. `startSession` collapses the instance + join + begin steps into one
call for the common case.

### The typed registry

[`defineRegistry`](src/lib/authoring/registry.ts) wraps the serialization
`CampaignRegistry` and lifts its key literals into the type:

```ts
const reg = defineRegistry({
  items: {
    "rusty-sword": makeRustySword,   // () => Item
    "torch":       makeTorch,
  },
  recipes: {
    "sword-recipe": swordRecipe,     // CraftingRecipe
  },
  // scenes and formations use the same CampaignRegistry under the hood
  scenes:     { "ambush": ambushBehavior },
  formations: { "wolf-pack": wolfPackFormation },
});
```

The return type is a `TypedRegistry<"rusty-sword" | "torch", "sword-recipe">`. Any
builder constructed from `reg` will reject an unknown key — like `"nope"` for an item
or `"unknown-recipe"` for a recipe — at compile time, not just at runtime. The
underlying `CampaignRegistry` is unchanged and is consumed verbatim by the server /
`Authority` / serialization path.

**Behaviors stay code, archetypes are data.** Scene scripts, formation factories, and
item factories are hand-written TypeScript registered under a stable `behaviorKey`. The
`behaviorKey` is what the serialization layer uses at restore time, so renaming a key
without migrating snapshots is a breaking change. Archetypes, by contrast, are plain
data (`ArchetypeDef` — id, name, stat modifiers, inventory slots, immunities) and have
no closure to register; they travel as data in the `CampaignTemplateDescription` and
are re-registered from that data each time the template is assembled.

### The fluent template builder

[`authorTemplate(title, registry, opts?)`](src/lib/authoring/template-builder.ts)
returns a chainable `TemplateBuilder` typed over the registry's key unions. Every
method returns `this`, so calls can be chained in any order — **forward references are
legal**: you can declare an exit before the rooms it references; `assemble` resolves
everything at build time.

```ts
import { authorTemplate, defineRegistry } from "./src/lib/authoring";

const reg = defineRegistry({
  items: { "torch": makeTorch, "rusty-sword": makeRustySword },
  recipes: { "sword-recipe": swordRecipe },
});

const builder = authorTemplate("The Crypt", reg, { maxRounds: 50, baseEncounterChance: 25 })
  .archetype({ id: "delver", name: "Delver", baseStats: { Health: 12 } })
  .room("entrance", { description: "A damp stone corridor.", dark: true, lights: ["torch"] })
  .room("vault",    { description: "A collapsed vault." })
  .startRoom("entrance")
  .exit("entrance", Directions.North, "vault")
  .mob("Goblin", {
    stats: { Health: 6, Sanity: 8, Energy: 8 },
    room: "vault",
    drops: ["rusty-sword"],
  })
  .loot("supply crate", { room: "entrance", items: ["torch"] })
  .cache("iron vein",   { room: "vault",    materials: { iron: 4 } })
  .recipe("sword-recipe")
  .materials("starting-grant", { wood: 2 });
```

**`.build()`** validates the entire description (collecting *all* problems into one
`AuthoringError`) and then constructs a live, player-less, not-yet-begun `Campaign`
via the engine's normal constructors in the required order: campaign shell → archetypes
→ caches → loot → mobs → rooms → room-mob placement → exits → recipes → materials.
Any dangling room reference, unknown item key, or duplicate name surfaces here rather
than silently misbehaving at runtime.

**`.toSnapshot()`** does the same assembly and then serializes the player-less world
into a `CampaignSnapshot` whose BFS is rooted from the template's rooms (not from
party members, since there are none). The snapshot is JSON-serializable and suitable
for storage or transmission.

### Orchestration: `instantiate` and `startSession`

[`instantiate(template)`](src/lib/authoring/orchestration.ts) clones a template
snapshot and assigns a fresh `CampaignId`, leaving all entity ids (rooms, items, loot,
caches, mobs) unchanged. Each call produces an isolated **instance genesis** — suitable
as the `genesisFor` argument to `Authority` or the initial record for `CampaignStore`:

```ts
const template = builder.toSnapshot();             // one-time build
const genesis  = instantiate(template);            // fresh campaign id each call
const authority = new Authority(genesis, { registry: reg });
```

[`startSession(builder, { players, gm, startRoom? })`](src/lib/authoring/orchestration.ts)
is the high-level entry point for the common case: it assembles the template, joins
each player via the existing `joinCampaign` → `selectArchetype` → `move` sequence,
assigns the GM, and calls `beginCampaign` — returning a fully started `Campaign`:

```ts
const campaign = startSession(builder, {
  players: [
    { name: "Ada", archetype: "delver" },
    { name: "Ben", archetype: "delver" },
  ],
  gm: 0,           // index into players array
});
// campaign.started === true; campaign.party.length === 2
```

`startSession` takes the builder (not a pre-built `Campaign`) so it can resolve the
`startRoom` name to the live `Room` instance produced by `assemble`, without exposing
that mapping through the engine itself.

### Victory conditions

A campaign tracks its resolution through the `outcome` property, which starts `"ongoing"` and
transitions exactly once to one of four terminal states:

| Outcome | When it fires |
|---------|---------------|
| `"won"` | A win condition's predicate returned `true` at round end |
| `"lost"` | A loss condition's predicate returned `true` at round end |
| `"timed-out"` | `round` reached `maxRounds` and no condition fired |
| `"ended"` | The GM called `campaign.endCampaign()` manually |

`campaign.finished` is a derived boolean (`outcome !== "ongoing"`) — no separate field to keep
in sync on load.

**Round-end evaluation.** At the close of every round — after the last party member calls
`nextPlayer()` — the engine calls `resolveOutcome`. Loss conditions are tested before win
conditions; if one fires, the campaign finishes immediately and wins are not checked. The
`maxRounds` ceiling resolves to `"timed-out"` only if no win or loss condition fired in that
same round.

**Conditions are predicates re-attached by key.** A win or loss condition is a function
`(campaign: ICampaign) => boolean` registered in the `CampaignRegistry` under a stable string
key via `defineRegistry({ conditions: { "key": predicate } })`. The predicate is *not*
serialized — only its key and authored narration are stored. On reload, `deserializeCampaign`
looks the predicate up in the registry by key (the same mechanism as item factories and recipes),
so a restored campaign evaluates conditions identically to the original. The key is exposed as
`campaign.outcomeReason` after the campaign finishes.

**Outcome prose.** Each condition can carry an `OutcomeNarration` (`{ text?, sound? }`) — plain,
surface-agnostic authored content. The engine does not render text or play sounds; it stores the
prose alongside the condition and surfaces it in two ways so every play surface can reach it:

- **`resolution` cue** — emitted once at the moment of resolution, carrying `{ outcome, reason, narration }`.
  Subscribe with `campaign.onCue(handler)`.
- **`campaign.outcomeNarration`** — a derived getter that re-derives the same prose from the
  stored conditions on every access, so a polled or reloaded campaign reports the same ending
  without replaying any cue.

The timeout and manual-end paths have their own prose slots: `.onTimeout(narration)` and
`.onEnd(narration)` on the builder.

**Authoring.** On the `TemplateBuilder` returned by `authorTemplate`:

```ts
const reg = defineRegistry({
  items: { "coin": makeCoin },
  conditions: {
    "reached-exit":  (c) => c.party[0]?.currentRoom?.name === "exit",
    "party-wiped":   (c) => c.party.every((p) => p.stats[StatType.Health] <= 0),
  },
});

const builder = authorTemplate("Escape", reg)
  .room("start", { description: "A locked cell." })
  .room("exit",  { description: "Freedom." })
  .startRoom("start")
  .exit("start", Directions.North, "exit")
  .winWhen("reached-exit", { text: "You escape into the night." })
  .loseWhen("party-wiped", { text: "The darkness claims you all.", sound: "defeat.ogg" })
  .onTimeout({ text: "Time runs out. The dungeon wins." });
```

`.winWhen(key, prose?)` and `.loseWhen(key, prose?)` each accept a condition key that must be
registered in the registry (compile-time-checked by `TypedRegistry`). `.onTimeout(prose)` and
`.onEnd(prose)` set the fallback prose for those two resolution paths.

## Swappable campaigns & play surfaces

The [`@wickedways/play`](packages/play/README.md) browser experience is built on three
workspace packages that keep the runtime, the surface implementation, and the campaign
content fully decoupled. See [`packages/play/README.md`](packages/play/README.md) for
the full topology and per-surface documentation.

### Package overview

| Package | Role |
|---------|------|
| `@wickedways/play-runtime` | Surface-independent runtime, audio engine, launcher, and **all contracts**: `CampaignManifest`, `PlaySurface`, `Theme`, `AudioDirector`, `SoundPack`, `CampaignAudio`. Zero Hollow-House / CRT references. |
| `@wickedways/play-surface-crt` | The CRT terminal — the first `PlaySurface` implementation. Parser, narrator, DOM terminal, `CrtTheme`/`defaultCrtTheme`/`applyTheme`. |
| `@wickedways/campaigns` | All player-facing campaigns under `src/<slug>/`; subpath-exported as `@wickedways/campaigns/hollow-house` and `@wickedways/campaigns/seed`. |
| `@wickedways/play` | Thin deploy shell — registers campaigns + surfaces, calls `bootLauncher`. `Dockerfile` and `nginx.conf` ship from here. |

Dependency direction is acyclic: `play` → `play-runtime`, `play-surface-crt`, `campaigns` →
(engine). `play-runtime` defines the `PlaySurface` contract but never imports a concrete
surface — the shell injects the available surfaces at startup. Campaign packages depend on the
engine for content and are type-only on surface-specific types (e.g. `import type { CrtTheme }`),
so campaign code stays node-testable and DOM-free.

### `CampaignManifest`

The contract between a campaign and the launcher. All fields are in
`packages/play-runtime/src/manifest.ts`:

```ts
interface CampaignManifest {
  slug: string;           // "hollow-house" — registry key + ?campaign= deep-link value
  title: string;          // "The Hollow House" — shown in the campaign menu
  blurb: string;          // one/two-line description for the menu
  intro: string;          // welcome-screen body text
  buttonText?: string;    // start button label; defaults to "Enter <title>"

  // Engine wiring — factories so restart re-boots from a clean template
  builder: () => TemplateBuilder<string, string>;
  registry: () => CampaignRegistry;
  aliases: AliasMap;      // verb/noun aliases for the parser
  playerName: string;     // player character display name
  archetype: string;      // archetype id applied at session start

  // Optional: omit for defaults
  surface?: string;       // PlaySurface id; defaults to "crt-terminal"
  themes?: Theme[];       // surface themes; themes[0] = default; player can switch live
  audio?: CampaignAudio;  // director + soundpacks; omit for flat bed + generic SFX
}
```

`builder`/`registry` are **factories** because `GameSession.restart` re-boots from them.

### `PlaySurface` contract

A surface takes a live `GameSession` and renders/drives it. The runtime owns the session,
view models, cues, audio, and save store; the **surface** owns input→intent, the turn loop,
DOM rendering, and its own control UI (mute toggle, soundpack switcher, theme switcher, map):

```ts
interface PlaySurface {
  id: string;            // "crt-terminal" — matched against CampaignManifest.surface
  label: string;         // "CRT Terminal"
  defaultTheme: Theme;   // fallback when a campaign supplies no manifest.themes
  mount(args: MountArgs): SurfaceHandle;
}
interface MountArgs {
  app: HTMLElement;  session: GameSession;  manifest: CampaignManifest;
  themes: Theme[];   // manifest.themes ?? [surface.defaultTheme] — always non-empty
  audio: AudioRuntime;
  onExit(): void;    // "back to menu"
}
interface SurfaceHandle { unmount(): void }
```

### The 4-layer audio architecture

```
Engine PresentationCue + live campaign state
        │
        ▼  AudioDirector              ◀── campaign-owned (CampaignManifest.audio)
AudioCue { type, entityId?, intensity? }  +  continuous tension(0..1)
        │
        ▼  SoundPack (one per audio theme)  ◀── campaign-owned
SoundSpec  ({ kind:'synth', voice } | { kind:'sample', … })
        │
        ▼  AudioBackend               ◀── runtime-owned (SynthRenderer; SampleRenderer deferred)
Web Audio output
```

Omit `manifest.audio` for the flat ambient bed + default chiptune SFX (`defaultChiptunePack`).

### Campaign-defined status bar

The status bar is **campaign-driven via `StatusCue`** — no stat name is hard-coded in the
runtime or surface. A campaign's `statusBar` mechanic emits
`{ kind: "status", fields: StatusField[] }` presentation cues; the surface renders the most
recent payload in its HUD. Before the first emission the area is empty. Campaigns that emit
no `StatusCue` (e.g. the seed demo) show an empty bar. The `StatusField` carries `{ label,
value, emphasis? }` where `emphasis` (`"warn"` / `"critical"`) maps to the active theme's
palette for color-coding.

The engine side: `PresentationCue` gains a `{ kind: "status"; fields }` variant;
`EffectKind.Status` + `Effect` arm in `src/lib/mechanics/mechanic.ts`; the applier in
`src/lib/mechanics/apply.ts` routes it through `EMIT_CUE`. See the spec:
[`docs/superpowers/specs/2026-06-27-swappable-campaigns-design.md`](docs/superpowers/specs/2026-06-27-swappable-campaigns-design.md).

### Per-surface themes

The CRT surface defines `CrtTheme` (palette/fonts/effects) and exports `defaultCrtTheme`.
A campaign supplies `CrtTheme[]` in `manifest.themes`; `themes[0]` is the default. The
surface renders a **theme switcher** that **auto-hides with fewer than two themes** (the
soundpack switcher behaves the same way). Switching re-applies CSS custom properties on the
CRT housing live; theme preference is in-memory.

The Hollow House ships two themes: `default` (green phosphor) and `haunted` (warm pinkish-red,
heavier glow and flicker — no new assets, pure palette/effect parameters).

### How to add a campaign

1. Create `packages/campaigns/src/<slug>/` with an `index.ts` that exports a `CampaignManifest`.
2. Register it in `packages/play/src/main.ts`:
   ```ts
   import { myCampaign } from "@wickedways/campaigns/my-campaign";
   bootLauncher(app, { campaigns: [hollowHouse, seed, myCampaign], surfaces: [crtSurface] }, …);
   ```

### How to add a theme

Add a `CrtTheme` to the campaign's `manifest.themes` array (`themes[0]` is the default; the
switcher appears automatically once there are two or more). No edits to the runtime or surface
are needed.

### How to add a surface

1. Implement `PlaySurface` in a new package (e.g. `@wickedways/play-surface-foo`).
2. Add it to `surfaces: [crtSurface, fooSurface]` in `packages/play/src/main.ts`.
3. Point a campaign at it with `manifest.surface = "foo"`.

### Deferred / not yet shipped

The following are planned but not part of this release:

- **YAML / JSON declarative format** (phase 2) — a text schema for `CampaignTemplateDescription`
  that does not require TypeScript.
- **Authoring UI** (phase 3) — a visual map/content editor.
- **Live authoring commands** — GM commands to mutate the world during a running session.
- **Procedural generation** — template composition and random map generation hooks.
- **Template library / store** — versioned templates shareable across campaigns.
- **Codex authoring** — the `Codex` is gameplay-generated (entries are recorded as players
  encounter things); there is no public authoring API for pre-populating codex entries.
- **`buildStartedCampaign` migration** — replacing the existing seed helpers with
  `startSession`; deferred because it spans the full integration suite.

## Multi-client sync

The snapshot format powers multiplayer over a command-log driven by an authoritative
[`Authority`](src/lib/sync/authority.ts) ([`src/lib/sync/`](src/lib/sync/)). Each client runs a
`SyncCoordinator` that owns a local replica and delegates all resolution to the authority.

`coordinator.submit(command)` is a thin pass-through: it calls `transport.submit(command)`, waits
for the authority's response, then applies the returned delta to the local replica via `DeltaApplier`
and returns `{ ok: true, seq, delta }`. The coordinator never resolves commands itself and never
optimistically mutates — state changes only when an authoritative delta arrives, so there is no
rollback and no CAS conflict. A denial returns `{ ok: false, rejected: true, reason }`.

**Reject ≠ fizzle.** A rejection (`{ ok: false, rejected: true }`) means the authority denied the
command (wrong turn, bad lifecycle state, seat-ownership check, or an engine constraint thrown by
`ProceduralViolation`). A fizzle is a legal action that simply had no mechanical effect (e.g. an
attack that dealt 0 damage) — those commit, produce a delta, and propagate normally.

Inbound, `start()` subscribes from `lastApplied + 1`; remote entries are applied to the replica via
`DeltaApplier` (which patches state and **never draws rng or runs game logic**, so replicas converge
deterministically with zero determinism burden), and gaps heal via `entriesSince`.
`SyncCoordinator.join(...)` brings a late client up to date from the transport's latest checkpoint
plus the deltas since.

Because a `join` may swap in a freshly deserialized `Campaign`, consumers must always read state
through `coordinator.campaign` and never cache the reference across a `submit`.

**`SyncTransport` seam.** The sync core depends only on the `SyncTransport` interface (`submit`,
`head`, `subscribe`, `entriesSince`, `loadSnapshot`). `InProcessTransport` wraps an in-process
`Authority` and drives the single-player and test paths. `WebSocketTransport` forwards to the room
server, which hosts its own `Authority` per campaign — both topologies are the same shape.

```ts
const authority = new Authority(genesis, { registry });
const transport = new InProcessTransport(authority);

const coordinator = SyncCoordinator.join({ registry, transport });
coordinator.start();
const result = await coordinator.submit({ kind: "move", actorId: active.id, roomId: dest.id });

// elsewhere / another client on the same transport:
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
- **Tests:** [Vitest](https://vitest.dev) — 711 tests across 58 files, including an end-to-end
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

## Multiplayer (comms)

The repo is a pnpm workspace. The pure engine lives at the root (`src/`); three
packages under `packages/` add real-time multiplayer:

- **`@wickedways/transport-shared`** — the engine-free WebSocket wire protocol
  (message types + validators).
- **`@wickedways/server`** — a self-hosted WebSocket room server. The server **runs
  the engine**: each campaign is backed by an `Authority` (built from the host's
  `genesisFor`) that re-derives every delta from the submitted command. Clients
  submit commands only; the server computes and broadcasts the authoritative delta.
- **`@wickedways/client`** — a `WebSocketTransport` implementing the engine's
  `SyncTransport` over the server, plus a minimal dev harness.

The architecture is:

```
single-player:   App ─ SyncCoordinator ─ InProcessTransport ─ Authority(local)
multiplayer:     App ─ SyncCoordinator ─ WebSocketTransport ─[ws]─ Server ─ Authority(per campaign)
```

Both topologies are the same shape: submit a command to an authority, apply the
delta it returns. The coordinator is the same on both paths; only the transport
differs.

### Running it

```bash
pnpm install
pnpm --filter @wickedways/server start      # ws://127.0.0.1:8787
pnpm --filter @wickedways/client dev        # http://localhost:5173
```

Open `http://localhost:5173/?c=demo` in two tabs. Act in one (e.g. **nextPlayer**);
both converge on identical state over the wire.

### Authentication, seat ownership & presence

Connections authenticate and the server enforces who may act for whom:

- **`createServer({ verifyToken, gmIdentityFor, registry, genesisFor })`** —
  `verifyToken(token) -> Identity | null` is host-supplied (the engine bakes in no
  crypto); `gmIdentityFor(campaignId)` seeds each campaign's GM; `genesisFor(campaignId)`
  supplies the initial campaign state from the host's trusted store (an unknown
  campaign is denied). A client presents its `token` on `join` (and on every reconnect).
- **Seat ownership** — the server holds a per-campaign `Membership` (`characterId ->
  identity` + `gmIdentity`). On `submit` the server derives the actor directly from
  the command (`commandActorId` / `isJoinCommand`) and checks `Membership.mayAct` —
  there is no client-supplied actor envelope. A command whose derived actor does not
  belong to the authenticated connection is `denied`.
- **Self-service join + GM override** — `joinCampaign` self-claims (binds the new
  character to the joiner's identity, if unowned). The GM-only
  `assignSeat`/`unassignSeat`/`transferGM` control messages handle reassignment,
  removal, and GM hand-off.
- **Presence** — the server broadcasts a `presence` snapshot (seat owners + who is
  online + GM online) on connect / disconnect / claim / control change. An identity
  is online while any of its connections is live.

**Security outcome.** Impersonation is structurally impossible: the client never
supplies a delta to forge, and the actor is read from the command by the server —
there is no envelope to desync from the command body. All replicas (including the
submitter) apply the identical server-derived delta, so there is no divergence window.
Genesis comes from the host's `genesisFor`, not from any client.

**Explicitly deferred (follow-up spec).** Client-side prediction and the deterministic /
serialized rng change that would enable it; per-identity seat caps, map pruning, and
`transferGM` lockout recovery.

### Durable persistence

The server persists each campaign's full snapshot + seat ownership on every commit,
**flush-before-ack** (the client is acked only after the record is durable), via a
host-injected `CampaignStore` interface:

```ts
interface CampaignStore {
  load(campaignId: string): Promise<CampaignRecord | null>;
  save(campaignId: string, record: CampaignRecord): Promise<void>;
}
```

`CampaignRecord` bundles the committed `seq`, the engine `CampaignSnapshot` (carries
`schemaVersion`), and `MembershipState` (seat assignments). Because `save` is atomic
(one SQLite transaction), snapshot and membership can never disagree across a crash.

**Reference adapter — `SqliteStore`.** A `SqliteStore(path)` stores records in a
single SQLite file via Node's built-in `node:sqlite`, WAL mode, one upsert per save.
Requires **Node ≥ 22.5**. (`node:sqlite` is experimental and emits a warning;
persistence tests suppress it via `NODE_OPTIONS=--no-warnings`.)

**Resume on restart.** On startup, `store.load(id)` returns the last durable record;
the server rebuilds the `Authority` at the persisted `seq` and restores the
`Membership` from the saved seat assignments — the campaign continues exactly where it
left off, seq is continuous, and reconnecting clients converge normally.

**Persistence is opt-in.** Pass no `store` to `createServer` and the server behaves
exactly as before — in-memory, ephemeral. The single-player in-process path is
entirely unaffected.

**Client identity.** `@wickedways/client` persists the browser's identity token in
`localStorage` (key `wickedways:identity`) so a page reload reuses the same identity
and retains its durable seat. Real deployments obtain the token from an auth flow;
this is the dev-harness behavior.

**Deferred.** Client state caching (warm-start / offline read); a WAL persistence
adapter; multi-instance locking (a single server instance owns a campaign's record);
schema migrations — v1 fails closed on a `schemaVersion` mismatch rather than
attempting to migrate.

### Text chat

Chat is a **player-to-player side-channel** — it runs over the same WebSocket room
but is entirely separate from the game log and the engine's `Command`/delta types.
There is no in-character vs out-of-character dimension; attribution always answers
"which *player* (identity) said this." The GM is the player holding the GM identity —
"message the GM" is a whisper to that identity.

**Two scopes.** Every message is either **room-wide** (no `to` field, delivered to all
subscribers) or a **whisper** (`to: Identity`, delivered and backfilled only to the
two participants). The server enforces whisper visibility on both live delivery and
every backfill/pagination response.

**Attribution is unforgeable.** The server stamps each message's `from` from the
authenticated connection — exactly as it derives the game actor from the command body
rather than a client-supplied envelope. Clients never supply their own `from`.

**Authored `ChatPolicy`.** Whether chat exists, and which features are enabled, is
configured on the campaign template as a `ChatPolicy` value. The server enforces the
policy authoritatively; the client reads `snapshot.campaign.chatPolicy` to gate UI
affordances.

| Field | Type | Meaning |
|---|---|---|
| `enabled` | `boolean` | Master switch — `false` disables chat entirely (no roster, no history) |
| `whisper` | `boolean` | Private identity-to-identity whispers |
| `edit` | `boolean` | Edit or delete own messages |
| `reactions` | `boolean` | Emoji reactions |
| `readReceipts` | `boolean` | Per-identity read high-water marks |
| `typing` | `boolean` | Transient typing indicators |
| `backfillWindow` | `number` | Join backfill / pagination page size (not a retention cap) |

`DEFAULT_CHAT_POLICY` (all features on, `backfillWindow: 200`) is used when a
template omits the `chat` field. A single-player campaign should set `enabled: false`.
The snapshot carries `chatPolicy`; `migrate()` injects `DEFAULT_CHAT_POLICY` when
deserializing a v2 snapshot in-process, while a server with a durable store fails
closed on a previously-persisted v2 campaign (no auto-migration — consistent with the
durable-persistence fail-closed stance).

**Player roster + `displayNameFor`.** Pass `displayNameFor(identity): string` to
`createServer` and the server resolves human display names (defaults to the identity
string). On every join / leave and on initial connect, the server broadcasts a
`players` message (`{ identity, displayName, online }[]`) — the player-centric
sibling of the seat-centric `presence` roster. Messages carry only the unforgeable
identity; the UI resolves names from this roster, which also powers the whisper-target
picker.

**Durable history with bounded backfill + pagination.** Every message is retained
durably forever (text is cheap; unlike snapshots, chat cannot be compacted). On join
the server replays the most recent `backfillWindow` messages the identity may see.
Older history is fetched on demand via `chatHistory { before: chatSeq }`, which
returns the next page with a `more` flag. Retention and working-set are decoupled —
nothing is ever deleted.

**Full feature set.**

- **Edit / delete** — the owner may update a message body (`chatEdit`) or tombstone it
  (`chatDelete`). A tombstone keeps the message id and ordering in place so reactions
  and read marks referencing it stay coherent; only the body is cleared.
- **Reactions** — per-message `emoji → Set<Identity>` toggles (`chatReact`).
  Reactions on a whisper are visible only to its two participants.
- **Read receipts** — each identity maintains a single per-room high-water `upTo`
  chatSeq (`chatRead`), broadcast as `chatReads`. Note: because room and whisper
  messages share one sequence space, a recipient can infer that hidden whispers exist
  from gaps in visible ids — a negligible metadata leak, not content exposure.
- **Typing indicators** — transient `typing` messages routed to the scope audience
  (room → all; whisper → target only); never stored, auto-expiring client-side.

**`ChatStore` seam.** The default is `InMemoryChatStore` (ephemeral). Pass a
`SqliteChatStore(path)` to `createServer` (`chatStore` option) for durable chat
history that survives restarts — reactions and read marks included. Typing is never
stored.

**Rate-limiting / anti-abuse are explicitly out of scope** (deferred per the Spec 3b
out-of-scope; implement as a thin wrapper in front of `Chat.send`).

**Wire protocol summary.** Client → server: `chatSend`, `chatEdit`, `chatDelete`,
`chatReact`, `chatRead`, `chatHistory`, `typing`. Server → client: `chat` (live +
backfill), `chatEdited`, `chatDeleted`, `chatReact`, `chatReads`, `chatHistory`
(paginated response), `players`, `typing`. All validators live in
`@wickedways/transport-shared` (`parseClientMsg` / `parseServerMsg`).

#### Manual smoke — text chat

Boot the server and client as described in [Running it](#running-it), then open
`http://localhost:5173/?c=demo` in **two separate browser tabs** (they get distinct
identity tokens from `localStorage`).

Verify the following — each interaction is attributed by display name (defaulting to
the truncated identity UUID until `displayNameFor` is wired):

1. **Room message** — type a message in Tab A and press **Send** with the whisper
   select on "Room". The message appears in both Tab A and Tab B with Tab A's identity
   prefix. Reload Tab B; the message is replayed from backfill.
2. **Whisper** — in Tab A, select Tab B's identity in the whisper picker and send a
   private message. It appears in both Tab A and Tab B but does **not** appear in a
   third tab opened simultaneously.
3. **Edit / delete** — not yet surfaced in the minimal harness UI (send + receive
   only); exercise via the WebSocket frame inspector or a `websocat` session:
   `{"t":"chatEdit","campaignId":"demo","id":1,"body":"edited text"}` — both tabs
   receive `chatEdited`; a `chatDelete` produces `chatDeleted` with the original id
   retained.
4. **Reaction** — send `{"t":"chatReact","campaignId":"demo","id":1,"emoji":"👍","on":true}`;
   both tabs receive `chatReact` with the updated `by` array.
5. **Read receipt** — send `{"t":"chatRead","campaignId":"demo","upTo":1}`; both tabs
   receive `chatReads` with the updated high-water mark.
6. **Typing indicator** — send `{"t":"typing","campaignId":"demo"}`; the other tab
   receives `typing` with the sender's identity (auto-expires client-side; no storage).

### A/V chat

Voice (and optional video) runs as a **campaign-wide "table call"** over the same
WebSocket backend, using WebRTC for media transport.

**Full-mesh P2P; server relays signaling only.** Every participant opens a direct,
encrypted `RTCPeerConnection` to every other participant. The server is a **pure
signaling relay + call-membership tracker** — it assigns each connection an opaque
`peerId`, owns the per-campaign call-set, enforces `AvPolicy`, and routes SDP/ICE
blobs between `peerId`s. It **never sees media**. This keeps media infrastructure
out of the backend and matches the engine's self-hosted, dumb-relay ethos. The
practical ceiling for full-mesh is **~4–6 participants** (each peer uploads its
stream N−1 times), which fits a tabletop party.

**Per-connection peer identity.** WebRTC endpoints are per-connection, not
per-identity: two browser tabs authenticated as the same identity become two
distinct peers. Signaling is addressed by the server-assigned opaque `peerId`
(one per socket); the call roster maps `peerId → identity` for display names.

**Audio baseline + opt-in video.** Voice is on when a participant joins (mutable
via mute toggle). Video is opt-in per participant and off by default. Mute and
camera on/off controls flip the local track's `enabled` flag and broadcast an
`avState` update, which the server fans out via `callPeers` so every tile reflects
the current state.

**Authored `AvPolicy`.** A/V availability is configured on the campaign template —
exactly like `ChatPolicy` for text chat — and carried in the snapshot (schema v4;
`migrate()` injects `DEFAULT_AV_POLICY` for v3 snapshots). The engine never acts on
it; the server reads it to gate the call, the client reads it to gate the UI.

| Field | Type | Meaning |
|---|---|---|
| `enabled` | `boolean` | Master switch — `false` disables A/V entirely for this campaign |
| `video` | `boolean` | Whether cameras are allowed (vs an audio-only table) |
| `maxParticipants` | `number` | Hard cap on simultaneous call members (protects the mesh) |

`DEFAULT_AV_POLICY` is `{ enabled: true, video: true, maxParticipants: 6 }`.
A single-player campaign should set `enabled: false`.

**Enforcement honesty.** `enabled` and `maxParticipants` are **hard server gates**:
the server owns call membership and denies `callJoin` if A/V is off or the call is
full. `video` is **client-enforced and state-validated**: the client won't add a
video track when `!policy.video`, and the server rejects an `avState` claiming
`cameraOn` under `!policy.video`. Because media flows P2P and is opaque to the
server, it cannot inspect actual tracks — a malicious trusted peer could still send
video. This is the same trusted-peers boundary as the rest of the stack.

**Host `iceServers` config.** Pass `iceServers: RTCIceServer[]` to `createServer`;
it defaults to Google's public STUN (`stun:stun.l.google.com:19302`). The server
delivers the list to each client on `callJoined` so a single host config point
drives every client's `RTCPeerConnection`. TURN (the relay fallback) is
config-pluggable: add a `{ urls: "turn:...", username, credential }` entry to
`iceServers` and `CallClient` will use it. **Operating a TURN server is out of
scope** — but note that a small minority behind symmetric NAT cannot establish a
direct P2P path without one and will show a failed peer tile.

**Wire protocol summary.** Client → server: `callJoin`, `callLeave`, `signal {to,
data}`, `avState {muted, cameraOn}`. Server → client: `callJoined {selfPeerId,
peers, iceServers}` (join ack + existing roster + ICE config), `callPeers {peers}`
(membership / state updates), `signal {from, data}` (relayed inbound signaling),
`denied {reason}` (A/V off, call full, or video disabled). Signaling `data` is
opaque (`unknown`) — relayed verbatim by the server. All validators live in
`@wickedways/transport-shared` (`parseClientMsg` / `parseServerMsg`).

#### Manual smoke — A/V chat

Boot the server and client as described in [Running it](#running-it), then open
`http://localhost:5173/?c=demo` in **two separate browser tabs**. The campaign must
have `avPolicy.enabled: true` (the demo genesis uses `DEFAULT_AV_POLICY`).

1. **Join the call** — click **Join call** in Tab A; verify the call panel appears
   with Tab A's display name listed. Do the same in Tab B; verify both tiles show in
   each tab's call panel with the correct display names.
2. **Audio** — speak in Tab A; verify Tab B hears audio. Speak in Tab B; verify Tab A
   hears audio.
3. **Mute** — click **Mute** in Tab A; verify Tab B's tile for Tab A shows the muted
   badge, and Tab A's tile shows the unmuted badge for Tab B. Un-mute; badge clears.
4. **Camera** — click **Camera on** in Tab A (if `policy.video: true`); verify Tab B
   shows a `<video>` tile for Tab A. Toggle camera off; video tile disappears.
5. **Camera badge** — in Tab B, observe that Tab A's tile reflects the `cameraOn`
   state (badge present / absent) matching what Tab A toggled.
6. **Leave** — click **Leave call** in Tab A; verify Tab B's call panel drops Tab A's
   tile and the roster updates to one participant.

**Symmetric-NAT note.** If two tabs on the same machine don't connect (rare but
possible in some corp VPN setups), adding a TURN entry to `iceServers` resolves it.
