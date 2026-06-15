# Presentation Assets & Cues — Design

**Date:** 2026-06-15
**Status:** Approved (pending implementation plan)

## Summary

Give the pure-logic engine the data and signals a future **Play Surface** (renderer +
audio host) needs, without building the surface itself. Two cooperating pieces:

1. **Presentation metadata** — an optional, opaque `presentation: { image?, sound? }`
   descriptor attached to every renderable/audible entity. The host reads `image`
   when it renders the surface.
2. **A presentation cue stream** — a push observer on the `Campaign` that emits typed
   cues (action and encounter) the moment they happen, each carrying a **resolved**
   sound for the host to play.

Images are **state** (read on render); sounds are **events** (delivered as cues). The
engine never loads, validates, or plays an asset — references are opaque strings the
host interprets.

## Motivation

The engine models a horror campaign but exposes nothing for a presentation layer to
draw or sound. Authors want to attach a portrait to a mob, a backdrop to a room, a
growl to a hobgoblin, coins to a chest, and marching to movement — and have a host be
told *what* to show and *when* to play it.

## Scope

### In scope

- An optional `Presentation` descriptor (`image?`, `sound?`) on presentable entities:
  `Character` (and its subclasses `Mob`/`PlayerCharacter`/`NonPlayerCharacter`),
  `Room`, `Item`, `Loot`, and `MaterialCache`.
- A `PresentationCue` discriminated union: `action` cues and `encounter` cues.
- A campaign-level push observer: `onCue` / `offCue`, with an engine-internal,
  symbol-guarded emit.
- Hybrid sound resolution: involved-entity sound, else a campaign default for the
  action kind, else none.
- A campaign-level `actionSounds` default map for generic actions (e.g. `move`).

### Out of scope (YAGNI)

- The Play Surface / renderer / audio playback itself (does not exist in this repo).
- Asset loading, validation, formats, or bundling.
- Per-entity multi-state art (idle vs. KO sprites), animations, volume/pan, looping.
- `Scene` and `Archetype` presentation (`Scene` is a trigger, not a surface object;
  `Archetype` is a descriptor, not an instance).
- A pull/queryable cue buffer (delivery is push-only).

## Design decisions (from brainstorming)

| Decision | Choice |
|----------|--------|
| Engine responsibility | Asset references **and** a runtime cue stream (the "what" and the "when"). |
| Asset attachment | One shared `presentation` descriptor via constructor options; opaque `AssetRef` string. |
| Action sound resolution | **Hybrid** — involved-entity sound wins; campaign action-kind default fills the gap; else none. |
| Cue delivery | **Push** — `Campaign.onCue` / `offCue`, fired synchronously; no engine buffer. |
| Image vs. sound | Images are state (read on render); sounds are events (carried by cues). |
| Mob encounter sound | Fires **once, on a character's first encounter** with that mob. |
| Pickup sound owner | The **container** (`Loot` box) owns the pickup sound. |
| Spec shape | A single cohesive spec (metadata + cues). |

## Components

### 1. `Presentation` descriptor — new file `src/lib/presentation.ts`

```ts
/** Host-interpreted reference to an asset (path, URL, or key). Opaque to the engine. */
export type AssetRef = string;

/** Optional presentation metadata attached to a renderable/audible entity. */
export interface Presentation {
  /** Image shown when the entity is rendered on the Play Surface. */
  image?: AssetRef;
  /** The entity's signature sound, used to resolve cue audio. */
  sound?: AssetRef;
}
```

The `PresentationCue` types also live here (so the cue and the metadata share one
module):

```ts
import type { ActionDetail } from "./character/history";

/** Minimal identity for an entity referenced by a cue. */
export interface EntityRef {
  id: string;
  name: string;
}

/** The action kinds an action cue can carry — the kinds of {@link ActionDetail}. */
export type ActionKind = ActionDetail["kind"];

/**
 * A presentation event emitted by the campaign. `sound` is pre-resolved by the
 * engine (entity sound → campaign default → undefined); the host plays it if set.
 */
export type PresentationCue =
  | { kind: "action"; action: ActionKind; actor: EntityRef; sound?: AssetRef }
  | { kind: "encounter"; mob: EntityRef; room: EntityRef; sound?: AssetRef };
```

`ActionKind` is derived from the existing `ActionDetail` union so the two never drift.

### 2. Presentation on entities

Each presentable entity accepts an optional `presentation?: Presentation` (via its
existing options object or a new optional constructor parameter, matching each class's
current convention) and exposes:

```ts
get presentation(): Presentation | undefined;
```

The stored value is held privately and returned as-is (opaque). No defaulting, no
merging. Entities: `Character` (base — inherited by all character subclasses), `Room`,
`Item`, `Loot`, `MaterialCache`.

For `Character`, the field lives on the base class so every subclass inherits it; the
constructor option threads through `Combatant`/`PlayerCharacter`/`Mob`/`NonPlayerCharacter`
the same way `rng`/`afflictionConfig` already do (appended to the existing `options`
object, so no positional-parameter churn).

### 3. Cue observer on `Campaign`

Mirrors the existing `CharacterEvents` add/remove pattern, but campaign-scoped:

```ts
// ICampaign
/** Subscribes a handler to the presentation cue stream. */
onCue: (handler: (cue: PresentationCue) => void) => void;
/** Removes a previously-subscribed cue handler. */
offCue: (handler: (cue: PresentationCue) => void) => void;
/** Emits a cue to all subscribers. Engine-internal; see EMIT_CUE. */
[EMIT_CUE]: (cue: PresentationCue) => void;
```

- `#cueHandlers: Array<(cue: PresentationCue) => void>` backing field.
- `EMIT_CUE` is a new exported `Symbol` (in `presentation.ts` or alongside the other
  inventory seams), so only engine code can publish cues — external code cannot inject
  fakes. Subscription (`onCue`/`offCue`) is public.
- Emission is synchronous: each handler is invoked in registration order. A throwing
  handler must not corrupt engine state or prevent other handlers from running — the
  emit wraps each handler call so one bad subscriber cannot break the turn loop
  (errors are swallowed at the boundary; the engine has no logger, and a presentation
  handler's failure is not a game-rule violation).

### 4. Sound resolution (hybrid)

The `Campaign` holds an optional default map, set at construction:

```ts
// constructor options
actionSounds?: Partial<Record<ActionKind, AssetRef>>;
```

A single helper resolves a cue's sound:

```
resolveSound(entitySound: AssetRef | undefined, action: ActionKind): AssetRef | undefined
  = entitySound ?? this.#actionSounds[action]
```

For an **encounter** cue, the resolved sound is simply the mob's
`presentation?.sound` (no action-kind default — encounters are entity-owned; if the
mob has no sound, the cue's `sound` is `undefined`).

### 5. Emission points

**Action cues — in `Character.recordAction`.** Every action already funnels through
`recordAction(callingFn, detail)`. After the history entry is pushed, the character
emits one action cue via `this.campaign[EMIT_CUE]({...})`:

- `action` = `detail.kind`.
- `actor` = `{ id: this.id, name: this.name }`.
- `sound` is resolved per the hybrid rule. `recordAction` computes the **involved-entity
  sound** as the actor's own `presentation?.sound` by default, then asks the campaign to
  apply the action-kind default fallback. So most kinds resolve actor-sound →
  `actionSounds[kind]` → undefined (e.g. `move → marching` when the character has no
  movement sound).
  - **Loot-box pickups/drops resolve the container's sound instead of the actor's.**
    `takeFromLootBox` / `putInLootBox` record their action through the inner
    `addToInventory` / `removeFromInventory` call (wrapped in `withGateSuppressed`), and
    `recordAction` is what emits the cue — so the container's sound is supplied via a
    transient override, mirroring the existing `#suppressGate` mechanism: a
    `withCueSound(sound, fn)` helper sets a private `#cueSoundOverride` for the duration
    of `fn`, and `recordAction` uses that override (when set) as the entity sound for the
    cue it emits. The loot-box methods wrap their suppressed inventory call in
    `withCueSound(box.presentation?.sound, …)`. Plain `addToInventory` pickups (no
    container) leave the override unset and fall back to the actor sound → campaign
    default.

To keep `recordAction` lean, it computes the entity sound (override ?? actor sound) and
delegates the campaign-default fallback to the campaign's resolution helper (§4).

**Encounter cues — on player room entry, first encounter only.** When a
`PlayerCharacter` enters a room (the existing `PlayerCharacter.move` override, after
`super.move` and the `maybeSpawn` check), the engine scans the room's occupants for
active (non-KO) mobs. For each such mob the **first time** that specific character
encounters that specific mob, it emits an `encounter` cue and records the pair as seen.

- "First encounter" dedup is per `(characterId, mobId)` pair, tracked on the campaign
  in a `Set<string>` keyed `"${characterId}:${mobId}"`. Re-entering the room, or the
  mob leaving and returning, does not replay the cue for that character. A *different*
  character encountering the same mob is that character's first encounter and fires.
- Because spawning happens inside `move` (via `maybeSpawn`) before the scan, this one
  rule covers both freshly **spawned** encounters and pre-seated **resident** mobs.
- A mob is identified as a non-party occupant whose status does not include KO
  (reusing the `partyIds`/active-mob logic already in `EncounterTable.maybeSpawn`).

## Data flow

```
authoring/setup:
  new Mob(campaign, "Hobgoblin", stats, …, { presentation: { image: "hob.png", sound: "growl.ogg" } })
  new Loot("chest", […], { presentation: { sound: "coins.ogg" } })
  new Campaign("…", …, { actionSounds: { move: "marching.ogg" } })
  campaign.onCue(cue => host.handle(cue))     // host subscribes once

render (host, state-driven):
  for each entity in the current room: read entity.presentation?.image → draw

play (engine, event-driven):
  pc.move(room)
    → super.move → records "move" action
        → recordAction → campaign[EMIT_CUE]({ kind:"action", action:"move",
             actor, sound: pc.presentation?.sound ?? actionSounds.move })   // marching
    → maybeSpawn may place mobs
    → scan occupants: for each active mob not yet encountered by pc →
        campaign[EMIT_CUE]({ kind:"encounter", mob, room, sound: mob.presentation?.sound })  // growl, once
  pc.takeFromLootBox(chest, item)
    → records "pickUp"; emit overrides entity sound with chest.presentation?.sound      // coins
```

## Error handling

- Asset refs are opaque: no validation, no throwing on missing/invalid refs.
- Cue emission never throws into the turn loop: a subscriber that throws is isolated so
  other subscribers still run and engine state is unaffected.
- `onCue`/`offCue` are tolerant: `offCue` with an unknown handler is a no-op;
  double-subscribe is the caller's concern (handlers are stored as given).
- No new `ProceduralViolation`s — this feature adds presentation signals, not game-rule
  guards.

## Security / integrity model

- `presentation` is stored privately and exposed through a getter; it is set only at
  construction (no public setter), consistent with the engine's hidden-state discipline.
- Cue **publication** is gated behind the `EMIT_CUE` symbol so only engine code can emit
  cues; **subscription** is public. This mirrors the existing symbol-seam pattern
  (`DEPOSIT_MATERIALS`, `PLACE`, etc.).
- The first-encounter set is private campaign state with no external mutator.

## Testing strategy

- **`src/lib/presentation.test.ts`** — `Presentation`/`PresentationCue`/`AssetRef`
  shape is a pure type; covered via consumers. `ActionKind` stays in sync with
  `ActionDetail` (a compile-time assertion / representative-kind test).
- **Per-entity** (`mob`, `room`, `inventory`, `loot`, `material-cache`,
  `non-player-character` tests) — the `presentation` getter returns what was supplied
  and `undefined` when omitted.
- **`src/lib/campaign.test.ts`** — `onCue`/`offCue` subscribe and unsubscribe;
  `EMIT_CUE` invokes all handlers in order; a throwing handler does not stop the others;
  sound resolution precedence (entity sound > `actionSounds` default > undefined).
- **`src/lib/character/character.test.ts`** — `recordAction` emits one action cue per
  recorded action with the right `action`/`actor`; actor-sound and campaign-default
  resolution.
- **`src/lib/character/player-character.test.ts`** — loot-box take/put resolves the
  **container's** sound on the cue; encounter cues fire on room entry for both spawned
  and resident mobs, and fire **once per (character, mob)** — re-entry does not replay,
  a second character does fire.
- **`src/integration.test.ts`** — subscribe a recording handler, run a few turns
  (move, encounter, loot), and assert the ordered cue sequence and resolved sounds.

All randomness already routes through injected `rng`; cues add none, so deterministic
tests are unaffected.

## Documentation

Per the project convention (update README + TSDoc after a feature), add a
"Presentation assets & cues" section to `README.md` (how `presentation` attaches, how
`onCue` works, and the hybrid sound resolution incl. first-encounter and
container-owned-pickup rules), and TSDoc on the new `presentation.ts` types,
`Campaign.onCue`/`offCue`, and the `actionSounds` option.
