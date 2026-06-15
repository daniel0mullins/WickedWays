# Presentation Assets & Cues Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the pure-logic engine optional presentation metadata (image/sound) on entities and a push cue stream on the campaign, so a future Play Surface knows what to render and what to play, and when.

**Architecture:** A shared opaque `Presentation` descriptor attaches to each presentable entity (read on render). A `PresentationCue` push stream on `Campaign` (`onCue`/`offCue`, symbol-guarded emit) fires `action` cues from `Character.recordAction` and `encounter` cues on player room entry (first encounter per character/mob). Sounds resolve hybrid: involved-entity sound, else a campaign action-kind default, else none.

**Tech Stack:** TypeScript (strict, NodeNext), Vitest. No new dependencies.

---

## Reference: spec

`docs/superpowers/specs/2026-06-15-presentation-assets-and-cues-design.md`

## File Structure

- **Create** `src/lib/presentation.ts` — `AssetRef`, `Presentation`, `EntityRef`, `ActionKind`, `PresentationCue`, and the `EMIT_CUE` / `NOTE_ENCOUNTERS` symbol seams. One cohesive module for the feature's shared types.
- **Modify** `src/lib/character/character.ts` — `CharacterOptions` type; `presentation` field + getter; `#cueSoundOverride` + `withCueSound`; action-cue emission in `recordAction`.
- **Modify** `src/lib/character/combatant.ts`, `player-character.ts`, `mob.ts`, `non-player-character.ts` — thread `CharacterOptions`; PC loot-box container-sound override; PC `move` encounter scan.
- **Modify** `src/lib/room.ts`, `src/lib/inventory.ts` (Item), `src/lib/loot.ts`, `src/lib/material-cache.ts` — `presentation` option + getter.
- **Modify** `src/lib/campaign.ts` — `onCue`/`offCue`, `#cueHandlers`, `#actionSounds`, `#encountered`, `[EMIT_CUE]`, `[NOTE_ENCOUNTERS]`, `actionSounds` constructor option.
- **Modify** `src/test-utils.ts` — add no-op cue seams to the `makeCampaign()` stub.
- **Tests:** `presentation` getters per entity; `campaign.test.ts` (cue infra + resolution); `character.test.ts` (action cue from recordAction); `player-character.test.ts` (container sound + encounter dedup); `integration.test.ts` (end-to-end cue sequence).

## Testing note

`src/lib/presentation.ts` is mostly pure types plus two `Symbol` values. There is no standalone `presentation.test.ts`; the types and symbols are exercised by their consumers (campaign cue tests, character/PC cue tests, per-entity getter tests). This mirrors the archetype-descriptor decision in the prior feature.

---

## Task 1: Presentation types and symbols

**Files:**
- Create: `src/lib/presentation.ts`

Pure type + symbol definitions; validated by the compiler and downstream consumers.

- [ ] **Step 1: Create the file**

Create `src/lib/presentation.ts`:

```ts
import type { ActionDetail } from "./character/history";

/** Host-interpreted reference to an asset (path, URL, or key). Opaque to the engine. */
export type AssetRef = string;

/** Optional presentation metadata attached to a renderable/audible entity. */
export interface Presentation {
  /** Image shown when the entity is rendered on the Play Surface. */
  image?: AssetRef;
  /** The entity's signature sound, used to resolve cue audio. */
  sound?: AssetRef;
}

/** Minimal identity for an entity referenced by a cue. */
export interface EntityRef {
  id: string;
  name: string;
}

/** The action kinds an action cue can carry — kept in sync with {@link ActionDetail}. */
export type ActionKind = ActionDetail["kind"];

/**
 * A presentation event emitted by the campaign. `sound` is pre-resolved by the
 * engine (entity sound → campaign default → undefined); the host plays it if set.
 */
export type PresentationCue =
  | { kind: "action"; action: ActionKind; actor: EntityRef; sound?: AssetRef }
  | { kind: "encounter"; mob: EntityRef; room: EntityRef; sound?: AssetRef };

/**
 * Engine-internal seam for publishing a cue to the campaign's subscribers.
 * Subscription (`onCue`/`offCue`) is public; publication is gated so external
 * code cannot inject fake cues.
 */
export const EMIT_CUE = Symbol("emitCue");

/**
 * Engine-internal seam: scan a room a character just entered and emit a one-time
 * `encounter` cue per active mob the character has not encountered before.
 */
export const NOTE_ENCOUNTERS = Symbol("noteEncounters");
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors). `ActionDetail` is exported from `src/lib/character/history.ts` — confirm the import resolves.

- [ ] **Step 3: Commit**

```bash
git add src/lib/presentation.ts
git commit -m "feat: add presentation types and cue symbols"
```

---

## Task 2: Presentation on the character family

**Files:**
- Modify: `src/lib/character/character.ts`
- Modify: `src/lib/character/combatant.ts`
- Modify: `src/lib/character/player-character.ts`
- Modify: `src/lib/character/mob.ts`
- Modify: `src/lib/character/non-player-character.ts`
- Test: `src/lib/character/mob.test.ts`

- [ ] **Step 1: Write a failing test**

In `src/lib/character/mob.test.ts`, add `import type { Presentation } from "../presentation";` to the imports, and add this test inside the top-level `describe("Mob", ...)`:

```ts
  describe("presentation", () => {
    it("exposes the supplied presentation and is undefined when omitted", () => {
      const campaign = makeCampaign();
      const pres: Presentation = { image: "hob.png", sound: "growl.ogg" };
      const withPres = new Mob(campaign, "Hobgoblin", makeStats(), 2, 2, [], {
        presentation: pres,
      });
      const without = new Mob(campaign, "Rat", makeStats(), 2, 2, []);

      expect(withPres.presentation).toBe(pres);
      expect(without.presentation).toBeUndefined();
    });
  });
```

`makeCampaign`, `makeStats`, `Mob` are already imported in `mob.test.ts` — confirm and add any missing.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/character/mob.test.ts -t "presentation"`
Expected: FAIL — `presentation` does not exist on `Mob`, and the options object rejects `presentation`.

- [ ] **Step 3: Add `CharacterOptions`, the field, and the getter to `Character`**

In `src/lib/character/character.ts`:

Add to the imports:

```ts
import type { Presentation } from "../presentation";
```

Add an exported options interface near the top (after the existing type aliases like `ActionFn`):

```ts
/** Constructor options shared by every character. */
export interface CharacterOptions {
  /** Injected randomness for deterministic tests. */
  rng?: () => number;
  /** Overrides the default affliction thresholds/roll config. */
  afflictionConfig?: AfflictionConfig;
  /** Optional presentation metadata (image/sound) for the Play Surface. */
  presentation?: Presentation;
}
```

In `interface ICharacter`, add (near the other getters, e.g. after `get inventory()`):

```ts
  /** Optional presentation metadata (image/sound), or `undefined` if none. */
  get presentation(): Presentation | undefined;
```

In `class Character`, add the backing field with the other private fields (near `#inventory`):

```ts
  #presentation?: Presentation;
```

Add the getter (near the `inventory` getter):

```ts
  get presentation(): Presentation | undefined {
    return this.#presentation;
  }
```

Change the constructor's `options` parameter type from the inline `{ rng?: ...; afflictionConfig?: ... }` to `CharacterOptions`:

```ts
    options: CharacterOptions = {},
```

And store the value at the end of the constructor body (after the existing `this.#afflictions = ...` assignment):

```ts
    this.#presentation = options.presentation;
```

- [ ] **Step 4: Thread `CharacterOptions` through the subclasses**

In `src/lib/character/combatant.ts`: change the constructor `options` type to `CharacterOptions` and update the import.
- Replace `import type { AfflictionConfig } from "./afflictions";` usage: add `import type { CharacterOptions } from "./character";` and change the constructor signature's options to `options: CharacterOptions = {}`. (Leave the `super(...)` call as-is — it already forwards `options`.) If `AfflictionConfig` is now unused in this file, remove its import.

In `src/lib/character/player-character.ts`: same change — `import type { CharacterOptions } from "./character";`, constructor `options: CharacterOptions = {}`, forward unchanged. Remove the now-unused `AfflictionConfig` import if present.

In `src/lib/character/mob.ts`: change the inline options type to intersect `CharacterOptions`:

```ts
    options: CharacterOptions & {
      baseEscapeChance?: number;
      materialDrops?: MaterialMap;
    } = {},
```

Add `import type { CharacterOptions } from "./character";` and remove the standalone `AfflictionConfig` import if it becomes unused. The `super(..., options)` call already forwards the (now wider) options object.

In `src/lib/character/non-player-character.ts`: the constructor currently has no options parameter. Add one and forward it:

```ts
  constructor(
    campaign: ICampaign,
    name: string,
    stats: Stats,
    initialDialogue: string,
    dialogueBlocks: IDialogue[],
    options: CharacterOptions = {},
  ) {
    super(campaign, name, stats, 5, 3, options);
    this.initialDialogue = initialDialogue;
    this.#dialogueBlocks = dialogueBlocks;
    this.#matchers = dialogueBlocks.map((block) =>
      this.#normalizeMatcher(block),
    );
  }
```

Add `import type { CharacterOptions } from "./character";` to `non-player-character.ts`. (5 and 3 are the Character defaults for `inventorySlots`/`actionsPerRound`, preserving today's behavior.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/lib/character/mob.test.ts -t "presentation"`
Expected: PASS.

- [ ] **Step 6: Run the affected suites and typecheck**

Run: `npx vitest run src/lib/character/ && npm run typecheck`
Expected: PASS — threading `CharacterOptions` is additive; existing tests are unaffected.

- [ ] **Step 7: Commit**

```bash
git add src/lib/character/character.ts src/lib/character/combatant.ts src/lib/character/player-character.ts src/lib/character/mob.ts src/lib/character/non-player-character.ts src/lib/character/mob.test.ts
git commit -m "feat: presentation metadata on the character family"
```

---

## Task 3: Presentation on Room, Item, Loot, MaterialCache

**Files:**
- Modify: `src/lib/room.ts`, `src/lib/inventory.ts`, `src/lib/loot.ts`, `src/lib/material-cache.ts`
- Test: `src/lib/loot.test.ts`, `src/lib/material-cache.test.ts`, `src/lib/room.test.ts`, `src/lib/inventory.test.ts`

- [ ] **Step 1: Write failing tests**

In `src/lib/loot.test.ts`, add `import type { Presentation } from "./presentation";` and:

```ts
  it("exposes supplied presentation and is undefined when omitted", () => {
    const pres: Presentation = { sound: "coins.ogg" };
    expect(new Loot("chest", [], pres).presentation).toBe(pres);
    expect(new Loot("plain", []).presentation).toBeUndefined();
  });
```

In `src/lib/material-cache.test.ts`, add `import type { Presentation } from "./presentation";` and:

```ts
  it("exposes supplied presentation and is undefined when omitted", () => {
    const pres: Presentation = { image: "ore.png" };
    expect(new MaterialCache({ metal: 1 }, pres).presentation).toBe(pres);
    expect(new MaterialCache({ metal: 1 }).presentation).toBeUndefined();
  });
```

In `src/lib/room.test.ts`, add `import type { Presentation } from "./presentation";` and (use the file's existing `ExitsArg` cast helper for the `exits` param):

```ts
  it("exposes supplied presentation and is undefined when omitted", () => {
    const pres: Presentation = { image: "hall.png" };
    const withPres = new Room("Hall", "A hall", [], {} as ExitsArg, [], 1, [], pres);
    const without = new Room("Cell", "A cell", [], {} as ExitsArg);
    expect(withPres.presentation).toBe(pres);
    expect(without.presentation).toBeUndefined();
  });
```

In `src/lib/inventory.test.ts`, add `import type { Presentation } from "./presentation";` and a test that constructs an `Item` with a `presentation` field in its descriptor and asserts the getter returns it, plus `undefined` when omitted. Use the file's existing Item-construction pattern; add `presentation: { image: "sword.png" }` to the descriptor object for the "with" case.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/loot.test.ts src/lib/material-cache.test.ts src/lib/room.test.ts src/lib/inventory.test.ts -t "presentation"`
Expected: FAIL — `presentation` getter missing / extra constructor arg rejected.

- [ ] **Step 3: Implement `Loot`**

In `src/lib/loot.ts`: add `import type { Presentation } from "./presentation";`. Add to `interface ILoot`:

```ts
  /** Optional presentation metadata (image/sound), or `undefined` if none. */
  get presentation(): Presentation | undefined;
```

Add the field + getter to the class and accept a third constructor parameter:

```ts
  #presentation?: Presentation;

  get presentation(): Presentation | undefined {
    return this.#presentation;
  }
```

```ts
  constructor(description: string, contents: IItem[], presentation?: Presentation) {
    if (contents.some((item) => item.type === "key")) {
      throw new ProceduralViolation("Keys cannot be stored in a loot container.");
    }
    this.id = generateId<LootId>();
    this.description = description;
    this.contents = contents;
    this.#capacity = contents.length + 2;
    this.#presentation = presentation;
    for (const item of contents) {
      item[CLAIM](this);
    }
  }
```

- [ ] **Step 4: Implement `MaterialCache`**

In `src/lib/material-cache.ts`: add `import type { Presentation } from "./presentation";`. Add to `interface IMaterialCache`:

```ts
  /** Optional presentation metadata (image/sound), or `undefined` if none. */
  get presentation(): Presentation | undefined;
```

Add the field + getter and a second constructor parameter:

```ts
  #presentation?: Presentation;

  get presentation(): Presentation | undefined {
    return this.#presentation;
  }
```

```ts
  constructor(contents: MaterialMap, presentation?: Presentation) {
    this.id = generateId<MaterialCacheId>();
    this.#contents = { ...contents };
    this.#presentation = presentation;
  }
```

- [ ] **Step 5: Implement `Room`**

In `src/lib/room.ts`: add `import type { Presentation } from "./presentation";`. Add to `interface IRoom`:

```ts
  /** Optional presentation metadata (image/sound), or `undefined` if none. */
  get presentation(): Presentation | undefined;
```

Add the field + getter and an eighth constructor parameter (after `mobs`):

```ts
  #presentation?: Presentation;

  get presentation(): Presentation | undefined {
    return this.#presentation;
  }
```

```ts
  constructor(
    name: string,
    description: string,
    loot: ILoot[],
    exits: Record<Direction, IRoom>,
    materials: IMaterialCache[] = [],
    spawnModifier: number = 1,
    mobs: IMob[] = [],
    presentation?: Presentation,
  ) {
```

Assign `this.#presentation = presentation;` in the body (e.g. right after `this.spawnModifier = spawnModifier;`, before the `mobs` loop).

- [ ] **Step 6: Implement `Item`**

In `src/lib/inventory.ts`: add `import type { Presentation } from "./presentation";`. Add `presentation?: Presentation` to the `Item` constructor's descriptor object — both the destructuring list and its inline type. Add the field + getter, and to `interface IItem` add:

```ts
  /** Optional presentation metadata (image/sound), or `undefined` if none. */
  get presentation(): Presentation | undefined;
```

In the class:

```ts
  #presentation?: Presentation;

  get presentation(): Presentation | undefined {
    return this.#presentation;
  }
```

In the constructor body, assign `this.#presentation = presentation;` alongside the other field assignments.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run src/lib/loot.test.ts src/lib/material-cache.test.ts src/lib/room.test.ts src/lib/inventory.test.ts -t "presentation"`
Expected: PASS.

- [ ] **Step 8: Typecheck and full suites for these files**

Run: `npm run typecheck && npx vitest run src/lib/loot.test.ts src/lib/material-cache.test.ts src/lib/room.test.ts src/lib/inventory.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/room.ts src/lib/inventory.ts src/lib/loot.ts src/lib/material-cache.ts src/lib/loot.test.ts src/lib/material-cache.test.ts src/lib/room.test.ts src/lib/inventory.test.ts
git commit -m "feat: presentation metadata on rooms, items, loot, and caches"
```

---

## Task 4: Campaign cue infrastructure

**Files:**
- Modify: `src/lib/campaign.ts`
- Test: `src/lib/campaign.test.ts`

- [ ] **Step 1: Write failing tests**

In `src/lib/campaign.test.ts`, add imports: `import { EMIT_CUE } from "./presentation"; import type { PresentationCue } from "./presentation";`. Add this block inside `describe("Campaign", ...)`:

```ts
  describe("cue stream", () => {
    it("delivers an emitted cue to subscribers and stops after offCue", () => {
      const campaign = new Campaign("C");
      const seen: PresentationCue[] = [];
      const handler = (cue: PresentationCue) => seen.push(cue);

      campaign.onCue(handler);
      campaign[EMIT_CUE]({ kind: "encounter", mob: { id: "m1", name: "Imp" }, room: { id: "r1", name: "Cell" }, sound: "screech.ogg" });
      campaign.offCue(handler);
      campaign[EMIT_CUE]({ kind: "encounter", mob: { id: "m2", name: "Rat" }, room: { id: "r1", name: "Cell" } });

      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ kind: "encounter", sound: "screech.ogg" });
    });

    it("fills an action cue's missing sound from the campaign default map", () => {
      const campaign = new Campaign("C", 100, [], { actionSounds: { move: "marching.ogg" } });
      const seen: PresentationCue[] = [];
      campaign.onCue((cue) => seen.push(cue));

      campaign[EMIT_CUE]({ kind: "action", action: "move", actor: { id: "p1", name: "Hero" } });
      campaign[EMIT_CUE]({ kind: "action", action: "move", actor: { id: "p1", name: "Hero" }, sound: "tiptoe.ogg" });

      expect(seen[0]).toMatchObject({ action: "move", sound: "marching.ogg" }); // default applied
      expect(seen[1]).toMatchObject({ action: "move", sound: "tiptoe.ogg" });   // explicit wins
    });

    it("isolates a throwing subscriber so others still receive the cue", () => {
      const campaign = new Campaign("C");
      const seen: PresentationCue[] = [];
      campaign.onCue(() => { throw new Error("bad handler"); });
      campaign.onCue((cue) => seen.push(cue));

      expect(() =>
        campaign[EMIT_CUE]({ kind: "encounter", mob: { id: "m", name: "M" }, room: { id: "r", name: "R" } }),
      ).not.toThrow();
      expect(seen).toHaveLength(1);
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/campaign.test.ts -t "cue stream"`
Expected: FAIL — `onCue`/`offCue`/`campaign[EMIT_CUE]` undefined; `actionSounds` option unrecognized.

- [ ] **Step 3: Implement the cue infrastructure**

In `src/lib/campaign.ts`:

Add imports:

```ts
import { EMIT_CUE } from "./presentation";
import type { ActionKind, AssetRef, PresentationCue } from "./presentation";
```

In `interface ICampaign`, under `// ### Methods`, add:

```ts
  /** Subscribes a handler to the presentation cue stream. */
  onCue: (handler: (cue: PresentationCue) => void) => void;
  /** Removes a previously-subscribed cue handler (no-op if not subscribed). */
  offCue: (handler: (cue: PresentationCue) => void) => void;
  /** Publishes a cue to subscribers. Engine-internal; see {@link EMIT_CUE}. */
  [EMIT_CUE]: (cue: PresentationCue) => void;
```

In `class Campaign`, add the backing fields (near `#knownRecipes`):

```ts
  #cueHandlers: Array<(cue: PresentationCue) => void> = [];
  #actionSounds: Partial<Record<ActionKind, AssetRef>>;
```

Extend the constructor's `options` type and store the map. Change the options parameter type to:

```ts
    options: {
      rng?: () => number;
      baseEncounterChance?: number;
      actionSounds?: Partial<Record<ActionKind, AssetRef>>;
    } = {},
```

and add in the constructor body (after the encounter-table setup):

```ts
    this.#actionSounds = options.actionSounds ?? {};
```

Add the methods (near `discoverRecipe`):

```ts
  /** Subscribes `handler` to the presentation cue stream. */
  onCue(handler: (cue: PresentationCue) => void) {
    this.#cueHandlers.push(handler);
  }

  /** Removes `handler` from the cue stream; a no-op if it was not subscribed. */
  offCue(handler: (cue: PresentationCue) => void) {
    const index = this.#cueHandlers.indexOf(handler);
    if (index !== -1) {
      this.#cueHandlers.splice(index, 1);
    }
  }

  // Fans a cue out to every subscriber. A throwing handler is isolated so one bad
  // presentation subscriber cannot break the turn loop (the engine has no logger,
  // and a handler failure is not a game-rule violation).
  #dispatch(cue: PresentationCue) {
    for (const handler of [...this.#cueHandlers]) {
      try {
        handler(cue);
      } catch {
        // Intentionally swallowed: presentation is best-effort, never load-bearing.
      }
    }
  }

  /**
   * Publishes a cue to subscribers. For an action cue with no resolved sound,
   * fills in the campaign default for that action kind. Engine-internal.
   */
  [EMIT_CUE](cue: PresentationCue) {
    const finalCue: PresentationCue =
      cue.kind === "action" && cue.sound === undefined
        ? { ...cue, sound: this.#actionSounds[cue.action] }
        : cue;
    this.#dispatch(finalCue);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/campaign.test.ts -t "cue stream"`
Expected: PASS.

- [ ] **Step 5: Typecheck + full campaign file**

Run: `npm run typecheck && npx vitest run src/lib/campaign.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/campaign.ts src/lib/campaign.test.ts
git commit -m "feat: campaign presentation cue stream (onCue/offCue + emit)"
```

---

## Task 5: Action cue emission from `recordAction`

**Files:**
- Modify: `src/lib/character/character.ts`
- Modify: `src/test-utils.ts`
- Test: `src/lib/character/character.test.ts`

This task wires `recordAction` to emit an action cue. Because many character tests use the `makeCampaign()` stub, the stub gains a no-op `[EMIT_CUE]` in the same commit to keep the suite green.

- [ ] **Step 1: Write a failing test**

In `src/lib/character/character.test.ts`, add `import { EMIT_CUE } from "../presentation"; import type { PresentationCue } from "../presentation";` and add a test that uses a real campaign so the cue actually flows:

```ts
  describe("action cues", () => {
    it("emits an action cue when an action is recorded, resolving the actor's sound", () => {
      const campaign = new Campaign("Cues");
      const character = new Character(campaign, "Mira", makeStats(), 5, 3, {
        presentation: { sound: "mira.ogg" },
      });
      const seen: PresentationCue[] = [];
      campaign.onCue((cue) => seen.push(cue));

      character.move({ id: "r1", name: "Hall", enterRoom: () => {}, exitRoom: () => {} } as unknown as IRoom);

      expect(seen).toContainEqual(
        expect.objectContaining({ kind: "action", action: "move", sound: "mira.ogg" }),
      );
      expect(seen[seen.length - 1]).toMatchObject({ actor: { name: "Mira" } });
    });
  });
```

Ensure `Campaign` and `IRoom` are imported in `character.test.ts` (the file already imports `Campaign` for the materials/repair tests; add `import type { IRoom } from "../room";` if missing).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/character/character.test.ts -t "action cues"`
Expected: FAIL — no cue is emitted (handler never called).

- [ ] **Step 3: Add the override field + helper and emit in `recordAction`**

In `src/lib/character/character.ts`:

Add to the imports:

```ts
import { EMIT_CUE } from "../presentation";
import type { AssetRef } from "../presentation";
```

(Combine with the existing `import type { Presentation } from "../presentation";` from Task 2 into a single import line: `import type { AssetRef, Presentation } from "../presentation";`.)

Add the transient override field (near `#suppressGate`):

```ts
  // Set transiently so an action recorded inside a wrapped call (e.g. a loot-box
  // exchange) attributes its cue sound to the involved container rather than the
  // actor. Mirrors #suppressGate.
  #cueSoundOverride: AssetRef | undefined;
```

Add the helper (near `withGateSuppressed`):

```ts
  /** Runs `fn` with `sound` as the cue-sound override for any action it records. */
  protected withCueSound<T>(sound: AssetRef | undefined, fn: () => T): T {
    const prev = this.#cueSoundOverride;
    this.#cueSoundOverride = sound;
    try {
      return fn();
    } finally {
      this.#cueSoundOverride = prev;
    }
  }
```

In `recordAction`, emit the cue immediately after pushing the history entry and before the budget block:

```ts
  recordAction(callingFn: ActionFn, detail: ActionDetail) {
    this.#history.push({
      ...detail,
      round: this.campaign.round,
    });

    // Entity sound: the loot-box override when set, else the actor's own sound.
    // The campaign fills the action-kind default when this is undefined.
    this.campaign[EMIT_CUE]({
      kind: "action",
      action: detail.kind,
      actor: { id: this.id, name: this.name },
      sound: this.#cueSoundOverride ?? this.#presentation?.sound,
    });

    if (this.isActionMap.get(callingFn)) {
      this.actionsThisRound = this.actionsThisRound + 1;
    }
    if (this.actionsThisRound === this.actionsPerRound) {
      this.endTurn();
    }
  }
```

- [ ] **Step 4: Update the `makeCampaign()` stub**

In `src/test-utils.ts`, add `import { EMIT_CUE } from "./lib/presentation";` and add a no-op `[EMIT_CUE]` to the stub so action-recording tests that use it don't throw:

```ts
export function makeCampaign(): ICampaign {
  return {
    maybeSpawn: () => [],
    addFormation: () => {},
    [EMIT_CUE]: () => {},
  } as unknown as ICampaign;
}
```

- [ ] **Step 5: Run the test, then the full suite**

Run: `npx vitest run src/lib/character/character.test.ts -t "action cues"`
Expected: PASS.

Run: `npm test`
Expected: PASS — the stub update keeps every action-triggering test green.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/character/character.ts src/test-utils.ts src/lib/character/character.test.ts
git commit -m "feat: emit an action cue from recordAction"
```

---

## Task 6: Loot-box container sound override

**Files:**
- Modify: `src/lib/character/player-character.ts`
- Test: `src/lib/character/player-character.test.ts`

- [ ] **Step 1: Write a failing test**

In `src/lib/character/player-character.test.ts`, add `import type { PresentationCue } from "../presentation";` and a test that takes from a loot box carrying a sound and asserts the recorded `pickUp` cue uses the **box's** sound. Use the file's existing `Loot`, `makeLootItem`, and co-location helpers; construct the box with a presentation sound, and subscribe to the real campaign the PC belongs to:

```ts
  it("attributes a loot-box pickup cue to the container's sound", () => {
    const campaign = new Campaign("Loot");
    const item = makeLootItem("coin");
    const box = new Loot("chest", [item], { sound: "coins.ogg" });
    const pc = new PlayerCharacter(campaign, "Hero", makeStats());
    const room = new Room("Vault", "Vault", [box], {} as ExitsArg);
    pc.move(room);
    pc.startTurn();

    const seen: PresentationCue[] = [];
    campaign.onCue((cue) => seen.push(cue));

    pc.takeFromLootBox(box, item);

    expect(seen).toContainEqual(
      expect.objectContaining({ kind: "action", action: "pickUp", sound: "coins.ogg" }),
    );
  });
```

Confirm `Loot`, `Room`, `ExitsArg`, `makeStats`, `makeLootItem` are imported/defined in this test file (they are used elsewhere in it).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/character/player-character.test.ts -t "container's sound"`
Expected: FAIL — the cue carries the actor's sound (undefined) rather than the box's `coins.ogg`.

- [ ] **Step 3: Wrap the loot-box inventory calls in `withCueSound`**

In `src/lib/character/player-character.ts`, in `takeFromLootBox`, change:

```ts
    if (removed.length > 0) {
      this.withGateSuppressed(() => this.addToInventory(removed));
    }
```

to:

```ts
    if (removed.length > 0) {
      this.withGateSuppressed(() =>
        this.withCueSound(lootBox.presentation?.sound, () =>
          this.addToInventory(removed),
        ),
      );
    }
```

In `putInLootBox`, change:

```ts
    if (toPut.length > 0) {
      this.withGateSuppressed(() => this.removeFromInventory(toPut));
      for (const putItem of toPut) {
        lootBox.stowItem(putItem);
      }
    }
```

to:

```ts
    if (toPut.length > 0) {
      this.withGateSuppressed(() =>
        this.withCueSound(lootBox.presentation?.sound, () =>
          this.removeFromInventory(toPut),
        ),
      );
      for (const putItem of toPut) {
        lootBox.stowItem(putItem);
      }
    }
```

`withCueSound` is the protected helper added to `Character` in Task 5, available to `PlayerCharacter`. `stowItem` records no action, so only the `removeFromInventory` drop cue fires.

- [ ] **Step 4: Run the test, then the file**

Run: `npx vitest run src/lib/character/player-character.test.ts -t "container's sound"`
Expected: PASS.

Run: `npx vitest run src/lib/character/player-character.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/character/player-character.ts src/lib/character/player-character.test.ts
git commit -m "feat: loot-box pickups/drops use the container's cue sound"
```

---

## Task 7: Encounter cues on first encounter

**Files:**
- Modify: `src/lib/campaign.ts`
- Modify: `src/lib/character/player-character.ts`
- Modify: `src/test-utils.ts`
- Test: `src/lib/character/player-character.test.ts`

- [ ] **Step 1: Write failing tests**

In `src/lib/character/player-character.test.ts`, ensure `import { Mob } from "./mob";` is present (it is used in the encounter tests) and add a block. These use a real campaign and real rooms:

```ts
  describe("encounter cues", () => {
    it("fires once on first encounter per (character, mob) and not on re-entry", () => {
      const campaign = new Campaign("Enc");
      const pc = new PlayerCharacter(campaign, "Hero", makeStats());
      pc.joinCampaign();
      const hob = new Mob(campaign, "Hobgoblin", makeStats(), 2, 2, [], {
        presentation: { sound: "growl.ogg" },
      });
      const lair = new Room("Lair", "Lair", [], {} as ExitsArg);
      lair.placeMob(hob);
      const hall = new Room("Hall", "Hall", [], {} as ExitsArg);

      const seen: PresentationCue[] = [];
      campaign.onCue((cue) => { if (cue.kind === "encounter") seen.push(cue); });

      pc.startTurn();
      pc.move(lair);   // first encounter → fires
      pc.move(hall);   // leaves
      pc.startTurn();
      pc.move(lair);   // re-entry → no repeat

      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ kind: "encounter", mob: { name: "Hobgoblin" }, sound: "growl.ogg" });
    });

    it("does not fire for a KO'd mob", () => {
      const campaign = new Campaign("Enc");
      const pc = new PlayerCharacter(campaign, "Hero", makeStats());
      pc.joinCampaign();
      const downed = new Mob(campaign, "Husk", makeStats({ [StatType.Health]: 0 }), 2, 2, []);
      const room = new Room("Crypt", "Crypt", [], {} as ExitsArg);
      room.placeMob(downed);
      // A freshly built mob has not reconciled yet, so KO is not latched until a
      // reconcile runs. A zero-strength hit forces the reconcile (no actual damage)
      // and latches KO from the 0 Health.
      downed.takeDamage(0, StatType.Energy);

      const seen: PresentationCue[] = [];
      campaign.onCue((cue) => { if (cue.kind === "encounter") seen.push(cue); });

      pc.startTurn();
      pc.move(room);

      expect(seen).toHaveLength(0);
    });
  });
```

(`StatType` is already imported in this test file.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/character/player-character.test.ts -t "encounter cues"`
Expected: FAIL — no encounter cue is emitted (`NOTE_ENCOUNTERS` not wired).

- [ ] **Step 3: Add `NOTE_ENCOUNTERS` to the campaign**

In `src/lib/campaign.ts`:

Add to the imports (extend the existing presentation import and add the status + character type):

```ts
import { EMIT_CUE, NOTE_ENCOUNTERS } from "./presentation";
import { Status } from "./status";
import type { ICharacter } from "./character/character";
```

(`IRoom` is already imported.)

Add the backing field (near `#cueHandlers`):

```ts
  #encountered: Set<string> = new Set<string>();
```

In `interface ICampaign`, under `// ### Methods`, add:

```ts
  /** Emits first-encounter cues for active mobs in a room a character entered. Engine-internal. */
  [NOTE_ENCOUNTERS]: (character: ICharacter, room: IRoom) => void;
```

Add the method (near `[EMIT_CUE]`), reusing `#dispatch`:

```ts
  /**
   * Scans `room` (which `character` just entered) and emits one `encounter` cue
   * per active (non-KO), non-party occupant the character has not encountered
   * before. Dedup is per (characterId, mobId), so re-entry — or the mob leaving
   * and returning — never replays the cue for that character. Engine-internal.
   */
  [NOTE_ENCOUNTERS](character: ICharacter, room: IRoom) {
    const partyIds = new Set(this.party.map((p) => p.id));
    for (const occupant of room.occupants) {
      if (partyIds.has(occupant.id)) continue;
      if (occupant.status.includes(Status.KO)) continue;
      const key = `${character.id}:${occupant.id}`;
      if (this.#encountered.has(key)) continue;
      this.#encountered.add(key);
      this.#dispatch({
        kind: "encounter",
        mob: { id: occupant.id, name: occupant.name },
        room: { id: room.id, name: room.name },
        sound: occupant.presentation?.sound,
      });
    }
  }
```

- [ ] **Step 4: Call it from `PlayerCharacter.move`**

In `src/lib/character/player-character.ts`, add `import { NOTE_ENCOUNTERS } from "../presentation";` and update the `move` override:

```ts
  override move(room: IRoom) {
    super.move(room);
    if (this.currentRoom === room) {
      this.campaign.maybeSpawn(room);
      this.campaign[NOTE_ENCOUNTERS](this, room);
    }
  }
```

The encounter scan runs after `maybeSpawn`, so freshly spawned mobs and pre-seated residents are both covered by the one room-entry rule.

- [ ] **Step 5: Add a no-op `[NOTE_ENCOUNTERS]` to the stub**

In `src/test-utils.ts`, extend the import to `import { EMIT_CUE, NOTE_ENCOUNTERS } from "./lib/presentation";` and add to the `makeCampaign()` stub:

```ts
    [NOTE_ENCOUNTERS]: () => {},
```

(So `PlayerCharacter.move` against the stub campaign — e.g. in `makePcInRoomWith`, which moves into a stub room with no `occupants` getter — stays a no-op and does not touch `room.occupants`.)

- [ ] **Step 6: Run the tests, then the full suite**

Run: `npx vitest run src/lib/character/player-character.test.ts -t "encounter cues"`
Expected: PASS.

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/campaign.ts src/lib/character/player-character.ts src/test-utils.ts src/lib/character/player-character.test.ts
git commit -m "feat: first-encounter cues on player room entry"
```

---

## Task 8: End-to-end cue sequence

**Files:**
- Test: `src/integration.test.ts`

- [ ] **Step 1: Write the end-to-end test**

In `src/integration.test.ts`, add `import type { PresentationCue } from "./lib/presentation";` (and `import { Status } from "./lib/status";` if not already present from a prior feature) and a test inside `describe("Campaign integration", ...)`:

```ts
  it("emits action and encounter cues with resolved sounds across a turn", () => {
    const campaign = new Campaign("Wicked Ways", 100, [], { actionSounds: { move: "marching.ogg" } });
    const hero = new PlayerCharacter(campaign, "Hero", makeStats());
    hero.joinCampaign();
    campaign.gm = hero;

    const coin = makeWeapon(); // any item; used as loot
    const chest = new Loot("chest", [coin], { sound: "coins.ogg" });
    const hob = new Mob(campaign, "Hobgoblin", makeStats(), 2, 2, [], { presentation: { sound: "growl.ogg" } });
    const lair = new Room("Lair", "A lair", [chest], {} as ExitsArg);
    lair.placeMob(hob);

    // Archetype requirement from the prior feature: give the PC a neutral one.
    assignNeutralArchetype(campaign, hero);
    campaign.beginCampaign();

    const cues: PresentationCue[] = [];
    campaign.onCue((cue) => cues.push(cue));

    hero.startTurn();
    hero.move(lair);                 // move cue (marching) + encounter cue (growl)
    hero.takeFromLootBox(chest, coin); // pickUp cue (coins, from the container)

    expect(cues).toContainEqual(expect.objectContaining({ kind: "action", action: "move", sound: "marching.ogg" }));
    expect(cues).toContainEqual(expect.objectContaining({ kind: "encounter", mob: { name: "Hobgoblin" }, sound: "growl.ogg" }));
    expect(cues).toContainEqual(expect.objectContaining({ kind: "action", action: "pickUp", sound: "coins.ogg" }));
  });
```

`makeWeapon`, `makeStats`, `Loot`, `Mob`, `Room`, `ExitsArg`, `PlayerCharacter`, `Campaign`, and `assignNeutralArchetype` are all already imported/defined in `integration.test.ts` (the last from the archetypes feature). Confirm and add any that are missing.

- [ ] **Step 2: Run the test**

Run: `npx vitest run src/integration.test.ts -t "action and encounter cues"`
Expected: PASS.

- [ ] **Step 3: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/integration.test.ts
git commit -m "test: end-to-end presentation cue sequence"
```

---

## Task 9: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a "Presentation assets & cues" section**

In `README.md`, add a `### Presentation assets & cues` subsection within "Core concepts" (a natural spot is right after "Rooms, the map, and scenes", or near the end of Core concepts). Use this content:

```markdown
### Presentation assets & cues

The engine is pure logic, but it carries optional hooks for a host renderer/audio layer
(a "Play Surface"). Every presentable entity — characters, [`Room`](src/lib/room.ts),
[`Item`](src/lib/inventory.ts), [`Loot`](src/lib/loot.ts), and material caches — accepts an
optional [`Presentation`](src/lib/presentation.ts) descriptor (`{ image?, sound? }`, where each
value is an opaque host-interpreted `AssetRef`). The host reads `presentation.image` when it
draws an entity.

Sounds are delivered as a push **cue stream**: subscribe with `Campaign.onCue(handler)` (and
`offCue`). The engine emits an `action` cue for every recorded action (move, pickUp, attack, …)
and an `encounter` cue the first time a character meets a given mob (once per character/mob pair,
covering both spawned and resident mobs). Each cue carries a pre-resolved `sound`: the involved
entity's sound wins (a chest's coins on a loot pickup, a hobgoblin's growl on encounter), falling
back to the campaign's `actionSounds` default for that action kind (e.g. `move → marching`), else
none. Subscriber errors are isolated so a faulty handler can't disrupt the turn loop.
```

- [ ] **Step 2: Verify links and project health**

Run: `npm run checks`
Expected: PASS (lint + typecheck + full suite).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document presentation assets & cues"
```

---

## Final verification

- [ ] Run `npm run checks` — lint, typecheck, and the full test suite all pass.
- [ ] Confirm every spec requirement maps to a task (see Self-Review below).

## Self-Review (completed during planning)

- **Spec coverage:** `Presentation`/`AssetRef`/`PresentationCue`/`ActionKind` (T1); presentation on character family (T2) and Room/Item/Loot/MaterialCache (T3); `onCue`/`offCue` + symbol-guarded emit + action-default resolution + subscriber isolation (T4); action cues from `recordAction` (T5); container-owned pickup sound via `withCueSound` (T6); first-encounter dedup for spawned + resident mobs, KO excluded (T7); end-to-end (T8); README + TSDoc (T1–T7 inline, T9). The standalone `presentation.test.ts` is intentionally omitted (pure types + symbols; see Testing note).
- **Placeholder scan:** none — every code/step is concrete.
- **Type consistency:** `Presentation`, `AssetRef`, `EntityRef`, `ActionKind`, `PresentationCue`, `EMIT_CUE`, `NOTE_ENCOUNTERS`, `CharacterOptions`, `onCue`/`offCue`, `actionSounds`, `withCueSound`, `#cueSoundOverride`, and `#encountered` are used identically across tasks.
- **Ripple handling:** the `makeCampaign()` stub gains `[EMIT_CUE]` (T5) and `[NOTE_ENCOUNTERS]` (T7) in the same commits that introduce the calls, keeping the suite green; the prior archetypes feature's `beginCampaign` requirement is satisfied in the integration test via `assignNeutralArchetype`.
```
