# Character Archetypes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let player characters choose a campaign-registered archetype during setup that layers stat deltas, an inventory-slot delta, and standing status immunities onto their baseline.

**Architecture:** An `Archetype` is a plain declarative descriptor (like `Item`/`CraftingRecipe`/`Formation`). The `Campaign` owns an idempotent archetype catalog (mirroring `discoverRecipe`/`knownRecipes`). `PlayerCharacter.selectArchetype(id)` validates against the catalog and applies the archetype's effects exactly once during setup; immunities flow through the existing `Character.#passiveImmunities()` union so no `Afflictions` changes are needed. `Campaign.beginCampaign()` requires every party member to have selected an archetype.

**Tech Stack:** TypeScript (strict, NodeNext), Vitest. No new dependencies.

---

## Reference: spec

`docs/superpowers/specs/2026-06-15-character-archetypes-design.md`

## File Structure

- **Create** `src/lib/archetype.ts` — the `Archetype` descriptor + `ArchetypeId` brand. Pure types, one responsibility.
- **Modify** `src/lib/campaign.ts` — add the archetype catalog (`registerArchetype`, `archetypes` getter), the `started` accessor, and the `beginCampaign` requirement. Interface `ICampaign` updated to match.
- **Modify** `src/lib/character/character.ts` — add a `protected archetypeImmunities` field and union it into `#passiveImmunities()`.
- **Modify** `src/lib/character/player-character.ts` — add `selectArchetype(id)` and the `archetype` getter. Interface `IPlayerCharacter` updated to match.
- **Modify** `src/test-utils.ts` — add a `NEUTRAL_ARCHETYPE` fixture and an `assignNeutralArchetype(...)` helper for tests that must satisfy the new `beginCampaign` requirement without caring about archetype effects.
- **Modify** `src/lib/campaign.test.ts`, `src/lib/character/player-character.test.ts`, `src/integration.test.ts` — add new behavior tests and repair existing `beginCampaign` call sites.

## Testing note (deviation from spec)

The spec lists a `src/lib/archetype.test.ts`. The `Archetype` descriptor is a **pure type with no runtime behavior**, so there is nothing to unit-test in isolation. Its behavior is fully exercised where it is consumed — catalog registration (Task 2, in `campaign.test.ts`) and selection (Task 3, in `player-character.test.ts`). A standalone `archetype.test.ts` is therefore intentionally omitted. All other spec test targets are covered.

---

## Task 1: Archetype descriptor

**Files:**
- Create: `src/lib/archetype.ts`

This task defines a pure type. There is no runtime behavior, so there is no failing test; the type is validated by the compiler and by its consumers in later tasks.

- [ ] **Step 1: Create the descriptor file**

Create `src/lib/archetype.ts`:

```ts
import type { Brand } from "./brand";
import type { Stats } from "./character/stats";
import type { Status } from "./status";

/**
 * Author-chosen archetype identifier, branded so a stray `string` can't be
 * passed where an archetype id is expected. Authors cast their literal at the
 * boundary: `"brawler" as ArchetypeId`.
 */
export type ArchetypeId = Brand<string, "ArchetypeId">;

/**
 * An authored character role registered on a {@link import("./campaign").ICampaign}.
 * Selecting it modifies a player character's baseline exactly once: stat deltas
 * layer onto the provided base stats, the slot delta adjusts inventory capacity,
 * and the immunities become a standing passive trait. Plain declarative data —
 * no class or factory, in the style of the item/recipe/formation descriptors.
 */
export interface Archetype {
  /** Stable identifier. */
  id: ArchetypeId;
  /** Display name. */
  name: string;
  /** Deltas added once to base stats at selection. A missing stat contributes +0. */
  statModifiers?: Partial<Stats>;
  /** Delta added once to inventory slot capacity (resulting capacity floored at 0). */
  inventorySlots?: number;
  /**
   * Standing status immunities granted while this archetype is held. Covers
   * Panic/Fear/Confused; KO is never immunizable, so a listed KO is ignored
   * (consistent with item immunities today).
   */
  immunities?: Status[];
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run typecheck`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add src/lib/archetype.ts
git commit -m "feat: add Archetype descriptor type"
```

---

## Task 2: Campaign archetype catalog + `started` accessor

**Files:**
- Modify: `src/lib/campaign.ts`
- Test: `src/lib/campaign.test.ts`

- [ ] **Step 1: Write failing tests**

Add this block inside the top-level `describe("Campaign", ...)` in `src/lib/campaign.test.ts` (after the existing imports, which already include `Campaign`). Add `import type { Archetype, ArchetypeId } from "./archetype";` to the imports at the top of the file.

```ts
  describe("archetype catalog", () => {
    function makeArchetype(id: string): Archetype {
      return { id: id as ArchetypeId, name: id };
    }

    it("registers an archetype and exposes it via the read-only view", () => {
      const campaign = new Campaign("C");
      const brawler = makeArchetype("brawler");

      campaign.registerArchetype(brawler);

      expect(campaign.archetypes.get(brawler.id)).toBe(brawler);
    });

    it("is idempotent by id (first definition wins)", () => {
      const campaign = new Campaign("C");
      const first = makeArchetype("brawler");
      const second: Archetype = { id: "brawler" as ArchetypeId, name: "Other" };

      campaign.registerArchetype(first);
      campaign.registerArchetype(second);

      expect(campaign.archetypes.get(first.id)).toBe(first);
      expect(campaign.archetypes.size).toBe(1);
    });

    it("reports started=false before begin and true after", () => {
      const campaign = new Campaign("C");
      expect(campaign.started).toBe(false);

      const pc = { id: "pc-arch", archetype: {} } as unknown as IPlayerCharacter;
      campaign.party.push(pc);
      campaign.gm = pc;
      campaign.beginCampaign();

      expect(campaign.started).toBe(true);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/campaign.test.ts -t "archetype catalog"`
Expected: FAIL — `campaign.registerArchetype is not a function` / `campaign.archetypes`/`campaign.started` undefined.

- [ ] **Step 3: Implement the catalog and accessor**

In `src/lib/campaign.ts`:

Add to the imports near the top:

```ts
import type { Archetype, ArchetypeId } from "./archetype";
```

In `interface ICampaign`, under `// ### Properties` (near the `knownRecipes` getter), add:

```ts
  /** Read-only view of the archetypes registered on this campaign. */
  get archetypes(): ReadonlyMap<ArchetypeId, Archetype>;
  /** Whether the campaign has begun (turn management active). */
  get started(): boolean;
```

In `interface ICampaign`, under `// ### Methods`, add:

```ts
  /** Registers an archetype in the catalog; idempotent by id (first wins). */
  registerArchetype: (archetype: Archetype) => void;
```

In `class Campaign`, add the backing field alongside the other private fields (near `#knownRecipes`):

```ts
  #archetypes: Map<ArchetypeId, Archetype> = new Map();
```

Add the getters (next to the `knownRecipes` getter):

```ts
  get archetypes(): ReadonlyMap<ArchetypeId, Archetype> {
    // Live map exposed as ReadonlyMap, matching knownRecipes: selection reads it
    // via .get(id), so a per-access copy would be wasteful. Mutation is funnelled
    // through registerArchetype.
    return this.#archetypes;
  }

  get started(): boolean {
    return this.#started;
  }
```

Add the method (next to `discoverRecipe`):

```ts
  /**
   * Registers an archetype in the campaign catalog. Idempotent by id: the first
   * definition for an id wins; later calls with that id are ignored.
   *
   * @param archetype - The archetype to register.
   */
  registerArchetype(archetype: Archetype) {
    if (this.#archetypes.has(archetype.id)) {
      return;
    }
    this.#archetypes.set(archetype.id, archetype);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/campaign.test.ts -t "archetype catalog"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/campaign.ts src/lib/campaign.test.ts
git commit -m "feat: campaign archetype catalog and started accessor"
```

---

## Task 3: `PlayerCharacter.selectArchetype` + stat/slot application

**Files:**
- Modify: `src/lib/character/character.ts` (add `protected archetypeImmunities` field)
- Modify: `src/lib/character/player-character.ts`
- Test: `src/lib/character/player-character.test.ts`

- [ ] **Step 1: Write failing tests**

In `src/lib/character/player-character.test.ts`, add `import type { Archetype, ArchetypeId } from "../archetype";` to the imports. Add this block inside the top-level `describe("PlayerCharacter", ...)`:

```ts
  describe("selectArchetype", () => {
    function makeArchetype(overrides: Partial<Archetype> = {}): Archetype {
      return { id: "brawler" as ArchetypeId, name: "Brawler", ...overrides };
    }

    it("layers stat deltas onto the base stats", () => {
      const campaign = new Campaign("Quest");
      const pc = new PlayerCharacter(campaign, "Hero", makeStats({ [StatType.Health]: 6 }));
      const brawler = makeArchetype({ statModifiers: { [StatType.Health]: 3 } });
      campaign.registerArchetype(brawler);

      pc.selectArchetype(brawler.id);

      expect(pc.stats[StatType.Health]).toBe(9);
      expect(pc.archetype).toBe(brawler);
    });

    it("adds the inventory-slot delta to capacity", () => {
      const campaign = new Campaign("Quest");
      const pc = new PlayerCharacter(campaign, "Hero", makeStats(), 5);
      const packer = makeArchetype({ inventorySlots: 2 });
      campaign.registerArchetype(packer);

      pc.selectArchetype(packer.id);

      expect(pc.inventory.slots).toBe(7);
    });

    it("floors resulting inventory capacity at 0", () => {
      const campaign = new Campaign("Quest");
      const pc = new PlayerCharacter(campaign, "Hero", makeStats(), 1);
      const burdened = makeArchetype({ inventorySlots: -5 });
      campaign.registerArchetype(burdened);

      pc.selectArchetype(burdened.id);

      expect(pc.inventory.slots).toBe(0);
    });

    it("throws on an unknown archetype id", () => {
      const campaign = new Campaign("Quest");
      const pc = new PlayerCharacter(campaign, "Hero", makeStats());

      expect(() => pc.selectArchetype("ghost" as ArchetypeId)).toThrow(ProceduralViolation);
    });

    it("throws when an archetype is already selected", () => {
      const campaign = new Campaign("Quest");
      const pc = new PlayerCharacter(campaign, "Hero", makeStats());
      const brawler = makeArchetype();
      campaign.registerArchetype(brawler);
      pc.selectArchetype(brawler.id);

      expect(() => pc.selectArchetype(brawler.id)).toThrow(ProceduralViolation);
    });

    it("throws when the campaign has already begun", () => {
      const campaign = new Campaign("Quest");
      const pc = new PlayerCharacter(campaign, "Hero", makeStats());
      const brawler = makeArchetype();
      campaign.registerArchetype(brawler);
      pc.joinCampaign();
      pc.selectArchetype(brawler.id);
      campaign.gm = pc;
      campaign.beginCampaign();

      const other: Archetype = { id: "rogue" as ArchetypeId, name: "Rogue" };
      campaign.registerArchetype(other);
      expect(() => pc.selectArchetype(other.id)).toThrow(/begun/);
    });
  });
```

Note: the last test calls `beginCampaign()` with a PC that already selected an archetype, so it passes the Task 5 requirement once that lands. Until Task 5 it passes regardless (no requirement yet).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/character/player-character.test.ts -t "selectArchetype"`
Expected: FAIL — `pc.selectArchetype is not a function`.

- [ ] **Step 3: Add the immunities field to the base class**

In `src/lib/character/character.ts`, add a protected field alongside the other private state (just after `#slots`):

```ts
  /**
   * Standing status immunities granted by a selected archetype. Set only by
   * PlayerCharacter.selectArchetype; read by #passiveImmunities. Protected (not
   * public) so untrusted code can't forge it — same hidden-state discipline as
   * the rest of the character.
   */
  protected archetypeImmunities: Status[] = [];
```

(`Status` is already imported in `character.ts`.)

- [ ] **Step 4: Implement `selectArchetype` and the `archetype` getter**

In `src/lib/character/player-character.ts`:

Update imports — add:

```ts
import type { Archetype, ArchetypeId } from "../archetype";
import { ProceduralViolation, typedEntries } from "../util";
import { StatType, Stats } from "./stats";
```

(The file already imports `Stats` and `ProceduralViolation`; merge rather than duplicate — the result must import `Archetype`, `ArchetypeId`, `typedEntries`, and `StatType` in addition to what's there. `StatType` is needed for the entries cast below.)

In `interface IPlayerCharacter`, add:

```ts
  /** The archetype this character selected, or `undefined` if none yet. */
  get archetype(): Archetype | undefined;
  /**
   * Selects a campaign-registered archetype, applying its stat and slot deltas
   * once and adopting its standing immunities. Setup-only and once-only.
   */
  selectArchetype: (id: ArchetypeId) => void;
```

In `class PlayerCharacter`, add the field and members:

```ts
  #archetype?: Archetype;

  get archetype(): Archetype | undefined {
    return this.#archetype;
  }

  /**
   * Selects an archetype from the campaign catalog, applying its effects exactly
   * once: stat deltas are added to the base stats, the slot delta adjusts
   * inventory capacity (floored at 0), and the immunities become a standing
   * passive trait. A setup-only, once-only operation.
   *
   * @param id - The id of an archetype registered on the campaign.
   * @throws {@link ProceduralViolation} if the campaign has already begun, an
   *   archetype is already selected, or `id` is not in the catalog.
   */
  selectArchetype(id: ArchetypeId) {
    if (this.campaign.started) {
      throw new ProceduralViolation(
        "Cannot select an archetype after the campaign has begun.",
      );
    }
    if (this.#archetype) {
      throw new ProceduralViolation(
        "Character has already selected an archetype.",
      );
    }
    const archetype = this.campaign.archetypes.get(id);
    if (!archetype) {
      throw new ProceduralViolation("Unknown archetype.");
    }

    if (archetype.statModifiers) {
      for (const [stat, delta] of typedEntries(archetype.statModifiers) as Array<
        [StatType, number | undefined]
      >) {
        if (delta === undefined) continue;
        this.stats[stat] = this.stats[stat] + delta;
      }
    }
    if (archetype.inventorySlots !== undefined) {
      // `inventory` returns the live inventory object, so this mutates capacity.
      this.inventory.slots = Math.max(0, this.inventory.slots + archetype.inventorySlots);
    }

    this.#archetype = archetype;
    this.archetypeImmunities = archetype.immunities ?? [];
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/lib/character/player-character.test.ts -t "selectArchetype"`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS. (If `Stats` is now imported but unused, drop it from the import — only `StatType` is referenced in the cast.)

- [ ] **Step 7: Commit**

```bash
git add src/lib/character/player-character.ts src/lib/character/player-character.test.ts src/lib/character/character.ts
git commit -m "feat: PlayerCharacter.selectArchetype applies stat and slot deltas"
```

---

## Task 4: Archetype passive immunity

**Files:**
- Modify: `src/lib/character/character.ts`
- Test: `src/lib/character/player-character.test.ts`

- [ ] **Step 1: Write a failing test**

Add to the `describe("selectArchetype", ...)` block in `src/lib/character/player-character.test.ts`:

```ts
    it("grants standing immunity to a status the stats would otherwise trigger", () => {
      const campaign = new Campaign("Quest");
      // Energy 0 would normally latch Confused on reconcile.
      const pc = new PlayerCharacter(campaign, "Hero", makeStats({ [StatType.Energy]: 0 }));
      const stoic = makeArchetype({ immunities: [Status.Confused] });
      campaign.registerArchetype(stoic);
      pc.selectArchetype(stoic.id);

      pc.takeDamage(0, StatType.Energy); // forces a reconcile

      expect(pc.status).not.toContain(Status.Confused);
    });
```

Add `import { Status } from "../status";` to the test file's imports (alongside the existing `StatType` import from `./stats`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/character/player-character.test.ts -t "grants standing immunity"`
Expected: FAIL — `pc.status` contains `Status.Confused` because the archetype immunities are not yet consulted.

- [ ] **Step 3: Union archetype immunities into the passive set**

In `src/lib/character/character.ts`, update `#passiveImmunities()` to add the archetype trait after the item loop:

```ts
  /** Statuses currently immunized by equipped, intact gear or the selected archetype. */
  #passiveImmunities(): Set<Status> {
    const set = new Set<Status>();
    for (const item of this.#inventory.items) {
      if (!item.properties.equipped || item.isBroken || !item.immunities) continue;
      for (const s of item.immunities) set.add(s);
    }
    for (const s of this.archetypeImmunities) set.add(s);
    return set;
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/character/player-character.test.ts -t "grants standing immunity"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/character/character.ts src/lib/character/player-character.test.ts
git commit -m "feat: archetype immunities flow through passive immunity union"
```

---

## Task 5: Require an archetype at `beginCampaign` (+ repair existing call sites)

**Files:**
- Modify: `src/lib/campaign.ts`
- Modify: `src/test-utils.ts`
- Modify: `src/lib/campaign.test.ts`
- Modify: `src/lib/character/player-character.test.ts`
- Modify: `src/integration.test.ts`

This task adds the requirement and, in the same commit, repairs every existing `beginCampaign` call site so the whole suite stays green.

- [ ] **Step 1: Add the shared test helper**

In `src/test-utils.ts`, add imports at the top:

```ts
import type { Archetype, ArchetypeId } from "./lib/archetype";
import type { IPlayerCharacter } from "./lib/character/player-character";
```

Add at the end of the file:

```ts
// A no-op archetype for tests that must satisfy beginCampaign's requirement
// without exercising any archetype effect.
export const NEUTRAL_ARCHETYPE: Archetype = {
  id: "neutral" as ArchetypeId,
  name: "Neutral",
};

// Registers NEUTRAL_ARCHETYPE on the campaign and assigns it to each PC, so
// beginCampaign's archetype requirement is satisfied.
export function assignNeutralArchetype(
  campaign: ICampaign,
  ...pcs: IPlayerCharacter[]
): void {
  campaign.registerArchetype(NEUTRAL_ARCHETYPE);
  for (const pc of pcs) {
    pc.selectArchetype(NEUTRAL_ARCHETYPE.id);
  }
}
```

(`ICampaign` is already imported in `test-utils.ts`.)

- [ ] **Step 2: Write failing tests for the requirement**

In `src/lib/campaign.test.ts`, add to the existing `describe("beginCampaign", ...)` block (or create one if absent), using the file's existing `makePlayer`/`makeCampaign` helpers:

```ts
    it("throws if a party member has not chosen an archetype", () => {
      const campaign = new Campaign("C");
      const noArchetype = { id: "pc-bare" } as unknown as IPlayerCharacter;
      campaign.party.push(noArchetype);
      campaign.gm = noArchetype;

      expect(() => campaign.beginCampaign()).toThrow(/archetype/);
    });

    it("begins when every party member has an archetype", () => {
      const campaign = new Campaign("C");
      const withArchetype = { id: "pc-ok", archetype: {} } as unknown as IPlayerCharacter;
      campaign.party.push(withArchetype);
      campaign.gm = withArchetype;

      expect(() => campaign.beginCampaign()).not.toThrow();
    });
```

- [ ] **Step 3: Run the new tests to verify the first fails**

Run: `npx vitest run src/lib/campaign.test.ts -t "has not chosen an archetype"`
Expected: FAIL — `beginCampaign` does not yet throw (the campaign begins with no archetype).

- [ ] **Step 4: Add the requirement to `beginCampaign`**

In `src/lib/campaign.ts`, in `beginCampaign()`, add this check **after** the existing GM-membership check and **before** `this.#started = true;`:

```ts
    if (this.party.some((member) => member.archetype === undefined)) {
      throw new ProceduralViolation(
        "Cannot begin a campaign whose party members have not all chosen an archetype",
      );
    }
```

- [ ] **Step 5: Run the new tests to verify they pass**

Run: `npx vitest run src/lib/campaign.test.ts -t "archetype"`
Expected: PASS.

- [ ] **Step 6: Run the full suite to find the broken existing call sites**

Run: `npm test`
Expected: FAILURES in `campaign.test.ts` (stub players from `makePlayer`), `player-character.test.ts` (3 sites), and `integration.test.ts` (4 sites) — all because their party members now lack archetypes.

- [ ] **Step 7: Repair `campaign.test.ts`'s `makePlayer` stub**

In `src/lib/campaign.test.ts`, change the `makePlayer` helper so its stubs carry an archetype:

```ts
function makePlayer(): IPlayerCharacter {
  return { id: `pc-${++counter}`, archetype: {} } as unknown as IPlayerCharacter;
}
```

- [ ] **Step 8: Repair `player-character.test.ts`'s three `beginCampaign` sites**

In `src/lib/character/player-character.test.ts`, add `assignNeutralArchetype` to the `test-utils` import. Then, in each of the three tests in the `describe("move triggers encounters", ...)` block (around the `campaign.beginCampaign()` calls), insert the helper call immediately before `campaign.beginCampaign();`:

```ts
      pc.joinCampaign();
      campaign.gm = pc;
      assignNeutralArchetype(campaign, pc);
      campaign.beginCampaign();
```

Apply identically to all three tests in that block ("spawns a formation when entering a new room", "does not spawn when the move fizzles (Confused)", "does not spawn when the move itself is blocked").

- [ ] **Step 9: Repair `integration.test.ts`'s four `beginCampaign` sites**

In `src/integration.test.ts`, add `assignNeutralArchetype` to the `test-utils` import. Before each `campaign.beginCampaign();`, assign the neutral archetype to that scenario's PCs:

- The first scenario (two PCs, `hero` and `seer`): insert before `campaign.beginCampaign();`
  ```ts
      assignNeutralArchetype(campaign, hero, seer);
  ```
- The other three scenarios (single `hero`): insert before each `campaign.beginCampaign();`
  ```ts
      assignNeutralArchetype(campaign, hero);
  ```

- [ ] **Step 10: Run the full suite**

Run: `npm test`
Expected: PASS — all files green.

- [ ] **Step 11: Commit**

```bash
git add src/lib/campaign.ts src/test-utils.ts src/lib/campaign.test.ts src/lib/character/player-character.test.ts src/integration.test.ts
git commit -m "feat: require an archetype for every party member at beginCampaign"
```

---

## Task 6: End-to-end archetype scenario

**Files:**
- Test: `src/integration.test.ts`

- [ ] **Step 1: Write the end-to-end test**

In `src/integration.test.ts`, add `import type { ArchetypeId } from "./lib/archetype";` and `import { Status } from "./lib/status";` if not already present, then add a new test inside `describe("Campaign integration", ...)`:

```ts
  it("applies a selected archetype's stat, slot, and immunity effects through setup", () => {
    const campaign = new Campaign("Wicked Ways");
    const hero = new PlayerCharacter(campaign, "Hero", makeStats({ [StatType.Energy]: 0 }), 5);
    hero.joinCampaign();
    campaign.gm = hero;

    campaign.registerArchetype({
      id: "stoic-packer" as ArchetypeId,
      name: "Stoic Packer",
      statModifiers: { [StatType.Health]: 2 },
      inventorySlots: 3,
      immunities: [Status.Confused],
    });
    hero.selectArchetype("stoic-packer" as ArchetypeId);
    campaign.beginCampaign();

    // Stat delta layered on the base.
    expect(hero.stats[StatType.Health]).toBe(12);
    // Slot delta applied to capacity.
    expect(hero.inventory.slots).toBe(8);

    // Standing immunity holds through a reconcile that would otherwise latch Confused.
    hero.startTurn();
    hero.takeDamage(0, StatType.Energy);
    expect(hero.status).not.toContain(Status.Confused);
  });
```

(`StatType` and `makeStats` are already imported in the integration test.)

- [ ] **Step 2: Run the test**

Run: `npx vitest run src/integration.test.ts -t "applies a selected archetype"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/integration.test.ts
git commit -m "test: end-to-end archetype effects through campaign setup"
```

---

## Task 7: Documentation

**Files:**
- Modify: `README.md`

Per the project convention (update README + TSDoc after a feature), document archetypes. TSDoc was written inline in Tasks 1–5; this task covers the README.

- [ ] **Step 1: Add a "Character archetypes" subsection to the README**

In `README.md`, under the "Characters" area of "Core concepts" (after the character hierarchy and before "Rooms, the map, and scenes"), add:

```markdown
### Character archetypes

Player characters choose an [`Archetype`](src/lib/archetype.ts) during setup. Archetypes are
authored, declarative descriptors registered on the campaign via `Campaign.registerArchetype`
(idempotent by id, like recipes), and a character adopts one with
`PlayerCharacter.selectArchetype(id)`. Selecting an archetype modifies the character's baseline
exactly once: `statModifiers` are added to the base stats, `inventorySlots` adjusts inventory
capacity (floored at 0), and `immunities` become a standing passive trait — a new source unioned
with equipped-gear immunities (Panic/Fear/Confused only; KO is never immunizable).

Selection is **once-only** and **setup-only** (it throws after the campaign begins), and
`Campaign.beginCampaign()` throws unless **every** party member has chosen an archetype — the same
shape as the existing GM-membership requirement.
```

- [ ] **Step 2: Verify the links resolve and the doc reads correctly**

Run: `npm run checks`
Expected: PASS (lint + typecheck + full test suite).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document character archetypes"
```

---

## Final verification

- [ ] Run `npm run checks` — lint, typecheck, and the full test suite all pass.
- [ ] Confirm every spec requirement maps to a task (see Self-Review below).

## Self-Review (completed during planning)

- **Spec coverage:** descriptor (T1); campaign catalog + `started` (T2); `selectArchetype` stat/slot application + lock + validation (T3); immunity union (T4); `beginCampaign` requirement (T5); end-to-end (T6); README + TSDoc (T1–5, T7). The spec's `archetype.test.ts` is intentionally omitted (pure type — see "Testing note" above); its behavior is covered in T2/T3.
- **Placeholder scan:** none — every code/step is concrete.
- **Type consistency:** `Archetype`, `ArchetypeId`, `registerArchetype`, `archetypes`, `started`, `selectArchetype`, `archetype`, and `archetypeImmunities` are used identically across all tasks and match the descriptor in T1.
