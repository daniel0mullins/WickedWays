# Haunted House Campaign + Infocom-Style Play Surface — Design

**Date:** 2026-06-24
**Status:** Approved design, pending implementation plan

## Goal

Two deliverables, one new package:

1. **A short single-player campaign** — a gothic haunted-house mystery, authored
   purely with the engine's `defineRegistry` + `authorTemplate` API.
2. **A browser play surface** in the style of the original Infocom text
   adventures — a scrolling transcript and a typed command parser, with gentle
   modern affordances (clickable compass/nouns, history, save/restore).

The engine (`src/`) is **not modified**. Everything new lives in a new workspace
package, `@wickedways/play`, that imports the engine and drives it in-browser.

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
│  │  session    Calls startSession() to get a live Campaign and      │   │
│  │             drives it directly. Executes Intents, exposes the     │   │
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
has no such need: `startSession(builder, opts)` returns a **live `Campaign`** that
the session drives directly via character methods (`move`, `attack`, `takeFromLootBox`,
…) and observes via `campaign.onCue(...)`. The parser still emits a serializable
`Intent` so it stays cleanly testable and UI-neutral; the session is the only code
that knows how to turn an `Intent` into engine calls. Should multiplayer ever be
wanted, only `core/session` changes — parser/narrator/ui are untouched.

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
(move, attack, take, drop, use, equip/unequip, unlock, wait, harvest, craft-as-an-
action) is followed by `nextPlayer()` to end the round, so Dread/timeout/win-checks
tick per meaningful command. Free queries (look/examine/inventory/exits/help) cost
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

(Exits are one-way in the engine, so each link is authored in both directions.)

**No key is locked behind the room it opens** — the spine is solvable:

- Ground floor: `Foyer` (start) connects down to the `Cellar` (a dark dead-end)
  and inward to the `Hall` hub; the Hall opens to the `Kitchen` and `Parlor` and up
  the stairs to the `Landing`.
- Upper floor: the `Landing` connects to the `Study` (locked: brass key), the
  `Nursery`, and up to the `Attic` (locked: iron key — the win room).

**The spine (mystery, not maze):**

- **The journal** — found early (a loot box in the Foyer/Hall); its entries are
  gated prose (NPC-style dialogue and/or room-entry scenes) that unlock as rooms are
  discovered, slowly revealing what the vanished occupant did. Holding the journal
  is part of the win condition.
- **The lantern** — found in the `Kitchen`; an `emitsLight` item. Carried, it lights
  dark rooms and suppresses Dread. You'll want it before descending into the dark
  Cellar — tying light → sanity → exploration together.
- **Two keys** (authored with `createKey`, matched by `keyCode`):
  - `brass key` — found in a loot box in the `Parlor`; reveals the door to the
    `Study`, which holds a pivotal journal clue.
  - `iron key` — dropped by the Revenant in the `Cellar`; reveals the door to the
    `Attic` (the win room). The Cellar is reachable from the Foyer with no key, so the
    fight that yields the iron key is never gated behind itself.
- **Two tense presences** (authored as `.mob`s with `drops`):
  - a **Wraith** in the `Nursery` (avoidable; provoking it drains Sanity);
  - a **Revenant** in the `Cellar` — the iron-key holder and the one fight that
    matters, fought in the dark unless you brought the lantern.

### Locked doors — the engine-faithful model

The engine **never blocks movement** (`Character.move` is ungated; mechanics fire
after the fact and cannot veto). A "locked door" is therefore **not** an enforced
lock — it is **an exit that does not exist yet**. Runtime exit mutation *is*
supported (`room.addExit(dir, to)` / `room.removeExit(dir)` are public), and scene
scripts may call them.

So each locked door is authored as a **key-gated `enter` scene on the antechamber
room** (the room you stand in to use the door):

- The locked exit is **not** declared at authoring time.
- A scene on the antechamber (phase `enter`) has a precondition that checks the
  entering character's `inventory.keys` for the matching `keyCode`. When you enter
  that room **holding the key**, the precondition passes and the script runs
  `antechamber.addExit(dir, target)` (plus the reverse exit on `target`), narrated as
  the door unlocking. A persisted `state` flag makes the reveal idempotent across
  re-entries; a `consumeOnUse` key is spent via `consumeKey` in the script.

Concretely: the **Landing** is the antechamber for both upper-floor locked doors.
Entering it with the `brass key` reveals the `Study`; entering it with the `iron key`
reveals the `Attic`. Picking the brass key up in the Parlor and walking back up the
stairs re-fires the Landing's `enter` scene, which now passes its precondition and
opens the way — the natural Infocom rhythm, with no engine primitive faked.

There is consequently **no `unlock`-an-exit Intent** (the engine has no such
primitive). `unlock`/`open` survive only as in-voice **convenience verbs** in the
parser (below): when a locked door is present they report its state ("The study door
is locked — you don't have the right key." / "The way is already open."), but the
actual reveal is the authored scene's job.
- **The Dread mechanic** — a custom `Mechanic` that drains 1 Sanity per turn while
  the actor is in an unlit/haunted room, returning an `adjustStat` effect on
  `onTurnStart`; suppressed when the room is lit. Registered under `mechanics` and
  enabled with `.useMechanic`.
- **Win** — reach the **Attic** while holding the **journal** (you've learned the
  truth and gone to face it). **Lose** — Sanity hits zero (the house takes your
  mind) or the party is KO'd. **Timeout** at round 150.

**Mechanics exercised:** rooms/exits, dark/light + lantern, loot containers, two
keys, one real combat (with durability on a found weapon), the Dread custom
mechanic, a Sanity-based lose condition, NPC/journal dialogue, room-entry scenes for
atmosphere, and win/lose/timeout outcomes.

**Single archetype** for the player (e.g. an "Heir"/"Visitor"), with baseline-ish
stats and perhaps one thematic immunity.

The campaign is authored as a module exporting a registry + a `TemplateBuilder` (and
a convenience `startHauntedHouse()` that calls `startSession`), mirroring the pattern
in `@wickedways/seed` and the Get Wicked guide.

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

- `start(opts)` — calls `startSession(hauntedHouseBuilder, { players:[…], gm:0 })`,
  subscribes a forwarding handler to `campaign.onCue`, returns a `GameSession`.
- `execute(intent)` — snapshots for undo, dispatches the Intent to the matching
  engine call on `campaign.activeCharacter` (or campaign), advances time
  (`nextPlayer()`) for time-advancing intents, returns the cues collected during
  execution and any thrown `ProceduralViolation` mapped to an in-voice failure.
- `cues` — subscription for the narrator.
- `save(slot)` / `restore(slot)` / `undo()` — delegate to the SaveStore +
  `serializeCampaign`/deserialize; `undo` restores the pre-last-turn snapshot
  (one level).
- `outcome` / `finished` — surfaced for the narrator's endgame.

### `viewmodel`

A pure function `view(campaign): ViewModel` producing render-agnostic data:

- `room`: id, name, description (full vs. terse depending on visited-before),
  `isLit`.
- `exits`: list of `{ dir, toName }` for available directions (drives the compass).
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

- *World verbs* → an `Intent`: `go`/`n`/`s`/`e`/`w`/`u`/`d` (and `north`…),
  `take`/`get`, `drop`, `open` (a loot box → the free `open` Intent),
  `attack`/`kill`/`hit`, `equip`/`wear`/`wield`, `unequip`/`remove`, `use`,
  `talk`/`ask`/`read` (dialogue / journal), `light`/`extinguish` (lantern),
  `harvest`, `craft`, `wait`/`z`.
- *Meta verbs* → handled locally, **no time, no Intent**: `look`/`l`,
  `inventory`/`i`, `examine`/`x` (reads a description from the viewmodel),
  `exits`, `help`/`?`, plus `save`, `restore`, `undo` (routed to the session).
- *Door affordance*: `unlock`, and `open` when its target is a door rather than a
  loot box, give in-voice lock-state feedback only — the actual reveal is the
  authored key-gated scene (see "Locked doors"), so no Intent is produced.

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
  with actor/target names and deltas), movement, taking/dropping, light/visibility
  changes, Dread ticks (`mechanic` cues → atmospheric one-liners), NPC/journal text
  passed through verbatim, scene scripts' text, and the win/lose/timeout
  `resolution` cue as the closing paragraph.
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
6. The engine package (`src/`) is unchanged. All new code is in `@wickedways/play`.
7. `pnpm checks` (lint + typecheck + test) passes, including the new package's tests.

## Future graphical UI

A `gui/` adapter would reuse `campaign/` and `core/` untouched: it renders the
viewmodel and cues visually, and produces the same `Intent`s from clicks/menus
instead of from typed text — no parser, no narrator. If `core/` needs to be shared
across two packages at that point, it is promoted to `@wickedways/play-core`; the
seam already exists, so the move is mechanical.
