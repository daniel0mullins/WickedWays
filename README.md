# Wicked Ways

!Wicked Ways

A turn-based tabletop RPG engine written in Rust, shipped as a wasm web client.
Wicked Ways models a party-based horror campaign: a Game Master and player characters
take turns across a dungeon, fighting mobs, looting containers, talking to NPCs, and
accumulating damage across three interlocking stats. Game rules are enforced by the
type system (branded ids, closed effect enums) and at runtime (lifecycle guards that
throw `ProceduralViolation` on illegal moves), and pinned by a golden-replay test
corpus.

The engine began life in TypeScript and has fully cut over to Rust; the TS tree has
been removed. The golden corpus under `conformance/fixtures/` pins the Rust engine's
own behavior. The authored campaign TOMLs those goldens are compiled from live in
[`campaigns/`](campaigns/README.md) — the place to start if you want to write or mod
a campaign.

A few TS-era behaviors did not make the cut and have no Rust equivalent yet — map generation,
runtime light placement, `teaches`, one-time material claims, the codex query API, and a couple
more. They are tracked as a porting backlog in
[`docs/unported-from-typescript.md`](docs/unported-from-typescript.md); this README documents the
engine as it actually is, not as TS left it.

## Documentation site

Full docs are published to GitHub Pages at
**<https://daniel0mullins.github.io/WickedWays/>** — a prose guide (this README,
rendered) plus getting-started pages. The site is built with VitePress and lives
in `docs-site/`. Work on it locally with:

```bash
pnpm docs:dev       # serve the site with hot reload
pnpm docs:build     # production build into docs-site/.vitepress/dist
```

It deploys automatically on every push to `main` via `.github/workflows/docs.yml`.

## Architecture: the Rust workspace

Everything that ships lives in `crates/`:

| Crate | Role |
|---|---|
| `wickedways-core` | The engine: world state, turn loop, combat, mechanics, the ops DSL, sync. `no_std`-capable (`alloc`-only without the `std` feature). |
| `wickedways-author` | Compiles the TOML campaign-author format into a campaign description + behavior catalog. |
| `wickedways-assemble` | Assembles a description + catalog (+ seated party) into a genesis snapshot. |
| `wickedways-wasm` | The wasm-bindgen boundary: a stateful `Authority` handle; only JSON strings cross the seam. |
| `wickedways-transport` | The multiplayer wire protocol (serde only, engine-free). |
| `wickedways-server` | The axum room server: per-campaign table actors, seat-ownership auth, SQLite persistence. |
| `wickedways-tabletop` | The physical-tabletop bridge: engine state ↔ device commands/events, the COBS-framed serial codec, and the `DeviceTransport` seam. Serde-only + `wickedways-core`, so it compiles native (the controller) and to wasm (the web client's on-screen simulator renders through it). |
| `wickedways-controller` | The host controller binary: runs the engine solo, projects the board through `wickedways-tabletop`, and speaks the device protocol over a serial line to real e-ink/NFC hardware. `--dry-run` exercises the whole engine→bridge→codec path with no device. |
| `wickedways-web` | The Dioxus web client — the shipped product (see the root `Dockerfile`). |
| `wickedways-studio` | Campaign Studio: the graphical campaign-authoring app (a second, standalone Dioxus wasm app — see `docs/campaign-studio-spec.md`). |

One crate lives outside the workspace: **`desktop/`**, a thin native shell that runs the same
client (`wickedways-web` with its `native-app` feature) in a desktop window via `dioxus`'s
webview — and, as a second binary, Campaign Studio (`wickedways-studio` with ITS `native-app`
feature). It is workspace-`exclude`d so the workspace-wide gates need no system GTK/WebKit
packages; build with `cargo run --manifest-path desktop/Cargo.toml --bin wickedways-desktop`
(or `--bin wickedways-studio-desktop` for the authoring app; on Linux install
`libwebkit2gtk-4.1-dev libgtk-3-dev libxdo-dev` first). The play shell is single-player only
for now — it has no multiplayer transport yet, and audio is silent pending a native backend.

Distributable packages are built with the Dioxus CLI (pinned `dioxus-cli --version 0.6.3`,
matching `Cargo.lock`) from `desktop/`:

```bash
cd desktop && dx bundle --release --platform desktop
```

`--platform desktop` is required (the dep graph also carries dioxus's `web` feature, so
auto-detection sees two platforms). Each OS builds its own formats — `.deb`/`.rpm`/AppImage
on Linux (AppImage additionally needs `librsvg2-dev` at build time), `.app`/`.dmg` on macOS,
`.msi`/NSIS on Windows — into `desktop/target/dx/wickedways-desktop/bundle/`. Bundle
identity/icons live in `desktop/Dioxus.toml` (icons generated from
`docs-site/public/logo.png`). A tag-triggered three-OS release workflow is parked at
`docs/ci/release.yml.proposed`.

The content pipeline: a campaign is authored in TOML, compiled by
`wickedways-author` into a **description** (world layout) plus a **catalog** (item
descriptors + scripted behaviors), assembled by `wickedways-assemble` into a
**genesis snapshot**, and then driven by `wickedways-core` — single-player through
the wasm `Authority`, multiplayer through the room server's `SyncAuthority`.

Behavior is pinned by four golden gates run under `cargo test --workspace`
(author, assembler, sync deltas, and a step-by-step engine replay of every
committed command/facade recording). The goldens are regression pins of the Rust
engine's own output — regenerate deliberately with `UPDATE_GOLDENS=1`, review the
diff like code, and commit it; see `conformance/fixtures/README.md`. Formatting,
lints (workspace-wide `-D warnings`), the `no_std` build, and the wasm targets are
gated in CI (`.github/workflows/checks.yml`, toolchain pinned by
`rust-toolchain.toml`).

## Core concepts

### Campaign

`Campaign` drives the turn loop and owns the campaign lifecycle:

- It tracks a `party` of player characters, a `gm` (always one of the party members), the
  current `round`, and `maxRounds` (default `100`).
- **Lifecycle:** `begin_campaign` validates that the party is non-empty and that the GM is
  a member, then starts the campaign; `end_campaign` finishes it. `next_player` advances
  the active character and ends the round once everyone has acted; the campaign auto-finishes
  when `round` reaches `maxRounds`.
- **Membership:** `join_campaign` and `leave_campaign` adjust the party during play (the GM
  cannot leave — it throws), and `transfer_gm` hands the GM role to another member mid-campaign.
- The `gm` may only be assigned during setup; once the campaign has begun, the GM can only be
  changed via `transfer()`.
- Every illegal operation (acting before `beginCampaign()`, beginning twice, a GM leaving,
  etc.) throws a `ProceduralViolation`.

### Characters

There is no class hierarchy. Every character — player, mob, or NPC — is one flat
`CharacterSnapshot` carrying a `kind` discriminant (`CharacterKind::{Player, Mob, Npc}`), and
every verb is a method on `World` that takes the actor's id. Behavior varies by `kind` and by
which optional fields a character carries, not by type.

- **Shared state.** `stats`, an `inventory` (slots, items, keyring), `equipment`, the current
  room, afflictions, action history, and the action-budget counters live on every character.
  The shared verbs are `World` methods: `go` / `move_to`, `attack`, `take` / `drop`, `equip` /
  `unequip`, `craft` / `repair`, `use_item` / `read_item`, and the turn lifecycle
  (`start_turn` / `end_turn`).
- **`Player`** characters are the seated party: they join via `join_campaign` (or the
  `joinCampaign` command), interact with loot containers, and default to a 3-action budget.
- **`Mob`** is an enemy with a smaller default budget (2 actions, 2 inventory slots), a `drops`
  list, and an escape action — a Health-gated roll (see Mob encounters below). It also tracks an
  `origin` — `"room"` for an authored resident, `"campaign"` for one spawned by a formation, and
  absent for a mob that has neither — which controls whether it drops key items on defeat.
- **`Npc`** carries an `npc_behavior_key` and its own `npc_state`, and is talked to through
  `World::talk` (the `talk` command). Authored NPCs may start holding catalog items via the
  `[[npcs]]` table's `holds` list; each held item is seeded into both the NPC's inventory and the
  campaign items map under a deterministic id (`npc:{name}:item#{i}`).

Every character carries a reversible `visible` flag (default `true`, flipped by the `setVisible`
effect). An invisible character is filtered out of a room's `view.occupants` and `view.scope` — the
way a hidden NPC "disappears" — and serializes only when `false` (omitted when `true`).

### Character archetypes

Player characters may choose an archetype during setup. Archetypes are authored, declarative
descriptors that ride in the campaign description (`campaign.archetypes`, authored as
`[[archetypes]]`), and a character adopts one through
`World::select_archetype(actor, archetype_id, …)`. Selecting an archetype modifies the character's baseline
exactly once: `baseStats` set the stats they name (a missing stat keeps its baseline of 10),
`inventorySlots` adjusts inventory capacity (floored at 0), and
`immunities` become a standing passive trait — a new source unioned
with equipped-gear immunities (Panic/Fear/Confused only; KO is never immunizable).

Selection is **once-only** and **setup-only** (it throws after the campaign begins). Whether an
archetype is required at `begin_campaign` depends on the campaign's catalog: with **none**
declared, archetypes are optional and a character with none keeps its base stats and slots; with
**exactly one** declared, it is auto-selected as the default for any member who hasn't chosen;
with **several** declared, every member must have chosen one explicitly or `begin_campaign`
throws.

### Rooms, the map, and scenes

- A `Room` has a description, a `loot` map, an `exits` map keyed by compass
  `Direction`, occupants, and a `spawnModifier` (default 1; 0 = never spawns) that scales the
  campaign's base encounter chance. A mob authored into a room is seated by the assembler as a
  room-attached resident (origin `"room"`), enabling key-item drops on defeat. Entering or exiting a room fires any
  `Scene` registered for that phase.
- A room's loot and exits are both optional. The map is **authored, not generated**: each
  `[[exits]]` entry in the campaign TOML declares one directed edge, and
  `wickedways-assemble` constructs the room graph from them. (There is no runtime map
  generator in the Rust engine — exits are wired at assembly time, and the return leg of a
  passage is a separate authored entry.)
- A `Scene` runs its `script(room, state)` only when the trigger phase (`"enter"` / `"exit"`)
  matches **and** all of its `preconditions` pass — preconditions short-circuit on the first
  failure. Each scene owns a private, typed **state bag** (seeded by `initialState`, empty by
  default) that persists across room visits for the life of the scene: the `script` may mutate
  it and `preconditions` read it (read-only), enabling fire-once events, world-state flags, and
  visit counters. The state is internal to the scene — nothing outside reads it.
- An `Exit` is a **first-class shared object** registered in _both_ rooms'
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
  - **Resolution.** Only the `behaviorKey` is stored in the snapshot; the behavior itself is never
    serialized. On load, `resolve_exit_behavior(key, catalog)` re-binds it — the native
    `key → &'static dyn ExitBehavior` registry first, then the campaign catalog's
    `family: "exit"` script (just as scenes do). An unresolvable key fails at load, when
    `validate_mechanics` reports `Exit behavior '<key>' is not registered.`
  - **Authoring.** Wire a keyed door in the campaign TOML: an `[[exits]]` entry carries
    `behavior` (the key), an optional `name` display label (e.g. `"Iron Door"`, readable by UIs and
    preserved across serialize → deserialize), and an optional `initialState` seed. The behavior
    itself is a `[behaviors.exit.<key>]` table — `canPass`, optional `runScript`, and
    `passMessage`/`failMessage`. Plain exits simply omit `behavior`.
  - **Serialization.** Exit state serializes natively — the persisted `state` object is included in
    the exit snapshot, so a door that was unlocked during play stays unlocked across save/reload.
    Exits without a `behaviorKey` carry an empty state and no behavior on restore.

### Darkness & light

- A `Room` can be authored **dark** (the trailing `dark` constructor flag,
  fixed at authoring; non-dark rooms are always lit). A dark room conceals its contents until lit,
  but its **exits stay visible** — navigation always works, so a party is never trapped by the
  dark.
- A **light source** is any `Item` with `emitsLight`. A light is active
  either **carried** (equipped in a hand by an occupant) or **placed** in the room
  (`Room.lightSources`, managed through the `ADD_LIGHT_SOURCE` / `REMOVE_LIGHT_SOURCE` seams).
  Lights are **persistent** — there is no fuel or burn-down; a placed light keeps a room lit
  regardless of occupancy.
- `Character.placeLight(item)` moves a held light into the room; `takeLight(item)` returns a placed
  light to inventory. Both are **free** actions (no budget tick, no history). `Room.isLit` is
  derived, not stored: a non-dark room is always lit; a dark room is lit iff it holds a non-broken
  placed light **or** an occupant carries an equipped, non-broken light.
- **The targeting gate.** In an unlit room, `attack`, `takeFromLootBox` (looting), and `harvest`
  throw `ProceduralViolation` (via `requireVisibleTarget`) — you can't hit, loot,
  or mine what you can't see — *unless* the actor `seesInDark`. Movement and the light actions
  themselves are **never** gated, and `openLootBox` (merely viewing contents) is **not** gated:
  concealment of the description / occupant / loot lists is a **renderer** concern driven by the
  `visibility` cue, while the underlying data model stays fully intact.
- **Light-averse mobs** (`lightAverse`) thrive in darkness: their `seesInDark` is true (so the gate
  never blocks them, even in the pitch dark), but they take `LIGHT_VULNERABILITY` (×1.5) amplified
  damage while their room is lit. Lighting a dark room therefore both *enables* the party to target
  the mob and *punishes* the mob for being in the light.
- **Combat initiative is light-tied.** In single-player, after a time-advancing action a live mob
  sharing the player's room strikes back (the solo-GM reaction). Entering a **lit** room is the
  exception: a player who can see gets the drop, so a move into a lit room draws **no** entry swing —
  you choose whether to engage. A **dark** room still ambushes on entry — a `lightAverse` mob strikes
  as you arrive (a normal mob can't see you either, so it's a mutual standoff until someone brings
  light). Killing the mob or leaving the room before it acts also denies its swing; loitering
  (wait/take/use) beside a live mob does not.
- A `visibility` presentation cue (`{ room, lit }`) fires when a character enters an unlit room, and
  when a light action flips a dark room's lit state. See **Presentation assets & cues** below.
- **Non-goals:** no torch fuel or burn-down (lights are permanent); exits are never hidden; there is
  no player-side darkvision (only `lightAverse` mobs see in the dark); and darkness does not affect
  encounter spawn rates.

### Presentation assets & cues

The engine is pure logic, but it carries optional hooks for a host renderer/audio layer
(a "Play Surface"). Every presentable entity — characters, `Room`,
`Item`, `Loot`, and material caches — accepts an
optional `Presentation` descriptor (`{ image?, sound? }`, where each
value is an opaque host-interpreted `AssetRef`). The host reads `presentation.image` when it
draws an entity.

Sounds are delivered as a **cue stream the caller owns**: every lifecycle and command entry point
takes a `&mut Vec<PresentationCue>` to append to, `World::submit` hands them back in
`ExecuteResult.cues`, and in multiplayer they ride along on `Delta.cues`. The engine holds no
handler and never calls out. It emits an `action` cue for every recorded action (move, pickUp, attack, …),
an `encounter` cue each time a character enters a room containing a live, non-party occupant
(deduped per viewer:mob pair — each character/mob combination fires at most once across the
whole campaign, covering both spawned mobs and room-resident mobs), and a `visibility` cue
(`{ room, lit }`) when a character
enters an unlit room or a light action (`equip`/`unequip` of a light source) flips a dark
room's lit state — the renderer uses it to reveal or conceal the room's contents (the data model is
never hidden). The `action` and `encounter` cues carry a pre-resolved `sound`: the involved
entity's sound wins (a chest's coins on a loot pickup, a hobgoblin's growl on encounter), falling
back to the campaign's `actionSounds` default for that action kind (e.g. `move → marching`), else
none. The `visibility` cue carries no `sound` (it drives reveal/conceal, not audio).

The web client builds a full procedural audio layer on this cue stream (four SFX
categories + a sanity-reactive ambient drone); see `crates/wickedways-web/src/audio.rs`.

### Loot and inventory

- `Loot` is a fixed-capacity container (default: initial contents + 2 slots).
  `World::put_in_loot_box` throws a `ProceduralViolation` once full (every engine error is a
  `ProceduralViolation`); `World::take` extracts items by id.
- `Item` carries a type (weapon, armor, accessory, consumable,
  throwable, key), recipe, modifier, target stat, and properties
  (equippable/equipped/destroyable/usable, plus optional `droppable`), plus actions: `pickUp`,
  `equip`, `unequip`, `transfer`, `use`, `read`, `destroy`. Optional authored fields layer on
  behaviour: `maxDurability` (gear that wears), `slot` / `twoHanded` (equipment slots and
  handedness), `keyCode` / `consumeOnUse` (keys), `teaches` (an authored recipe hint the engine
  does not yet read — see *Materials and crafting*), and `lore` (evocative backstory text).
- **Item capability flags are enforced, not advisory.** `use` is rejected (a `ProceduralViolation`,
  nothing consumed) unless the item is `usable`; and `droppable: false` marks a required item — a
  quest item such as a win-condition object — that the drop path refuses to set down. `droppable`
  is absent on ordinary items (⇒ droppable); only required items opt out.
- **Reading** is a first-class, non-consuming interaction. `World::read_item` is free
  (no budget tick, no history), emits the item's `lore` as a cue, and fires the item's
  optional `onRead` hook — so the item stays in inventory and can be read again. Unlike `use`
  (which consumes the item, and only works on a `usable` one), `read` is the seam for examinable
  flavour and for read-triggered side effects (e.g. a cursed tome that drains Sanity via `onRead`).
- Both characters and loot boxes are **item holders**. State that must not be forged changes
  only through the engine's own action verbs — ownership via the pick-up/transfer/stow paths,
  durability via its single write seam, and equip/unequip via the slot-aware equipment path — so
  a holder can't be silently re-pointed, durability can't be refilled, and slot capacity can't be
  bypassed.

### Codex

The **Codex** is a party-wide record of every distinct kind of thing the party has
encountered: mobs, items, keyring keys, rooms, recipes, and material types. It is owned by
the campaign and consultable at any time by any player via `campaign.codex`
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

In Rust the codex is a flat, inert `serde_json::Value` array on `World` (`world.codex`) in
discovery order: entries are appended by the engine's own record paths, and there are no
grouped, sorted, or keyed accessors over it — a host that wants per-kind views builds them
itself. Discovery/completion tracking (e.g. "12 of 30 materials found") is
intentionally **not** part of the Codex — it is left to a separate future achievements feature,
which can read the Codex's structured entries.

### The Villain & Wicked Ways Cards

A campaign may designate one character as the **Villain** — a true adversary who works
against the Heroes (the rest of the party) and wields **Wicked Ways Cards**, one-time powers
drawn from an authored deck. In multiplayer the Villain is the **GM's own pre-seated
character** (authored as `character = "@gm"`); in single-player it is an authored mob/npc the
**computer drives** (see the solo policy below).

- **Designation & state.** `campaign.villain` (`crates/wickedways-core/src/world/snapshot.rs`,
  `VillainSnapshot`) carries the villain's `characterId` plus the card economy: `deck` (draw
  pile), `hand`, `discard`, and the per-turn `cardActionTaken` latch. All fields are
  serde-omitted when absent/default, so villain-less campaigns serialize no trace of the
  feature (the committed golden corpus is byte-unchanged). Sync deltas replicate the state
  automatically (the campaign core diffs wholesale).
- **Card economy.** The Villain starts with **5 cards** (`VILLAIN_HAND_SIZE`), dealt at
  `begin_campaign` after a deterministic `World.rng` shuffle of the authored deck (genesis
  stays pristine — deck in authored order, hand empty). On their turn they take at most
  **one card action**, enforced by the latch (reset at their turn start): **play one card**
  (resolve → discard it → draw 1) **or mulligan** (discard exactly 3 named cards, draw 3,
  playing nothing). Both are **budgeted** actions. An empty draw pile reshuffles the discard
  back in (again via `World.rng`); with both piles empty a draw yields nothing.
- **Cards are the 7th behavior family** (`crates/wickedways-core/src/world/villain.rs`):
  a `CardBehavior` trait (`playable` probe + `play`), a native `card_behavior(key)` registry,
  and a `ResolvedCardBehavior` falling back to `BehaviorScript::Card { onPlay }` catalog
  scripts (the same effect-body grammar as an item's `onUse`). Deck/hand/discard keys are
  validated strictly at load in `validate_mechanics` (an unresolvable key is a
  `ProceduralViolation`). Card faces (name/text/config) live in `catalog.cards`
  (`CardDescriptor`), keyed by the same card key.
- **The card-effect layer is villain-privileged and open by default.** Unlike mechanics
  (a closed, party-restricted union), cards may reach **anything in the world except what is
  specifically prohibited**. `CardEffect` wraps the standard `Effect` vocabulary applied
  *without* the party-only targeting restriction (damage/heal/adjust/immunity may target any
  character), and adds world-level powers: `DestroyItem` (inventory + equipment-slot cleanup,
  no material deposit — loss, not scrapping), `Teleport` (any character, through the shared
  `relocate` path: exit/enter scenes fire, the visibility cue emits, but no budget tick, no
  move history, no spawn tail), `LightsOut`, and `SetExitState` (merge a JSON patch into an
  exit's persisted state — seal or unseal doors). The **prohibition list** is the explicit
  exception (`card_protected`): quest items (`droppable: false`) and keys cannot be
  destroyed. Integrity clamps (stat floors, reconcile, the 64-effect cap) still hold —
  privilege lifts targeting, never state integrity.
- **The three shipped cards** (native, always compiled in): **`wicked:lights-out`** —
  supernatural darkness for `config.rounds` (default 2) rounds: `campaign.lightsOutRounds`
  makes **every** room unlit (`is_lit` short-circuits first, so the targeting gate,
  light-averse ×1.5, entry-swing initiative, and both view projections all follow), ticking
  down at round end with a "darkness lifts" cue on expiry; **`wicked:ruin`** — destroy a
  random unprotected item a Hero carries (unplayable when no candidate exists — rejected
  before anything is spent); **`wicked:shadow-step`** — teleport a character (default: the
  villain) to any room (`roomId` target required).
- **Wire commands.** `playCard { actorId, cardKey, roomId?, targetId? }` and
  `mulligan { actorId, cardKeys }` are Rust-side extensions (like `talk`/`wait`/`destroy`):
  budgeted, turn-gated turn-actions; the villain designation, hand membership, and the
  play-XOR-mulligan latch are engine guards (rollback-safe denials). The `ViewModel` projects
  a `villain` panel (hand faces from the catalog, pile counts, `isYou`, the latch) and
  `lightsOutRounds` — both omitted when absent, keeping pinned view shapes byte-stable.
- **The solo computer Villain.** In solo mode, a designated **non-party** villain acts after
  each player turn — alongside mob reactions, before `next_player` (so a fatal card lands in
  the round's outcome check). The deterministic rng-driven policy probes each distinct card
  in hand for playability (Shadow Step stalks the active hero's room), plays one at random if
  any qualifies, otherwise mulligans the first 3, otherwise passes. A party-member villain
  (the multiplayer GM case) is skipped — they take real turns. KO'd villains skip.
- **Authoring.** The TOML surface: a `[villain]` table (`character` — a declared mob/npc name,
  mob-first resolution, or `"@gm"` resolved at seating exactly like `gmId`; `deck` — card
  keys in authored order), `[[cards]]` faces (`key`/`name`/`text`/`config`), and optional
  `[behaviors.card.<key>]` scripted behaviors. Native `wicked:*` cards need no `[[cards]]`
  entry at all. Pinned by the `g2-villain` author + genesis goldens:

  ```toml
  [villain]
  character = "Warden"          # or "@gm" — the seated GM plays the Villain
  deck = ["wicked:lights-out", "wicked:ruin", "wicked:shadow-step", "hex"]

  [[cards]]
  key = "wicked:lights-out"
  name = "Lights Out"
  text = "Every flame gutters and dies for three rounds."
  config = { rounds = 3 }

  [behaviors.card.hex]
  onPlay = '''
    emit cue('A whispered curse crawls through the walls.')
    emit adjustStat(party[0], sanity, -2)
  '''
  ```

- **The web client surface.** Both shipped surfaces play the Villain. The CRT terminal parses
  `play <card> [to <room>]` (the room is a NAME, resolved against the live world — Shadow Step
  may target any room) and `mulligan <a>, <b>, <c>`; the active villain's hand is minted into
  the parser scope as `kind: "card"` entities (verb-namespaced so a card never collides with a
  same-named item). The CRT sidebar shows the hand face-up for the villain's own seat (pile
  counts for everyone else) and the HUD pulses a `DARK n` countdown during supernatural
  darkness; the point-and-click sidebar mirrors it with per-card Play buttons and a 3-card
  mulligan toggle-selection. Face-up rendering is gated on the GM identity (the view projects
  for the *active* seat, so an ungated panel would show the hand to players while the
  GM-villain acts). The solo computer villain announces its plays from the engine
  (`"<name> plays <card>."` mechanic cues, mirroring `MobAttack::narration`), so every surface
  narrates it for free. **The Warden's Gallery** (the `g2-villain` oracle) is registered as a
  debug-tier launcher campaign to exercise the whole loop.
- **Villain map omniscience & the map picker.** The Villain sees the ENTIRE map:
  `MapModel::reveal_world` (the shared fog-of-war model in `wickedways-tabletop`) places every
  room and exit from the live world — anchored on any already-observed rooms, fog stubs
  cleared, keyed doors whose state is still warded drawn as locked links. Both surfaces reveal
  whenever the client *is* the Villain (`villain_omniscient`: the GM identity holds the
  designated villain character — identity-based, so the full map persists off-turn, and a solo
  hero facing a computer villain keeps normal fog). A card that needs a target room
  (`CardView.needsRoom`: Shadow Step natively, or any authored card with
  `config.target = "room"`) plays through the **map picker** on the point-and-click surface —
  its Play button opens the map overlay with clickable room tiles, and since the Villain's map
  is the whole house, any room is a legal Shadow Step target. The CRT hints
  `(play … to <room>)` for targeted cards.
- **Non-goals (v1):** no deck-building or draw-economy variants beyond the fixed rules above;
  no card-driven victory conditions; no third multiplayer seat type (the multiplayer Villain
  is the GM's character).

## Key mechanics

### Action budget

Each character has an `actionsPerRound` budget (default 3 for player characters, 2 for mobs).
Whether an action costs a slot is decided per call site: each verb tail-routes through
`World::record_action(actor, budgeted, …)` passing an explicit `budgeted` flag, so the budgeted
set (move, attack, escape, take, drop, …) is fixed in code rather than in a registry keyed by
function identity. Once the budget is spent, `record_action` automatically ends the turn.
Notably, taking damage is **not** a recordable
action — taking a hit never consumes your turn. It still tail-routes through the same cap
check, though: attacking a target whose `actionsThisRound` is already at its cap auto-ends
*that target's* turn (reconcile + `onTurnEnd`/mechanic `on_turn_end`), even though the hit
itself never advances the budget.

A character's turn ends either explicitly (the `endTurn` command) or automatically the moment a
budgeted action brings `actionsThisRound` up to `actionsPerRound`. Ending a turn reconciles the
character — base stats are floored, affliction flags recomputed from effective stats, and
knock-out latched — mirroring `Character.endTurn`. Mechanic turn-end hooks fire for whichever
character's turn just ended, whether they're a party member or a mob/NPC actor. (Character
`onTurnEnd` events are a separate, still-unported hook.)

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
mitigated      = max(0, attackStrength − armorModifiers)
lightMultiplier = lightAverse && roomLit ? 1.5 : 1
finalDamage    = mitigated × max(0, 10 − mitigator) × 0.2 × lightMultiplier
```

So a fully-rested mitigator (10) absorbs all damage, while a depleted one (0) doubles it.
A `lightAverse` defender (a character or mob trait) in a lit room takes 1.5× damage. Each
armor piece that absorbs a hit loses 1 durability and stops mitigating once it breaks (see
Durability below). A broken armor piece (durability = 0) is excluded from the `armorModifiers`
sum — it contributes nothing and wears no further.

### Status effects

Statuses are triggered by stat thresholds (using effective stats — base plus any equipped-accessory bonuses):

- **KO** — Health ≤ 0
- **Panic** — Sanity ≤ 0
- **Fear** — 0 < Sanity < 5
- **Confused** — Energy ≤ 0 (with a (0, 1] hysteresis band so it does not flicker at the boundary)

A character with no active afflictions has an empty affliction set (`afflictions.list()` yields nothing).

#### Consequences

Once triggered, statuses impose hard rules enforced by `Afflictions.gate`
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
   `Afflictions.onTurnStart` rolls a
   `roll(100, rng)` d100 against an escalating threshold:

   | Status | 1st turn | 2nd turn | 3rd turn | Guaranteed by |
   |--------|----------|----------|----------|---------------|
   | Fear | 40 % | 70 % | 100 % | turn 3 |
   | Panic | 20 % | 40 % | 60 % | turn 5 |
   | Confused | 15 % | 30 % | 45 % | turn 7 |

   A successful roll marks the status *shaken off* for the rest of that depressed episode; it does not
   re-trigger until the stat recovers past the threshold and drops again. Confused separately rolls its
   50 % per-action fizzle chance independently of the turn-start shake-off.

Status lifecycle is managed by the `Afflictions` unit, which
`Character` delegates to. All randomness goes through the injected `rng` (a `() => number` constructor
option); passing a seeded RNG makes every roll deterministic for tests.

#### Immunity

Passive and timed immunity both cover Panic, Fear, and Confused only — KO can never be immunized:

- **Passive (equipped item):** an item descriptor with an `immunities` field
  confers immunity to those statuses while the item is equipped and intact. Consulted on every
  `applyFromStats` reconciliation, exactly like the accessory effectiveStat bonuses.
- **Timed (consumable):** an item descriptor with a `grantsImmunity` field (`{ statuses, turns }`)
  grants immunity for `turns` of the holder's turns when the item is used. The grant goes through the
  `GRANT_IMMUNITY` symbol seam (unforgeable by stray code); the timer ticks down
  in `Afflictions.onTurnStart` and the active status is cleared on grant.

Both fields are plain declarative `Item` descriptor fields — no factory or subclass required.

### Combat

`World::attack` collects the attacker's *equipped, non-broken weapons*, sums each
weapon's modifier onto the stat it targets, and applies the result to the defender via `takeDamage`
(which runs the mitigation above). Broken weapons (durability = 0) are silently excluded — they
neither contribute to the attack matrix nor wear further. With no non-broken equipped weapon an
attack falls back to the combatant's **natural attack** — `naturalAttack: { stat, power }`,
defaulting to a 1-point Health jab. `Mob` exposes this as an authorable trait
(`.mob(name, { …, naturalAttack })`), so a resident horror can claw Sanity, batter Health, etc.;
it is serialized with the mob. Because weapons occupy hand slots (see Equipment below), an attacker
fields at most two one-handed weapons — or one two-handed — so the summed modifier is naturally
bounded.

Durability wear happens in two places:

- **Weapons wear on attack**: every non-broken weapon that contributed to the swing loses 1 durability
  after all `takeDamage` calls resolve.
- **Armor wears on `takeDamage`**: each piece of non-broken armor that soaked incoming strength loses
  1 durability at the end of that `takeDamage` call.

#### To-hit rolls & the dice-supply seam

**Every** attacker — player or mob — rolls a **d20 to-hit** before its damage lands: a natural **20** is
a critical hit dealing **1.5×** damage; a natural **1** is a critical miss where the attacker *stumbles*
and takes 1 self-damage; **2–5** miss; **6–19** hit. Each outcome emits a mechanic cue
(`"Ada rolls d20 → 14: hit."`) for the log. Players roll their own attacks; mobs default to the house
roll.

The d20 is drawn through `World::draw_die(sides)`, the one seam any table-supplied die reaches: it
consumes a matching queued die (a literal physical outcome) if one is present, else the seeded
`World.rng` — so a physical tabletop can let a player **supply the die they rolled** (for their own
attack, or for a monster), or pick **"Roll for me"** (supply nothing; the house rolls). Supplied dice
arrive as a recorded `SupplyDice { dice }` command (on both the sync and single-seat command unions,
validated `1 ≤ value ≤ sides`), so replays remain deterministic and the golden gates hold — the queue
is transient world state, never serialized, and a supplied die draws no rng (so a fixture that supplies
hits is byte-identical to the pre-roll damage plus the roll cue). On the physical/simulator board the
dice reach the engine as a `DeviceEvent::DiceRolled { sides, values }` resolved to `SupplyDice` by the
tabletop bridge; the web surface's dice tray and the controller's `--dry-run` both drive it. Because all
randomness still flows through `World.rng` or recorded command data, the determinism invariant is
preserved either way. A **pause-at-the-moment** roll-request handshake (prompt the table *when* a roll
is owed) is specced in [`docs/tabletop-async-rolls-spec.md`](docs/tabletop-async-rolls-spec.md).

When the defender's Health drops to ≤ 0 as a result of damage, `reconcile` fires and — if this is a
false→true KO transition — calls `onKnockOut` exactly once. For mobs this drops loot (see
Drop-on-defeat above); for player characters the base implementation is a no-op.

Note the mitigation interaction: a defender whose *mitigator* stat for the attacked stat is
≥ the cap fully absorbs the hit (multiplier `max(0, MAX_STAT − mitigator) × …` → 0). So a
natural attack only lands on a target with a sub-cap mitigator for that stat — power alone
can't punch through full mitigation.

### Custom mechanics

The custom-mechanics system lets a campaign author layer typed, namespaced game
rules on top of the core engine — a doom counter, a fire-ward, a sanity spiral —
without touching engine internals.

#### Hook taxonomy

Every mechanic implements the `MechanicOp` trait. Hooks fall into two
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

Mechanics communicate intent through a **closed union** of eight effect kinds — they
cannot reach raw setters:

| Kind | What it does |
|---|---|
| `{ kind: "damage"; target; amount }` | `Health −amount` (floored at 0) |
| `{ kind: "heal"; target; amount }` | `Health +amount` (floored at 0) |
| `{ kind: "adjustStat"; target; stat: "sanity"\|"energy"; delta }` | Sanity or Energy ±delta via `ADJUST_STAT` |
| `{ kind: "grantImmunity"; target; turns }` | Grant all-status immunity for `turns` rounds (floored at 0) |
| `{ kind: "cue"; cue }` | Emit a `{ kind: "mechanic", cue }` presentation cue |
| `{ kind: "status"; fields }` | Emit a `{ kind: "status", fields }` presentation cue |
| `{ kind: "giveItem"; from; to; item }` | Move an item id `from`→`to` (key→keyring, else inventory), leaving the item registry intact |
| `{ kind: "setVisible"; target; visible }` | Flip `target`'s `visible` flag (reversibly) |

All magnitude arguments are floored at 0 before being applied; `adjustStat` passes
the delta sign through unchanged (the stat accumulator floors separately). Unlike the
target-oriented effects, `giveItem`/`setVisible` are **not** party-restricted: they
act on any character (NPCs and mobs included). `giveItem` throws `ProceduralViolation`
if `from` does not hold the item or `to` cannot be resolved; `setVisible` on a missing
target is a no-op.

#### Hook contexts

Every hook receives a `HookCtx<'a>` — three borrowed fields:

- `state: &mut Value` — the mechanic's own JSON state; **mutate in place**
- `view: &CampaignView` — a read-only projection (round, maxRounds, party, rooms); no engine
  handles, no clock, no IO (guardrail B)
- `rng: &mut Rng` — a mutable borrow of the campaign's seeded RNG, the only randomness available
  (`dice::roll(sides, unit)` is a free function that turns a draw into a die face)

`TurnCtx` adds `actor: &CharacterView`. `ActionCtx` adds the action being taken.
`CharacterView::has_equipped(key)` returns `true` when an equipped item resolves under the given
catalog key (matched via the item's `behavior_key`).

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

Mechanics are inert unless a campaign opts in with a `[[mechanics]]` entry in its TOML —
`key` plus an optional `config` table. The opt-in list is static config fixed at authoring
time; it cannot change mid-play. **Authored order is precedence**: earlier mechanics' hooks
run first, so an earlier transformer's `final` result pre-empts all later ones.

#### Custom actions

A mechanic may expose named actions. A native op implements
`MechanicOp::run_action(action_key, cx) -> Option<Vec<Effect>>` (returning `None` when it has no
such action); a scripted one authors them as `[behaviors.mechanic.<key>.actions]` statement
bodies. Every action costs 1. A player character invokes one through
`World::use_mechanic_action(mechanic_key, action_key, …)` — reached from the surfaces as the
`mechanicAction` command — which is a **budgeted** action: it counts against the per-round action
budget, and a fizzled invocation still ticks it.

#### Serialization

Only `{ key, state }` persists per mechanic — behavior is never serialized. On load,
`resolve_mechanic_op(key, catalog)` re-binds it (native registry first, then the catalog's
`family: "mechanic"` script); an unresolvable key is rejected by `validate_mechanics` with
`Mechanic '<key>' is not registered.` State is a JSON object namespaced by key. The snapshot
format as a whole is versioned by `SCHEMA_VERSION` (currently `6`).

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

Custom mechanics are authored in the TOML campaign format as scripted behaviors
(compiled by `wickedways-author` into `catalog.behaviors`, resolved by the engine's
mechanic registry at load). A doom-clock that ticks every round and fires a cue at a
threshold:

```toml
[[mechanics]]
key = "doom-clock"

[behaviors.mechanic.doom-clock]
init = { doom = 0 }
onRoundEnd = '''
  set state.doom = state.doom + 1
  guard state.doom == 3
  emit cue('The house exhales. Something below begins to climb.')
'''
```

Hollow House's `dread`, `storyteller`, and `status-bar` mechanics
(`campaigns/hollow-house.toml`) are the shipped reference examples.

### Scripted behaviors (the ops DSL)

Alongside compiled-in native `MechanicOp`/`ExitBehavior`/victory behaviors, first-party
ops can be authored as **scripts**: a closed, loop-free, deterministic data-AST
(values, expressions, statements) interpreted by the Rust core. Scripts are pure —
they read a projection (`CampaignView`, the actor, the action, their own JSON
state) and return effects / a boolean / an optional narration line; the engine
applies the results through the same collect-then-apply pipeline as native ops.

- **Authoring:** the TOML `[behaviors.*]` tables (compiled by `wickedways-author`)
  emit the AST via the ops-DSL expression parser.
- **Storage/resolution:** scripts ride in the campaign catalog under
  `Catalog.behaviors[key]`; the engine resolves a behavior key against the native
  registry first, then the catalog (`family: "mechanic" | "exit" | "victory" | "item"`).
  Unknown keys and ill-shaped ASTs fail fast at load with `ProceduralViolation`.
- **Item behaviors (`onUse` / `onRead`):** an item keyed to an `item`-family script
  can drive its `use` and `read` side effects from the DSL instead of a hand-written
  closure. The two hooks fire at the exact points the native paths do, so ordering is
  observable and contract-bound:
  - `onUse` runs **after** the usable/KO guards (a non-`usable` item or a KO'd holder
    is still rejected before any script runs) and **before** `grantsImmunity` is
    applied and the item is consumed — so the script sees the pre-consume state and
    its emitted effects land ahead of immunity/consumption.
  - `onRead` runs **before** the item's `lore` cue is emitted, matching
    `Character.read` (free action, non-consuming) — the read-triggered effect precedes
    the flavour line, so a cursed tome can drain Sanity and *then* narrate.

  Items without an `item`-family script (or with an unset hook) are pure no-ops on that
  path — no descriptor churn — so existing items are unaffected. **Laudanum** (Hollow
  House) is the first dogfooded example: its `onUse` emits `+6 Sanity`, reproducing the
  hand-written `laudanum` descriptor.
- **Determinism:** f64 arithmetic is restricted to `+ − × ÷` and comparisons,
  iteration is ordered, string-from-number matches JS `Number.prototype.toString`
  byte-for-byte, and randomness only comes from the injected rng.
- **Hollow House** is the reference user: its dread/storyteller/status-bar
  mechanics, all three keyed doors (cellar/study/attic), all three victory conditions,
  and laudanum's `onUse` effect are authored as scripts in
  `campaigns/hollow-house.toml` and pinned by the `scripted-*` replay
  goldens.

### Mob encounters & loot

#### Mob origin

A mob's **origin** (`"room"` | `"campaign"` | `"unbound"`) gates which drops it releases on
defeat. Room-attached mobs (seated by the assembler with origin `"room"`) may drop
key items; campaign-roving mobs (spawned by the encounter table, origin `"campaign"`) never do.
A freshly constructed mob starts as `"unbound"` until the engine sets its origin.

#### Drop-on-defeat

When a mob's Health hits 0, its `onKnockOut` hook fires exactly once:

1. **Material drops** — any `materialDrops` in the mob's options are deposited into the
   campaign's shared material pool via `World::deposit_materials`, and each new material type is
   also recorded in the Codex (attributed to the defeating character, or the party if no
   defeater is resolvable).
2. **Item loot box** — held items are relinquished and placed into a fresh `Loot` box
   (human name `"<mob>'s remains"`, machine id `${mob.id}:remains`, capacity = initial items + 2)
   which is added to the mob's current room. If the mob has no items and no keys to drop,
   no box is created.
3. **Key items** — if the mob is room-attached (`origin === "room"`), keys on its keyring
   are also stashed into the box via the `STASH_DROP` seam (past normal capacity, bypassing
   the key-exclusion guard on the regular stow path). Campaign-roving mobs never drop keys.

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

Formations are **authored, not registered at runtime**: `[[formations]]` entries ride in the
description into `campaign.encounter_table`, each a `behaviorKey` plus a positive `weight`, and
`World::maybe_spawn` resolves each key at spawn time (native registry first, then
`Catalog.formations`). Roving mobs may not drop key items — the author/assembler validation
enforces that. The table carries a `baseChance` (default 20, on a 0–100 scale, authored as
`[opts] baseEncounterChance`), and all spawn randomness is drawn from `World.rng`.

When a player character moves into a room, the move path calls `World::maybe_spawn`.
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

##### Formations as data (`Catalog.formations`)

A formation does not have to be a hand-written factory. It can instead be authored as **plain
data** — a [`FormationDescriptor`](crates/wickedways-core/src/world/formation_descriptor.rs)
(`{ mobs: MobSpec[] }`), where each `MobSpec` is a serializable mob template (`name`, `stats`,
`naturalAttack`, `drops`, `baseEscapeChance`, `lightAverse`, `materialDrops`, `actionsPerRound`)
whose field set reproduces the exact `CharacterSnapshot` a native factory would emit. Descriptors
travel in the catalog under `Catalog.formations`, keyed by the same `behaviorKey` the encounter
table references. When the encounter table picks a key, `maybe_spawn` resolves it **native first,
then descriptor**: a compiled-in `FormationBehavior` wins if one is registered for the key,
otherwise the catalog descriptor is interpreted (`None` from neither is a `ProceduralViolation` at
the spawn site). Descriptor mobs get deterministic ids (`campaign-mob:{name.toLowerCase()}`, then
`…#{i+1}` for the second and later mobs), and their `drops` are seeded into the world by
`maybe_spawn` right after `build` (a descriptor's `build` has no catalog access).

Hollow House exercises this path: its roving **Rats** are authored purely as descriptors (a single
Rat and a Rat pair) rather than as a code factory. A Rat is a low farm mob (Health 2 / Sanity 2 /
Energy 3, a 1-power Health bite, escape 50, dark-agnostic) that drops a **rat-tail** — a usable,
non-key item whose `use` restores **+1 Sanity** to the user. Because the rat-tail is not a key, it
is a legal roving-formation drop.

### Materials and crafting

Crafting components are pooled at the **campaign** level and shared party-wide, not held per
character. The pool (`campaign.materials`) is fed only through sanctioned paths — destroying
(scrapping) an item deposits its `recipe`, and harvesting a material cache. A cache can't be
farmed because harvesting latches its `depleted` flag and a depleted cache yields nothing.
`World::can_afford` gates spending, a component is deleted from the pool when it reaches zero, and
every deposit funnels through the single `World::deposit_materials` seam.

`World::craft(recipe_id, …)` turns a known recipe into an item and is a **free** action (no budget
tick, no history); the attempt fizzles while the character is Confused. A
`CraftingRecipe` is discriminated into two tracks: a
**materials** recipe withdraws from the pool, while a **keys** recipe consumes keys by code
(validated atomically — every code must be fully available before any key is spent). Recipe
knowledge is party-wide and campaign-scoped: `campaign.known_recipes` is seeded by the assembler
from the campaign's declared `[[recipes]]`, so every member can craft them. (An item descriptor
may carry a `teaches` field, but the engine does not yet read it — picking such an item up does
not currently impart its recipe.)

### Durability and repair

Gear authored with `maxDurability` wears with use. Armor loses 1 durability each time it absorbs
a hit and stops mitigating once broken (durability 0). Durability is read freely but written
through exactly one seam, `World::set_durability` — the only place an item's durability is
mutated. The seam itself does not clamp: callers pass `durability - 1`, and only non-broken items
(durability ≥ 1) ever wear, so the floor is upheld by the callers rather than the setter. `repair`
restores a held, damaged item to full for a material cost proportional to the missing fraction —
`ceil(recipe[c] × missing ∕ maxDurability)` per component — drawn from the campaign pool. Repair is
**free** and throws if the item is unheld, has no durability, is already full, or the party can't
afford it.

### Equipment slots and handedness

Equipping is bounded by named anatomy rather than an unlimited flag. An item declares a slot
**kind** (`SlotKind`: hand, finger, wrist, head, torso, legs, feet); a
character has discrete, single-occupancy **named slots** (`EquipmentSlot`)
— head/torso/legs/feet, two wrists, two hands, and two ring fingers per hand.
`Character.equip(item, targetSlot?)` validates that the item is held, equippable, and has a slot
kind, then fills the first free named slot of that kind (or an explicit `targetSlot`),
**auto-swapping** the occupant when none is free. A `twoHanded` weapon spans both hand slots, and
equipping a one-handed weapon displaces a worn two-hander; `Character.unequip(item)` clears every
slot the item occupies. Both are **free** and leave displaced items in inventory, unequipped.

Occupancy lives in the character's slot map but mirrors `properties.equipped`, so the combat
filters are unchanged — and now naturally capped. Every equip path routes through
`World::equip` / `World::unequip`, so slot capacity can't be bypassed.

### Keys

Keys are a distinct item variant (`ItemSnapshot::Key`) that lives on a character's
keyring rather than in inventory slots. A key carries a `keyCode` matched by scene/lock gates and a
`consumeOnUse` flag. Keys are **transfer-only**: the generic drop path rejects them
(`Keys cannot be dropped; hand them over with transferKey instead`), so the only way a key changes
hands is the `transferKey` command (recorded as a pickup on the recipient). The `consumeKey`
command spends a key — removing it from the keyring and unhoming it — when a `consumeOnUse` gate is
satisfied.

### Dialogue

An NPC's conversation is a **data-driven catalog behavior**: a
`BehaviorScript::Npc` resolved through the
NPC's `npcBehaviorKey` against the campaign's `behaviors` map, pinned by the replay goldens. The behavior is an
`NpcScript` `{ description, default, dialogue }` — a
`description` (returned by `examine`), a `default`
`DialogueEntry` for a bare `talk`, and an
ordered list of prompt→response `dialogue` entries. Each entry is `{ match, response, effects, once }`,
where `match` is a `DialogueMatch` —
`{ kind: "exact", text }` or `{ kind: "fuzzy", tokens }`.

**Matching selects exactly one entry.** The talk prompt is lowercased and tokenized — split on
whitespace, with ASCII punctuation stripped from each token's *edges* (internal punctuation kept)
and empty tokens dropped. An **exact** entry matches when the tokenized prompt equals the tokenized
trigger (order-exact, whitespace- and edge-punctuation-insensitive); a **fuzzy** entry matches when
all of its normalized, non-empty, deduplicated tokens appear in the prompt's token set (an
order-independent subset — extra prompt tokens are fine), scoring by that token count. Any exact
match wins (first authored); otherwise the highest-scoring fuzzy match (ties break to the first
authored); otherwise — for a bare `talk`, or when nothing matches — the `default` entry.

A resolved entry emits its `response` (a text cue) **and** its `effects`, run through the same
`Effect` pipeline as scene mechanics (including `giveItem`/`setVisible`) and subject to
the same `MAX_EFFECTS_PER_EVENT = 64` cap. The `once` flag latches the **effects only**: a `once`
entry fires its effects a single time, recorded in the NPC's per-instance `npcState`
(`{ "onceFired": { … } }`) that serializes with the character — so re-talking after the hand-off
replays the response cue without re-firing the effects. Two NPCs sharing one behavior key keep
independent latches.

The `talk` verb resolves a co-located **visible** NPC occupant (`CharacterKind::Npc`). It is a **free**
interaction: it does **not** advance the round and does **not** provoke mob reactions. Talking to a
missing, invisible, or non-NPC target fails with "There's no one here to talk to." The CRT parser
accepts `talk`/`speak`/`ask` in a bare form (`talk to the keeper`) or with a quoted prompt
(`talk to the keeper "how do I get out"`). `examine <npc>` is likewise a **free**, non-advancing
action that returns the resolved NPC's `description`.

**Authoring.** Write the behavior as a `[behaviors.npc.<key>]` table — a `description`, a
`[behaviors.npc.<key>.default]` reply, and any number of dialogue entries, each with `match`,
`response`, and optional `effects` / `once`. The compiler lowers it to the
`BehaviorScript::Npc` AST in the campaign's `behaviors` map under the NPC's `npcBehaviorKey`.

**The Hollow House caretaker.** The reference campaign puts this machinery to work in its start
room. Entering the Foyer at game start fires an `"enter"` scene that sets the mood — the front
door thudding shut for good, a stooped figure waiting in the gloom with a ring of keys shaking in
his hand. A `Caretaker` NPC stands there holding the campaign's cellar key: `examine caretaker`
returns his description, and a single `talk to caretaker` runs a `once` hand-off entry whose
effects `giveItem` the cellar key to the player and `setVisible false` the caretaker so he
vanishes (both free/non-advancing, fired exactly once — re-talking would only replay the line, and
he is unreachable anyway). That cellar key unlocks the keyed Foyer->Cellar door (the "cellar
door"), opening the corridor down to the Revenant, its iron key, and the attic win beyond —
otherwise unchanged.

### Serialization (save/load)

A whole in-play world round-trips through a plain-data snapshot
(`crates/wickedways-core/src/world/snapshot.rs`). Serialization walks the live world —
the party plus every room reachable from a party member's current room via exits (BFS),
and those rooms' occupants, loot, material caches, and all characters'
inventory/keyring/equipment items — and emits a self-contained, JSON-friendly snapshot
(`schemaVersion`, campaign core state, rooms, characters, items, loot, material caches,
codex). Rooms no party member occupies and nothing links to are not captured —
reachable-from-party is the playable world for save/load. Affliction state (active
statuses, per-status turn counters, shaken-off set, and immunity stacks) is captured in
full; a restored world is indistinguishable mid-turn from the original.

**Behavior keys.** Code can't be serialized; instead every scene, non-key item, recipe,
and formation carries a `behavior_key` — a stable string resolved against the campaign's
`Catalog` at hydrate time (native registry first, then `catalog.behaviors` scripts; see
the Behavior-trait pattern under *The Rust engine core* below). Key items (`keyCode`
set) are exempt: they are rebuilt from their stored fields without a catalog lookup.
`World::from_snapshot` itself is infallible — it does no `schemaVersion` check and no
id-reference check; behavior-key resolution is what fails loudly, and it is
`validate_mechanics` (called after loading) that reports an unregistered key as a
`ProceduralViolation`. The RNG does **not** ride in the snapshot: `from_snapshot` reseeds to
`Rng::seeded(0)`, so a host that needs the stream to survive save/load carries it across itself —
the wasm `Authority::restore` does exactly that, preserving its rng around the swap.

## Multi-client sync

The snapshot format powers multiplayer over a command log driven by an authoritative
[`SyncAuthority`](crates/wickedways-core/src/sync/authority.rs). Each client runs a
`SyncCoordinator` that owns a local replica `World` and delegates all resolution to the authority.

`SyncCoordinator::submit(&mut transport, command)` is a thin pass-through: it calls
`transport.submit(command)`, then applies the authoritative response to the local replica and
returns the authority's `SubmitResult` — `Committed { seq, delta }` or `Denied { reason }`. The
coordinator never resolves commands itself and never optimistically mutates — state changes only
when an authoritative delta arrives, so there is no rollback and no CAS conflict.

**Reject ≠ fizzle.** A rejection (`SubmitResult::Denied`) means the authority denied the
command (wrong turn, bad lifecycle state, seat-ownership check, or an engine constraint thrown by
`ProceduralViolation`). A fizzle is a legal action that simply had no mechanical effect (e.g. an
attack that dealt 0 damage) — those commit, produce a delta, and propagate normally.

The coordinator is **pull**-based: after a submit, and on demand via `SyncCoordinator::sync`, it
drains `entries_since(last_applied + 1)` and applies each delta in order through
[`sync::apply_delta`](crates/wickedways-core/src/sync/applier.rs) — which patches state and
**never draws rng or runs game logic**, so replicas converge deterministically with zero
determinism burden. An out-of-order entry is buffered until its predecessor lands.
`SyncCoordinator::join(&transport)` brings a late client up to date from the transport's latest
checkpoint plus the deltas since. A genuinely-async push subscription is a WebSocket-transport
concern, not the coordinator's.

Because a `join` may swap in a freshly deserialized world, consumers read state through
`coordinator.replica()` / `coordinator.snapshot()` rather than caching a reference across a `submit`.

**`SyncTransport` seam.** The sync core depends only on the `SyncTransport` trait — `head`,
`submit`, `entries_since`, `load_snapshot`. `InProcessTransport` wraps an in-process
`SyncAuthority` and drives the single-player and test paths; the web client's `WsTransport`
forwards to the room server, which hosts its own `SyncAuthority` per campaign — both topologies
are the same shape.

```rust
let mut transport = InProcessTransport::new(SyncAuthority::new(world, catalog, opts));

let mut coordinator = SyncCoordinator::join(&transport);
let result = coordinator.submit(&mut transport, Command::NextPlayer);

// elsewhere / another client on the same transport:
let mut replica = SyncCoordinator::join(&transport);
replica.sync(&transport);
```

**Rust port (landed).** The sync layer and room server are ported to Rust
alongside the engine (see `docs/superpowers/specs/2026-07-14-rust-phase-2c-*`). Landed so far:

- **The sync core** in [`crates/wickedways-core/src/sync/`](crates/wickedways-core/src/sync/): the
  actor-tagged [`Command`](crates/wickedways-core/src/sync/command.rs) union (mirroring
  the original TS wire shapes byte-for-byte, plus the Rust-side extensions — `talk`, `wait`,
  `destroy`, `playCard`, `mulligan`, and `supplyDice`), the [`authorize`](crates/wickedways-core/src/sync/authorize.rs)
  gate, and the native [`SyncAuthority`](crates/wickedways-core/src/sync/authority.rs) (submit →
  authorize → apply → `Delta` diff → ordered log) + `Delta` apply + `SyncCoordinator`. The **sync
  gate** ([`crates/wickedways-assemble/tests/sync_gate.rs`](crates/wickedways-assemble/tests/sync_gate.rs))
  replays committed command sequences through the Rust authority and asserts each `{ seq, delta }`
  matches the committed golden byte-for-byte.
  - **Solo mode** (`AuthorityOpts.solo`) is how the offline single-player host (the browser client's
    `SinglePlayerTransport`) recovers the full per-turn machinery the explicit multiplayer path leaves
    to the GM. A time-advancing command (`move`/`take`/`drop`/`use`/`attack`/`wait`) drives a turn that
    respects the character's `actionsPerRound` **action budget**: the turn begins with `start_turn`
    (affliction tick + campaign `onTurnStart`, e.g. dread) on the actor's first action, each action
    spends a budget slot, and the turn ends — light-tied mob reactions → `next_player` (round advance +
    outcome) — only once the budget is spent (or immediately on `wait`, a pass). So a player gets its
    whole budget of actions per turn and dread ticks once per turn, not once per action. Mob strikes
    ride the delta as mechanic cues (`MobAttack::narration`). The multiplayer room server leaves `solo`
    off — mob strikes stay the GM's explicit `mobAttack` there.
  - **Managed turns** (`AuthorityOpts.manage_turns`) is the multiplayer complement to the budget: the
    room server turns it on so a seat's turn-actions are refused once its `actionsPerRound` budget is
    spent (`submit` denies with "You have no actions left this turn."), and a turn-changing command
    (`beginCampaign`/`nextPlayer`/`endTurn`) `start_turn`s the incoming player — resetting the budget
    and firing `onTurnStart` (dread). A player ends **their own** turn with the `endTurn` command (the
    surfaces' _End Turn_ button, which the server routes to that seat via `actorOf`); the GM's
    `nextPlayer` still advances the turn for an unavailable player. The budget lives in `submit`, not
    the sync `authorize` gate, and the sync gate constructs the authority with
    `AuthorityOpts::default()` (both `solo` and `manage_turns` off), so authorize stays budget-free
    and byte-stable against the goldens.
  - **Keyed doors** are gated client-side. The sync `move` command carries a room id and lands via
    `move_to`, which performs no door check (the guard lives
    only in the direction-based `go`). So the surfaces gate a `move` with `World::exit_block_reason`
    (a pure `can_pass` query that runs no `run_script`), narrating the door's fail message and issuing
    no command when it's locked — e.g. the Hollow House cellar door stays shut until the caretaker's
    dialogue hands over the key.
  - **Materials & crafting** are wired end to end. `harvest`/`craft`/`repair`/`destroy` are **free**
    turn-gated commands (`authorize` requires the actor's turn; none tick the budget) that resolve
    against the ported engine verbs — harvesting a room's `MaterialCache` into the shared pool,
    crafting a known recipe's `outputItemKey` into a fresh item, repairing worn gear for a
    proportional cost, and scrapping an item back into the pool. The widened `ViewModel` projects the
    room's caches, the party's known recipes (with affordability), and the pool, so the CRT parser
    resolves `harvest <cache>` / `craft <recipe>` and both surfaces render them. `destroy` is a
    Rust-side wire extension (like `talk`/`wait`); the differential gate never issues these, so oracle
    parity holds. Campaigns declare caches/recipes in the TOML authoring surface (`[[caches]]` /
    `[[recipes]]`); the multiplayer client projects against the campaign's bundled catalog so recipes
    and aliases resolve there too.
- **The room server** in [`crates/wickedways-server/`](crates/wickedways-server/): a Rust/axum
  server. A `RoomServer` hosts a native `SyncAuthority` per campaign behind a per-campaign
  tokio actor (`Table`) that serializes submit → persist → ack (flush-before-ack), gates appends by
  seat ownership (`Membership`), persists to SQLite (`SqliteStore`), and speaks the
  `wickedways-transport` wire protocol over a `/ws` WebSocket endpoint. A two-client convergence e2e proves two replicas
  converge over a real socket.

The sync gate (`cargo test -p wickedways-assemble --test sync_gate`) replays the committed
command-log goldens against the Rust authority and pins the deltas byte-for-byte. Chat and
A/V comms are not implemented in the Rust server yet; the wire protocol reserves their
message arms (`crates/wickedways-transport`).

## Notable patterns

- **Branded ID types** (the `branded_id!` macro in `crates/wickedways-core/src/world/ids.rs`)
  give `CharacterId`, `RoomId`, `ItemId`, `LootId`, etc. distinct compile-time identities at zero
  runtime cost, so one kind of id can't be passed where another is expected.
- **Lifecycle guards** throw `ProceduralViolation` to keep the game in a legal state.
- **Single write seams** — invariant-bearing mutations funnel through one engine function
  rather than ad-hoc field writes (durability wear, for instance, has exactly one writer), so
  the rule that guards an invariant lives in exactly one place.

## The Rust engine core, module by module

The sections below document `crates/wickedways-core`'s subsystems in detail — the
mechanics op-registry, keyed exits, scenes, victory conditions, formations, the ops
DSL, and the sync layer. They are the authoritative deep-dive on the engine as
shipped.

### Mechanics: the op-registry (`crates/wickedways-core/src/world/mechanics/`)

The campaign mechanics system's extension points. On the Rust side,
mechanics are still **data** — a campaign's `{ key, state }` list (`campaign.mechanics`)
— but instead of rebinding an author-registered TS closure, each `key` resolves to a
compiled-in, stateless `impl MechanicOp` via the static lookup `mechanic_op(key)`; an
unrecognized key is a `ProceduralViolation` (`validate_mechanics`), mirroring the TS
registry throw at hydrate.

`MechanicOp` exposes the same hook set as the TS `Mechanic` interface —
`on_round_start`/`on_round_end`, `on_turn_start`/`on_turn_end`, `on_action`, and the
damage transformer `modify_damage` — each defaulted to a no-op so an op only implements
the hooks it needs. Hooks return the closed, eight-variant `Effect` enum — `Damage`, `Heal`,
`AdjustStat`, `GrantImmunity`, `Cue`, `Status`, `GiveItem`, `SetVisible` — routed through
`apply_effect`/`adjust_stat` (Damage/Heal/AdjustStat reconcile
the target; GrantImmunity/Cue/Status do not). Damage/Heal/AdjustStat/GrantImmunity may only
target a **party member** — mirroring TS's `campaign[FIND_CHARACTER]` lookup — so a mechanic
that resolves an effect against a non-party character (e.g. a mob) throws a
`ProceduralViolation` rather than silently no-op'ing.

`dispatch_round`/`dispatch_turn`/`dispatch_action` fire at the same points as the TS
turn loop (round start/end, turn start/end, and budgeted actions) and preserve
**collect-then-apply**: every enabled mechanic's reducer runs against a read-only
`CampaignView`/`CharacterView` projection first, and only after all reducers have run
are the collected effects applied in order — a mechanic can't observe another's effects
mid-event. A per-mechanic-per-event cap of `MAX_EFFECTS_PER_EVENT = 64` throws a
`ProceduralViolation` if exceeded, matching the TS guardrail.

`run_damage_transformers` folds post-mitigation damage through each enabled mechanic's
`modify_damage` in opt-in order, clamping the running value to `>= 0` after every step; a
`TransformResult::Final` result locks the value, emits a diagnostic `"{key} fixed damage
at {value}."` cue, and short-circuits the remaining chain. `combat::take_damage` slots
this chain between built-in mitigation and the stat subtract — the order is **mitigate →
transform → subtract**, matching `Character.takeDamage` in the TS oracle.

An op may also expose named custom actions via `MechanicOp::run_action(action_key, cx)
-> Option<Vec<Effect>>` (`None` means the key is unrecognized). A player invokes one
through the `Command::MechanicAction { mechanic_key, action_key }` command / the
`use_mechanic_action` method — mirroring TS's `useMechanicAction`/
`INVOKE_MECHANIC_ACTION` — which is a **budgeted** action: it gates, runs the action's
effects through `apply_all`, records an `ActionHistoryEntry::MechanicAction`, then
ticks the budget and dispatches `on_action` via the shared `record_action` path (same
signature as every other budgeted action). Data-driven mechanics are the ops DSL's
`BehaviorScript::Mechanic` family — see *Scripted behaviors (the ops DSL)*.

### Keyed exits: the `ExitBehavior` registry (`crates/wickedways-core/src/world/exits.rs`)

Keyed-door traversal follows the same registry idiom as mechanics: an
exit's `behavior_key` resolves to a compiled-in, stateless `impl ExitBehavior` via the
static lookup `exit_behavior(key)`, rather than rebinding an author-registered TS
closure; an unrecognized key surfaces as a `ProceduralViolation` at the `go` call site.
`ExitBehavior` exposes `can_pass(actor, state)` (read-only), an optional
`run_script(actor, state)` that may mutate the exit's persisted `state` and return a
one-time narration line, and optional `pass_message`/`fail_message` strings — mirroring
the TS `Exit`'s `preconditions`/`script`/`passMessage`/`failMessage` contract.

`World::go` evaluates a keyed exit before moving: a blocked exit (`can_pass` fails)
emits its `fail_message` (if any) as a `Mechanic` cue and does **not** move; a passable
exit runs `run_script` — falling back to `pass_message` when the script yields no
narration — emits that line as a cue, then delegates to `move_to`. A behavior-free exit
(no `behavior_key`) is always passable and skips straight to `move_to`. The reference
behavior, `conformance:keyed-door`, gates on `state.unlocked` or the actor holding a
`"brass-key"`-keyed item, and flips `state.unlocked = true` (once, with narration) the
first time a keyed actor passes.

The `ViewModel` projects exit/lock state to renderers via its `exits` /
`lockedDoors` fields.

### Scenes: native `SceneBehavior` + data-driven `BehaviorScript::Scene` (`crates/wickedways-core/src/world/scenes.rs`)

Room-attached scene hooks follow the same idiom as keyed exits: a
scene's `behavior_key` resolves to a compiled-in, stateless `impl SceneBehavior` via the
static lookup `scene_behavior(key)`; an unrecognized key surfaces as a
`ProceduralViolation` at the firing site. `SceneBehavior` exposes `can_play(room, state)`
(read-only over a `RoomView` and the scene's own persisted `state`) and
`run_script(room, state)`, which may mutate that `state` and returns the mechanic cues to
emit (`Vec<MechanicCue>`, empty meaning none) — mirroring the TS `Scene`'s
`preconditions`/`script` contract, extended so the script can emit cues (the TS `script`
was previously `void`-returning).

**Scenes are also authorable as data.** `resolve_scene(key, cat)` resolves
a scene's `behavior_key` **native-first**: a compiled-in `SceneBehavior` wins
(`ResolvedScene::Native`), and only if no native behavior is registered does it fall back to
a catalog `BehaviorScript::Scene`
(`ResolvedScene::Scripted`); an unregistered key — or a catalog key of a non-scene family —
resolves to `None` and is the same `ProceduralViolation` at the fire site (and
`validate_mechanics` fails fast on it). A scripted scene is a
`SceneScript` `{ canPlay, onEnter?, onExit? }`
— a `can_play` predicate `Expr` (absent/`null` = always playable) plus optional
`on_enter`/`on_exit` **effect bodies** (`Vec<Stmt>`), mirroring the `MechanicScript`/`ItemScript`
hook-body shape. In `fire_scenes` a scripted scene reads the **live world** (a read-only
`CampaignView` plus the entering/exiting character's view, via the `ScriptedScene` adapter's
World-backed room resolver); it gates the matching-phase body on `can_play`, evaluates that
body into an ordered effect list, and runs it through the same collect-then-apply `Effect`
pipeline the mechanics and dialogue use. So an `on_enter`/`on_exit` body can emit cues **and**
`SetVisible`/`GiveItem`/`SetState` effects, subject to the same `MAX_EFFECTS_PER_EVENT = 64`
cap (exceeding it is a `ProceduralViolation`). The scene's own JSON `state` is threaded through
the body (readable by `can_play`, mutated by `SetState`) and written back before the effects
apply. Native scenes are untouched — they keep the cue-only `run_script` path.

**Authoring.** Write a scripted scene as a `[behaviors.scene.<key>]` table with `canPlay`,
`onEnter`, and `onExit` — the hook bodies compile to DSL `Stmt` lists and `canPlay` to a DSL
`Expr` — which the compiler emits as the `BehaviorScript::Scene` AST in the campaign's
`behaviors` map under the room scene's `behaviorKey`. `canPlay` is always serialized (`null` = always playable), mirroring the Rust
`SceneScript` serde shape (`#[serde(default)]`, not skip-if-none).

`World::move_to` fires scenes at two points per move, matching TS `Room.exitRoom`/
`Room.enterRoom`/`#enterRoom`:
- **Exit-phase scenes** of the departed room fire first, while the mover is **still** an
  occupant of that room (so `can_play`/`run_script` observe it in the room's `RoomView`),
  and only then is the mover removed from that room's occupancy.
- **Enter-phase scenes** of the destination room fire after the mover has **already**
  joined that room's occupancy, and before the destination's visibility cue.

Each matching-phase scene on a room fires in snapshot order; an unregistered
`behavior_key` on a matching-phase scene aborts the move with a `ProceduralViolation`.
Every emitted mechanic cue is pushed as a `Mechanic` cue on the shared `cues` buffer
**before** the destination's visibility cue, which in turn precedes the move's `Action`
cue — so one `go` that crosses a lit boundary can emit, in order: old-room exit-scene
cues, new-room enter-scene cues, a visibility cue (dark destination only), then the move
action cue. The reference behavior, `conformance:visit-counter`, fires while
`state.count < 3` and the room is occupied, incrementing `state.count` and emitting a
cue naming the room and the new visit count.

**Start-room enter-scenes fire at `begin_campaign`, not at assembly.** Seating places the
PC in the start room WITHOUT firing scenes, so genesis carries an **un-fired** start-room
scene (pristine state). `begin_campaign` then fires the active player's start-room
enter-scenes into the same buffer `take_startup_cues` returns — so a start-room scene's cue
surfaces as a startup cue and its state advances exactly once. The fire-point is pinned
**after** the round-0 `onRoundStart` dispatch (the replay goldens depend on this ordering). Regular later `move`/`go` keep firing scenes as before (default
`fireScenes = true`). `validate_mechanics` fails fast on any room scene whose `behaviorKey`
resolves via neither the native registry nor a catalog descriptor.

### Encounter spawning: the `FormationBehavior` registry (`crates/wickedways-core/src/world/formations.rs`)

The roving-encounter table follows the same idiom as keyed exits and scenes: it is
ported: a registered formation's `behaviorKey` resolves to a compiled-in, stateless
`impl FormationBehavior` via the static lookup `formation(key)`, rather than rebinding an
author-registered TS factory. `FormationBehavior` exposes a single method,
`build(&self, &CampaignView) -> Vec<CharacterSnapshot>`, and each mob it returns MUST
carry a deterministic id — unlike ordinary character creation, spawned mob ids are not
auto-derived. The reference behavior, `conformance:wraith`, always builds one fixed
`"campaign-mob:wraith"` snapshot.

`World::maybe_spawn(room, cat)` is the port of TS `EncounterTable.maybeSpawn` and runs
the same gate sequence:

1. **First-visit-only.** The room is marked visited **unconditionally** on first visit —
   before any other check — so a suppressed spawn still consumes the room's one shot.
   An already-visited room short-circuits immediately.
2. **Active-occupant guard.** Suppressed if the room already holds an active (non-KO)
   non-party occupant.
3. **No-formations guard.** Suppressed if the encounter table has no registered
   formations.
4. **Threshold roll.** `threshold = clamp(baseChance * spawnModifier, 0, 100)`; a
   `roll(100)` above the threshold suppresses the spawn.
5. **Weighted select.** A second `roll(totalWeight)` picks one formation by cumulative
   weight, exactly as the TS table does.

If all gates pass, the chosen behavior's `build` runs against a read-only
`CampaignView`, and each returned mob is placed: `origin` is set to `"campaign"`, the
mob is inserted into the character roster and pushed onto the room's `occupant_ids`,
and the room's enter-phase scenes fire **silently** — same `fire_scenes` path scenes
otherwise use, but the cues are discarded, matching the TS `[PLACE]` behavior of not
narrating a spawn's own arrival. `maybe_spawn` itself emits no cues; only the spawn's
subsequent detection (below) does.

The move path's player-only tail runs its steps in this order, all **after**
`record_action` (so any turn-end/reconcile from the budget-exhausting move happens
first): `maybe_spawn` → `NOTE_ENCOUNTERS` → room codex. Because the spawn runs before
the occupant scan, a freshly spawned mob is picked up by that same move's encounter
detection and gets its own `Encounter` cue, staged after the move's `Action` cue and
any turn-end cues.

**v1 simplifications:** `build` is rng-free (the reference formation always returns the
same fixed mob), and `spawnModifier` is modeled as an integer rather than a fractional
multiplier.

### The stateful WASM `Authority` (single-player runtime)

`crates/wickedways-wasm` exposes the engine to JavaScript hosts as a stateful WASM
handle, the `Authority` (`crates/wickedways-wasm/src/authority.rs`; distinct from the
multiplayer sync `Authority` in `crates/wickedways-core/src/sync/`). The handle owns a
genesis-loaded `World`; the host drives `begin_campaign`, per-intent `submit`
(`World::submit` runs the round/turn wrap and solo-GM mob reactions), `view`, `snapshot`,
and `restore` (undo is host-side: keep the pre-intent snapshot, call `restore`).

**JSON-only boundary.** Nothing but JSON strings cross the WASM edge: an `Intent` goes
in; `ExecuteResult { cues, mobAttacks?, error? }`, a `ViewModel`, and a
`CampaignSnapshot` come out. No host ever holds a live engine object.

Note the shipped Dioxus client does **not** use this crate — `wickedways-web` links
`wickedways-core` directly as a Rust rlib and drives the same `World`/`submit` API
natively. The wasm cdylib is the embedding boundary for any external JS host, and CI
keeps it clippy-clean on `wasm32-unknown-unknown` with its `conformance` feature on
(the feature compiles the first-party `conformance:*` ops used by several replay
fixtures).

The facade replay corpus (`conformance/fixtures/facade-*.golden.json`) pins this
single-player loop: the replay gate (`cargo test -p wickedways-assemble --test
replay_gate`) replays each fixture's intent stream through the engine and diffs
`{ result, snapshot, view }` per intent against the committed golden.

### The Rust campaign assembler (G1)

`crates/wickedways-assemble` is the campaign assembler: it turns an author's campaign definition into a playable **pre-begin
genesis snapshot** the Rust core can `begin_campaign` on.

**The artifact triple.** Authoring is now a two-input, one-output pipeline:

```
description.json  +  catalog.json   ->   genesis.json
(what the author       (registry of        (a pre-begin CampaignSnapshot,
 declared)              behaviors/items/     ready for begin_campaign)
                        recipes/formations)
```

`description.json` is the campaign the author declared (rooms, mobs, npcs, loot, caches,
exits, scenes, win/lose conditions, policies); `catalog.json` is the resolved registry of
behavior scripts, items, aliases, formations, and crafting-recipe metadata; `genesis.json`
is the deterministic `CampaignSnapshot` `assemble()` produces from the pair. Both
inputs are emitted by `wickedways-author` from the TOML campaign format.

**Id derivation, never generation.** Every id is derived from author-supplied names, so the
crate depends on neither `rand` nor `uuid` and re-running `assemble()` on the same inputs
yields byte-identical output. The rules:

| entity | id |
| --- | --- |
| campaign | `campaign:{title}` |
| room | `room:{name}` |
| mob | `mob:{name}` |
| npc | `npc:{name}` |
| cache | `cache:{name}` |
| loot box | `loot:{name}` |
| exit | `exit:{a}\|{b}` — the two **author-supplied room names** (`e.from`, `e.to`), sorted |
| scene | `scene:{room}:{key}:{phase ?? "enter"}` |
| loot content item | `loot:{name}:item#{i}` |
| mob drop item | `mob:{name}:drop#{i}` |
| room light item | `room:{name}:light#{i}` |
| npc held item | `npc:{name}:item#{i}` |
| player | `player:{name}` — minted by seating (see below) |

Note the item infix differs by holder — `item#`, `drop#`, `light#` — and `i` is the index in
the source key array, so repeated keys still get distinct ids.

**ASCII room names + the sort rationale.** `exit:` ids are minted by sorting the two author
room names with `str: Ord` (UTF-8 byte order). The historical TS engine sorted UTF-16 code
units, which agrees with byte order on ASCII and diverges above the BMP — the committed
goldens were minted under that constraint. Room names (and all conformance-fixture prompts, triggers, and
descriptions) are therefore constrained to ASCII.

**Party seating: `assemble()` takes 0..N seats; the first becomes GM.** The signature is
`assemble(desc, catalog, party: &[Seat]) -> Result<CampaignSnapshot, AssembleError>`. Seating is folded into `assemble()` so it
produces a genesis directly. The party may be empty (a pristine, unseated snapshot) or hold
any number of seats; the **first seat becomes the GM** (`gmId`), all seats — GM included — fill
`partyIds` in order, and each PC is placed in `startRoom`. Player ids are `player:{name}`, minted here.

**The gate, and why only pre-begin goldens are assembler pins.** `cargo test -p wickedways-assemble`
diffs Rust's assembled genesis against the committed goldens **byte-for-byte**. The goldens
are regression pins of the assembler's own output — regenerate deliberately with
`UPDATE_GOLDENS=1` and review the diff like code. It is
gated against **pre-begin goldens only** — 27 tests covering the pristine snapshots, the
single-PC facade genesis fixtures, the `g2-*` genesis family, the playable genesis fixtures, and
a determinism check. The 31 `started: true`
snapshots in the corpus are **not** valid oracles for the assembler: they capture state
*after* `begin_campaign` and turn execution (round/turn wrap, mob reactions, scene fires),
which is the core's job, not the assembler's. Gating `assemble()` against a post-begin
snapshot would conflate "did we build the genesis correctly" with "did the engine run
correctly" — so only the pre-begin artifacts are used as assembler oracles.

**Deliberate divergences / early decisions (recorded so they aren't mistaken for bugs):**

1. **The recipe-catalog extension was pulled into G1.** The core `Catalog`
   (`wickedways_core::world::descriptor`) now carries a `recipes: BTreeMap<String, RecipeMeta>`
   map (`skip_serializing_if` empty, so zero churn to existing catalog goldens). The recipe
   `outputName`/`materials` otherwise live only inside the registry's `create` closure and
   could not be reconstructed on the Rust side; carrying them in the catalog lets the assembler
   reproduce seed's recipe codex. This is distinct from validation — there is still **no
   `UnregisteredRecipe` check** (the catalog has no recipe *registry* for existence checks);
   `knownRecipes` is populated straight from `desc.recipes`. Closing that validation gap is a
   G2 prerequisite once `assemble()` consumes untrusted (modded) input.
2. **Validation message strings are not byte-gated.** The gate compares genesis bytes, not
   error text.
3. **`assemble()` seats the party** (see the seating note above) — this is what lets the
   crate emit a genesis directly, and why `party: &[Seat]` exists.

**Forward pointer (G2).** G2 adds the TOML authoring surface and a CLI on top of this crate
**without changing `assemble()`'s signature** — the TOML/parser/CLI layer produces the same
`(description, catalog, party)` inputs `assemble()` already takes. The gate is pure `cargo test`,
so it runs in the fast CI job.

### The Rust campaign author (G2 MVP)

`crates/wickedways-author` sits one layer above the G1 assembler: it turns a friendly,
hand-written **TOML** campaign into the `description.json` + `catalog.json` pair the assembler
consumes. The public entry point is one function —

```
compile(toml_src: &str) -> Result<CompiledCampaign, CompileError>
//                              ^ { description, catalog }
```

— and the `wwauthor` bin wraps it: `wwauthor <campaign.toml>` reads the TOML, compiles it
via `compile_all` (the collect-all compile), and writes `<stem>.description.json` +
`<stem>.catalog.json` (`serde_json::to_string_pretty` + trailing newline) beside the input.
On failure it prints EVERY collected finding to stderr — one line each, labeled with its
body's TOML path — and exits non-zero; author input never panics (`compile` is the modding
trust boundary). Modders can also skip hand-writing TOML entirely: the repo's
`author-campaign` Claude Code skill (`.claude/skills/author-campaign/`) generates and
validates a campaign from a plain-language description.

**The TOML surface.** Rooms, exits, items, loot containers, and a victory condition are declared
as tables/arrays; behaviors are named tables the exits/victory reference by key:

```toml
title = "Vault"
startRoom = "Hall"

[[rooms]]
name = "Hall"
description = "A cold stone hall."

[[exits]]
from = "Hall"
to = "Vault"
direction = "north"
behavior = "vault-door"          # -> [behaviors.exit.vault-door]

[behaviors.exit.vault-door]
canPass     = "hasKey(actor, 'vault')"
failMessage = "The vault door is locked."

[[victory.win]]
key = "reached-vault"
test = "party[0].room.name == 'Vault'"
narration = "You reached the vault."
```

Win/lose conditions are an **array of tables** (`[[victory.win]]` / `[[victory.lose]]` with an explicit
`key`), not a `[victory.win.<key>]` map, so the author controls their **order** — the description's
`winConditions`/`loseConditions` are ordered arrays and a real campaign's order need not be alphabetical.

**The infix expression language.** The string values of `canPass`/`test` (and similar) are not
opaque — they are a single-line **infix expression language** that Pratt-parses into the closed
`wickedways_core::script::ast::Expr` AST the runtime already evaluates. It has the four read-model
subjects (`actor`, `party`, `round`, `maxRounds`), literals (including **negative number
literals** — a prefix `-` on a numeric literal parses to a negative `Lit`, distinct from a `-`
between two operands, which stays subtraction), `.field` access, `[i]` subscripting,
the three typed calls (`hasKey`/`hasItem`/`hasEquipped`, each 2-arg with a string-literal key),
comparison/equality/boolean operators, unary `!`, and a ternary — precedence loosest→tightest:
`?:` < `||` < `&&` < equality < comparison < additive < multiplicative < unary < postfix. So
`party[0].room.name == 'Vault'` lowers to an `eq` of a `get`/`get`/`index` chain against a string
literal. It is panic-free: every failure is a spanned `CompileError`
(`TomlParse`/`ExprParse`/`UnknownReference`/`UnresolvedKey`).

**The statement grammar (imperative behavior bodies).** Beyond single-expression predicates, a
behavior body can be an imperative **statement block** — a newline-separated sequence lowered to
the `Stmt` AST the runtime executes. Five statement forms are parsed: `guard <expr>` (abort the
script unless the condition holds), `when <expr> { <stmts> }` (a nested block run conditionally),
`set state.<field> = <expr>` (write a scalar into scene/mechanic state), `emit cue(<expr>)`
(surface a narration cue), and `emit adjustStat(<target>, <stat>, <delta>)` (change a character
stat — `target`/`delta` are expressions, `stat` is a **bare keyword** ∈
`sanity`/`health`/`energy` mapped to `StatType`). `emit` also lowers the `giveItem`/`setVisible`
effects the **npc** family exercises (below). Scenes are the first family wired to this: a `[[scenes]]` room-attached
scene plus a `[behaviors.scene.<key>]` body compile to a `SceneDef` (description) and a
`BehaviorScript::Scene { canPlay, onEnter, onExit }` (catalog), gated byte-for-byte against the
`g2-scene` oracle. The scene's `canPlay` is a predicate (here using `stateGet`), and `onEnter`
is a statement block:

```toml
[[scenes]]
room = "Threshold"
key = "scene/threshold-draft"
phase = "enter"

[behaviors.scene."scene/threshold-draft"]
canPlay = "!stateGet('seen', false)"
onEnter = '''
guard round == 0
when !stateGet('revealed', false) {
  emit cue('A cold draft stirs the dust of the threshold.')
  set state.revealed = true
}
set state.seen = true
'''
```

**Consumable items with behavior bodies.** Beyond the MVP's key items, an item can carry an
imperative behavior. An `[[items]]` entry with a `type` (e.g. `consumable`) plus a
`[behaviors.item.<key>]` table whose `onUse`/`onRead` are statement blocks compiles to an
`ItemDescriptor` (`usable: true`) in the catalog's `items` map **and** a `BehaviorScript::Item`
under the **same key** in `behaviors` — `catalog.items[k]` and `catalog.behaviors[k]` share the
key. The bodies reuse the exact statement grammar above, so an `onUse` can `emit
adjustStat(actor, sanity, 6)`. Gated byte-for-byte against the `g2-item` oracle:

```toml
[[items]]
key = "elixir"
name = "Calming Elixir"
type = "consumable"
behavior = "elixir"              # -> [behaviors.item.elixir]

[behaviors.item.elixir]
onUse = '''
emit cue('A warmth spreads through you.')
emit adjustStat(actor, sanity, 6)
'''
```

**NPCs with dialogue trees.** An `[[npcs]]` entry (name, `stats`, `room`, an optional `holds`
inventory, and a `behavior` key) plus a `[behaviors.npc.<key>]` table compile to an `NpcDef` in the
description **and** a `BehaviorScript::Npc` under the **same key** in the catalog's `behaviors` map.
The behavior table carries a `description`, a **`default`** catch-all entry (the `talk`/`match ""`
response), and an ordered array of `[[behaviors.npc.<key>.dialogue]]` entries. Each entry is
`{ match, response, effects, once }`: `match` is **polymorphic** — a bare TOML string is an
`Exact` prompt match, while a `{ fuzzy = [...] }` table is a `Fuzzy` token match (this rides serde's
`#[serde(untagged)]` on the surface `MatchToml`, and `DialogueEntry.match_` serializes back out under
the serde-renamed `"match"` key). A dialogue `effects` body is **`emit`-only**: it reuses the
statement parser but `parse_effects` rejects any non-`Emit` statement, so an entry's `effects` lowers
to a `Vec<EffectTemplate>` (not a `Vec<Stmt>`). The two new effects this family exercises —
`emit giveItem(<from>, <to>, <item>)` and `emit setVisible(<target>, <visible>)` — take **literal
string ids** for the item/character (id-derivation from a `holds`/name reference is a later slice),
and `response` is likewise a **literal string** (computed responses are deferred). Gated
byte-for-byte against the `g2-npc` oracle:

```toml
[[npcs]]
name = "Caretaker"
stats = { health = 1, sanity = 1, energy = 1 }
room = "Foyer"
behavior = "caretaker"                       # -> [behaviors.npc.caretaker]
holds = ["cellar-key"]

[behaviors.npc.caretaker]
description = "A stooped caretaker in a moth-eaten coat, keys trembling at his belt."

[behaviors.npc.caretaker.default]            # the catch-all (match "")
match = ""
response = "Take the cellar key. I am leaving now."
once = true
effects = '''
  emit giveItem('npc:Caretaker', actor, 'npc:Caretaker:item#0')
  emit setVisible('npc:Caretaker', false)
'''

[[behaviors.npc.caretaker.dialogue]]
match = { fuzzy = ["key", "cellar"] }        # a Fuzzy token match; a bare string is Exact
response = "It opens the cellar."
```

**Mechanics with lifecycle hooks.** The final family slice wires **campaign mechanics** — the
long-lived, tick-driven systems (a dread meter, a curse, a weather cycle) the runtime advances on
its own schedule. A `[[mechanics]]` entry is a thin **opt-in** carrying a `key` (and an optional
`config`); the behavior lives in a `[behaviors.mechanic.<key>]` table that the opt-in references
**by the same key** — the two share the key (here `dread`), because the engine resolves a
mechanic's hooks via `catalog.behaviors[mechanic_key]`. That table compiles to a
`BehaviorScript::Mechanic` (`family: "mechanic"`) whose `script` is a `MechanicScript` with an
`init` state seed plus up to five lifecycle hooks: `onRoundStart`, `onRoundEnd`, `onTurnStart`,
`onTurnEnd`, and `onAction`. Each hook is an optional statement block reusing the exact grammar
above (so `onTurnStart` can `guard !hasEquipped(actor, 'lantern')` then `emit adjustStat(actor,
sanity, -1)` — the `-1` delta being the negative literal). The serialized `script` shape is pinned
by the goldens: `init` is **always** present (no serde default — an omitted `init`
lowers to `{}`), `actions` is **always** serialized (an empty actions map emits as `{}`), and
each `hooks` entry (the five lifecycle hooks plus `modifyDamage`) is emitted **only when
authored** (absent ones are omitted). Pinned by the `g2-mechanic` golden:

```toml
[[mechanics]]
key = "dread"                                # -> [behaviors.mechanic.dread]
# config optional

[behaviors.mechanic.dread]
init = {}                                    # seeds the genesis mechanic state
onTurnStart = '''
  guard !hasEquipped(actor, 'lantern')
  emit adjustStat(actor, sanity, -1)
'''
```

**Mechanic damage transforms and custom actions.** A mechanic may also carry a **`modifyDamage`**
transform and a table of budgeted **custom `actions`** — the two fields the scaffolding slice above
stubbed. `modifyDamage` is a single string in its own transform grammar: a `final <expr>` value
(which halts the transformer chain), a bare `<expr>` value (which lets it continue), or a
`<cond> ? <thenBody> : <elseBody>` ternary between two transform bodies. It reads the incoming
damage through the `damage` subject (e.g. `damage.amount`), so the conformance dread's "cap at 3"
transform authors as `damage.amount > 3 ? final 3 : damage.amount`. Custom actions live in a
`[behaviors.mechanic.<key>.actions]` table, each key mapping to a statement block reusing the
lifecycle-hook grammar (a PC invokes one via `useMechanicAction(key, action)`; each call ticks the
per-round budget). Gated byte-for-byte against the `g2-mechanic-actions` oracle:

```toml
[behaviors.mechanic.dread]
init = {}
onTurnStart = '''
  guard !hasEquipped(actor, 'lantern')
  emit adjustStat(actor, sanity, -1)
'''
modifyDamage = "damage.amount > 3 ? final 3 : damage.amount"

[behaviors.mechanic.dread.actions]
brace = '''
  emit cue('You brace against the dread.')
  emit adjustStat(actor, sanity, 1)
'''
```

**The expression/effect/statement surface is now complete.** Every node of the closed `Expr`,
`Stmt`, and `EffectTemplate` sets is authorable, so any behavior the engine can interpret can be
written in TOML. The final slices filled in what earlier ones deferred:

- **Exit narration** — an exit behavior's `runScript` (a **script** body) plus the `pass <expr>`
  statement, which is legal *only* in script bodies (`parse_script`/`allow_pass`) and still rejected
  in effect/hook bodies. Proven by `g2-door` (the real `doorScript`).
- **Storyteller forms** — the `action`/`element` subjects, `mapLit(k, v, …)`, `has(map, key)`,
  `lookup(map, key)`, `stateGetIn(field, key, default)`, and the subscripted `set state.<map>[<key>]
  = <v>` (`SetStateIn`) statement. Proven by `g2-storyteller` (the real storyteller mechanic).
- **Status-bar forms** — `str(x)`, `concat(…)`, `length(x)`, `first(x)` (the `First` node, distinct
  from the subscript `x[0]`→`Index`), and the `Status` effect with its `field(label, value[,
  emphasis])` sub-grammar. Proven by `g2-status-bar` (the real status-bar mechanic).
- **Victory quantifiers** — `some(list, pred)`, `every(list, pred)`, `includes(list, value)`. Proven
  by `g2-victory` (the three real win/lose conditions). Win/lose conditions serialize in sorted
  (`BTreeMap`) key order, faithful to the unordered TOML-table surface.
- **The remaining effects** — `damage`, `heal`, `grantImmunity` — and `defined(x)`. No committed
  hollow-house behavior uses them, so they are proven by the bespoke `g2-effects` oracle.

All six behavior families (**exit**, **victory**, **scene**, **item**, **npc**, **mechanic**) are
wired, every one reusing this same parser. The one remaining permissive divergence stands: subscript
always lowers to `Index` (only `first(...)` produces `First`).

**The gate.** Like the assembler, the author is gated **byte-for-byte** against the committed
`g2-*` golden fixtures (each also checked for compile determinism) via
`cargo test -p wickedways-author` (pure Rust, fast CI job). The gate compares
canonicalized JSON values (whole-float numbers collapsed to ints, object keys sorted), so the
bin's raw pretty output — where `Value::Number` emits `0.0` and catalog keys serialize in
`BTreeMap` order — matches the golden under that comparison. **The goldens are regression
pins of the compiler's own output:** regenerate deliberately with `UPDATE_GOLDENS=1` and
review the diff like code — never hand-edit a golden; when a diff is unintended, fix
`lower.rs`/the parser, never the fixture.

**The description-structure surface is now complete too.** Beyond behaviors/expressions, the author
now emits every `CampaignDescription` field the real Hollow House needs — no longer hardcoding empties
or defaults: **`[[archetypes]]`** (id/name/baseStats/inventorySlots/immunities — the Heir), the **full
item descriptor** (`slot`/`emitsLight`/`maxDurability`/`lore`/`equippable`/`droppable`/`twoHanded` — the
lantern/poker/journal), **`[[mobs]]`** (stats/room/drops/`{stat,power}` naturalAttack — Wraith/Revenant),
room **`dark`** + **`spawnModifier`**, exit **`name`** + **`initialState`**, **`[[formations]]`** (a single
entry carrying both the `{key,weight}` opt-in and the catalog `MobSpec` roster — the roving rats),
**`[opts]`** (`maxRounds`/`baseEncounterChance`), and **`timeoutNarration`**. Each is proven by a bespoke
`g2-*` oracle authoring the corresponding **real** hollow-house content byte-for-byte. Still deferred
(no Hollow House usage, so a bespoke oracle would be needed): `endedNarration`, `chat`, `av`, `caches`,
standalone `materials`/`recipes`, room `lights`, item `presentation`, and the mob override fields beyond
naturalAttack/drops.

**MVP scope, and forward pointers.** This started as a deliberately thin first slice — **exit**
(`canPass` + fail/pass messages) and **victory** (a `test` expression + narration, which produces
*two* artifacts — a `winConditions` entry in the description AND a `BehaviorScript::Victory { test }`
in the catalog) with expression-only bodies — since extended with the **statement grammar**, the
**scene** family, the **adjustStat**/**giveItem**/**setVisible** effects, (consumable) **items** with
`onUse`/`onRead` bodies, the **npc** family with polymorphic-`match` dialogue trees, **negative
number literals**, and the **mechanic** family (`[[mechanics]]` opt-in + a `[behaviors.mechanic.<key>]`
`init`-plus-five-hooks behavior) above. Two
deliberate divergences from the design spec carry through: the compiler
is permissive (no compile-time `TypeError` — the `Expr` AST is total, and the historical TS
builders type-checked nothing, so mapping stays permissive to preserve the pinned output), and subscript always lowers to `Index`
(never `First` — only `first(...)` does). Both the expression/effect/statement surface and the
description-structure surface are complete, and the **capstone is done**: the ENTIRE real campaign is
re-authored in one `hollow-house.toml` whose `compile()` reproduces the committed
`hollow-house.{description,catalog}.json` — the whole shipped campaign (9 rooms, 13 exits, 2 mobs, 4 loot
containers, an NPC, 2 formations, 3 mechanics incl. the full-lore storyteller, 3 victory conditions, 8
items, 3 keyed doors) — **byte-for-byte**. Two small surface additions fell out of it: string literals may
use single OR double quotes (so the storyteller lore's embedded apostrophes author cleanly), and items
carry `aliases`. What remains is only **packaging**: **id-derivation** for `giveItem`/`setVisible` and
computed dialogue responses, **npx/WASM packaging** of the CLI, and **runtime-load** of a compiled
campaign. None of those change `compile()`'s signature.

**Engine change this milestone made.** Authoring a key item into a loot container's initial
contents was previously rejected by the `Loot` constructor guard; that guard was **relaxed** so
campaign authors can seed a key in a container (as `g2-vault` does — `vault-key` in the `shelf`).
The runtime add-to-loot guards (`Loot.receiveItem` / player mid-game stashing) are **unchanged** —
a player stashing a key during play is a distinct action still governed by those guards.

### Campaign Studio (`crates/wickedways-studio`)

The graphical authoring app for the TOML surface above — a **standalone** Dioxus wasm app
(separate from the play client; shares upstream crates and idioms, not code). Spec:
`docs/campaign-studio-spec.md`. The P0+P1 MVP is built:

- **CRUD for every asset family** over an `AuthorDoc`-shaped `EditorDoc` (stable editor ids,
  total conversion both ways), with a room hub (exits in/out, loot, caches, mobs, NPCs,
  scenes, add-here shortcuts), a return-exit convenience, enum dropdowns for the
  silently-defaulting `type`/`slot`/`stat` fields, and formations presented honestly as the
  global weighted encounter table.
- **Layered validation, all in-browser** (author + assemble are wasm-clean): instant field
  constraints → a live all-errors referential-integrity pass (`refs::check_refs`, clickable
  problems panel + per-section badges) → per-body DSL validation by probe-doc `compile()`
  (`gate::validate_body`) → the authoritative **Check campaign** gate
  (`compile()` → `assemble()` → `World::from_snapshot` + `validate_mechanics`).
- **Persistence & interchange**: versioned JSON blobs in localStorage
  (`wickedways:studio:campaign:<id>` + an index), synchronous write-through autosave; TOML
  import (paste) and export (download). Round-trip is gated by
  `crates/wickedways-studio/tests/roundtrip.rs`: every fixture TOML imports, re-exports, and
  recompiles to **byte-equal description + catalog JSON** (compiled equality is the
  equivalence — comments/formatting are lossy by design). The `Serialize` derives this needs
  live in `wickedways-author`'s `author_doc.rs` (absent-means-default fields are skipped, so
  exports stay close to the hand-authored idiom).

The P2 set ships too: a bounded coalescing **undo** stack; **compiled-artifact export**
(a green Check-campaign gate offers description/catalog/genesis JSON — the same files
`wwauthor` writes); **file-picker import** alongside paste; the **full template gallery**
(every single-feature `g2-*` fixture, one click each); an **unreachable-rooms** lint (BFS
from `startRoom`); and per-body validation now dispatches to
`wickedways_author::validate`'s public span-bearing single-body parsers (the second
upstream change the spec mandated) instead of the MVP's probe-document hack.

And the full P3 set: the read-only **Map view** — the campaign
compiled, assembled, loaded into a `World`, and revealed through the play client's own
`wickedways_tabletop::map` geometry (locked doors dashed, dark rooms shaded, click a room
to edit it); **structured behavior builders** — a snippet bar under every DSL body whose
document-fed forms generate the DSL (property-tested: a builder can only emit text its
slot's parser accepts; raw text stays the escape hatch); **`compile_all`** — the
collect-all compile (each finding labeled with its body's TOML path), now behind the
Check-campaign overlay; a **native desktop arm** (`native-app` feature + the `desktop/`
shell's `wickedways-studio-desktop` binary — file-backed campaigns in the shared data
dir, exports to Downloads); **IndexedDB** as the campaign-blob store (boot-primed
cache, one-time localStorage migration, no more ~5 MB ceiling); and the **Playtest
handoff** — a green Check-campaign gate offers **▶ Playtest**, which writes the compiled
genesis + catalog to a shared storage slot (`wickedways:playtest:genesis` / `:catalog`:
localStorage on the web, files in the shared data dir natively) and opens the game client
at `/?campaign=playtest&mode=single`. On the play-client side, `wickedways-web` resolves
`playtest` from that slot (`driver::bundled_campaign` — an explicit error when no slot is
saved, never a silent demo fallback) and lists a synthetic "Studio Playtest" launcher
campaign while the slot exists. Same-origin serving makes the handoff work with zero
server involvement; the desktop shells share it through the common data dir.

Post-P3 polish: every DSL body edits with **syntax highlighting** — the overlay idiom
(a transparent-text textarea over an `aria-hidden` `<pre>` of colored token spans,
scroll-synced), driven by a lossless tokenizer (`ui/highlight.rs`) whose vocabulary
mirrors the real grammar's keyword/effect/call/subject lists and is property-tested to
reproduce every line of the campaign corpus byte-for-byte. The compiler stays the
validity authority; the colors are cosmetic and never guess at unknown words. On top of
it, **asset autocomplete** (`ui/autocomplete.rs`, a pure host-tested analysis): with the
caret inside a string literal, the surrounding call/comparison picks a suggestion pool
from the live document (`hasKey` → key codes, `hasItem`/`hasEquipped` → item keys,
`…room.name ==` → room names, `setVisible`/`giveItem` → `npc:` refs, `stateGet` → state
fields already used in the body, `includes(….status, …)` → status keys), offered in a
popover accepted by click or ↑↓/Enter/Tab — sugar only, unknown names never error.

Build/serve like the play client: `dx serve` in `crates/wickedways-studio` for dev,
`crates/wickedways-studio/build-studio.sh` for the static bundle. **Deployment**: the root
`Dockerfile` builds the studio bundle alongside the play client, and the room server serves
it at **`/studio`** (`STUDIO_DIR`, default `./studio`; empty or missing ⇒ off) — one deploy
ships play + authoring on one port.
