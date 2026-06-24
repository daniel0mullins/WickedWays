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

The engine (`src/`) is touched by **one small, additive, backward-compatible
change**: a `hasItem(itemKey): boolean` method on the mechanic system's
`CharacterView` (mirroring the existing `hasEquipped`). Everything else is new and
lives in a new workspace package, `@wickedways/play`, that imports the engine and
drives it in-browser.

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
│  │             Campaign + room map. Executes Intents, exposes the    │   │
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
supported (`room.addExit(dir, to)` / `room.removeExit(dir)` are public).

Reveals **cannot** be done from a scene: a scene behavior only ever receives its own
room, and the locked target room is disconnected, so a scene has no way to reference
it for `addExit`. The room references live only in the `Map<string, IRoom>` that
`assemble(description, registry)` returns — which `startSession` consumes and hides.

So locked doors are handled in **`core/session`**, which obtains that map directly:

- The session calls `assemble(builder.description, builder.registry)` (instead of
  `startSession`) to get `{ campaign, rooms }`, then replicates `startSession`'s
  seating (construct each `PlayerCharacter`, `joinCampaign`, `selectArchetype`, move
  to the start room, set the GM, `beginCampaign`). It retains the `rooms` map.
- The campaign content exports a **locked-door table** — plain data, e.g.
  `{ id, from, dir, to, keyCode, consume }[]`. The session is generic: it applies
  whatever table it is handed, so `core/` stays campaign-agnostic.
- An `unlock` Intent (a real, time-advancing action) names a locked door present in
  the current room. The session checks the active character's `inventory.keys` for
  the matching `keyCode`; on a match it calls `from.addExit(dir, rooms.get(to))` plus
  the reverse exit, spends a `consume` key via `consumeKey`, and the reveal is
  narrated. With no key it fails in-voice ("The study door won't budge — you don't
  have the right key.").

Because the reveal mutates `room.exits`, it is captured by `serializeCampaign`, so
**save/restore restores unlocked doors automatically** — no client-side unlock state
to persist separately.

Concretely: the **Landing** holds both upper-floor locked doors — `unlock study
door` (brass key) reveals the `Study`; `unlock attic door` (iron key) reveals the
`Attic`. `open <door>` is a synonym for `unlock` when its target is a door;
`open <chest>` remains the loot-box action.
- **The Dread mechanic** — a custom `Mechanic` that drains 1 Sanity per turn,
  returning an `adjustStat` effect on `onTurnStart`, **unless** the actor has the
  lantern equipped (`hasEquipped(lanternKey)`). Registered under `mechanics` and
  enabled with `.useMechanic`. (Mechanics cannot inspect rooms — `CampaignView.rooms`
  is empty — so the gate is the equipped lantern, not room light directly; equipping
  the lantern is what both lights the room and stops the bleed.)
- **Win** — reach the **Attic** while holding the **journal** (you've learned the
  truth and gone to face it). **Lose** — Sanity hits zero (the house takes your
  mind) or the party is KO'd. **Timeout** at round 150.

**Mechanics exercised:** rooms/exits, dark/light + lantern, loot containers, two
keys + locked-door reveals, one real combat (with durability on a found weapon), the
Dread custom mechanic, the Storyteller lore mechanic, a Sanity-based lose condition,
and win/lose/timeout outcomes. (No engine `scene`s — scene scripts can't push text to
a browser and can't reference disconnected rooms, so atmosphere comes from room
descriptions + mechanic cues, and door reveals from the session.)

**Single archetype** for the player (e.g. an "Heir"/"Visitor"), with baseline-ish
stats and perhaps one thematic immunity.

The campaign is authored as a module (mirroring `@wickedways/seed` and the Get Wicked
guide) exporting: the **registry** (`buildHauntedHouseRegistry()`), the
**`TemplateBuilder`** (`hauntedHouseTemplate()`), the **locked-door table**, the
**lore-fragment table** (consumed by the Storyteller mechanic), and an **alias table**
(item/entity synonyms for the parser). The session consumes the builder + door table;
it does not use `startSession` (which would hide the room map).

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
  | { kind: "unlock"; doorId: string }                 // reveal a locked door
  | { kind: "talk"; npcId: string; prompt?: string }   // dialogue / read journal
  | { kind: "wait" }
  | { kind: "harvest"; targetId: string }
  | { kind: "craft"; recipeId: string };
```

Targets are entity ids resolved by the parser from `viewmodel.scope`. Keeping ids
(not names) on the Intent means the session never re-resolves nouns.

### `session`

- `start(opts)` — calls `assemble(builder.description, builder.registry)` to get
  `{ campaign, rooms }`, replicates `startSession`'s seating (construct each
  `PlayerCharacter`, `joinCampaign`, optional `selectArchetype`, move to the start
  room, set GM, `beginCampaign`), subscribes a forwarding handler to
  `campaign.onCue`, retains the `rooms` map and the campaign's **locked-door table**,
  and returns a `GameSession`. (It uses `assemble` rather than `startSession` because
  only `assemble` exposes the room map needed to reveal disconnected locked rooms.)
- `execute(intent)` — snapshots for undo; for a **time-advancing** intent it calls
  `activeCharacter.startTurn()` (which ticks `onTurnStart` mechanics like Dread),
  dispatches the intent to the matching engine call, then `campaign.nextPlayer()`
  (single-player → `endRound` → round++, win/lose/timeout check); **free** intents
  (open, equip, unequip, craft, light) execute directly with no `startTurn`/
  `nextPlayer`. An `unlock` intent looks the door up in the table, checks
  `inventory.keys` for the `keyCode`, and on a match `addExit`s both directions via
  the `rooms` map and `consumeKey`s. Returns the cues collected during execution; a
  thrown `ProceduralViolation` is caught and mapped to an in-voice failure.
- **Time-advancing intents:** move, take, drop, use, harvest, attack, unlock, wait.
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
- `exits`: list of `{ dir, toName }` for available directions (drives the compass).
- `lockedDoors`: locked-door entries whose `from` is the current room and whose
  exit `dir` is not yet present — each `{ id, name, dir }` so the parser can resolve
  "study door" and the compass can hint a locked way. (Derived from the door table +
  current `room.exits`.)
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
  `take`/`get`, `drop`, `open` (a loot box → the `open` Intent),
  `unlock` (a door → the `unlock` Intent; `open <door>` is a synonym),
  `attack`/`kill`/`hit`, `equip`/`wear`/`wield`, `unequip`/`remove`, `use`,
  `talk`/`ask`/`read` (dialogue / journal), `light`/`extinguish` (lantern),
  `harvest`, `craft`, `wait`/`z`. (`open` resolves by target type: a loot box →
  `open`; a locked door → `unlock`.)
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
- **Revealed exits**: a successful `unlock` reveals an exit via the session's
  `addExit`, which surfaces as a **viewmodel exit diff** — after each command the
  narrator compares the room's exits before/after and announces any newly-opened way
  ("With a grinding click, the way to the Study opens.").
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
6. The only engine (`src/`) change is the additive `CharacterView.hasItem` method
   (plus its test); all other new code is in `@wickedways/play`.
7. `pnpm checks` (lint + typecheck + test) passes, including the new package's tests.

## Future graphical UI

A `gui/` adapter would reuse `campaign/` and `core/` untouched: it renders the
viewmodel and cues visually, and produces the same `Intent`s from clicks/menus
instead of from typed text — no parser, no narrator. If `core/` needs to be shared
across two packages at that point, it is promoted to `@wickedways/play-core`; the
seam already exists, so the move is mechanical.
