# @wickedways/play

A browser **play surface** for the [`wickedways`](../../README.md) engine: a single-page,
keyboard-driven text adventure rendered as a retro CRT terminal. It bundles one playable
campaign — **The Hollow House** — and is the reference example of how to drive the engine
from a UI.

The engine itself (turn loop, combat, items, mobs, serialization) is documented in the
[root `README.md`](../../README.md). This package only covers the play surface that sits on
top of it.

## Quick start

```bash
pnpm --filter @wickedways/play dev        # Vite dev server (hot reload) at http://localhost:5173
pnpm --filter @wickedways/play build      # production bundle → dist/
pnpm --filter @wickedways/play typecheck  # tsc --noEmit
pnpm --filter @wickedways/play test:e2e   # Playwright end-to-end playthrough
```

Unit tests (`*.test.ts`) run as part of the repo-wide `pnpm test`; the Playwright e2e suite
in `e2e/` is separate and driven by `test:e2e`.

## How it works

The UI never touches engine internals directly. Each turn flows through a thin glue layer
that turns the live `Campaign` into a plain, serializable **view model**, and turns typed
commands into **intents** the session executes:

```
keypress ─▶ parse(input, viewModel) ─▶ ParseResult
                                         │
            ┌────────────────────────────┼─────────────────────────────┐
            ▼              ▼              ▼              ▼               ▼
          intent        query         examine          meta          error /
            │          (look/inv/    (no engine     (save/restore/   ambiguous
            │           exits/help)    call)            undo)         (printed)
            ▼
   session.execute(intent) ─▶ engine mutation ─▶ ExecuteResult { cues, error? }
            │
            ▼
   transcript ◀─ narrator.renderAction(intent, before, after) + narrator.renderCues(cues)
   HUD/status ◀─ refresh() reads session.view()  →  Here: / Carrying: / Exits: + status bar
```

Time-advancing intents (`move`, `take`, `drop`, `use`, `attack`, `wait`, `talk`) tick the
round and snapshot the pre-state so a single level of **undo** is available; queries,
`examine`, and meta commands do not advance time.

### Feedback model

The engine emits terse `PresentationCue`s — an `action` cue carries only the action *kind*
and actor, **not** the affected item's name. So confirmation text for inventory-class actions
(`take`/`drop`/`open`/`equip`/`unequip`/`use`/`wait`) is synthesized in
`Narrator.renderAction(intent, before, after)`, which reads item names out of the before/after
view models. `move` and `attack` return no synthetic line — the room re-render and combat cues
already speak for them. Mechanic, encounter, visibility, and resolution cues are rendered by
`Narrator.renderCues`.

The persistent bottom **HUD** (`Here:` loot, `Carrying:` inventory, `Exits:`) is redrawn from
`session.view()` every turn, so inventory and location state are always visible without a
query.

## Source layout

| Path | Responsibility |
|------|----------------|
| `src/main.ts` | Entry point — boots a `GameSession` for The Hollow House and mounts the terminal into `#app`. |
| `src/core/session.ts` | `GameSession`: boot, `execute`/`dispatch` (intent → engine calls), `save`/`restore`/`undo`. Catches `ProceduralViolation` and surfaces it as an `error`. |
| `src/core/intent.ts` | The `Intent` union and `isTimeAdvancing`. |
| `src/core/viewmodel.ts` | Derives a plain `ViewModel` (room, exits, locked doors, occupants, loot, inventory, scope, status) from the live `Campaign`. Classifies exits as passable vs. locked per the active character. |
| `src/core/savestore.ts` | `SaveStore` interface + `LocalStorageSaveStore` (slots persisted under `wickedways:save:<slot>`). |
| `src/text/parser.ts` | Natural-language command → `ParseResult`. Verb tables, direction aliases, noun resolution against the view-model scope (exact, then substring), ambiguity detection. |
| `src/text/narrator.ts` | Renders room text, action confirmations, cues, queries, and examine lines (pure → `string[]`). |
| `src/text/link-nouns.ts` | Tokenizes a line into plain + clickable noun segments (longest-phrase-first, word-boundary aware) for the "click a noun to `examine` it" affordance. |
| `src/text/ui.ts` | The DOM terminal: CRT housing/overlay styling, welcome screen, typewriter, command history, clickable exits/nouns, HUD, and the submit→parse→render loop. |
| `src/campaign/` | The bundled **Hollow House** campaign: `index.ts` (template + registry), `content.ts` (intro/lore/keyed-door behaviors/aliases), `mechanics.ts` (`dread`, `storyteller`), `items.ts`, `ids.ts`. |

## Command vocabulary

| Category | Commands |
|----------|----------|
| Move | `n` `s` `e` `w` `ne` `nw` `se` `sw` (and full names), `go <dir>`, `walk <dir>` |
| Look | `look` / `l`, `examine` / `x` `<thing>` |
| Items | `take` / `get`, `drop`, `equip` / `wear` / `wield` / `light`, `unequip` / `remove` / `extinguish`, `use`, `open <container>` |
| Combat | `attack` / `kill` / `hit` `<foe>` |
| Query | `inventory` / `i` / `inv`, `exits`, `help` / `?` |
| Meta | `save`, `restore` / `load`, `undo`, `wait` / `z` |

Nouns resolve against everything currently in scope — room occupants, loot containers and
their contents, and carried items/keys — by name or alias (aliases defined per campaign in
`content.ts`). An unambiguous substring match is accepted; multiple matches prompt a
"which do you mean?" disambiguation.

## The Hollow House (bundled campaign)

A nine-room haunted estate played as the **Heir** archetype.

- **Goal:** reach the **Attic** carrying the **journal** (found in the Foyer drawer).
- **Lose** if Sanity hits 0, the party is downed, or the 150-round clock runs out.
- **Dread:** Sanity drains by 1 each round unless a lit **lantern** is equipped.
- **Keyed doors:** the **brass key** (dropped by the Wraith in the Nursery) opens the Study;
  the **iron key** (dropped by the Revenant in the Cellar) opens the Attic. Walk into a locked
  door while carrying its key to open it.
- **Storyteller:** entering a room while carrying the journal reveals a one-time lore fragment.

See `src/campaign/index.ts` for the full room graph, loot, mobs, and win/lose conditions.

## Testing

- **Unit** — co-located `*.test.ts` covering the parser, narrator, view model, session,
  save store, and campaign wiring.
- **End-to-end** — `e2e/playthrough.spec.ts` drives a full winning run in a real browser
  (welcome screen → loot → combat → save/undo → win), plus checks for the clickable-exit and
  clickable-noun affordances. Run with `pnpm --filter @wickedways/play test:e2e`.
