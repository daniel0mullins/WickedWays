# The Systems Tour (10–15 minutes)

**Title:** *One Engine, Many Faces: a tour of the Wicked Ways architecture*

**Audience:** engineers who want to see how the pieces fit — the systems, not
yet the internals. No Rust or game-dev background assumed; every term of art
gets a plain-English gloss at first use. Each section names the crate(s) —
Rust's word for a package — so listeners can go read the code.
**Format:** 6 sections, ~2 minutes each, ~12 slides. Timing checkpoints at the
end.

---

## 0 — Frame (1 min)

One sentence of setup: Wicked Ways is a turn-based horror RPG — a party of
player characters and one Game Master exploring a haunted house, room by room
— and its rules exist in exactly one place, `wickedways-core`, with every
surface a projection of it. This talk walks the pipeline end to end:
**content → engine → extensions → sync → surfaces → the checks that pin it
all.**

*Visual: the workspace table from the README — nine crates, one line each.*

## 1 — The content pipeline: TOML → description + catalog → genesis (2 min)

*Crates: `wickedways-author`, `wickedways-assemble`.*

A campaign is **authored in TOML** — a plain-text configuration format, like
INI — declaring rooms, exits, monsters ("mobs"), non-player characters
(NPCs), items, victory conditions, and behavior bodies written in a small
custom scripting language (`guard`, `when`, `set state.x`,
`emit cue(...)` — a "cue" being a presentation event such as a line of
narration or a sound).

`wickedways-author` compiles that into two artifacts: a **description** (what
the author declared) and a **catalog** (the compiled registry of behavior
scripts, items, recipes, formations). `wickedways-assemble` then folds in the
seated party — which players occupy which character slots, or "seats" — and
emits the **genesis snapshot**: the world's complete starting state, ready
for the engine to `begin_campaign` on.

Two properties worth calling out:

- **Ids are derived, never generated** — `room:{name}`, `exit:{a}|{b}`
  sorted, `npc:{name}:item#{i}`. The assembler depends on no random or UUID
  library; the same inputs yield byte-identical output.
- **The surface is complete.** The entire shipped campaign, Hollow House —
  9 rooms, 13 exits, 3 mechanics, 3 keyed doors, an NPC with a dialogue tree —
  is one TOML file whose compilation reproduces the committed JSON
  byte-for-byte. The authoring format isn't a toy beside the engine; it *is*
  how the shipped content is written.

## 2 — The engine core: a lifecycle-guarded state machine (2.5 min)

*Crate: `wickedways-core` (~24k lines).*

The core is a pure state machine over commands. Highlights, fast:

- **Turn loop & budgets.** Each character gets a per-turn action budget (3
  for player characters, 2 for mobs); actions spend it, and the turn ends
  when it's gone. Illegal moves — acting before the campaign begins, the
  Game Master leaving mid-game — are refused with the engine's
  `ProceduralViolation` error. Refusal is the API contract, not error
  handling.
- **The stat triangle.** Health, Sanity, Energy, each guarded by the next in
  a cycle: Sanity absorbs Health damage, Energy absorbs Sanity damage,
  Health absorbs Energy damage. Every attack first rolls a d20 to-hit (a
  natural 20 crits for 1.5×, a natural 1 stumbles into self-damage, 2–5
  miss); damage that lands is then absorbed by the guard stat — full guard
  absorbs it entirely, empty guard doubles it. Afflictions (knock-out,
  Panic, Fear, Confused) trigger at stat thresholds, stick until shaken off,
  and restrict which actions you may even attempt.
- **A living world.** Generated maps guaranteed fully connected, dark rooms
  you can't aim inside without a light, randomly triggered monster
  encounters, loot, crafting from a party-wide material pool, gear that
  wears down and gets repaired, NPC dialogue trees, a party Codex — an
  in-game encyclopedia of everything encountered.
- **Determinism throughout.** One seeded random-number generator on the
  world (mulberry32 — a small, fast, reproducible algorithm); no clock; no
  IO. Even *physical* dice fit: a die rolled at the table enters the engine
  as a recorded command — a literal value on the log — so replays stay
  exact. And the core is built to run without an operating system underneath
  (Rust's `no_std` mode) — that's what lets the identical code compile for
  browsers and for embedded hardware, and CI checks that build on every
  commit.

The point isn't any one mechanic — it's that *all* of this exists once, and
nothing outside this crate re-implements a scrap of it.

## 3 — The extension system: one idiom, six families (2.5 min)

*Files: `crates/wickedways-core/src/world/{mechanics,exits,scenes,formations}.rs`,
`src/script/`.*

Every extensible thing follows the **same pattern**: a trait — Rust's version
of an interface — (`MechanicOp`, `ExitBehavior`, `SceneBehavior`,
`VictoryConditionBehavior`, `ItemBehavior`, `FormationBehavior`), a built-in
lookup table from name to compiled-in implementation, and a fallback to
**scripted behaviors** from the campaign catalog — the TOML-authored scripts,
stored as data with no loops, so termination isn't a runtime worry. Resolution
tries native first; an unknown name fails at load time, not mid-session.

Extensions communicate through a **closed set of effects** — damage, heal,
adjustStat, grantImmunity, cue, status, giveItem, setVisible — and four
guardrails keep them honest:

- **Integrity:** extensions never touch state. They return effect *requests*,
  and the engine applies each one itself through accessors keyed by private
  types outside code can't even construct, clamping values to legal ranges.
- **Determinism:** hooks see a read-only view of the world; randomness only
  via the injected generator.
- **Termination:** every hook runs against the pre-event state, and the
  collected effects apply afterward in one deterministic pass
  ("collect-then-apply"), with a hard cap of 64 effects per event and no
  re-entry.
- **Balance** — limits on how mechanically powerful an effect content may
  produce — is advisory. Three walls and a sign.

So a campaign's doom clock, its keyed doors, its dialogue hand-offs, and its
damage-capping dread mechanic are all *data riding the same rails* — and a
save file stores only `{ key, state }` per behavior, re-binding the code on
load.

## 4 — Sync: one authority, every topology (2.5 min)

*Files: `crates/wickedways-core/src/sync/`; crates `wickedways-server`,
`wickedways-transport`.*

Multiplayer is a command log with a single resolver. Each client owns a
coordinator object holding a **replica** — its local copy of the world. The
coordinator submits a command to the **Authority**; the authority checks it,
applies it to the real engine, computes a **Delta** — a minimal patch
describing what changed — appends it to an ordered log, and returns it.
Replicas apply deltas through an applier that **patches state and never runs
game logic or draws randomness** — so every copy converges by construction.
Nothing is ever applied ahead of the log, so there's nothing to undo: no
guessing, no rollback. And a denial is not a fizzle: a denied command never
commits, while a *fizzle* — a legal action that happened to have no effect,
like a fully-absorbed attack — commits and propagates like any other.

The kicker: **single-player and multiplayer are the same machinery.**

- Single-player: the same Authority behind an in-process connection, with
  `solo` on — the engine itself drives turn wrap-up and monster reactions.
- Multiplayer: the same Authority hosted by the room server (built on axum,
  a Rust web framework), one per campaign, each behind a single task that
  owns the state and handles one submit at a time — apply, write to SQLite,
  and only then acknowledge. Players hold seats, and the server refuses a
  command unless it comes from the seat that owns that character;
  `manage_turns` is on, so a player whose action budget is spent is refused
  at submit.

Two option flags and a transport choice. There is no "multiplayer mode" in
the game rules.

## 5 — The surfaces: five faces, zero rules (2.5 min)

*Crates: `wickedways-web`, `desktop/`, `wickedways-wasm`,
`wickedways-tabletop`, `wickedways-controller`.*

- **Browser** (`wickedways-web`, ~10k lines): the shipped product, built with
  Dioxus — a React-like UI framework for Rust — and compiled to WebAssembly
  ("wasm," the binary format browsers run at near-native speed), linking the
  core directly as an ordinary library. Builds a full procedural
  audio layer — four sound-effect categories plus an ambient drone that
  tracks the party's sanity — purely off the engine's **cue stream**;
  presentation is a subscriber, never a participant.
- **Desktop** (`desktop/`): the same client code in a webview shell.
  Deliberately kept out of the main build, so its Linux GUI system libraries
  never have to be installed to build or test anything else. Ships as
  `.deb`/`.dmg`/`.msi` via `dx bundle`.
- **JS embedding** (`wickedways-wasm`): a stateful `Authority` handle for any
  external JavaScript host. **Only JSON strings cross the boundary** — a
  command in; cues, view model, snapshot out. No host ever holds a live
  engine object.
- **Physical tabletop** (`wickedways-tabletop` + `wickedways-controller`):
  the bridge turns the engine's ready-to-render view of the world into
  device commands — paint e-ink tiles, place pieces — and resolves incoming
  device events (an NFC piece set down on a tile, physical dice read off the
  table and fed in as recorded roll values) into character-tagged engine
  commands, over a framed serial protocol (COBS — a standard trick for
  marking packet boundaries on a raw byte stream). The same bridge code
  also compiles to wasm, so the web client renders an on-screen simulator of
  the physical board. And the controller — the program that drives the real
  hardware — has a `--dry-run` mode that exercises the whole
  engine→bridge→codec path with no hardware attached.

Tally the cost of a face: the tabletop bridge is ~1,400 lines; the controller
~400; the wasm boundary ~260. The rules never changed.

## 6 — The gates: how it stays true (1.5 min)

*Directory: `conformance/fixtures/` — 256 files. CI:
`.github/workflows/checks.yml`.*

Four golden gates run under plain `cargo test` — "goldens" being recorded
known-good outputs committed to the repo: the author gate (TOML →
artifacts), the assembler gate (artifacts → genesis), the replay gate (every
committed gameplay recording, stepped command-by-command, diffing result +
snapshot + view), and the sync gate (command logs → delta streams,
byte-for-byte).

Goldens are **regression pins of the engine's own output**: re-record
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
