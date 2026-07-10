# Rust Campaign Assembler (G1) — Design

**Date:** 2026-07-09
**Status:** Approved, ready for planning
**Sub-project:** G1 of the Phase 2c program (see *Program context* below)

---

## Naming disambiguation (read first)

Two unrelated types are named `Authority`. Every reader of this program loses time to
this, so it is stated once, up front:

| Type | Location | What it is |
| --- | --- | --- |
| `Authority` (single-player) | `crates/wickedways-wasm/src/authority.rs:16` | The stateful WASM game-runtime handle shipped in Phase 2a. Takes `(genesis, catalog, seed)`. |
| `Authority` (multiplayer sync) | `src/lib/sync/authority.ts:20` | The single-writer command-log authority: `head()`, `entriesSince()`, `submit() -> SubmitResult { seq, delta }`. |

`README.md:1986` already flags the collision. **This spec concerns neither of them
directly** — it concerns what produces the `genesis` they both consume. A later
sub-project (B) renames one of them.

---

## Problem

The TypeScript engine still runs in production, on every boot.

`GameSession.boot` (`packages/play-runtime/src/session.ts:70-100`) calls `assemble()` to
construct a live TS `Campaign` object graph, instantiates a `PlayerCharacter`, calls
`joinCampaign()` and `move()`, and only then serializes the result to the `genesis` JSON
that the Rust `Authority` consumes. Rust takes over *after* genesis exists.

This has three consequences:

1. **`src/lib/` can never be deleted.** The re-authoring cannot finish.
2. **Every engine feature must be built twice** — once in Rust to run it, once in
   TypeScript to author it. This is precisely the two-engine drift the re-authoring
   exists to end.
3. **A native desktop binary that needs a Node build step to produce a campaign is not
   really a native app**, and modding is impossible.

## Goal

Port `assemble()` to Rust, byte-faithfully, gated by the committed genesis goldens.

**G1 ends when Rust reproduces every pre-begin genesis golden byte-for-byte from
`description.json + catalog.json`.** Nothing else.

## Non-goals (explicitly out of scope for G1)

- The TOML surface syntax and its expression parser — **that is G2.**
- CLI ergonomics, TOML spans in error messages — **G2.**
- Runtime modding / loading a campaign file in the client — **G2.**
- Multiplayer, the sync layer, the Dioxus client, deleting any TypeScript.
- Presentation images. `RoomDef`/`MobDef` have no image field and no campaign in
  `packages/campaigns` sets `presentation`, so `GameSession`'s `#roomImages` /
  `#occupantImages` maps are empty in production today. That plumbing is aspirational.
  G2's format is the natural place to introduce it.

---

## Key findings that constrain the design

These were verified against the repository, not assumed. Each one is load-bearing.

### 1. The serialized registry already exists — it is the catalog

`catalog.json` is `{ items, aliases, behaviors, formations }`. Its `items` are already
pure data descriptors:

```json
"items/iron-sword": {
  "name": "Iron Sword", "type": "weapon", "stat": "health", "modifier": 5,
  "properties": { "equippable": true, "equipped": false, "destroyable": true, "usable": false },
  "slot": "hand", "maxDurability": 10, "recipe": { "metal": 2 }
}
```

All **five** item factories in `packages/campaigns/src/hollow-house/items.ts` have
`actions` blocks containing **only** `noop` / `() => null`. The `() => Item` factory
signature in `CampaignRegistry.registerItem` is vestigial; real item behavior lives in
the scripted-ops DSL as a `BehaviorScript`.

### 2. The description is already plain data — and is the only missing artifact

`CampaignTemplateDescription` (`src/lib/authoring/description.ts:118`) is nine flat
interfaces (`RoomDef`, `ExitDef`, `MobDef`, `LootDef`, `CacheDef`, `NpcDef`,
`FormationDef`, `SceneDef`, `ArchetypeDef`). `TemplateBuilder` is a fluent facade that
pushes into its arrays.

| artifact | exists today? |
| --- | --- |
| `catalog.json` (the registry, as data) | ✅ committed goldens |
| `genesis.json` (the assembled world) | ✅ committed goldens |
| `description.json` | ❌ **never serialized** |

Its single non-serializable member is `opts.rng?: () => number`.

### 3. Genesis ids are derived, never generated

`Item`'s constructor assigns `uuid()` (`src/lib/inventory.ts:550`), yet **zero
uuid-shaped ids appear in any golden** (34 ids in `hollow-house.snapshot.json`, 0
uuids). Serialization re-derives item ids from holder and index, discarding the uuid.

**This is the single assumption the entire gate rests on, and it is currently implicit
in serialization code rather than written down anywhere.** It is now written down:

| entity | id |
| --- | --- |
| room | `room:{name}` |
| exit | `exit:{a}\|{b}` where `a` < `b` **lexicographically** — *not* `from\|to` |
| scene | `scene:{room}:{key}:{phase}` |
| npc / mob / player | `npc:{Name}` · `mob:{Name}` · `player:{Name}` |
| item | `{holderId}:item#{index}` — positional, e.g. `loot:foyer-table:item#0` |

The Rust assembler mints these directly and never allocates a uuid.

The exit rule is easy to get wrong. `hollow-house` declares `Foyer --south--> Cellar` yet
serializes `exit:Cellar|Foyer`, while `Foyer --north--> Hall` serializes `exit:Foyer|Hall`.
Both are the sorted pair; neither is `from|to`. **Implementation must confirm the exact
comparator against the TS serializer** rather than infer it from these two cases.

### 4. Only pre-begin goldens are valid assembler oracles

Across all 47 goldens:

| corpus | count | usable? |
| --- | --- | --- |
| `*.genesis.json` — `started: false`, 1 PC | 14 | ✅ |
| `hollow-house.snapshot.json`, `seed.snapshot.json` — `started: false`, 0 PCs | 2 | ✅ pristine |
| `*.snapshot.json` — `started: true` | 31 | ❌ post-`beginCampaign` |

The post-begin snapshots encode `Authority`'s work (round-0 dispatch, start-room
enter-scenes), not the assembler's. Gating against them would test the wrong component.

`combat.start.snapshot.json` contains two player characters but is `started: true`, so
**there is no pre-begin multi-PC golden.** One is generated (see *Gate*).

### 5. `assemble()` uses the registry for validation and item construction only

`assembler.ts` calls `registry.item(k)` / `.recipe(k)` / `.condition(k)` / `.scene(k)` /
`.exit(k)` / `.formation(k)` / `.npc(k)` / `.mechanic(k)` to *validate that keys
resolve*, and `registry.item(k)()` to *instantiate items*. It mints room ids as
`` `room:${r.name}` `` (`assembler.ts:248`). Validation collects **all** problems before
throwing (`assembler.ts:39-48`).

---

## Architecture

**New crate `crates/wickedways-assemble`**, depending on `wickedways-core`.

Not a module inside core: the browser client should not carry authoring types if modding
proves to be desktop-only, and a separate crate makes that an opt-in dependency rather
than a bundle-size decision made by default.

One function is the entire public surface:

```rust
pub fn assemble(
    desc:    &CampaignDescription,   // NEW artifact
    catalog: &Catalog,               // EXISTS: crates/wickedways-core/src/world/descriptor.rs:106
    party:   &[Seat],                // 0 = pristine · 1 = single-player · N = multiplayer
) -> Result<CampaignSnapshot, AssembleError>   // EXISTS: .../world/snapshot.rs:233

/// `archetype` is `Option<String>`, matching `CharacterSnapshot::archetype_id`
/// (`snapshot.rs:130`). There is no `ArchetypeId` newtype in the Rust core.
pub struct Seat { pub name: String, pub archetype: Option<String> }
```

An empty `party` yields the pristine genesis that sub-project A needs once
`joinCampaign` becomes a runtime command. Cardinalities 0 and 1 are gated by existing
goldens; `N` is gated by one newly generated fixture.

### Party seating rules

`campaign.gm = pc` happens in `GameSession.boot` (`session.ts:86`), *not* in
`assembler.ts` — so genesis carries a `gmId` that the assembler must set. The goldens
fix the rules:

| `party` | `gmId` | `partyIds` | `activeCharacterIndex` |
| --- | --- | --- | --- |
| `[]` (pristine) | `null` | `[]` | `0` |
| `[Ada]` | `"player:Ada"` | `["player:Ada"]` | `0` |
| `[Ada, Ben]` | `"player:Ada"` | `["player:Ada", "player:Ben"]` | `0` |

**The first seat becomes GM.** Party order is turn order. `activeCharacterIndex` is
always `0` at genesis, since genesis is pre-`beginCampaign`.

The two-seat row is read from `combat.start.snapshot.json`, which is **post-begin** and
therefore not itself a valid assembler oracle (see *Only pre-begin goldens* above).
`beginCampaign` does not mutate `gmId` or `partyIds`, so it is sound evidence for the
*rule* — but the rule is only *gated* once the new pre-begin two-PC fixture exists.

### Schema ownership: Rust owns it, TypeScript conforms

`CampaignDescription` is defined in Rust with `#[derive(Serialize, Deserialize)]` and
`ts(export)`, emitting `generated/bindings/CampaignDescription.ts`. The TS exporter
type-checks against that binding.

This is the pattern `BehaviorScript` and `FormationDescriptor` already follow. It means
the two sides cannot drift silently: `pnpm run bindings:check` fails the build if they do.

### What `assemble` does

A faithful port of `assembler.ts`:

1. **Validate-all pass.** Duplicate names; unknown registry keys across
   item/recipe/condition/scene/exit/formation/npc/mechanic; unresolved room references;
   `startRoom` exists; archetypes referenced by seats exist. Collect **every** problem,
   return one aggregated `AssembleError`. Do not fail on the first.
2. **Construct pass.** Rooms, exits, mobs, loot, caches, npcs, scenes, materials,
   recipes, win/lose conditions, and mechanics **in declared order** — `description.ts`
   states that order is the reducer/transformer execution order.
3. **Seat the party.** The TS path calls `pc.joinCampaign()` then
   `pc.move(startRoom, fireScenes: false)`. Rust has neither method. G1 constructs seated
   PCs **directly into the snapshot**: we are building state, not executing commands. If
   `joinCampaign` or `move` carries a side effect not reproduced here, the byte-parity
   gate catches it. That is what the gate is for.

---

## Data flow

**Today** — the TS engine runs on every boot:

```
TemplateBuilder.description ─┐
                             ├─→ assemble() → live TS Campaign → seat PC → serializeCampaign → genesis
CampaignRegistry → catalogFromRegistry → catalog ──────────────────────────────────────────────┐
                                                                                               ├─→ Authority::new(genesis, catalog, seed)
```

**After G1** — TypeScript runs once at build time; Rust owns assembly:

```
build step (TS):  builder.description ──→ description.json      [NEW]
                  catalogFromRegistry ──→ catalog.json          [exists]

runtime (Rust):   assemble(&description, &catalog, &party) ──→ CampaignSnapshot
                                                                    │
                                                   Authority::new(genesis, catalog, seed)
```

### The one new TypeScript file

A ~20-line exporter that writes `builder.description` to `description.json`, dropping
`opts.rng`. It is deleted in sub-project F.

**Spec check:** assert that no shipped campaign sets `opts.rng`. Silently dropping a
supplied rng would be a real divergence, not a cosmetic one.

---

## The conformance gate

**The differential conformance gate is the authority.** A golden is never hand-edited to
force a pass. `conformance/canonical-json.ts` is not touched by this work at all.

### Oracle corpus

The 16 pre-begin goldens (14 single-PC `*.genesis.json` + 2 pristine `*.snapshot.json`),
plus **one new pre-begin two-PC fixture**, produced by running the real generator. That
is generation, not golden-editing.

### New generated artifact

`<fixture>.description.json` per fixture, emitted by extending the existing
`fixtures:gen` generator.

### Mechanics — a pure Rust test, no WASM

```rust
let desc: CampaignDescription = read_json("caretaker.description.json");
let cat:  Catalog             = read_json("caretaker.catalog.json");
let want: Value               = read_json("caretaker.genesis.json");
let got                       = to_value(assemble(&desc, &cat, &party)?)?;
assert_eq!(got, want);
```

`serde_json::Value::Object` is a map, so equality is **key-order-insensitive**;
`Value::Array` equality is **order-sensitive**. Those are exactly the semantics
`canonicalize()` implements for the TypeScript harness. Canonical comparison is
inherited from the standard library — the edit-forbidden module is neither imported nor
re-implemented.

Because it is `cargo test -p wickedways-assemble`, the gate needs no wasm-pack, no
browser, and no vitest. It joins `cargo test --workspace` and runs in milliseconds, so
it belongs in the **fast `checks` job**, not the slow one.

### Not gated

- The *text* of aggregated validation errors. The collect-all-problems **behavior** is
  ported and unit-tested; message strings are not byte-compared.
- `opts.rng`, asserted absent (above).

---

## Error handling

Once campaigns are plaintext and moddable, `assemble` consumes **untrusted input**. The
crate must never `panic!` or `unwrap` on author data.

```rust
pub struct AssembleError { pub problems: Vec<Problem> }   // ALL problems, not the first

pub enum Problem {
    DuplicateName      { kind: &'static str, name: String },
    UnknownRegistryKey { kind: &'static str, key: String },
    UnknownRoom        { referenced_by: String, room: String },
    MissingStartRoom,
    UnknownArchetype   { seat: String, archetype: String },
}
```

Aggregating every problem mirrors `assembler.ts:39-48` and is what makes the eventual
CLI usable. Two hosts, two presentations: the CLI prints all problems (with TOML spans,
once G2 exists); the client renders a "this campaign didn't load" state and stays alive.

Malformed-file errors (serde) stay a distinct type from valid-but-wrong-content errors
(`AssembleError`) — different audiences, different messages.

---

## Testing

The parity gate proves the assembler agrees with TypeScript on campaigns that *work*. It
proves nothing about validation paths, because a valid campaign never trips them.

- **Negative tests, one per `Problem` variant**, ported from `assembler.test.ts`
  (16 KB of existing cases).
- **Determinism test:** `assemble(x) == assemble(x)` across runs.

Two Rust-specific hazards the implementation must avoid:

1. **`HashMap` iteration order would destroy byte-parity nondeterministically** —
   passing locally, failing in CI, or the reverse. Anything reaching serialization uses
   `BTreeMap` / `BTreeSet`. The core already sets this precedent — the WASM `Authority`
   holds `opened: BTreeSet<String>`.
2. **No randomness may enter the assembler.** Enforced structurally: the crate takes no
   `rand` dependency. Ids are derived, never generated. The seeded rng belongs to
   `Authority`.

---

## How G2 slots in without rework

G1's signature takes plain data. G2 adds a `parse` module to the same crate producing
exactly those two values from TOML, and **`assemble`'s signature never changes.**

```
G2:  campaign.toml ──parse──→ (CampaignDescription, Catalog) ──assemble──→ genesis
                                        │
                        gated: must equal the committed
                        description.json + catalog.json byte-for-byte
```

**G2 therefore needs no new genesis goldens.** If the TOML produces the same description
and catalog, it produces the same genesis, and G1's gate already proved that. Parity is
inherited transitively.

The CLI (`npx`-distributable, per the esbuild/swc/Biome precedent of shipping native
binaries through npm `optionalDependencies`) lands as a thin `bin` over the lib.

---

## Program context

Phase 2c decomposes into sub-projects, each with its own spec → plan → implementation
cycle. Decisions taken during this brainstorm:

- **The endgame is Rust everywhere** — engine, server, and client. TypeScript survives
  only as a frozen conformance oracle until the goldens replay, then is deleted.
- **One client, not two.** The multiplayer surface is **Dioxus, not egui** — the
  deciding constraint is native desktop clients, and Dioxus keeps DOM/CSS (so the
  campaign-owned theming survives) while a native client links `wickedways-core`
  directly. The TS/Lit surfaces are retired at parity.
- **Campaign assembly is both** a CLI (authoring, CI validation) and a runtime library
  call (modding), over one crate.
- **Behavior surface syntax is TOML + a small expression language**, compiling to the
  existing `BehaviorScript` AST. The AST is a fixed contract with an existing oracle;
  surface syntax is free.

| # | Sub-project | Oracle |
| --- | --- | --- |
| **G1** | **Rust campaign assembler** *(this spec)* | ✅ genesis goldens |
| G2 | Plaintext TOML format + expression parser + CLI | ✅ description/catalog goldens |
| A | Rust core: party, multi-seat turn order, full `Command` vocabulary | ✅ TS `Campaign` |
| B | Rust sync layer: `Authority` + log, `Delta`, `Resolver` gate | ✅ frozen `src/lib/sync/` |
| C | Rust room server (axum): seats, presence, SQLite, WebSocket | ❌ conventional |
| D | Dioxus client: launcher, save store, audio, themes, surfaces | ❌ e2e + parity |
| E | Chat + A/V signalling port | ❌ conventional |
| F | Retire TypeScript | — |

**Critical sequencing note.** `src/lib/sync/` is the *only* oracle for `Authority`,
`Delta`, and the resolver's authorize gate. Deleting the TS sync layer must be the
**last** step (F), not a step within B — otherwise B is ported blind. The precedent
exists: `conformance/fixtures/oracle-session.ts` is a frozen oracle copy of the
pre-cutover `GameSession`.

**Running alongside G1:** a timeboxed, throwaway **Dioxus spike** — one CRT-styled
screen, web and native — to validate the CSS carryover, the native link to
`wickedways-core`, and desktop packaging before D is ever specced. No spec, no plan;
deleted afterward. Nothing in G1 depends on its outcome.
