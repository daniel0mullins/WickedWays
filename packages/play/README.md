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
and actor, **not** the affected item's name or damage dealt. So confirmation text for
inventory-class actions (`take`/`drop`/`open`/`equip`/`unequip`/`use`/`wait`) and for combat
is synthesized in `Narrator.renderAction(intent, before, after)`, which reads names, item
details, and occupant **health** out of the before/after view models. `attack` reports the
damage dealt (`before.health − after.health`), announces a kill when the target becomes
`defeated`, and notes a glancing blow when nothing lands; `move` returns no synthetic line —
the room re-render speaks for it. Mechanic, encounter, visibility, and resolution cues are
rendered by `Narrator.renderCues`.

Defeated mobs are a `defeated` (KO) status, not removal — the engine keeps them in the room.
The play surface treats them as gone: they drop out of `You see …`, and re-attacking a corpse
is rejected (`"The Revenant is already dead."`). Their dropped loot (`"<name>'s remains"`)
still appears in the HUD to collect.

**Mob aggression.** The session acts as the *solo GM*: after any time-advancing action, each
live (non-KO) mob in the player's current room strikes back via the engine's `mob.attack(pc)`
(`session.runMobReactions`). Entering a mob's room costs you; fleeing out that turn is safe;
the killing blow draws no retaliation. The damage and its **stat** are read from the player's
effective-stat deltas and surfaced as typed feedback — *"The Wraith claws at your mind — you
lose 3 Sanity."* In the Hollow House, both mobs attack **Sanity** (the haunt preys on the
mind); the Heir's Energy is tuned to 5 so the Sanity-damage multiplier is 1.0 and a mob's
`power` lands as whole points (see the mitigation note in the engine README — Health attacks
can't land on the Sanity-16 Heir, so the threat is wholly a sanity drain). A mob can kill the
player: a fatal blow drops Sanity to 0 and the round's outcome check ends the game.

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
| `src/audio/` | Procedural Web Audio subsystem — pure cue→sound mapping (`cue-sound.ts`), Web Audio rendering (`synth.ts`), sanity-reactive ambient drone (`ambient.ts`), and the `AudioManager` orchestrator. See [**Audio**](#audio) below. |
| `src/campaign/` | The bundled **Hollow House** campaign: `index.ts` (template + registry), `content.ts` (intro/lore/keyed-door behaviors/aliases), `mechanics.ts` (`dread`, `storyteller`), `items.ts`, `ids.ts`. |

## Audio

The play surface generates all sound via **procedural Web Audio synthesis** — no shipped audio
assets, no licensing or bundle-size concerns. The approach fits the retro-CRT aesthetic and keeps
the mapping logic purely deterministic (separated from the Web Audio backend so it is
unit-testable under Vitest's `node` environment, which has no Web Audio API).

### Four SFX categories

| Category | Trigger |
|----------|---------|
| **Combat (strikes & death)** | `action` cue with `attack`/`takeDamage` kind; `MobAttack` from `session.runMobReactions`; a `resolution` win-sting / lose-fall on campaign end. |
| **Mob encounter** | `encounter` cue (first time the player meets a given mob). |
| **Item use / pickup** | `action` cue with `pickUp`/`drop` kind — a soft confirming blip via `playCue` (taking an item emits `pickUp`, dropping emits `drop`). |
| **Movement, lights & UI** | `action` cue with `move` kind (soft whoosh); `visibility` cue (light click); rejected command or parser error (short buzz). |

### Sanity-reactive ambient drone

A continuous low drone (layered oscillators through a low-pass filter) runs while audio is
enabled. `AmbientBed.setTension(t)` adjusts detune, filter brightness, and gain as `t` moves
from 0 to 1. Tension is computed by `sanityToTension(current, baseline)` — a ratio normalized
against the session's **high-water-mark** sanity so the drone is calm at a healthy baseline and
grows dissonant only as sanity degrades. Updated every turn from `refresh()`.

### Master toggle

A single button in the monitor bezel controls all audio (ambient + SFX together). Audio starts
**muted** on every page load and never plays without a user gesture — the toggle click is the
gesture that resumes the `AudioContext`. The preference is **in-memory** only (not persisted to
`localStorage`). If `AudioContext` is unavailable or blocked, the manager no-ops gracefully; the
game is unaffected.

### Integration seams (`src/audio/audio-manager.ts`)

```
cue from session.execute()   →  AudioManager.playCue(cue)
mob strike from runMobReactions →  AudioManager.playMobAttack(atk)
rejected command / error     →  AudioManager.noteError()
each turn in refresh()       →  AudioManager.update(view.status.sanity)
toggle click in ui.ts        →  AudioManager.setEnabled(on)
```

No `Math.random` is used — the slight pitch variation between instances is derived
deterministically from actor/entity id hashes (`detuneFactor` in `cue-sound.ts`).

## Command vocabulary

| Category | Commands |
|----------|----------|
| Move | `n` `s` `e` `w` `ne` `nw` `se` `sw` (and full names), `go <dir>`, `walk <dir>` |
| Look | `look` / `l`, `examine` / `x` / `read` `<thing>` |
| Items | `take` / `get`, `drop`, `equip` / `wear` / `wield` / `light`, `unequip` / `remove` / `extinguish`, `use`, `open <container>` |
| Combat | `attack` / `kill` / `hit` `<foe>` |
| Query | `inventory` / `i` / `inv`, `exits`, `help` / `?` |
| Meta | `save`, `restore` / `load`, `undo`, `restart`, `wait` / `z` |

Nouns resolve against everything currently in scope — room occupants, loot containers and
their contents, and carried items/keys — by name or alias (aliases defined per campaign in
`content.ts`). An unambiguous substring match is accepted; multiple matches prompt a
"which do you mean?" disambiguation.

**Reading items.** `examine`/`read`/`x <item>` reveals a held item's `lore` (its backstory
text) when it has any, falling back to the generic look line otherwise. This routes through
the engine's free, non-consuming `Character.read` (see `session.read`), so reading never
spends a turn or consumes the item. You read what you carry — examine an item still sitting
in a container gives only the generic line until you take it. In the bundled campaign, the
**Water-Stained Journal** carries the family's backstory; take it, then `read journal`.

**Restart.** `restart` re-boots the campaign to a fresh opening state (new world, start room,
turn 0, empty inventory). Because it wipes all progress with no undo, it **confirms first**:
the first `restart` prompts, a second `restart` performs it, and any other command cancels.
Saved games are untouched, and `restart` works after the game has ended (the natural "play
again"). It re-runs `GameSession.boot` from the stored builder — see `GameSession.restart`.

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

## Deployment (Coolify)

The play surface ships as a static bundle served by nginx, built by the multi-stage
[`Dockerfile`](./Dockerfile). Because the SPA bundles the `wickedways` engine straight from
TypeScript source through the pnpm workspace, **the Docker build context is the repo root**
(not this package directory) and there is no separate engine build step.

Build/run locally to mirror production:

```bash
# from the repo root
docker build -f packages/play/Dockerfile -t wickedways-play .
docker run --rm -p 8080:80 wickedways-play   # → http://localhost:8080
```

Coolify is configured for Git-push auto-deploy from this repository. Create/point the
application at these settings:

| Setting | Value |
|---------|-------|
| Build Pack | **Dockerfile** |
| Dockerfile Location | `/packages/play/Dockerfile` |
| Base Directory (build context) | `/` |
| Ports Exposed | `80` |
| Source | this GitHub repo, deploy on push |

No environment variables or runtime config are needed — the game is fully client-side.
Asset caching, gzip, and the SPA fallback live in [`nginx.conf`](./nginx.conf).
