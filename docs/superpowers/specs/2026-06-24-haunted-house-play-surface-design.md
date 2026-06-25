# Haunted House Campaign + Infocom-Style Play Surface — Design

**Date:** 2026-06-24 (locked-door model revised 2026-06-25)
**Status:** Approved design; locked-door model revised mid-implementation — pending re-plan

## Goal

Two deliverables, one new package:

1. **A short single-player campaign** — a gothic haunted-house mystery, authored
   purely with the engine's `defineRegistry` + `authorTemplate` API.
2. **A browser play surface** in the style of the original Infocom text
   adventures — a scrolling transcript and a typed command parser, with gentle
   modern affordances (clickable compass/nouns, history, save/restore).

The engine (`src/`) gains **two changes**, both general-purpose (not play-specific):

1. A `hasItem(itemKey): boolean` method on the mechanic system's `CharacterView`
   (mirroring the existing `hasEquipped`) — small, additive, backward-compatible.
2. A first-class **`Exit`** entity with author-defined **preconditions** and a
   **`go(direction)`** traversal method on `Character`. This replaces the old model
   where `Room.exits` mapped a direction straight to a room and a "locked door" was a
   missing exit revealed at runtime. It is a breaking change to `Room.exits`'
   shape and the serialization of exits (see *Locked doors*).

Everything else is new and lives in a new workspace package, `@wickedways/play`, that
imports the engine and drives it in-browser. Because doors become an engine concept,
the play package ends up **thinner** than the original design — it no longer carries a
locked-door table, an `unlock` intent, or any runtime exit-mutation glue.

### Why the one engine change

Authored text reaches a browser UI only through **mechanic Cue effects** — a
`Mechanic` returns `{ kind: EffectKind.Cue, cue: { text } }`, which `apply.ts`
emits as a `{ kind: "mechanic", cue }` `PresentationCue` for `onCue` subscribers.
(Scene scripts in the engine's guide use `console.log`, which only a CLI captures.)
But a mechanic's `CharacterView` currently exposes only `hasEquipped(itemKey)`,
`roomId`, and stats — not inventory contents. Gating journal lore on *holding the
journal* therefore requires `hasItem`. The payoff: the "which lore fragments
have been seen" state lives in **mechanic state, which is serialized in the
snapshot**, so save/restore and any future UI get lore delivery for free, with no
client-side reimplementation.

## Non-Goals (YAGNI)

- No multiplayer, no server, no network. Single local player only.
- No audio. The engine emits `sound` fields on cues; v1 ignores them (a future
  graphical UI can use them).
- No map screen, no settings UI, no accounts.
- No hyperlink/choice-driven IF mode — the parser is the primary input.

## Architecture

The play surface is split into a **UI-neutral core** and a **text adapter**, so a
graphical UI can be added later by reusing the campaign + core and replacing only
the text-specific modules.

```
┌──────────────────────────── packages/play ────────────────────────────┐
│  campaign/   Haunted-house content (defineRegistry + authorTemplate).  │
│              Pure engine usage. UI-neutral.                            │
│                                                                        │
│  ┌─────────── core/  ── UI-NEUTRAL, shared by every surface ───────┐   │
│  │  session    Calls assemble() + seats the player to get a live    │   │
│  │             Campaign. Executes Intents, exposes the               │   │
│  │             cue stream, save/restore/undo, finished/outcome.      │   │
│  │  viewmodel  Derives a plain, render-agnostic snapshot from the    │   │
│  │             live campaign: current room, exits, visible occupants │   │
│  │             /loot, inventory, status line, and the scope of       │   │
│  │             entities in reach this turn.                          │   │
│  │  intent     The serializable union the parser emits and the       │   │
│  │             session executes ({kind:"move",dir} …).               │   │
│  │  savestore  Async SaveStore interface + LocalStorageSaveStore.    │   │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                        │
│  ┌─────────── text/  ── the Infocom surface (one adapter) ─────────┐   │
│  │  parser    Typed text + viewmodel.scope → Intent, OR a local      │   │
│  │            read-only query (look/examine/inventory/exits/help).   │   │
│  │  narrator  Cues + viewmodel → atmospheric prose in the transcript.│   │
│  │  ui        Terminal: scrolling transcript + command line +        │   │
│  │            affordances (compass chips, clickable nouns, history). │   │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                        │
│  (later) gui/  Another adapter over core/ — renders viewmodel + cues   │
│                visually; produces the same Intents from clicks.         │
└──────────────────────────────────────────────────────────────────────┘
```

### Why drive the campaign directly (not the sync stack)

The existing `@wickedways/client` uses `Authority` + `SyncCoordinator` because
multiple networked clients must converge on one authority. A single local player
has no such need: the session assembles a **live `Campaign`** (via `assemble` + the
same seating `startSession` performs) and drives it directly via character methods
(`move`, `attack`, `takeFromLootBox`, …), observing via `campaign.onCue(...)`. The
parser still emits a serializable `Intent` so it stays cleanly testable and
UI-neutral; the session is the only code that knows how to turn an `Intent` into
engine calls. Should multiplayer ever be wanted, only `core/session` changes —
parser/narrator/ui are untouched.

### Data flow per command

1. Player types a line (or clicks an affordance that pre-fills the line; **fill-on-click,
   confirm with Enter** — clicks never fire actions directly).
2. `parser.parse(input, viewmodel)` returns one of:
   - a **read-only query** (LOOK, EXAMINE, INVENTORY, EXITS, HELP) → answered
     immediately from the viewmodel, **no time passes**, no engine call;
   - a **meta command** (SAVE, RESTORE, UNDO) → handled by the session/savestore;
   - an **Intent** → submitted to the session;
   - a **disambiguation request** ("Which key?") → no time passes until resolved;
   - a **parse error** ("You don't see that here.") in-voice.
3. For an Intent, the session snapshots the campaign (for UNDO), executes the engine
   call(s), and — because of the one-command-one-turn rule — advances game time.
4. Cues emitted during execution flow to the narrator, which appends prose to the
   transcript. The viewmodel is recomputed and the UI (status line, compass,
   nouns) refreshes.

### One command = one turn of game time

The engine is round-based with a per-round action budget and a `maxRounds`
timeout; mechanics like Dread tick on round boundaries. Classic Infocom treats one
command as one turn. The session maps it that way: each **time-advancing** Intent
(move — including walking through a door, attack, take, drop, use, wait, harvest,
craft-as-an-action) is followed by `nextPlayer()` to end the round, so
Dread/timeout/win-checks tick per meaningful command. Free queries (look/examine/inventory/exits/help) cost
no time. The 5-action budget is effectively invisible in single-player.

`maxRounds: 150` — a relaxed upper bound (≈150 time-advancing commands). The timeout
reads as a soft safety net for a ~9-room house, not a pressure clock; `.onTimeout()`
prose is written to match (the house never lets dawn come).

## Component: `campaign/` — the haunted-house mystery

**Concept.** You arrive at a dead estate to settle the affairs of a relative who
vanished. The house remembers what happened; you piece it together room by room.
Exploration and atmosphere lead; a few tense presences punctuate. Sanity/Dread is
the slow-burn threat.

**Map (9 rooms, two floors + cellar):**

```
              [Attic] (win room)
                 | (locked: iron key)
 [Study]———[Landing]———[Nursery]
   (locked:    | (stairs)
 brass key)    |
 [Kitchen]——[Hall]———[Parlor]
                 |
              [Foyer] (start)
                 | (down)
              [Cellar] (dead end)
```

(Each link is **one shared `Exit` object** registered in both rooms' maps — see
*Locked doors*. The `(locked: …)` links are exits whose precondition is holding the
named key.)

**No key is locked behind the room it opens** — the spine is solvable:

- Ground floor: `Foyer` (start) connects down to the `Cellar` (a dark dead-end)
  and inward to the `Hall` hub; the Hall opens to the `Kitchen` and `Parlor` and up
  the stairs to the `Landing`.
- Upper floor: the `Landing` connects to the `Study` (locked: brass key), the
  `Nursery`, and up to the `Attic` (locked: iron key — the win room).

**The spine (mystery, not maze):**

- **The journal** — a regular readable item (`behaviorKey: "journal"`) found early
  in a loot box. Holding it unlocks lore: a **Storyteller mechanic** watches `move`
  actions and, when you enter a significant room holding the journal, emits that
  room's lore fragment once as a Cue (gated by `hasItem("journal")`). Its "seen"
  state lives in serialized mechanic state. Holding the journal is part of the win
  condition (`inventory.items` carries `behaviorKey === "journal"`).
- **The lantern** — found in the `Kitchen`; an **equippable** Hand-slot item with
  `emitsLight`. Equipping it both lights dark rooms (engine `room.isLit`) and
  suppresses Dread (the Dread mechanic checks `hasEquipped(lanternKey)`) — one action
  tying light → sanity → exploration together. You'll want it before descending into
  the dark Cellar. (Hand slots are paired, so the lantern and a one-handed weapon can
  be equipped together for the Cellar fight.)
- **Two keys** (authored with `createKey`, matched by `keyCode`):
  - `brass key` — dropped by the Wraith in the `Nursery`; its `keyCode` is the
    precondition on the `Study` door (the Study holds a pivotal journal clue).
  - `iron key` — dropped by the Revenant in the `Cellar`; its `keyCode` is the
    precondition on the `Attic` door (the win room). The Cellar is reachable from the
    Foyer with no key, so the fight that yields the iron key is never gated behind
    itself.
  - A key opens its door **once**: the first holder to `go` through it runs the
    exit's script, which flips the exit's `unlocked` state, so the door then stands
    open for everyone — see *Locked doors*. (`createKey` items cannot be placed in
    authoring loot, so both keys are mob drops.)
- **Two tense presences** (authored as `.mob`s with `drops`):
  - a **Wraith** in the `Nursery` (avoidable; provoking it drains Sanity);
  - a **Revenant** in the `Cellar` — the iron-key holder and the one fight that
    matters, fought in the dark unless you brought the lantern.

### Locked doors — first-class `Exit` entities (engine)

A door is modelled in the **engine**, not the play package. The exit becomes a
first-class entity shaped like the existing `Scene`: it carries author-defined
preconditions, an optional script, persisted state, and a serialization
`behaviorKey`.

**`Exit` (`src/lib/exit.ts`).** One shared object connects two rooms and is
registered in **both** rooms' `exits` maps (`Landing.exits[North]` and
`Attic.exits[South]` are the *same instance*). Per the repo's data-hiding
convention, its mutable state is `#private` behind getters and written only through a
symbol seam.

```ts
type ExitPrecondition<TState> = (character: ICharacter, state: Readonly<TState>) => boolean;
type ExitScript<TState>       = (character: ICharacter, state: TState) => void;

class Exit<TState> {
  readonly endpoints: [IRoom, IRoom];        // the two rooms it joins
  preconditions: ExitPrecondition<TState>[];
  #script?: ExitScript<TState>;
  #state: TState;                            // persisted, e.g. { unlocked: false }
  failMessage?: string;                      // shown (as a cue) when a precondition fails
  #behaviorKey?: string;                     // registry key for (de)serialization

  otherSide(from: IRoom): IRoom;             // small helper: the far endpoint
  canPass(character: ICharacter): boolean;   // pure — evaluates preconditions, no side effects
  [SET_STATE_FLAG](...): void;               // symbol-gated state write (script path)
}
```

**`Character.go(direction)` (engine, gated).** `Character.move(room)` stays as the
ungated primitive (mob movement, forced moves). `go` is the player-facing traversal:

1. Resolve `currentRoom.exits.get(direction)`; absent → soft "You can't go that way."
2. Evaluate `preconditions.every(p => p(this, state))`.
3. **Pass** → run the exit's script (which may flip persisted state, e.g.
   `state.unlocked = true`, and consume the key on the unlocking transition), then
   `move(exit.otherSide(currentRoom))`. The script owns the success narration, so a
   one-time line ("You turn the iron key; the cellar door grinds open.") fires only
   on the transition, not on every later walk-through.
4. **Fail** → emit `failMessage` as a cue and **do not move**. This is a *soft* fail,
   not a thrown `ProceduralViolation`.

**Why state + script (not a bare `locked` flag).** The unlocked-ness belongs to the
*door*, not the character: once the first key-holder opens it, `state.unlocked`
flips, and thereafter `canPass` is true for **anyone** — other PCs and mobs included —
with or without the key. A precondition like
`(char, s) => s.unlocked || char.inventory.keys.some(k => k.keyCode === "iron")`
captures exactly that.

**Serialization is automatic.** The shared `Exit` serializes once as a top-level
entity with its own id (like items/loot); each room stores `{ dir: exitId }`. Its
`#state` and `#behaviorKey` round-trip, and the precondition/script functions
reattach from the registry on hydrate — exactly as scenes do. Because the door's
open-ness lives in serialized engine state, **save/restore/undo carry it for free**,
with no client-side unlock state. And because a locked exit is still *present* in
both maps, the room graph is permanently connected: the serializer's BFS reaches
every room and nothing is ever disconnected. (This is what fixes the save→unlock
crash class the old runtime-`addExit` model was prone to.)

Concretely: the **Landing** holds both upper-floor doors as gated exits — west to the
`Study` (brass-key precondition) and north to the `Attic` (iron-key precondition).
The player simply walks into them (`w`, `n`, or `go west`); there is **no `unlock`
verb and no `unlock` intent** — `go` does it all.
- **The Dread mechanic** — a custom `Mechanic` that drains 1 Sanity per turn,
  returning an `adjustStat` effect on `onTurnStart`, **unless** the actor has the
  lantern equipped (`hasEquipped(lanternKey)`). Registered under `mechanics` and
  enabled with `.useMechanic`. (Mechanics cannot inspect rooms — `CampaignView.rooms`
  is empty — so the gate is the equipped lantern, not room light directly; equipping
  the lantern is what both lights the room and stops the bleed.)
- **Win** — reach the **Attic** while holding the **journal** (you've learned the
  truth and gone to face it). **Lose** — Sanity hits zero (the house takes your
  mind) or the party is KO'd. **Timeout** at round 150.

**Mechanics exercised:** rooms/exits, **precondition-gated `Exit`s** (the two keyed
doors), dark/light + lantern, loot containers, two keys, one real combat (with
durability on a found weapon), the Dread custom mechanic, the Storyteller lore
mechanic, a Sanity-based lose condition, and win/lose/timeout outcomes. (No engine
`scene`s for atmosphere — scene scripts can't push text to a browser — so room
atmosphere comes from descriptions + mechanic cues; door behavior, by contrast, now
lives on the `Exit` itself.)

**Single archetype** for the player (e.g. an "Heir"/"Visitor"), with baseline-ish
stats and perhaps one thematic immunity.

The campaign is authored as a module (mirroring `@wickedways/seed` and the Get Wicked
guide) exporting: the **registry** (`buildHauntedHouseRegistry()` — which now also
registers the door exits' precondition/script behaviors by key, alongside the win/lose
conditions and mechanics), the **`TemplateBuilder`** (`hauntedHouseTemplate()` —
authoring the keyed exits via the builder), the **lore-fragment table** (consumed by
the Storyteller mechanic), and an **alias table** (item/entity synonyms for the
parser). There is **no locked-door table** — door behavior is on the `Exit`. The
session consumes the builder; it still uses `assemble` rather than `startSession` (it
needs the seated live campaign), but no longer needs the room map for unlocking.

## Component: `core/`

### `intent` — the parser's output / session's input

A serializable discriminated union, one variant per world action the parser can
produce, e.g.:

```ts
type Intent =
  | { kind: "move"; dir: Direction }
  | { kind: "take"; targetId: string }
  | { kind: "drop"; targetId: string }
  | { kind: "open"; targetId: string }        // loot box
  | { kind: "attack"; targetId: string }
  | { kind: "equip"; targetId: string }
  | { kind: "unequip"; targetId: string }
  | { kind: "use"; targetId: string }
  | { kind: "talk"; npcId: string; prompt?: string }   // dialogue / read journal
  | { kind: "wait" }
  | { kind: "harvest"; targetId: string }
  | { kind: "craft"; recipeId: string };
```

Targets are entity ids resolved by the parser from `viewmodel.scope`. Keeping ids
(not names) on the Intent means the session never re-resolves nouns.

### `session`

- `start(opts)` — calls `assemble(builder.description, builder.registry)` to get the
  seated, live `Campaign`, replicates `startSession`'s seating (construct each
  `PlayerCharacter`, `joinCampaign`, optional `selectArchetype`, move to the start
  room, set GM, `beginCampaign`), subscribes a forwarding handler to `campaign.onCue`,
  and returns a `GameSession`. (It still uses `assemble` rather than `startSession`,
  but only to get the seated campaign — it no longer needs the room map, because door
  reveals are now the engine's job.)
- `execute(intent)` — snapshots for undo; for a **time-advancing** intent it calls
  `activeCharacter.startTurn()` (which ticks `onTurnStart` mechanics like Dread),
  dispatches the intent to the matching engine call, then `campaign.nextPlayer()`
  (single-player → `endRound` → round++, win/lose/timeout check); **free** intents
  (open, equip, unequip, craft, light) execute directly with no `startTurn`/
  `nextPlayer`. A **move** intent dispatches to `activeCharacter.go(dir)` — the engine
  evaluates the exit's preconditions, narrates the pass/fail, and (on a pass) moves;
  a blocked door is a soft fail whose `failMessage` arrives as a cue, not an error.
  Returns the cues collected during execution; a thrown `ProceduralViolation` (e.g.
  attacking in the dark) is still caught and mapped to an in-voice failure.
- **Time-advancing intents:** move, take, drop, use, harvest, attack, wait.
  **Free intents:** open, equip, unequip, craft, repair, light, extinguish.
- `cues` — subscription for the narrator.
- `save(slot)` / `restore(slot)` / `undo()` — delegate to the SaveStore +
  `serializeCampaign`/deserialize; `undo` restores the pre-last-turn snapshot
  (one level).
- `outcome` / `finished` — surfaced for the narrator's endgame.

### `viewmodel`

A pure function `view(campaign): ViewModel` producing render-agnostic data:

- `room`: id, name, description (full vs. terse depending on visited-before),
  `isLit`.
- `exits`: for each entry in `room.exits` that the active character `canPass`,
  a `{ dir, toName }` (drives the compass). A door the player has already opened
  reads as an ordinary exit here.
- `lockedDoors`: each `room.exits` entry the active character **cannot** pass right
  now → `{ name, dir }` (name from the exit's label) so the compass can hint a locked
  way. (Derived by calling `exit.canPass(pc)` on the current room's exits — no door
  table.)
- `occupants`: NPCs/mobs present, each `{ id, name, aliases, kind }`.
- `loot`: containers present and (once opened) their contents as scope entities.
- `inventory`: carried items `{ id, name, aliases, equipped }`.
- `scope`: the merged, alias-tagged set of entities the parser may resolve nouns
  against this turn (room occupants + open loot contents + inventory).
- `status`: `{ locationName, turn, maxTurns, sanity }` for the status line.

The viewmodel is the single source the parser and (later) the GUI read — never the
raw engine objects.

### `savestore`

```ts
interface SaveStore {
  list(): Promise<SaveSlot[]>;
  save(slot: string, snapshot: CampaignSnapshot): Promise<void>;
  load(slot: string): Promise<CampaignSnapshot | null>;
  delete(slot: string): Promise<void>;
}
```

**Async by design even though `localStorage` is synchronous** — IndexedDB is async,
so presenting an async API now means a future backend swap touches only the
implementation, never the calling code. v1 ships `LocalStorageSaveStore` (a couple
of named slots, JSON-serialized snapshots).

**Known risk:** a campaign snapshot may approach the ~5 MB per-origin `localStorage`
cap. If saves outgrow it, drop in an `IndexedDbSaveStore` behind the same interface.
No other code changes.

## Component: `text/`

### `parser`

A hand-written tokenizer + verb table (not a heavyweight grammar):

1. lowercase → strip leading articles (`the`, `a`, `an`) → split tokens;
2. match the first token against the **verb table** (with synonyms);
3. resolve the remaining noun phrase against `viewmodel.scope` by
   case-insensitive token/substring match over each entity's name + aliases.

**Verb table** — two kinds of verbs:

- *World verbs* → an `Intent`: `go`/`n`/`s`/`e`/`w` (and `north`…) → the `move`
  Intent (walking *into* a locked door is just a `move`; the engine narrates the
  locked-failure), `take`/`get`, `drop`, `open` (a loot box → the `open` Intent),
  `attack`/`kill`/`hit`, `equip`/`wear`/`wield`, `unequip`/`remove`, `use`,
  `talk`/`ask`/`read` (dialogue / journal), `light`/`extinguish` (lantern),
  `harvest`, `craft`, `wait`/`z`. There is **no `unlock` verb** — doors open by
  walking through them with the key.
- *Meta verbs* → handled locally, **no time, no Intent**: `look`/`l`,
  `inventory`/`i`, `examine`/`x` (reads a description from the viewmodel),
  `exits`, `help`/`?`, plus `save`, `restore`, `undo` (routed to the session).

**Resolution outcomes:** an Intent; a local query answer; a disambiguation
request when a noun matches >1 scope entity ("Which do you mean — the brass key or
the iron key?", resolved without time passing); or an in-voice parse error
("You don't see that here." / "You can't do that.").

Entity **synonyms/aliases** are authored alongside the campaign content and surfaced
through the viewmodel, so `lantern`/`lamp`/`light` resolve to the same item.

### `narrator`

Subscribes to the session cue stream and reads the viewmodel. Responsibilities:

- **Room rendering** (on entry and on `look`): authored room description, then a
  sentence listing visible exits, occupants, and loot. First visit gives the full
  description; re-entry gives the terse form (classic Infocom behavior).
- **Event prose** from cues: combat (`action`/`encounter` cues → templated lines
  with actor/target names), movement, taking/dropping, light/visibility changes,
  Dread ticks and **journal lore fragments** (both `mechanic` cues — text passed
  through verbatim), and the win/lose/timeout `resolution` cue as the closing
  paragraph.
- **Door pass/fail prose**: walking into a gated exit produces a cue either way — the
  exit's script narrates a successful first unlock ("You turn the iron key; the cellar
  door grinds open."), and its `failMessage` narrates a blocked attempt ("The study
  door won't budge — it's locked."). The narrator simply renders those cues; there is
  no separate exit-diff to compute, since opening a door is no longer a runtime exit
  mutation.
- A small **prose-templates** module keyed by cue kind keeps the voice consistent
  and is the single file to tune for tone.

### `ui`

A monospace, dark terminal:

- a scrolling **transcript** pane;
- a fixed bottom **command line** with a blinking cursor;
- a **compass/exit row** of clickable chips (click → fills `go <dir>`);
- **clickable nouns** in prose (click → pre-fills `examine <noun>`; confirm with
  Enter — **clicks never fire actions directly**);
- **command history** via ↑/↓;
- a **status line**: location · turn N/150 · Sanity.

The UI shell stays thin; it is verified by playing, not unit tests.

## Tooling & package setup

- New workspace package `@wickedways/play` (Vite + TypeScript), matching the
  existing `@wickedways/client` setup: `"wickedways": "workspace:*"` dependency,
  `vite` dev/build scripts, `tsc --noEmit` typecheck.
- Its own Vitest config, co-located tests (`foo.ts` ↔ `foo.test.ts`), mirroring the
  engine convention.
- Deployable to GitHub Pages alongside the docs site (static build).

## Testing

- **Parser** (richest unit surface): input string + a stub viewmodel scope →
  expected Intent, query, disambiguation, or error. Covers synonyms, articles,
  ambiguity, no-match, abbreviations, directions.
- **Narrator**: canned cues + viewmodel → asserted prose lines. Guards voice and
  first-visit vs. terse rendering against regression.
- **Campaign integration** (executable acceptance test): drive the authored house
  through a full winning path purely via the engine (no UI) — confirms it is
  winnable and that keys, the lantern/Dread interaction, the one combat, and the
  win/lose/timeout conditions all fire. Also a losing path (Sanity → 0).
- **Session**: Intent → engine call mapping, time advancing only on time-advancing
  intents, save/restore round-trip, undo restoring the prior turn.
- **UI**: manual play-through verification.

## Acceptance criteria

1. `pnpm --filter @wickedways/play dev` serves a playable terminal in the browser.
2. A player can complete the haunted house — explore, read the journal, find both
   keys, manage the lantern/Sanity, win by reaching the Attic with the journal.
3. Sanity → 0 and the round-150 timeout both end the game with their authored prose.
4. Save, restore, and one-level undo work via the `SaveStore` interface.
5. Clickable compass/nouns fill the command line; Enter confirms.
6. The engine (`src/`) changes are: (a) the additive `CharacterView.hasItem` method,
   and (b) the first-class `Exit` entity + `Character.go(direction)` (with exit
   (de)serialization), each with tests; all other new code is in `@wickedways/play`.
7. `pnpm checks` (lint + typecheck + test) passes, including the new package's tests.

## Future graphical UI

A `gui/` adapter would reuse `campaign/` and `core/` untouched: it renders the
viewmodel and cues visually, and produces the same `Intent`s from clicks/menus
instead of from typed text — no parser, no narrator. If `core/` needs to be shared
across two packages at that point, it is promoted to `@wickedways/play-core`; the
seam already exists, so the move is mechanical.
