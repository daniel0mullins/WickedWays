# The Systems Tour (10–15 minutes)

**Title:** *One Engine, Many Faces: a tour of the Wicked Ways architecture*

**Audience:** engineers who want to see how the pieces fit — the systems, not
yet the internals. Assumes the elevator pitch's framing; each section names
the crate(s) so listeners can go read the code.
**Format:** 6 sections, ~2 minutes each, ~12 slides. Timing checkpoints at the
end.

---

## 0 — Frame (1 min)

One sentence of setup: Wicked Ways is a turn-based horror RPG whose rules
exist in exactly one place — `wickedways-core` — with every surface a
projection of it. This talk walks the pipeline end to end: **content →
engine → extensions → sync → surfaces → the gates that pin it all.**

*Visual: the workspace table from the README — nine crates, one line each.*

## 1 — The content pipeline: TOML → description + catalog → genesis (2 min)

*Crates: `wickedways-author`, `wickedways-assemble`.*

A campaign is **authored in TOML** — rooms, exits, mobs, NPCs, items, victory
conditions, and behavior bodies written in a small infix expression/statement
language (`guard`, `when`, `set state.x`, `emit cue(...)`,
`emit adjustStat(actor, sanity, -1)`).

`wickedways-author` compiles that into two artifacts: a **description** (what
the author declared) and a **catalog** (the registry of behavior scripts,
items, recipes, formations). `wickedways-assemble` then folds in a seated
party and emits a **genesis snapshot** the engine can `begin_campaign` on.

Two properties worth calling out:

- **Ids are derived, never generated** — `room:{name}`, `exit:{a}|{b}`
  sorted, `npc:{name}:item#{i}`. The assembler depends on neither `rand` nor
  `uuid`; the same inputs yield byte-identical output.
- **The surface is complete.** The entire shipped campaign, Hollow House —
  9 rooms, 13 exits, 3 mechanics, 3 keyed doors, an NPC with a dialogue tree —
  is one TOML file whose compilation reproduces the committed JSON
  byte-for-byte. The authoring format isn't a toy beside the engine; it *is*
  how the shipped content is written.

## 2 — The engine core: a lifecycle-guarded state machine (2.5 min)

*Crate: `wickedways-core` (~24k lines, `no_std`-capable).*

The core is a pure state machine over commands. Highlights, fast:

- **Turn loop & budgets.** Each character has an action budget (3 for PCs, 2
  for mobs); budgeted actions tick it and auto-end the turn when spent.
  Illegal moves — acting before the campaign begins, a GM leaving — throw
  `ProceduralViolation`. Guards are the API contract, not error handling.
- **The stat triangle.** Health, Sanity, Energy, each mitigated by the next in
  a cycle (Health by Sanity, Sanity by Energy, Energy by Health). Damage is
  `armor-reduced, then scaled by the mitigator` — a fully-rested mitigator
  absorbs everything; a depleted one doubles damage. Afflictions (KO, Panic,
  Fear, Confused) latch off stat thresholds and gate which actions you may
  even attempt.
- **A living world.** Spanning-tree map generation, dark rooms with a
  light/targeting gate, weighted roving encounters, loot, crafting from a
  party-wide material pool, durability and repair, NPC dialogue trees, a
  party Codex recording everything encountered.
- **Determinism throughout.** One seeded mulberry32 RNG on the world; no
  clock; no IO. `no_std` discipline (`alloc`-only) keeps the core portable —
  CI gates the `--no-default-features` build.

The point isn't any one mechanic — it's that *all* of this exists once, and
nothing outside this crate re-implements a scrap of it.

## 3 — The extension system: one idiom, six families (2.5 min)

*Files: `crates/wickedways-core/src/world/{mechanics,exits,scenes,formations}.rs`,
`src/script/`.*

Every extensible thing follows the **same pattern**: a trait (`MechanicOp`,
`ExitBehavior`, `SceneBehavior`, `VictoryConditionBehavior`, `ItemBehavior`,
`FormationBehavior`), a native `key → &'static dyn` registry, and a fallback
to **scripted behaviors** from the catalog — the TOML-authored, loop-free,
deterministic AST. Resolution is native-first; unknown keys fail fast at load.

Extensions communicate through a **closed `Effect` union** — damage, heal,
adjustStat, grantImmunity, cue, status, giveItem, setVisible — and four
guardrails keep them honest:

- **Integrity:** effects route through clamping appliers behind unforgeable
  symbol seams; no raw setters.
- **Determinism:** hooks see a read-only view projection; randomness only via
  the injected RNG.
- **Termination:** collect-then-apply (reducers can't observe each other
  mid-event), a hard 64-effects-per-event cap, no re-entrancy.
- **Balance:** advisory — the one guardrail that's a suggestion.

So a campaign's doom clock, its keyed doors, its dialogue hand-offs, and its
damage-capping dread mechanic are all *data riding the same rails* — and
serialization only stores `{ key, state }`, rebinding behavior on load.

## 4 — Sync: one authority, every topology (2.5 min)

*Files: `crates/wickedways-core/src/sync/`; crates `wickedways-server`,
`wickedways-transport`.*

Multiplayer is a command log with a single resolver. A client's coordinator
`submit`s a command to the **Authority**; the authority authorizes, applies it
to the real engine, diffs a **Delta**, appends it to an ordered log, and
returns it. Replicas apply deltas through a `DeltaApplier` that **patches
state and never runs game logic or draws RNG** — so convergence is
deterministic by construction. No optimistic mutation, no rollback, no CAS.
A rejection is not a fizzle: denials never commit; legal-but-ineffective
actions commit and propagate like any other.

The kicker: **single-player and multiplayer are the same machinery.**

- Single-player: the same Authority behind an `InProcessTransport`, with
  `solo` on — the engine itself drives turn wrap and mob reactions.
- Multiplayer: the same Authority hosted by an axum server, one per campaign
  behind a tokio actor (submit → persist to SQLite → ack, flush-before-ack),
  seat-ownership auth, `manage_turns` on.

Two option flags and a transport choice. There is no "multiplayer mode" in the
game rules.

## 5 — The surfaces: five faces, zero rules (2.5 min)

*Crates: `wickedways-web`, `desktop/`, `wickedways-wasm`,
`wickedways-tabletop`, `wickedways-controller`.*

- **Browser** (`wickedways-web`, Dioxus → wasm): the shipped product. Links
  the core directly as a Rust rlib. Builds a full procedural audio layer —
  four SFX categories plus a sanity-reactive ambient drone — purely off the
  engine's **cue stream**; presentation is a subscriber, never a participant.
- **Desktop** (`desktop/`): the same client crate in a dioxus-desktop webview
  shell. Deliberately workspace-excluded so the GTK/WebKit linkage never
  touches the workspace gates. Ships as `.deb`/`.dmg`/`.msi` via `dx bundle`.
- **JS embedding** (`wickedways-wasm`): a stateful `Authority` handle for any
  external JS host. **Only JSON strings cross the seam** — an intent in;
  cues, view model, snapshot out. No host ever holds a live engine object.
- **Physical tabletop** (`wickedways-tabletop` + `wickedways-controller`): the
  bridge turns the engine's `ViewModel` into device commands — paint e-ink
  tiles, place pieces — and resolves NFC device events back into actor-tagged
  engine commands, over a COBS-framed serial protocol. The same bridge crate
  compiles to wasm, so the web client renders an on-screen simulator of the
  physical board. The controller's `--dry-run` exercises the whole
  engine→bridge→codec path with no hardware.

Tally the cost of a face: the tabletop bridge is ~1,400 lines; the controller
~400; the wasm boundary ~260. The rules never changed.

## 6 — The gates: how it stays true (1.5 min)

*Directory: `conformance/fixtures/` — 256 files. CI:
`.github/workflows/checks.yml`.*

Four golden gates run under plain `cargo test`: the author gate (TOML →
artifacts), the assembler gate (artifacts → genesis), the replay gate (every
committed command/facade recording, stepped intent-by-intent, diffing result +
snapshot + view), and the sync gate (command logs → delta streams,
byte-for-byte).

Goldens are **regression pins of the engine's own output**: regenerate
deliberately with `UPDATE_GOLDENS=1`, review the diff like code, never
hand-edit. Regeneration is deterministic — a second run must produce a zero
git diff.

And the receipt: this corpus carried the engine across a **full
TypeScript→Rust rewrite** — the Rust engine was built until it reproduced the
goldens byte-for-byte, then the TypeScript tree was deleted. The tests
outlived the language.

## Close (0.5 min)

The architecture is three decisions, compounding: put the rules in one
deterministic core; make every boundary a closed vocabulary; pin observable
behavior in goldens. Everything demo-worthy — the no-rollback multiplayer,
the cheap ports, the physical board — is interest on those three.

---

### Timing checkpoints

- End of §2: ~6 min. Long? Trim §2's mechanic list — the section's job is
  "it all lives here once," not the tour of mechanics.
- End of §4: ~10.5 min. The sync section is the heart; protect it.
- §5 can compress to the tally sentence + tabletop if you're at 13 min.
