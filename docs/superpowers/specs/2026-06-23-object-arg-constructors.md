# Plan: Object-argument constructors for domain entities

## Context

Domain-entity constructors use long positional argument lists — `Room` takes 10
positional params, the `Character` hierarchy threads `(campaign, name, stats,
inventorySlots, actionsPerRound, options)` through `super()`. Positional calls
are hard to read and easy to misorder. This refactor replaces positional
constructor arguments with a single **options object** per class.

Decisions (agreed):
- **Scope:** domain entities only. Skip sync / mechanics / serialization /
  authoring infra and error classes.
- **Required vs optional:** unchanged — a field is required in the object iff it
  has no default today; optional fields keep their current defaults, applied
  inside the constructor.
- **Compat:** replace positional entirely; no overloads.
- **Rollout:** one class at a time, `pnpm checks` green before moving on.

## Scope

Convert: `MaterialCache`, `EncounterTable`, `Loot`, `Item`, `PlayerCharacter`,
`NonPlayerCharacter`, `Mob`, `Combatant`/`Character` (base), `Room`, `Campaign`.

Out of scope: `Afflictions`, `CharacterEvents`, `HydrateContext`, everything
under `sync/`, `mechanics/`, `serialization/` (except hydrate factories that
call a converted constructor), `authoring/`, and the `Error` subclasses.

## Conventions

- Each class gets an exported interface `XOptions` (e.g. `RoomOptions`,
  `CampaignOptions`). Field names = current parameter names.
- Constructor becomes `constructor(opts: XOptions)`, destructures with the old
  defaults (`const { foo = 1 } = opts`), and keeps the body otherwise identical.
- The existing trailing `CharacterOptions` bag (`{ rng, afflictionConfig,
  presentation }`) is **absorbed** into the flat per-class character options; the
  standalone bag type is removed and references updated.
- Paired hydrate/serialize factories that call a converted constructor
  (`constructBareRoom`, `hydrateLoot`, `hydrateMaterialCache`, `hydrateItem`,
  `constructBareCharacter`, …) are updated to pass the object.
- Update README + TSDoc and the Getting Started guide wherever a converted
  constructor appears.

## Per-class shapes

- **MaterialCache** → `{ contents, presentation? }`
- **EncounterTable** → `{ rng, baseChance }`
- **Loot** → `{ description, contents, presentation? }`
- **Item** → `{ descriptor: ItemDescriptor, properties, actions, events }`
  (keeps `ItemDescriptor` as a nested field rather than flattening ~17 keys).
  Update `createKey` and any other `new Item(` factories.
- **Character / Combatant** (base) → `CharacterOptions =
  { campaign, name, stats, inventorySlots?, actionsPerRound?, rng?,
  afflictionConfig?, presentation? }`.
- **PlayerCharacter** → `{ campaign, name, stats, inventorySlots?, rng?,
  afflictionConfig?, presentation? }` (no `actionsPerRound`; super hardcodes 3).
- **NonPlayerCharacter** → `{ campaign, name, stats, initialDialogue,
  dialogueBlocks, rng?, afflictionConfig?, presentation? }`.
- **Mob** → `{ campaign, name, stats, inventorySlots?, actionsPerRound?, drops,
  baseEscapeChance?, materialDrops?, lightAverse?, rng?, … }`.
- **Room** → `{ name, description, loot, exits?, materials?, spawnModifier?,
  mobs?, presentation?, dark?, lightSources? }`.
- **Campaign** → `{ title, maxRounds?, knownRecipes?, rng?, baseEncounterChance?,
  actionSounds?, winConditions?, loseConditions?, timeoutNarration?,
  endedNarration?, chatPolicy?, avPolicy?, mechanics? }`.

## Order (each step is self-contained and ends green)

Bottom-up so each step's `super()`/factory dependencies are already stable.

1. **MaterialCache** (~2 non-test, ~18 test)
2. **EncounterTable** (~1, ~11)
3. **Loot** (~4, ~62)
4. **Item** (~2 + factories) — fold the 4 args into one object
5. **Character hierarchy**, leaves first so `super()` stays positional until the
   base flips, keeping each sub-step green:
   - a. **PlayerCharacter** (~5, ~54) — public ctor → object; `super(...)` stays positional
   - b. **NonPlayerCharacter** (~0, ~3)
   - c. **Mob** (~2, ~24)
   - d. **Combatant + Character base** (~0, ~41) — base ctor → object, rewrite
        the three `super(...)` calls to pass the object, remove the old
        `CharacterOptions` bag
6. **Room** (~5, ~77)
7. **Campaign** (~4, ~118) — fold `title`/`maxRounds`/`knownRecipes` into options

## Per-class mechanics

1. Define/extend `XOptions`; change the constructor to a single object param,
   destructuring with the current defaults; body unchanged.
2. Update the paired hydrate/serialize constructor call.
3. Update every `new X(` call site (non-test then test) to the object form.
4. Run `pnpm checks` — let `tsc` flag any missed site — and only advance when
   green.

## Verification

- `pnpm checks` green after **every** class (lint + typecheck across engine and
  all workspace packages + full vitest).
- Final pass: full `pnpm checks` + build and run the Getting Started example.
- Spot-check serialization round-trip tests (they exercise the hydrate paths).

## Risks / notes

- **Volume:** ~120 non-test + ~500 test call sites total. Mitigate with
  per-pattern find/replace and compiler-driven cleanup; the one-class cadence
  keeps each diff reviewable.
- **Character `super()` coupling** — handled by the leaf-first ordering.
- **`Campaign` and `Room`** carry the most test call sites; expect the largest
  per-step diffs there.
- **Naming:** `CharacterOptions` already exists as the trailing bag; it is
  subsumed by the new flat type of the same name.
