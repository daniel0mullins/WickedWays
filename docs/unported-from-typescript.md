# Features not yet ported from the TypeScript engine

The engine began life in TypeScript and has fully cut over to Rust; the TS tree is deleted. Most
of it came across, but a handful of behaviors did not — and until this list was written they were
still described in `README.md` as though they worked, because the README was written against the
TS implementation.

This file is the backlog of what still needs porting. Each entry says what the TS version did,
what the Rust engine does today, and the evidence. **Verify before you start** — the engine moves,
and an entry here may have been closed since.

Nothing in this list is a regression against a shipped Rust feature. These are capabilities that
existed in TS and have no Rust equivalent yet.

## Ported — closed since this list was written

### Map generation (`buildMap`) — PORTED

**TS:** `buildMap(rooms, options)` wired a list of rooms into a connected dungeon via a randomized
spanning tree — every room reachable, `n - 1` edges, bidirectional exits, no self-connections, a
cap of 8 exits per room. `extraConnections` added loops; `requiredConnections` pinned specific
pairs as neighbors before the tree was laid down; an injectable rng made it deterministic.

**Rust now:** `World::generate_map` (`crates/wickedways-core/src/world/mapgen.rs`), run from
`begin_campaign` for campaigns carrying a `[mapGen]` config (authored in the TOML surface,
carried as `campaign.map_gen`). All the TS semantics, drawn from `World.rng` — plus a `sealed`
extension: rooms reachable only through their `required` (keyed-door) passages. Hand-wired
`[[exits]]` campaigns are untouched. `campaigns/solomons-rest.toml` is the first user.

## Genuinely absent — needs porting

### 2. Runtime light placement (`placeLight` / `takeLight`)

**TS:** a character could set a held light source down in a room and pick it back up, flipping a
dark room's lit state for everyone in it.

**Rust today:** absent. A room's `light_source_ids` is authored (`[[rooms]] lights = [...]`) and
read for lit-ness, but **no production code ever adds to or removes from it** — every mutation
site in `crates/wickedways-core/src/world/` is a test fixture building a room. Lit-ness can only
be changed at runtime by equipping/unequipping a carried light
(`World::character_has_light`).

**Knock-on:** the `visibility` cue can fire on equip/unequip, but never on place/take.

### 3. `teaches` — recipes imparted by picking an item up

**TS:** picking up an item whose `teaches` field named a recipe called `Campaign.discoverRecipe()`
(idempotent by id), so the whole party could then craft it. This is how recipe knowledge spread
mid-campaign.

**Rust today:** `ItemDescriptor.teaches` exists (`crates/wickedways-core/src/world/descriptor.rs`)
but **the engine never reads it** — the only non-test references are the field declaration and
`json!(null)` in fixtures. `campaign.known_recipes` is written in exactly one non-test place, the
assembler (`construct.rs`, seeded from the campaign's declared `[[recipes]]`). The pickup path
(`items_actions.rs`) records the codex and never touches `known_recipes`.

**Effect:** recipe knowledge is fixed at assembly time. A campaign cannot teach a recipe through
play.

### 4. One-time material claims (`claimMaterials`)

**TS:** `Campaign.claimMaterials(claimId, …)` granted materials once, idempotent by `claimId`, so
a given source could not be farmed.

**Rust today:** no `claim_materials`. `CampaignCoreSnapshot.claims` exists in the snapshot but is
**inert** — never read or written by engine logic, only initialized empty. Farm-prevention is
handled differently and more narrowly, by a per-cache `depleted` latch
(`crates/wickedways-core/src/world/crafting.rs`).

**Effect:** there is no general idempotent-grant mechanism; only material caches are protected,
and the `claims` field is dead weight in the format until this lands.

### 5. Codex query API

**TS:** the codex was queryable — `mobs`, `items`, `keys`, `rooms`, `recipes`, `materials` (each
sorted by name), `all` in discovery order, `get(kind, key)` for a single entry, and `size`.

**Rust today:** `world.codex` is a flat, inert `serde_json::Value` array in discovery order
(`snapshot.rs` literally comments it `// CodexEntry[], inert`). Entries are appended by the
engine's record paths; there is no grouping, no name sorting, and no keyed lookup. Any host
wanting per-kind views builds them itself.

### 6. Character `onTurnEnd` events

**TS:** characters had their own turn-end event hook, separate from mechanic turn-end hooks.

**Rust today:** only mechanic hooks fire (`dispatch_turn(TurnPhase::End)`). The character-level
event is referenced in a comment in `turn.rs` and nowhere else. The README has flagged this one
as unported for a while.

### 7. Chat and A/V

**TS/design:** in-room chat and audio/video comms.

**Rust today:** not implemented in the room server. The wire protocol deliberately reserves the
message arms (`chatSend` / `callJoin` / `signal` / …) so they can land additively — see the module
docs in `crates/wickedways-transport/src/lib.rs` and `crates/wickedways-server/src/server.rs`.

## Moved to authoring time — runtime API intentionally absent

These are not gaps in capability; the capability moved from a runtime call to the authoring
pipeline. They are listed so nobody re-adds the runtime API by mistake, and so the decision is
recorded if a campaign ever needs to do one of these *mid-play*.

| TS runtime call | Where it lives now |
|---|---|
| `Room.placeMob` | authored mobs; the assembler seats residents with origin `"room"` (`construct.rs`) |
| `Room.addLoot` / `Room.removeLoot` | authored `[[loot]]`; containers are built at assembly |
| `Campaign.registerArchetype` | `[[archetypes]]` in the description; applied by `World::select_archetype` |
| `Campaign.addFormation` | `[[formations]]` into `campaign.encounter_table`; resolved by `World::maybe_spawn` |
| `CampaignRegistry.registerExit` / `defineRegistry` | the native behavior registries plus `catalog.behaviors` scripts, resolved by `resolve_*_behavior` |
| `authorTemplate` / `TemplateBuilder` | the campaign TOML surface compiled by `wickedways-author` |

Adding a room, mob, or loot container **during play** is therefore not currently possible through
any sanctioned path. If that's ever needed, it's a real feature, not a doc fix.

## Ported, but renamed — not backlog

Recorded only to stop them being re-reported as gaps. The behavior is present; the TS name is not.

- `stowItem` / `ContainerFullException` / `removeItems` → `World::put_in_loot_box` / `World::take`;
  capacity **is** enforced, and the error is a `ProceduralViolation` like every other engine error.
- `canAfford` / `withdrawMaterials` / `DEPOSIT_MATERIALS` → `World::can_afford` /
  `World::deposit_materials`.
- `Character.transferKey` / `consumeKey` → the `transferKey` / `consumeKey` commands.
- `createKey` → the `ItemSnapshot::Key` serde variant, built by the assembler.
- `isNormal` → read the affliction set directly (`afflictions.list()`).
- The symbol seams (`HELD_BY`, `CLAIM`, `SET_DURABILITY`, `EQUIP`/`UNEQUIP`,
  `RECORD_ENCOUNTER`, `INVOKE_MECHANIC_ACTION`) → ordinary Rust methods. Rust has no symbols; the
  invariants are upheld by routing every mutation through one function. Note `set_durability`
  does **not** clamp, unlike the TS symbol — callers pass `durability - 1` and only non-broken
  items wear.

## One behavioral difference worth knowing

`World::from_snapshot` is **infallible** and reseeds the RNG to `Rng::seeded(0)`. The TS hydrate
was fail-fast (throwing on an unknown `schemaVersion` or a dangling id) and carried the RNG state
in the snapshot. In Rust:

- Snapshot validation happens later and separately, via `World::validate_mechanics`, which
  reports unresolvable behavior keys as a `ProceduralViolation`. There is no `schemaVersion` check
  and no dangling-id check on load.
- The RNG does not ride in the snapshot, so **a host that needs the dice stream to survive
  save/load must carry it across itself** — `Authority::restore` in `crates/wickedways-wasm` does
  exactly that.

Whether hydrate should validate is an open question; if it should, that's a change to make
deliberately, since the golden gates pin current load behavior.
