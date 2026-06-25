# Haunted House Campaign + Infocom-Style Play Surface — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Author a short single-player gothic haunted-house mystery on the Wicked Ways engine and build a browser, Infocom-style parser play surface for it in a new `@wickedways/play` package.

**Architecture:** A UI-neutral `core/` (a `GameSession` that assembles and drives a live `Campaign`, a render-agnostic `viewmodel`, an `Intent` seam, an async `SaveStore`) plus a text adapter (`parser`, `narrator`, terminal `ui`). The campaign content is pure engine authoring. One typed command = one turn of game time. Locked doors are revealed by the session via `room.addExit`, gated on a key, from a campaign-supplied door table.

**Tech Stack:** TypeScript (strict, NodeNext), Vite (dev/build), Vitest (tests run from the repo root), the `wickedways` engine imported as a workspace package. No new runtime dependencies.

## Global Constraints

- **Engine changes:** exactly one — add `hasItem(itemKey: string): boolean` to the mechanic system's `CharacterView`. No other `src/` change.
- **Package name / location:** `@wickedways/play` at `packages/play`, `"private": true`, `"type": "module"`, mirroring `@wickedways/client`.
- **Engine import style:** import from `wickedways/lib/...` subpaths with **no file extension** (e.g. `import { StatType } from "wickedways/lib/character/stats";`), exactly as `packages/seed/src/index.ts` does.
- **Tests:** co-located `*.test.ts`; the repo-root `vitest.config.ts` already globs `packages/*/src/**/*.test.ts`, so run all tests with `pnpm test` from the repo root. Test environment is `node`.
- **`pnpm checks`** (root) runs `eslint .`, root `tsc`, `pnpm -r run typecheck` (per-package), then `pnpm test`. The new package MUST have a `typecheck` script.
- **TS strictness:** `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`. Indexed access yields `T | undefined` — handle it; never cast a raw string to a branded id.
- **Engine directions:** the `Directions` constant has only the 8 compass points (`North, South, East, West, Northeast, Northwest, Southeast, Southwest`) — **no up/down**. Vertical links (stairs, cellar) use a compass direction and are narrated as up/down in prose.
- **Game-time model:** one *time-advancing* command = `activeCharacter.startTurn()` → engine action → `campaign.nextPlayer()`. *Free* commands execute with neither. Time-advancing: `move, take, drop, use, attack, unlock, wait`. Free: `open, equip, unequip`.
- **`maxRounds: 150`.** `baseEncounterChance: 0` (no random encounters — placed mobs only).

---

## File Structure

```
src/lib/mechanics/mechanic.ts        (modify) — add hasItem to CharacterView
src/lib/campaign.ts                  (modify) — implement hasItem in #characterView
src/lib/mechanics/character-view.test.ts (create) — hasItem test

packages/play/
  package.json, tsconfig.json, vite.config.ts, index.html
  src/main.ts                        — boot: wires session + parser + narrator + ui
  src/campaign/
    ids.ts                           — as-const name maps
    items.ts                         — makeItem helper + item/key factories
    mechanics.ts                     — dread + storyteller Mechanics
    content.ts                       — lore table, door table, alias table
    index.ts                         — registry + template + exports
    campaign.test.ts                 — builds/seats + winning + losing path
  src/core/
    intent.ts                        — Intent union + isTimeAdvancing
    savestore.ts                     — SaveStore interface + LocalStorageSaveStore
    viewmodel.ts                     — view(campaign, doors) → ViewModel
    session.ts                       — GameSession
    *.test.ts
  src/text/
    parser.ts                        — parse(input, view) → ParseResult
    narrator.ts                      — render cues + room + exit diff → lines
    ui.ts                            — terminal DOM shell
    *.test.ts
  README.md
```

---

### Task 1: Engine — `CharacterView.hasItem`

**Files:**
- Modify: `src/lib/mechanics/mechanic.ts` (the `CharacterView` interface)
- Modify: `src/lib/campaign.ts` (the private `#characterView` factory, near line 663 where `hasEquipped` is built)
- Test: `src/lib/mechanics/character-view.test.ts`

**Interfaces:**
- Produces: `CharacterView.hasItem(itemKey: string): boolean` — returns true iff a non-equipped-or-equipped item in the character's `inventory.items` has `behaviorKey === itemKey`. Mirrors `hasEquipped`, which already matches `behaviorKey` over equipped items.

- [ ] **Step 1: Write the failing test**

Create `src/lib/mechanics/character-view.test.ts`. It builds a tiny campaign, registers a mechanic that records `ctx.actor.hasItem(...)` on turn start, gives the player a registered item via loot, and asserts.

```ts
import { describe, it, expect } from "vitest";
import { defineRegistry } from "../authoring/registry";
import { authorTemplate } from "../authoring/template-builder";
import { startSession } from "../authoring/orchestration";
import { Item, ItemType } from "../inventory";
import { StatType } from "../character/stats";
import type { Mechanic, JsonObject } from "./mechanic";

const noop = () => {};
function makeProp(behaviorKey: string): Item {
  return new Item({
    descriptor: { behaviorKey, name: "Prop", type: ItemType.Consumable, recipe: { item: 1 }, modifier: 0, stat: StatType.Health },
    properties: { equippable: false, equipped: false, destroyable: true, usable: false },
    actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    events: { onPickUp: noop },
  });
}

describe("CharacterView.hasItem", () => {
  it("is true for a held item's behaviorKey and false otherwise", () => {
    const seen: { has: boolean; hasOther: boolean }[] = [];
    const probe: Mechanic<JsonObject> = {
      initialState: () => ({}),
      onTurnStart: (ctx) => {
        seen.push({ has: ctx.actor.hasItem("prop"), hasOther: ctx.actor.hasItem("nope") });
      },
    };
    const registry = defineRegistry({
      items: { prop: () => makeProp("prop") },
      mechanics: { probe },
    });
    const builder = authorTemplate("T", registry, { maxRounds: 5, baseEncounterChance: 0, rng: () => 0.5 })
      .room("Start", { description: "start" })
      .startRoom("Start")
      .loot("box", { room: "Start", items: ["prop"] })
      .useMechanic("probe");
    const campaign = startSession(builder, { players: [{ name: "P" }], gm: 0 });
    const pc = campaign.activeCharacter;
    const box = [...pc.currentRoom!.loot.values()][0]!;
    pc.openLootBox(box);
    pc.takeFromLootBox(box, box.contents.slice());
    pc.startTurn();
    expect(seen.at(-1)).toEqual({ has: true, hasOther: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/mechanics/character-view.test.ts`
Expected: FAIL — `ctx.actor.hasItem is not a function` (property does not exist on `CharacterView`).

- [ ] **Step 3: Add `hasItem` to the `CharacterView` interface**

In `src/lib/mechanics/mechanic.ts`, in the `CharacterView` interface, add the method right after `hasEquipped`:

```ts
  hasEquipped(itemKey: string): boolean;
  hasItem(itemKey: string): boolean;
```

- [ ] **Step 4: Implement it in `#characterView`**

In `src/lib/campaign.ts`, in the object returned by `#characterView` (where `hasEquipped` is defined, ~line 663), add immediately after the `hasEquipped` property:

```ts
      hasItem: (key: string) => {
        for (const item of c.inventory.items) {
          if (item.behaviorKey === key) return true;
        }
        return false;
      },
```

(Match the file's existing import/quote style; do not add a file extension to imports the file already writes without one.)

- [ ] **Step 5: Run the test to verify it passes, then run the engine suite**

Run: `pnpm vitest run src/lib/mechanics/character-view.test.ts`
Expected: PASS.
Run: `pnpm vitest run src/lib/mechanics src/lib/campaign.test.ts`
Expected: PASS (no regressions).

- [ ] **Step 6: Commit**

```bash
git add src/lib/mechanics/mechanic.ts src/lib/campaign.ts src/lib/mechanics/character-view.test.ts
git commit -m "feat(mechanics): add CharacterView.hasItem for inventory-gated mechanics"
```

---

### Task 2: Scaffold the `@wickedways/play` package

**Files:**
- Create: `packages/play/package.json`, `packages/play/tsconfig.json`, `packages/play/vite.config.ts`, `packages/play/index.html`, `packages/play/src/main.ts`

**Interfaces:**
- Produces: a workspace package that builds and serves a Vite dev server, with a `typecheck` script picked up by `pnpm -r run typecheck`.

- [ ] **Step 1: Create `packages/play/package.json`**

```json
{
  "name": "@wickedways/play",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "dev": "vite",
    "build": "vite build"
  },
  "dependencies": {
    "wickedways": "workspace:*"
  },
  "devDependencies": {
    "vite": "^8.0.0"
  }
}
```

- [ ] **Step 2: Create `packages/play/tsconfig.json`** (copy of the client's)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ESNext", "DOM"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "noEmit": true,
    "allowImportingTsExtensions": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create `packages/play/vite.config.ts` and `index.html`**

`vite.config.ts`:
```ts
import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 5174 },
});
```

`index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Wicked Ways — The Hollow House</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 4: Create a stub `packages/play/src/main.ts`**

```ts
const app = document.getElementById("app");
if (app) app.textContent = "The Hollow House — booting…";
```

- [ ] **Step 5: Install and verify**

Run: `pnpm install`
Expected: workspace resolves `@wickedways/play`; no errors.
Run: `pnpm --filter @wickedways/play typecheck`
Expected: PASS (no type errors).
Run: `pnpm --filter @wickedways/play dev` (start, confirm it serves on http://localhost:5174, then stop with Ctrl-C).
Expected: Vite starts and serves the stub page.

- [ ] **Step 6: Commit**

```bash
git add packages/play pnpm-lock.yaml
git commit -m "chore(play): scaffold @wickedways/play Vite package"
```

---

### Task 3: Campaign — names, items, and keys

**Files:**
- Create: `packages/play/src/campaign/ids.ts`, `packages/play/src/campaign/items.ts`
- Test: `packages/play/src/campaign/items.test.ts`

**Interfaces:**
- Produces:
  - `ids.ts`: `Rooms`, `Items`, `Keys`, `Mobs`, `Mechanics`, `Archetypes`, `Conditions` — `as const` string maps.
  - `items.ts`: `makeItem(descriptor, props?) => Item`; item factories `lantern()`, `journal()`, `poker()`, `laudanum()`; key factories `brassKey()`, `ironKey()`. Plus `ITEM_FACTORIES: Record<string, () => Item>` for the registry.

- [ ] **Step 1: Write the failing test**

```ts
// packages/play/src/campaign/items.test.ts
import { describe, it, expect } from "vitest";
import { ITEM_FACTORIES } from "./items";
import { Items, Keys } from "./ids";

describe("campaign items", () => {
  it("registers a factory for every item and key id", () => {
    for (const id of [...Object.values(Items), ...Object.values(Keys)]) {
      expect(typeof ITEM_FACTORIES[id]).toBe("function");
    }
  });
  it("the lantern emits light and is equippable; the journal carries its behaviorKey", () => {
    const lantern = ITEM_FACTORIES[Items.Lantern]!();
    expect(lantern.emitsLight).toBe(true);
    expect(lantern.properties.equippable).toBe(true);
    const journal = ITEM_FACTORIES[Items.Journal]!();
    expect(journal.behaviorKey).toBe(Items.Journal);
  });
  it("keys carry their keyCode", () => {
    expect(ITEM_FACTORIES[Keys.Brass]!().keyCode).toBe("brass");
    expect(ITEM_FACTORIES[Keys.Iron]!().keyCode).toBe("iron");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/play/src/campaign/items.test.ts`
Expected: FAIL — cannot find module `./items` / `./ids`.

- [ ] **Step 3: Create `ids.ts`**

```ts
export const Rooms = {
  Foyer: "Foyer", Cellar: "Cellar", Hall: "Hall", Kitchen: "Kitchen",
  Parlor: "Parlor", Landing: "Landing", Study: "Study", Nursery: "Nursery", Attic: "Attic",
} as const;

export const Items = {
  Lantern: "lantern", Journal: "journal", Poker: "poker", Laudanum: "laudanum",
} as const;

export const Keys = { Brass: "brass-key", Iron: "iron-key" } as const;

export const Mobs = { Wraith: "Wraith", Revenant: "Revenant" } as const;

export const Mechanics = { Dread: "dread", Storyteller: "storyteller" } as const;

export const Archetypes = { Heir: "heir" } as const;

export const Conditions = {
  ReachedAtticWithJournal: "reached-attic-with-journal",
  SanityZero: "sanity-zero",
  PartyDown: "party-down",
} as const;
```

- [ ] **Step 4: Create `items.ts`**

```ts
import { Item, ItemType, createKey, type ItemDescriptor } from "wickedways/lib/inventory";
import { StatType } from "wickedways/lib/character/stats";
import { SlotKind } from "wickedways/lib/equipment";
import { Items, Keys } from "./ids";

const noop = () => {};

export function makeItem(
  descriptor: ItemDescriptor,
  props: { equippable?: boolean; usable?: boolean } = {},
): Item {
  return new Item({
    descriptor,
    properties: { equippable: props.equippable ?? false, equipped: false, destroyable: true, usable: props.usable ?? false },
    actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    events: { onPickUp: noop },
  });
}

export const lantern = (): Item =>
  makeItem(
    { behaviorKey: Items.Lantern, name: "Brass Lantern", type: ItemType.Weapon, recipe: { item: 1 }, modifier: 0, stat: StatType.Health, slot: SlotKind.Hand, emitsLight: true },
    { equippable: true },
  );

export const journal = (): Item =>
  makeItem({ behaviorKey: Items.Journal, name: "Water-Stained Journal", type: ItemType.Consumable, recipe: { item: 1 }, modifier: 0, stat: StatType.Health });

export const poker = (): Item =>
  makeItem(
    { behaviorKey: Items.Poker, name: "Iron Fire-Poker", type: ItemType.Weapon, recipe: { metal: 1 }, modifier: 5, stat: StatType.Health, slot: SlotKind.Hand, maxDurability: 8 },
    { equippable: true },
  );

export const laudanum = (): Item =>
  makeItem({ behaviorKey: Items.Laudanum, name: "Vial of Laudanum", type: ItemType.Consumable, recipe: { healing: 1 }, modifier: 6, stat: StatType.Sanity }, { usable: true });

export const brassKey = (): Item => createKey({ name: "Brass Key", keyCode: "brass", consumeOnUse: false });
export const ironKey = (): Item => createKey({ name: "Iron Key", keyCode: "iron", consumeOnUse: false });

export const ITEM_FACTORIES: Record<string, () => Item> = {
  [Items.Lantern]: lantern,
  [Items.Journal]: journal,
  [Items.Poker]: poker,
  [Items.Laudanum]: laudanum,
  [Keys.Brass]: brassKey,
  [Keys.Iron]: ironKey,
};
```

(Note: `createKey` items are stored free and never dropped; the lantern is `ItemType.Weapon` so it can take a Hand slot, like the engine guide's torch. Confirm `Item`, `ItemType`, `createKey`, `ItemDescriptor` against `src/lib/inventory.ts` and `SlotKind` against `src/lib/equipment.ts`.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run packages/play/src/campaign/items.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/play/src/campaign/ids.ts packages/play/src/campaign/items.ts packages/play/src/campaign/items.test.ts
git commit -m "feat(play): campaign item and key factories"
```

---

### Task 4: Campaign — the Dread and Storyteller mechanics

**Files:**
- Create: `packages/play/src/campaign/mechanics.ts`
- Test: `packages/play/src/campaign/mechanics.test.ts`

**Interfaces:**
- Consumes: `Items` (ids), the engine `Mechanic`/`Effect`/`EffectKind` types, `StatType`.
- Produces: `dread: Mechanic<JsonObject>` (drains 1 Sanity on turn start unless the lantern is equipped) and `storyteller: Mechanic<JsonObject>` (on a `move`, if the actor holds the journal and the entered room has an unseen lore fragment, emits it once as a Cue). The lore table is injected via a factory `makeStoryteller(lore: Record<string, string>)`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/play/src/campaign/mechanics.test.ts
import { describe, it, expect } from "vitest";
import { dread, makeStoryteller } from "./mechanics";
import { EffectKind } from "wickedways/lib/mechanics/mechanic";
import { StatType } from "wickedways/lib/character/stats";
import { Items } from "./ids";

const actor = (over: Partial<{ id: string; equipped: string[]; items: string[] }> = {}) => ({
  id: "c1" as never,
  name: "Heir",
  health: 10, sanity: 10, energy: 10, status: [],
  roomId: "Cellar",
  hasEquipped: (k: string) => (over.equipped ?? []).includes(k),
  hasItem: (k: string) => (over.items ?? []).includes(k),
});
const ctx = (a: ReturnType<typeof actor>, action?: unknown) =>
  ({ actor: a, state: {}, action, view: { round: 1, maxRounds: 150, party: [], rooms: [] }, rng: () => 0.5, roll: () => 1 }) as never;

describe("dread", () => {
  it("drains 1 sanity when the lantern is not equipped", () => {
    const effects = dread.onTurnStart!(ctx(actor()));
    expect(effects).toEqual([{ kind: EffectKind.AdjustStat, target: "c1", stat: StatType.Sanity, delta: -1 }]);
  });
  it("does nothing when the lantern is equipped", () => {
    expect(dread.onTurnStart!(ctx(actor({ equipped: [Items.Lantern] })))).toEqual([]);
  });
});

describe("storyteller", () => {
  const lore = { Cellar: "The cellar reeks of old water." };
  it("emits the room's fragment once when holding the journal", () => {
    const m = makeStoryteller(lore);
    const state = m.initialState();
    const c = actor({ items: [Items.Journal] });
    const action = { kind: "move", room: { id: "r", name: "Cellar" } };
    const first = m.onAction!({ actor: c, state, action, view: { round: 1, maxRounds: 150, party: [], rooms: [] }, rng: () => 0.5, roll: () => 1 } as never);
    expect(first).toEqual([{ kind: EffectKind.Cue, cue: { text: "The cellar reeks of old water." } }]);
    const second = m.onAction!({ actor: c, state, action, view: { round: 1, maxRounds: 150, party: [], rooms: [] }, rng: () => 0.5, roll: () => 1 } as never);
    expect(second ?? []).toEqual([]);
  });
  it("stays silent without the journal", () => {
    const m = makeStoryteller(lore);
    const action = { kind: "move", room: { id: "r", name: "Cellar" } };
    const out = m.onAction!({ actor: actor(), state: m.initialState(), action, view: { round: 1, maxRounds: 150, party: [], rooms: [] }, rng: () => 0.5, roll: () => 1 } as never);
    expect(out ?? []).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/play/src/campaign/mechanics.test.ts`
Expected: FAIL — cannot find module `./mechanics`.

- [ ] **Step 3: Implement `mechanics.ts`**

```ts
import { EffectKind, type Mechanic, type JsonObject } from "wickedways/lib/mechanics/mechanic";
import { StatType } from "wickedways/lib/character/stats";
import { Items } from "./ids";

export const dread: Mechanic<JsonObject> = {
  initialState: () => ({}),
  onTurnStart: (ctx) =>
    ctx.actor.hasEquipped(Items.Lantern)
      ? []
      : [{ kind: EffectKind.AdjustStat, target: ctx.actor.id, stat: StatType.Sanity, delta: -1 }],
};

export function makeStoryteller(lore: Record<string, string>): Mechanic<JsonObject> {
  return {
    initialState: () => ({ seen: {} }),
    onAction: (ctx) => {
      if (ctx.action.kind !== "move") return [];
      const roomName = ctx.action.room.name;
      const fragment = lore[roomName];
      if (fragment === undefined) return [];
      if (!ctx.actor.hasItem(Items.Journal)) return [];
      const seen = (ctx.state.seen ??= {}) as Record<string, boolean>;
      if (seen[roomName]) return [];
      seen[roomName] = true;
      return [{ kind: EffectKind.Cue, cue: { text: fragment } }];
    },
  };
}
```

(Confirm `Mechanic`, `EffectKind`, the `onAction` ctx shape — `ctx.action` is an `ActionDetail` with a `move` variant `{ kind: "move"; room: { id; name } }` — against `src/lib/mechanics/mechanic.ts` and `src/lib/character/history.ts`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/play/src/campaign/mechanics.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/play/src/campaign/mechanics.ts packages/play/src/campaign/mechanics.test.ts
git commit -m "feat(play): Dread and Storyteller campaign mechanics"
```

---

### Task 5: Campaign — content tables, registry, template, and exports

**Files:**
- Create: `packages/play/src/campaign/content.ts`, `packages/play/src/campaign/index.ts`
- Test: `packages/play/src/campaign/index.test.ts`

**Interfaces:**
- Consumes: `ids`, `items` (`ITEM_FACTORIES`), `mechanics` (`dread`, `makeStoryteller`).
- Produces (from `content.ts`):
  - `LORE: Record<string, string>` (room name → fragment),
  - `LOCKED_DOORS: LockedDoor[]` where `LockedDoor = { id: string; from: string; dir: Direction; to: string; keyCode: string; consume: boolean; name: string }`,
  - `ALIASES: Record<string, string[]>` (behaviorKey/name → synonyms).
- Produces (from `index.ts`):
  - `buildHauntedHouseRegistry(): CampaignRegistry`,
  - `hauntedHouseTemplate(): TemplateBuilder<...>`,
  - re-exports `LORE`, `LOCKED_DOORS`, `ALIASES`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/play/src/campaign/index.test.ts
import { describe, it, expect } from "vitest";
import { buildHauntedHouseRegistry, hauntedHouseTemplate } from "./index";
import { startSession } from "wickedways/lib/authoring/orchestration";
import { Rooms, Archetypes } from "./ids";

describe("haunted house template", () => {
  it("builds without an AuthoringError and seats the player in the Foyer", () => {
    const builder = hauntedHouseTemplate();
    const campaign = startSession(builder, { players: [{ name: "Heir", archetype: Archetypes.Heir }], gm: 0 });
    expect(campaign.activeCharacter.currentRoom?.name).toBe(Rooms.Foyer);
    expect(campaign.maxRounds).toBe(150);
  });
  it("exposes the registry", () => {
    expect(buildHauntedHouseRegistry()).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/play/src/campaign/index.test.ts`
Expected: FAIL — cannot find module `./index`.

- [ ] **Step 3: Create `content.ts`**

```ts
import { Directions, type Direction } from "wickedways/lib/room";
import { Rooms, Items, Keys } from "./ids";

export interface LockedDoor {
  id: string;
  from: string;
  dir: Direction;
  to: string;
  keyCode: string;
  consume: boolean;
  name: string;
}

export const LOCKED_DOORS: LockedDoor[] = [
  { id: "study-door", from: Rooms.Landing, dir: Directions.West, to: Rooms.Study, keyCode: "brass", consume: false, name: "study door" },
  { id: "attic-door", from: Rooms.Landing, dir: Directions.North, to: Rooms.Attic, keyCode: "iron", consume: false, name: "attic door" },
];

export const LORE: Record<string, string> = {
  [Rooms.Parlor]: "A page of the journal clears: 'They would not let me bury her properly. The parlor still smells of lilies.'",
  [Rooms.Study]: "The journal's hand grows frantic here: 'The thing in the cellar wears her face now. The iron key keeps it down.'",
  [Rooms.Nursery]: "An entry, water-blurred: 'The child never cried. That was the first wrong thing.'",
  [Rooms.Cellar]: "The last legible page: 'If you are reading this in the dark, you have already lost the light. I am sorry.'",
  [Rooms.Attic]: "The final entry is unfinished — but you understand it now, standing where it ends.",
};

export const ALIASES: Record<string, string[]> = {
  [Items.Lantern]: ["lantern", "lamp", "light"],
  [Items.Journal]: ["journal", "diary", "book"],
  [Items.Poker]: ["poker", "fire-poker", "iron"],
  [Items.Laudanum]: ["laudanum", "vial", "tonic"],
  [Keys.Brass]: ["brass key", "brass", "key"],
  [Keys.Iron]: ["iron key", "iron", "key"],
};
```

(Confirm `Directions`/`Direction` against `src/lib/room.ts`.)

- [ ] **Step 4: Create `index.ts`**

```ts
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate, type TemplateBuilder } from "wickedways/lib/authoring/template-builder";
import type { CampaignRegistry } from "wickedways/lib/serialization/registry";
import type { ICampaign } from "wickedways/lib/campaign";
import { StatType } from "wickedways/lib/character/stats";
import { Status } from "wickedways/lib/status";
import { Directions } from "wickedways/lib/room";
import { ITEM_FACTORIES } from "./items";
import { dread, makeStoryteller } from "./mechanics";
import { LORE, ALIASES, LOCKED_DOORS } from "./content";
import { Rooms, Items, Keys, Mobs, Mechanics, Archetypes, Conditions } from "./ids";

export { LORE, ALIASES, LOCKED_DOORS } from "./content";
export type { LockedDoor } from "./content";

export function buildHauntedHouseRegistry(): CampaignRegistry {
  return defineRegistry({
    items: ITEM_FACTORIES,
    mechanics: { [Mechanics.Dread]: dread, [Mechanics.Storyteller]: makeStoryteller(LORE) },
    conditions: {
      [Conditions.ReachedAtticWithJournal]: (c: ICampaign) => {
        const pc = c.party[0];
        return pc?.currentRoom?.name === Rooms.Attic && pc.inventory.items.some((i) => i.behaviorKey === Items.Journal);
      },
      [Conditions.SanityZero]: (c: ICampaign) => c.party.some((p) => p.effectiveStat(StatType.Sanity) <= 0),
      [Conditions.PartyDown]: (c: ICampaign) => c.party.length > 0 && c.party.every((p) => p.status.includes(Status.KO)),
    },
  });
}

export function hauntedHouseTemplate(): TemplateBuilder<string, string> {
  const stats = () => ({ [StatType.Health]: 10, [StatType.Sanity]: 10, [StatType.Energy]: 10 });
  return authorTemplate("The Hollow House", buildHauntedHouseRegistry(), { maxRounds: 150, baseEncounterChance: 0, rng: () => 0.5 })
    .archetype({ id: Archetypes.Heir, name: "Heir", baseStats: { [StatType.Health]: 12, [StatType.Sanity]: 16 }, inventorySlots: 6, immunities: [Status.Fear] })
    // Rooms
    .room(Rooms.Foyer, { description: "The entrance hall of the Hollow House. Dust sheets shroud the furniture; the front door has locked itself behind you." })
    .room(Rooms.Cellar, { description: "A low brick cellar, black as a throat. Water seeps somewhere unseen.", dark: true })
    .room(Rooms.Hall, { description: "A long central hall. Portraits watch from the walls, their eyes scratched out." })
    .room(Rooms.Kitchen, { description: "A cold scullery. Copper pots hang in rows; one still sways." })
    .room(Rooms.Parlor, { description: "A receiving parlor gone to mildew. A piano sits with its lid nailed shut." })
    .room(Rooms.Landing, { description: "The upstairs landing. Two doors face you — one to the west, one leading further up — and a nursery stands open to the east." })
    .room(Rooms.Study, { description: "A cramped study, papers everywhere, as if someone left mid-sentence." })
    .room(Rooms.Nursery, { description: "A child's nursery. A rocking horse moves, very slightly, on its own.", dark: true })
    .room(Rooms.Attic, { description: "The attic, under the bare ribs of the roof. This is where the journal ends." })
    .startRoom(Rooms.Foyer)
    // Exits (one-way; declared both directions). Stairs/cellar use compass dirs.
    .exit(Rooms.Foyer, Directions.North, Rooms.Hall).exit(Rooms.Hall, Directions.South, Rooms.Foyer)
    .exit(Rooms.Foyer, Directions.South, Rooms.Cellar).exit(Rooms.Cellar, Directions.North, Rooms.Foyer)
    .exit(Rooms.Hall, Directions.West, Rooms.Kitchen).exit(Rooms.Kitchen, Directions.East, Rooms.Hall)
    .exit(Rooms.Hall, Directions.East, Rooms.Parlor).exit(Rooms.Parlor, Directions.West, Rooms.Hall)
    .exit(Rooms.Hall, Directions.North, Rooms.Landing).exit(Rooms.Landing, Directions.South, Rooms.Hall)
    .exit(Rooms.Landing, Directions.East, Rooms.Nursery).exit(Rooms.Nursery, Directions.West, Rooms.Landing)
    // NOTE: Landing↔Study (west) and Landing↔Attic (north) are intentionally NOT
    // declared — they are revealed by the session on unlock (see LOCKED_DOORS).
    // Loot
    .loot("foyer-table", { room: Rooms.Foyer, items: [Items.Journal], description: "A hall table with a single drawer." })
    .loot("hall-stand", { room: Rooms.Hall, items: [Items.Poker], description: "A fireplace stand." })
    .loot("kitchen-hook", { room: Rooms.Kitchen, items: [Items.Lantern], description: "A lantern hangs from a hook." })
    .loot("parlor-piano", { room: Rooms.Parlor, items: [Keys.Brass], description: "The piano stool lifts to reveal a compartment." })
    .loot("study-desk", { room: Rooms.Study, items: [Items.Laudanum], description: "A writing desk with a locked-open drawer." })
    // Mobs
    .mob(Mobs.Wraith, { stats: { [StatType.Health]: 6, [StatType.Sanity]: 5, [StatType.Energy]: 5 }, room: Rooms.Nursery, drops: [] })
    .mob(Mobs.Revenant, { stats: { [StatType.Health]: 10, [StatType.Sanity]: 8, [StatType.Energy]: 6 }, room: Rooms.Cellar, drops: [Keys.Iron] })
    // Mechanics + outcomes
    .useMechanic(Mechanics.Dread)
    .useMechanic(Mechanics.Storyteller)
    .winWhen(Conditions.ReachedAtticWithJournal, { text: "You climb into the attic with the journal in hand, and at last the house is only a house. You understand. You may leave." })
    .loseWhen(Conditions.SanityZero, { text: "The dark gets in. Your thoughts come apart like wet paper, and the Hollow House keeps what is left of you." })
    .loseWhen(Conditions.PartyDown, { text: "You fall, and do not rise. The house is patient. It has all the time there is." })
    .onTimeout({ text: "Dawn never comes. You realize, slowly, that it never will — and that you stopped looking for the door some hours ago." });
}
```

(Confirm builder method names/signatures — `.archetype`, `.room`, `.exit`, `.startRoom`, `.loot`, `.mob`, `.useMechanic`, `.winWhen`, `.loseWhen`, `.onTimeout` — against `src/lib/authoring/template-builder.ts`, and `Status` against `src/lib/status.ts`. `inventorySlots`/`immunities` on `.archetype` per the Get Wicked guide.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run packages/play/src/campaign/index.test.ts`
Expected: PASS. (If `AuthoringError` throws, read its `.problems` array — it lists every unresolved key — and fix the offending id/reference.)

- [ ] **Step 6: Commit**

```bash
git add packages/play/src/campaign/content.ts packages/play/src/campaign/index.ts packages/play/src/campaign/index.test.ts
git commit -m "feat(play): haunted house registry, template, and content tables"
```

---

### Task 6: Campaign — winning and losing path integration test

**Files:**
- Test: `packages/play/src/campaign/campaign.test.ts`

**Interfaces:**
- Consumes: `hauntedHouseTemplate`, `LOCKED_DOORS`, engine `startSession` and the assembled rooms. Because `startSession` hides the room map, this test reveals locked doors the same way the session will: it re-derives room references by walking exits and adds them with `addExit`. (The session, Task 10, holds the `assemble` room map and does this generically — this test proves the *content* is winnable using the same primitive.)

- [ ] **Step 1: Write the test (winning path)**

```ts
// packages/play/src/campaign/campaign.test.ts
import { describe, it, expect } from "vitest";
import { assemble } from "wickedways/lib/authoring/assembler";
import { PlayerCharacter } from "wickedways/lib/character/player-character";
import { hauntedHouseTemplate, LOCKED_DOORS } from "./index";
import { Rooms, Items, Mobs, Archetypes } from "./ids";
import { StatType } from "wickedways/lib/character/stats";
import { Status } from "wickedways/lib/status";
import type { IRoom } from "wickedways/lib/room";
import type { Campaign } from "wickedways/lib/campaign";

function boot(): { campaign: Campaign; rooms: Map<string, IRoom> } {
  const builder = hauntedHouseTemplate();
  const { campaign, rooms } = assemble(builder.description, builder.registry);
  const pc = new PlayerCharacter({ campaign, name: "Heir" });
  pc.joinCampaign();
  pc.selectArchetype(Archetypes.Heir as never);
  pc.move(rooms.get(Rooms.Foyer)!);
  campaign.gm = pc;
  campaign.beginCampaign();
  return { campaign, rooms };
}

const take = (pc: PlayerCharacter, name: string) => {
  const box = [...pc.currentRoom!.loot.values()].find((l) => l.contents.some((i) => i.name === name))!;
  pc.openLootBox(box);
  return pc.takeFromLootBox(box, box.contents.filter((i) => i.name === name));
};
const go = (pc: PlayerCharacter, room: IRoom) => { pc.startTurn(); pc.move(room); };

describe("The Hollow House — winning path", () => {
  it("is winnable: journal + lantern + poker, fell the Revenant for the iron key, iron-door → Attic", () => {
    const { campaign, rooms } = boot();
    const pc = campaign.activeCharacter as unknown as PlayerCharacter;

    take(pc, "Water-Stained Journal");              // Foyer loot (a regular item, allowed in loot)
    go(pc, rooms.get(Rooms.Hall)!); campaign.nextPlayer();
    take(pc, "Iron Fire-Poker"); pc.equip(pc.inventory.items.find((i) => i.name === "Iron Fire-Poker")!);
    go(pc, rooms.get(Rooms.Kitchen)!); campaign.nextPlayer();
    take(pc, "Brass Lantern"); pc.equip(pc.inventory.items.find((i) => i.name === "Brass Lantern")!);

    // Down to the cellar (lantern keeps Dread off), fell the Revenant, grab the iron key.
    // NOTE: the brass key / Study is an optional side-branch (covered by the next test) — the
    // win path needs only the journal + iron key + Attic.
    go(pc, rooms.get(Rooms.Hall)!); campaign.nextPlayer();
    go(pc, rooms.get(Rooms.Foyer)!); campaign.nextPlayer();
    go(pc, rooms.get(Rooms.Cellar)!); campaign.nextPlayer();
    const revenant = pc.currentRoom!.occupants.find((o) => o.name === Mobs.Revenant)!;
    for (let i = 0; i < 12 && !revenant.status.includes(Status.KO); i++) { pc.startTurn(); pc.attack(revenant); campaign.nextPlayer(); }
    expect(revenant.status).toContain(Status.KO);
    take(pc, "Iron Key");                           // dropped into the cellar's loot on defeat

    // Back up to the landing, reveal the attic door (what the session's unlock does), enter with the journal.
    go(pc, rooms.get(Rooms.Foyer)!); campaign.nextPlayer();
    go(pc, rooms.get(Rooms.Hall)!); campaign.nextPlayer();
    go(pc, rooms.get(Rooms.Landing)!); campaign.nextPlayer();
    const atticDoor = LOCKED_DOORS.find((d) => d.id === "attic-door")!;
    rooms.get(atticDoor.from)!.addExit(atticDoor.dir, rooms.get(atticDoor.to)!);
    rooms.get(atticDoor.to)!.addExit(reverse(atticDoor.dir), rooms.get(atticDoor.from)!);
    go(pc, rooms.get(Rooms.Attic)!); campaign.nextPlayer();

    expect(campaign.outcome).toBe("won");
  });

  it("the Wraith drops the brass key (the brass key is a mob drop, not loot)", () => {
    const { campaign, rooms } = boot();
    const pc = campaign.activeCharacter as unknown as PlayerCharacter;
    go(pc, rooms.get(Rooms.Hall)!); campaign.nextPlayer();
    take(pc, "Iron Fire-Poker"); pc.equip(pc.inventory.items.find((i) => i.name === "Iron Fire-Poker")!);
    go(pc, rooms.get(Rooms.Landing)!); campaign.nextPlayer();
    go(pc, rooms.get(Rooms.Nursery)!); campaign.nextPlayer();
    const wraith = pc.currentRoom!.occupants.find((o) => o.name === Mobs.Wraith)!;
    for (let i = 0; i < 12 && !wraith.status.includes(Status.KO); i++) { pc.startTurn(); pc.attack(wraith); campaign.nextPlayer(); }
    expect(wraith.status).toContain(Status.KO);
    take(pc, "Brass Key");
    expect(pc.inventory.keys.some((k) => k.keyCode === "brass")).toBe(true);
  });
});

// Local reverse-direction helper for the test (the session owns the real one).
import { Directions, type Direction } from "wickedways/lib/room";
function reverse(d: Direction): Direction {
  const m: Record<string, Direction> = {
    [Directions.North]: Directions.South, [Directions.South]: Directions.North,
    [Directions.East]: Directions.West, [Directions.West]: Directions.East,
    [Directions.Northeast]: Directions.Southwest, [Directions.Southwest]: Directions.Northeast,
    [Directions.Northwest]: Directions.Southeast, [Directions.Southeast]: Directions.Northwest,
  };
  return m[d]!;
}
```

- [ ] **Step 2: Run it; expect PASS**

Run: `pnpm vitest run packages/play/src/campaign/campaign.test.ts`
Expected: PASS. If the Revenant proves unkillable in 12 turns, raise the poker `modifier` (Task 3) or lower the Revenant `Health` (Task 5) — keep one clean kill window with the equipped poker. If `won` does not fire, log `campaign.outcomeReason`.

- [ ] **Step 3: Add the losing path**

Append to the same file:

```ts
describe("The Hollow House — losing path", () => {
  it("loses to Sanity drain when wandering the dark without the lantern", () => {
    const { campaign, rooms } = boot();
    const pc = campaign.activeCharacter as unknown as PlayerCharacter;
    // No lantern: Dread drains 1 Sanity per turn. Heir starts at Sanity 16.
    // Shuffle Foyer↔Hall until the bleed-out resolves the campaign.
    for (let i = 0; i < 40 && campaign.outcome === "ongoing"; i++) {
      pc.startTurn();
      pc.move(pc.currentRoom!.name === Rooms.Foyer ? rooms.get(Rooms.Hall)! : rooms.get(Rooms.Foyer)!);
      campaign.nextPlayer();
    }
    expect(campaign.outcome).toBe("lost");
  });
});
```

- [ ] **Step 4: Run the full campaign suite; expect PASS**

Run: `pnpm vitest run packages/play/src/campaign`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/play/src/campaign/campaign.test.ts
git commit -m "test(play): winning and losing path integration for the haunted house"
```

---

### Task 7: core/intent

**Files:**
- Create: `packages/play/src/core/intent.ts`
- Test: `packages/play/src/core/intent.test.ts`

**Interfaces:**
- Produces: the `Intent` union and `isTimeAdvancing(intent: Intent): boolean`.

```ts
// Intent union (the subset this campaign uses — no craft/harvest: no recipes/caches)
export type Intent =
  | { kind: "move"; dir: Direction }
  | { kind: "take"; targetId: string }
  | { kind: "drop"; targetId: string }
  | { kind: "open"; targetId: string }
  | { kind: "unlock"; doorId: string }
  | { kind: "attack"; targetId: string }
  | { kind: "equip"; targetId: string }
  | { kind: "unequip"; targetId: string }
  | { kind: "use"; targetId: string }
  | { kind: "talk"; npcId: string; prompt?: string }
  | { kind: "wait" };
```

- [ ] **Step 1: Write the failing test**

```ts
// packages/play/src/core/intent.test.ts
import { describe, it, expect } from "vitest";
import { isTimeAdvancing, type Intent } from "./intent";

describe("isTimeAdvancing", () => {
  it("advances time for world-changing intents", () => {
    for (const k of ["move", "take", "drop", "use", "attack", "unlock", "wait"] as const) {
      expect(isTimeAdvancing({ kind: k } as Intent)).toBe(true);
    }
  });
  it("is free for housekeeping intents", () => {
    for (const k of ["open", "equip", "unequip"] as const) {
      expect(isTimeAdvancing({ kind: k } as Intent)).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run; expect FAIL** (`cannot find module ./intent`).

Run: `pnpm vitest run packages/play/src/core/intent.test.ts`

- [ ] **Step 3: Implement `intent.ts`**

```ts
import type { Direction } from "wickedways/lib/room";

export type Intent =
  | { kind: "move"; dir: Direction }
  | { kind: "take"; targetId: string }
  | { kind: "drop"; targetId: string }
  | { kind: "open"; targetId: string }
  | { kind: "unlock"; doorId: string }
  | { kind: "attack"; targetId: string }
  | { kind: "equip"; targetId: string }
  | { kind: "unequip"; targetId: string }
  | { kind: "use"; targetId: string }
  | { kind: "talk"; npcId: string; prompt?: string }
  | { kind: "wait" };

const TIME_ADVANCING = new Set(["move", "take", "drop", "use", "attack", "unlock", "wait", "talk"]);

export function isTimeAdvancing(intent: Intent): boolean {
  return TIME_ADVANCING.has(intent.kind);
}
```

- [ ] **Step 4: Run; expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add packages/play/src/core/intent.ts packages/play/src/core/intent.test.ts
git commit -m "feat(play): Intent union and time-advancement classifier"
```

---

### Task 8: core/savestore

**Files:**
- Create: `packages/play/src/core/savestore.ts`
- Test: `packages/play/src/core/savestore.test.ts`

**Interfaces:**
- Produces: `interface SaveStore` (async) and `class LocalStorageSaveStore implements SaveStore`. `interface SaveSlot { slot: string; savedAt: number }`.

```ts
import type { CampaignSnapshot } from "wickedways/lib/serialization/types";
export interface SaveSlot { slot: string; savedAt: number; }
export interface SaveStore {
  list(): Promise<SaveSlot[]>;
  save(slot: string, snapshot: CampaignSnapshot, savedAt: number): Promise<void>;
  load(slot: string): Promise<CampaignSnapshot | null>;
  delete(slot: string): Promise<void>;
}
```

(`savedAt` is passed in by the caller — the engine forbids ambient `Date.now()` only in workflows, but to keep the store pure and testable the timestamp is an argument.)

- [ ] **Step 1: Write the failing test** (uses an in-memory `localStorage` stub)

```ts
// packages/play/src/core/savestore.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { LocalStorageSaveStore } from "./savestore";
import type { CampaignSnapshot } from "wickedways/lib/serialization/types";

class MemStorage {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  get length() { return this.m.size; }
}

const snap = { schemaVersion: 5, campaign: { title: "x" } } as unknown as CampaignSnapshot;

describe("LocalStorageSaveStore", () => {
  let store: LocalStorageSaveStore;
  beforeEach(() => { store = new LocalStorageSaveStore(new MemStorage() as unknown as Storage); });

  it("round-trips a snapshot", async () => {
    await store.save("slot1", snap, 1000);
    expect(await store.load("slot1")).toEqual(snap);
  });
  it("lists saved slots with timestamps", async () => {
    await store.save("a", snap, 1000);
    await store.save("b", snap, 2000);
    expect((await store.list()).map((s) => s.slot).sort()).toEqual(["a", "b"]);
  });
  it("returns null for a missing slot and deletes", async () => {
    expect(await store.load("ghost")).toBeNull();
    await store.save("c", snap, 1);
    await store.delete("c");
    expect(await store.load("c")).toBeNull();
  });
});
```

- [ ] **Step 2: Run; expect FAIL.**

Run: `pnpm vitest run packages/play/src/core/savestore.test.ts`

- [ ] **Step 3: Implement `savestore.ts`**

```ts
import type { CampaignSnapshot } from "wickedways/lib/serialization/types";

export interface SaveSlot { slot: string; savedAt: number; }
export interface SaveStore {
  list(): Promise<SaveSlot[]>;
  save(slot: string, snapshot: CampaignSnapshot, savedAt: number): Promise<void>;
  load(slot: string): Promise<CampaignSnapshot | null>;
  delete(slot: string): Promise<void>;
}

interface Envelope { savedAt: number; snapshot: CampaignSnapshot; }
const PREFIX = "wickedways:save:";

export class LocalStorageSaveStore implements SaveStore {
  constructor(private readonly storage: Storage = globalThis.localStorage) {}

  async list(): Promise<SaveSlot[]> {
    const out: SaveSlot[] = [];
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (key === null || !key.startsWith(PREFIX)) continue;
      const raw = this.storage.getItem(key);
      if (raw === null) continue;
      const env = JSON.parse(raw) as Envelope;
      out.push({ slot: key.slice(PREFIX.length), savedAt: env.savedAt });
    }
    return out;
  }
  async save(slot: string, snapshot: CampaignSnapshot, savedAt: number): Promise<void> {
    const env: Envelope = { savedAt, snapshot };
    this.storage.setItem(PREFIX + slot, JSON.stringify(env));
  }
  async load(slot: string): Promise<CampaignSnapshot | null> {
    const raw = this.storage.getItem(PREFIX + slot);
    if (raw === null) return null;
    return (JSON.parse(raw) as Envelope).snapshot;
  }
  async delete(slot: string): Promise<void> {
    this.storage.removeItem(PREFIX + slot);
  }
}
```

- [ ] **Step 4: Run; expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add packages/play/src/core/savestore.ts packages/play/src/core/savestore.test.ts
git commit -m "feat(play): async SaveStore interface + LocalStorage implementation"
```

---

### Task 9: core/viewmodel

**Files:**
- Create: `packages/play/src/core/viewmodel.ts`
- Test: `packages/play/src/core/viewmodel.test.ts`

**Interfaces:**
- Consumes: a live `Campaign`, the `LockedDoor[]` table, the `ALIASES` map.
- Produces: `view(campaign, doors, aliases): ViewModel` and these types:

```ts
export type ScopeKind = "occupant" | "item" | "loot" | "door";
export interface ScopeEntity { id: string; name: string; aliases: string[]; kind: ScopeKind; }
export interface ExitView { dir: Direction; toName: string; }
export interface LockedDoorView { id: string; name: string; dir: Direction; }
export interface LootView { id: string; description: string; opened: boolean; contents: ScopeEntity[]; }
export interface ViewModel {
  room: { id: string; name: string; description: string; isLit: boolean };
  exits: ExitView[];
  lockedDoors: LockedDoorView[];
  occupants: ScopeEntity[];
  loot: LootView[];
  inventory: { items: ScopeEntity[]; keys: ScopeEntity[]; equippedNames: string[] };
  scope: ScopeEntity[];
  status: { locationName: string; turn: number; maxTurns: number; sanity: number; health: number };
  outcome: string;
  finished: boolean;
}
```

- [ ] **Step 1: Write the failing test**

```ts
// packages/play/src/core/viewmodel.test.ts
import { describe, it, expect } from "vitest";
import { assemble } from "wickedways/lib/authoring/assembler";
import { PlayerCharacter } from "wickedways/lib/character/player-character";
import { hauntedHouseTemplate, LOCKED_DOORS, ALIASES } from "../campaign/index";
import { Rooms, Archetypes } from "../campaign/ids";
import { view } from "./viewmodel";

function bootInLanding() {
  const builder = hauntedHouseTemplate();
  const { campaign, rooms } = assemble(builder.description, builder.registry);
  const pc = new PlayerCharacter({ campaign, name: "Heir" });
  pc.joinCampaign(); pc.selectArchetype(Archetypes.Heir as never);
  pc.move(rooms.get(Rooms.Landing)!); campaign.gm = pc; campaign.beginCampaign();
  return { campaign, rooms };
}

describe("viewmodel", () => {
  it("reports the room, exits, and locked doors in scope", () => {
    const { campaign } = bootInLanding();
    const vm = view(campaign, LOCKED_DOORS, ALIASES);
    expect(vm.room.name).toBe(Rooms.Landing);
    expect(vm.exits.map((e) => e.toName)).toContain(Rooms.Nursery);   // open exit
    expect(vm.exits.map((e) => e.toName)).not.toContain(Rooms.Study); // locked, not yet revealed
    expect(vm.lockedDoors.map((d) => d.id).sort()).toEqual(["attic-door", "study-door"]);
    // a locked door is a resolvable scope entity
    expect(vm.scope.some((s) => s.kind === "door" && s.aliases.includes("study door"))).toBe(true);
  });
  it("includes the Foyer's start-room journal loot in scope once opened", () => {
    const builder = hauntedHouseTemplate();
    const { campaign, rooms } = assemble(builder.description, builder.registry);
    const pc = new PlayerCharacter({ campaign, name: "Heir" });
    pc.joinCampaign(); pc.selectArchetype(Archetypes.Heir as never);
    pc.move(rooms.get(Rooms.Foyer)!); campaign.gm = pc; campaign.beginCampaign();
    const box = [...pc.currentRoom!.loot.values()][0]!;
    pc.openLootBox(box);
    const vm = view(campaign, LOCKED_DOORS, ALIASES);
    expect(vm.loot[0]!.opened).toBe(true);
    expect(vm.scope.some((s) => s.kind === "item" && s.name === "Water-Stained Journal")).toBe(true);
  });
});
```

- [ ] **Step 2: Run; expect FAIL.**

Run: `pnpm vitest run packages/play/src/core/viewmodel.test.ts`

- [ ] **Step 3: Implement `viewmodel.ts`**

```ts
import type { Campaign } from "wickedways/lib/campaign";
import type { Direction } from "wickedways/lib/room";
import { StatType } from "wickedways/lib/character/stats";
import type { LockedDoor } from "../campaign/content";

export type ScopeKind = "occupant" | "item" | "loot" | "door";
export interface ScopeEntity { id: string; name: string; aliases: string[]; kind: ScopeKind; }
export interface ExitView { dir: Direction; toName: string; }
export interface LockedDoorView { id: string; name: string; dir: Direction; }
export interface LootView { id: string; description: string; opened: boolean; contents: ScopeEntity[]; }
export interface ViewModel {
  room: { id: string; name: string; description: string; isLit: boolean };
  exits: ExitView[];
  lockedDoors: LockedDoorView[];
  occupants: ScopeEntity[];
  loot: LootView[];
  inventory: { items: ScopeEntity[]; keys: ScopeEntity[]; equippedNames: string[] };
  scope: ScopeEntity[];
  status: { locationName: string; turn: number; maxTurns: number; sanity: number; health: number };
  outcome: string;
  finished: boolean;
}

const aliasesFor = (behaviorKey: string | undefined, name: string, aliases: Record<string, string[]>): string[] => {
  const fromTable = behaviorKey !== undefined ? aliases[behaviorKey] ?? [] : [];
  return [...new Set([name.toLowerCase(), ...fromTable])];
};

// A loot container is "opened" once the player has issued openLootBox; the engine
// tracks no opened flag, so the session passes the set of opened loot ids in.
export function view(campaign: Campaign, doors: LockedDoor[], aliases: Record<string, string[]>, openedLootIds: ReadonlySet<string> = new Set()): ViewModel {
  const pc = campaign.activeCharacter;
  const room = pc.currentRoom!;
  const roomName = room.name;

  const occupants: ScopeEntity[] = room.occupants
    .filter((o) => o.id !== pc.id)
    .map((o) => ({ id: o.id, name: o.name, aliases: [o.name.toLowerCase()], kind: "occupant" as const }));

  const loot: LootView[] = [...room.loot.values()].map((l) => {
    const opened = openedLootIds.has(l.id);
    return {
      id: l.id,
      description: l.description,
      opened,
      contents: l.contents.map((i) => ({ id: i.id, name: i.name, aliases: aliasesFor(i.behaviorKey, i.name, aliases), kind: "item" as const })),
    };
  });

  const items: ScopeEntity[] = pc.inventory.items.map((i) => ({ id: i.id, name: i.name, aliases: aliasesFor(i.behaviorKey, i.name, aliases), kind: "item" as const }));
  const keys: ScopeEntity[] = pc.inventory.keys.map((k) => ({ id: k.id, name: k.name, aliases: aliasesFor(k.behaviorKey, k.name, aliases), kind: "item" as const }));

  const exits: ExitView[] = [...room.exits.entries()].map(([dir, to]) => ({ dir, toName: to.name }));

  const lockedDoors: LockedDoorView[] = doors
    .filter((d) => d.from === roomName && !room.exits.has(d.dir))
    .map((d) => ({ id: d.id, name: d.name, dir: d.dir }));

  const doorScope: ScopeEntity[] = lockedDoors.map((d) => ({ id: d.id, name: d.name, aliases: [d.name, "door"], kind: "door" as const }));

  // scope: things the player can name this turn. Loot contents only once opened.
  const lootContentScope = loot.filter((l) => l.opened).flatMap((l) => l.contents);
  const scope = [...occupants, ...lootContentScope, ...items, ...keys, ...doorScope,
    ...loot.map((l) => ({ id: l.id, name: l.description, aliases: ["chest", "box", "drawer", "container"], kind: "loot" as const }))];

  return {
    room: { id: room.id, name: roomName, description: room.description, isLit: room.isLit },
    exits,
    lockedDoors,
    occupants,
    loot,
    inventory: { items, keys, equippedNames: [...pc.equipment.values()].map((i) => i.name) },
    scope,
    status: { locationName: roomName, turn: campaign.round, maxTurns: campaign.maxRounds, sanity: pc.effectiveStat(StatType.Sanity), health: pc.effectiveStat(StatType.Health) },
    outcome: campaign.outcome,
    finished: campaign.finished,
  };
}
```

(Confirm `room.exits` is a `Map<Direction, IRoom>` and `room.loot` a `Map<LootId, ILoot>` with `.contents`, `.description`, `.id`; `pc.equipment` a `Map`; `effectiveStat` per the engine reference.)

- [ ] **Step 4: Run; expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add packages/play/src/core/viewmodel.ts packages/play/src/core/viewmodel.test.ts
git commit -m "feat(play): render-agnostic viewmodel with scope and locked doors"
```

---

### Task 10: core/session — `GameSession`

**Files:**
- Create: `packages/play/src/core/session.ts`
- Test: `packages/play/src/core/session.test.ts`

**Interfaces:**
- Consumes: `Intent`/`isTimeAdvancing`, `view`/`ViewModel`, `SaveStore`, `LockedDoor`, the campaign's `hauntedHouseTemplate`/`buildHauntedHouseRegistry`/`LOCKED_DOORS`/`ALIASES`, and the engine `assemble`, `PlayerCharacter`, `serializeCampaign`, `deserializeCampaign`, `Directions`.
- Produces:

```ts
export interface ExecuteResult { cues: PresentationCue[]; error?: string; }
export interface SessionOptions {
  builder: TemplateBuilder<string, string>;
  registry: CampaignRegistry;
  doors: LockedDoor[];
  aliases: Record<string, string[]>;
  playerName: string;
  archetype?: string;
  saveStore: SaveStore;
  now: () => number;          // injected clock (no ambient Date.now)
  rng?: () => number;
}
export class GameSession {
  static start(opts: SessionOptions): GameSession;
  view(): ViewModel;
  execute(intent: Intent): ExecuteResult;
  get finished(): boolean;
  get outcome(): string;
  save(slot: string): Promise<void>;
  restore(slot: string): Promise<boolean>;
  undo(): boolean;
}
```

- [ ] **Step 1: Write the failing test**

```ts
// packages/play/src/core/session.test.ts
import { describe, it, expect } from "vitest";
import { GameSession } from "./session";
import { hauntedHouseTemplate, buildHauntedHouseRegistry, LOCKED_DOORS, ALIASES } from "../campaign/index";
import { LocalStorageSaveStore } from "./savestore";
import { Rooms, Items, Archetypes } from "../campaign/ids";
import { Directions } from "wickedways/lib/room";

class MemStorage {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  get length() { return this.m.size; }
}

function newSession() {
  return GameSession.start({
    builder: hauntedHouseTemplate(),
    registry: buildHauntedHouseRegistry(),
    doors: LOCKED_DOORS,
    aliases: ALIASES,
    playerName: "Heir",
    archetype: Archetypes.Heir,
    saveStore: new LocalStorageSaveStore(new MemStorage() as unknown as Storage),
    now: () => 1234,
    rng: () => 0.5,
  });
}

describe("GameSession", () => {
  it("starts the player in the Foyer", () => {
    expect(newSession().view().room.name).toBe(Rooms.Foyer);
  });
  it("a move advances the round; an open does not", () => {
    const s = newSession();
    const before = s.view().status.turn;
    s.execute({ kind: "move", dir: Directions.North });
    expect(s.view().room.name).toBe(Rooms.Hall);
    expect(s.view().status.turn).toBe(before + 1);
    const afterMove = s.view().status.turn;
    const box = s.view().loot[0]!;
    s.execute({ kind: "open", targetId: box.id });
    expect(s.view().status.turn).toBe(afterMove); // open is free
    expect(s.view().loot[0]!.opened).toBe(true);
  });
  // Helpers for the unlock success path. (The brass key is a Wraith drop — keys
  // cannot be authored into loot — so the only legitimate route is through combat.)
  const openTake = (s: GameSession, name: string): void => {
    const box = s.view().loot.find((l) => l.contents.some((c) => c.name === name))!;
    s.execute({ kind: "open", targetId: box.id });
    const item = s.view().scope.find((e) => e.name === name)!;
    s.execute({ kind: "take", targetId: item.id });
  };
  const equipNamed = (s: GameSession, name: string): void => {
    const item = s.view().inventory.items.find((i) => i.name === name)!;
    s.execute({ kind: "equip", targetId: item.id });
  };

  it("unlock fails in-voice without the matching key, and reveals nothing", () => {
    const s = newSession();
    s.execute({ kind: "move", dir: Directions.North });   // Hall
    s.execute({ kind: "move", dir: Directions.North });   // Landing
    const door = s.view().lockedDoors.find((d) => d.id === "study-door")!;
    const res = s.execute({ kind: "unlock", doorId: door.id });
    expect(res.error).toBeTruthy();
    expect(s.view().exits.map((e) => e.toName)).not.toContain(Rooms.Study);
  });

  it("unlock reveals the study door once the brass key (a Wraith drop) is in hand", () => {
    const s = newSession();
    // Mirror the proven winning sequence: equip poker + lantern (the lantern is
    // required to fight in the dark Nursery), then fell the Wraith for the brass key.
    s.execute({ kind: "move", dir: Directions.North });   // Hall
    openTake(s, "Iron Fire-Poker"); equipNamed(s, "Iron Fire-Poker");
    s.execute({ kind: "move", dir: Directions.West });    // Kitchen
    openTake(s, "Brass Lantern"); equipNamed(s, "Brass Lantern");
    s.execute({ kind: "move", dir: Directions.East });    // Hall
    s.execute({ kind: "move", dir: Directions.North });   // Landing
    s.execute({ kind: "move", dir: Directions.East });    // Nursery
    const wraith = s.view().occupants.find((o) => o.name === "Wraith")!;
    for (let i = 0; i < 10; i++) s.execute({ kind: "attack", targetId: wraith.id }); // KO'd early; later attacks no-op via caught error
    openTake(s, "Brass Key");                              // dropped into the Nursery on defeat
    s.execute({ kind: "move", dir: Directions.West });    // Landing
    const door = s.view().lockedDoors.find((d) => d.id === "study-door")!;
    s.execute({ kind: "unlock", doorId: door.id });
    expect(s.view().exits.map((e) => e.toName)).toContain(Rooms.Study);
  });
  it("save then restore reproduces location and inventory", async () => {
    const s = newSession();
    s.execute({ kind: "move", dir: Directions.North });
    await s.save("slot1");
    s.execute({ kind: "move", dir: Directions.West });    // Kitchen
    expect(s.view().room.name).toBe(Rooms.Kitchen);
    expect(await s.restore("slot1")).toBe(true);
    expect(s.view().room.name).toBe(Rooms.Hall);
  });
  it("undo reverts the last time-advancing command", () => {
    const s = newSession();
    s.execute({ kind: "move", dir: Directions.North });
    expect(s.view().room.name).toBe(Rooms.Hall);
    expect(s.undo()).toBe(true);
    expect(s.view().room.name).toBe(Rooms.Foyer);
  });
});
```

- [ ] **Step 2: Run; expect FAIL.**

Run: `pnpm vitest run packages/play/src/core/session.test.ts`

- [ ] **Step 3: Implement `session.ts`**

```ts
import { assemble } from "wickedways/lib/authoring/assembler";
import { PlayerCharacter } from "wickedways/lib/character/player-character";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { deserializeCampaign } from "wickedways/lib/serialization/deserializer";
import { ProceduralViolation } from "wickedways/lib/util";
import { Directions, type Direction, type IRoom } from "wickedways/lib/room";
import type { Campaign } from "wickedways/lib/campaign";
import type { CampaignRegistry } from "wickedways/lib/serialization/registry";
import type { CampaignSnapshot } from "wickedways/lib/serialization/types";
import type { PresentationCue } from "wickedways/lib/presentation";
import type { TemplateBuilder } from "wickedways/lib/authoring/template-builder";
import type { ArchetypeId } from "wickedways/lib/archetype";
import type { ILoot } from "wickedways/lib/loot";
import type { IItem } from "wickedways/lib/inventory";
import { isTimeAdvancing, type Intent } from "./intent";
import { view, type ViewModel } from "./viewmodel";
import type { SaveStore } from "./savestore";
import type { LockedDoor } from "../campaign/content";

const REVERSE: Record<string, Direction> = {
  [Directions.North]: Directions.South, [Directions.South]: Directions.North,
  [Directions.East]: Directions.West, [Directions.West]: Directions.East,
  [Directions.Northeast]: Directions.Southwest, [Directions.Southwest]: Directions.Northeast,
  [Directions.Northwest]: Directions.Southeast, [Directions.Southeast]: Directions.Northwest,
};

export interface ExecuteResult { cues: PresentationCue[]; error?: string; }
export interface SessionOptions {
  builder: TemplateBuilder<string, string>;
  registry: CampaignRegistry;
  doors: LockedDoor[];
  aliases: Record<string, string[]>;
  playerName: string;
  archetype?: string;
  saveStore: SaveStore;
  now: () => number;
  rng?: () => number;
}

export class GameSession {
  private campaign!: Campaign;
  private rooms!: Map<string, IRoom>;
  private readonly cueBuffer: PresentationCue[] = [];
  private readonly opened = new Set<string>();
  private undoSnapshot: CampaignSnapshot | null = null;

  private constructor(private readonly opts: SessionOptions) {}

  static start(opts: SessionOptions): GameSession {
    const s = new GameSession(opts);
    s.boot(opts.builder);
    return s;
  }

  private boot(builder: TemplateBuilder<string, string>): void {
    const { campaign, rooms } = assemble(builder.description, builder.registry);
    this.campaign = campaign;
    this.rooms = rooms;
    const pc = new PlayerCharacter({ campaign, name: this.opts.playerName });
    pc.joinCampaign();
    if (this.opts.archetype !== undefined) pc.selectArchetype(this.opts.archetype as ArchetypeId);
    pc.move(rooms.get(builder.description.startRoom!)!);
    campaign.gm = pc;
    campaign.beginCampaign();
    campaign.onCue((cue) => this.cueBuffer.push(cue));
  }

  // Re-derive the rooms map after restore by walking exits from every party room.
  // (Disconnected rooms that were never unlocked stay disconnected on restore,
  // which is correct: their unlocked state lives in room.exits and was serialized.)
  private reindexRooms(): void {
    const map = new Map<string, IRoom>();
    const seen = new Set<string>();
    const queue: IRoom[] = [];
    for (const p of this.campaign.party) { const r = p.currentRoom; if (r) queue.push(r); }
    while (queue.length) {
      const r = queue.shift()!;
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      map.set(r.name, r);
      for (const next of r.exits.values()) queue.push(next);
    }
    this.rooms = map;
  }

  view(): ViewModel {
    return view(this.campaign, this.opts.doors, this.opts.aliases, this.opened);
  }
  get finished(): boolean { return this.campaign.finished; }
  get outcome(): string { return this.campaign.outcome; }

  execute(intent: Intent): ExecuteResult {
    this.cueBuffer.length = 0;
    const advances = isTimeAdvancing(intent);
    const pre = serializeCampaign(this.campaign, { rootRooms: this.rooms.values() });
    try {
      if (advances) this.campaign.activeCharacter.startTurn();
      this.dispatch(intent);
      if (advances) this.campaign.nextPlayer();
      if (advances) this.undoSnapshot = pre;
      return { cues: [...this.cueBuffer] };
    } catch (e) {
      if (e instanceof ProceduralViolation) return { cues: [...this.cueBuffer], error: e.message };
      throw e;
    }
  }

  private dispatch(intent: Intent): void {
    const pc = this.campaign.activeCharacter;
    const room = pc.currentRoom!;
    switch (intent.kind) {
      case "move": {
        const to = room.exits.get(intent.dir);
        if (!to) throw new ProceduralViolation("You can't go that way.");
        pc.move(to);
        return;
      }
      case "wait": return;
      case "open": {
        const loot = [...room.loot.values()].find((l) => l.id === intent.targetId);
        if (!loot) throw new ProceduralViolation("There's nothing like that to open here.");
        pc.openLootBox(loot);
        this.opened.add(loot.id);
        return;
      }
      case "take": {
        const { loot, item } = this.findInOpenedLoot(intent.targetId);
        pc.takeFromLootBox(loot, [item]);
        return;
      }
      case "drop": {
        const item = pc.inventory.items.find((i) => i.id === intent.targetId);
        if (!item) throw new ProceduralViolation("You aren't carrying that.");
        pc.drop([item]);
        return;
      }
      case "equip": {
        const item = pc.inventory.items.find((i) => i.id === intent.targetId);
        if (!item) throw new ProceduralViolation("You aren't carrying that.");
        pc.equip(item);
        return;
      }
      case "unequip": {
        const item = [...pc.equipment.values()].find((i) => i.id === intent.targetId);
        if (!item) throw new ProceduralViolation("That isn't equipped.");
        pc.unequip(item);
        return;
      }
      case "use": {
        const item = pc.inventory.items.find((i) => i.id === intent.targetId);
        if (!item) throw new ProceduralViolation("You aren't carrying that.");
        item.actions.use(pc);
        return;
      }
      case "attack": {
        const target = room.occupants.find((o) => o.id === intent.targetId);
        if (!target) throw new ProceduralViolation("There's nothing like that to attack here.");
        pc.attack(target);
        return;
      }
      case "unlock": {
        this.unlock(intent.doorId);
        return;
      }
      case "talk": {
        // No NPCs in this campaign; dialogue is reserved for future content.
        throw new ProceduralViolation("There's no one here to talk to.");
      }
    }
  }

  private findInOpenedLoot(itemId: string): { loot: ILoot; item: IItem } {
    const room = this.campaign.activeCharacter.currentRoom!;
    for (const loot of room.loot.values()) {
      if (!this.opened.has(loot.id)) continue;
      const item = loot.contents.find((i) => i.id === itemId);
      if (item) return { loot, item };
    }
    throw new ProceduralViolation("You don't see that here.");
  }

  private unlock(doorId: string): void {
    const pc = this.campaign.activeCharacter;
    const door = this.opts.doors.find((d) => d.id === doorId);
    if (!door || pc.currentRoom!.name !== door.from) throw new ProceduralViolation("There's no such door here.");
    if (pc.currentRoom!.exits.has(door.dir)) throw new ProceduralViolation("That way is already open.");
    const key = pc.inventory.keys.find((k) => k.keyCode === door.keyCode);
    if (!key) throw new ProceduralViolation(`The ${door.name} won't budge — you don't have the right key.`);
    const from = this.rooms.get(door.from)!;
    const to = this.rooms.get(door.to)!;
    from.addExit(door.dir, to);
    to.addExit(REVERSE[door.dir]!, from);
    if (door.consume) pc.consumeKey(key);
  }

  async save(slot: string): Promise<void> {
    const snapshot = serializeCampaign(this.campaign, { rootRooms: this.rooms.values() });
    await this.opts.saveStore.save(slot, snapshot, this.opts.now());
  }
  async restore(slot: string): Promise<boolean> {
    const snapshot = await this.opts.saveStore.load(slot);
    if (!snapshot) return false;
    this.loadSnapshot(snapshot);
    return true;
  }
  undo(): boolean {
    if (!this.undoSnapshot) return false;
    this.loadSnapshot(this.undoSnapshot);
    this.undoSnapshot = null;
    return true;
  }

  private loadSnapshot(snapshot: CampaignSnapshot): void {
    this.campaign = deserializeCampaign(snapshot, { registry: this.opts.registry, rng: this.opts.rng });
    this.campaign.onCue((cue) => this.cueBuffer.push(cue));
    this.opened.clear();
    this.reindexRooms();
  }
}
```

(Confirm: `pc.drop(items[])` exists on the player; `item.actions.use(character)` is the public use path; `serializeCampaign(campaign, { rootRooms })` and `deserializeCampaign(snapshot, { registry, rng })` signatures; `pc.consumeKey(key)`. If `drop` is named differently, adjust. The `rootRooms` option is required because the BFS is party-rooted and must include disconnected-but-unlocked rooms.)

- [ ] **Step 4: Run; expect PASS.**

Run: `pnpm vitest run packages/play/src/core/session.test.ts`
Expected: PASS. If `restore` loses the start room, verify `serializeCampaign` is receiving `rootRooms` and that `reindexRooms` runs after deserialize.

- [ ] **Step 5: Commit**

```bash
git add packages/play/src/core/session.ts packages/play/src/core/session.test.ts
git commit -m "feat(play): GameSession driving the live campaign with save/restore/undo"
```

---

### Task 11: text/parser

**Files:**
- Create: `packages/play/src/text/parser.ts`
- Test: `packages/play/src/text/parser.test.ts`

**Interfaces:**
- Consumes: `Intent`, `ViewModel`/`ScopeEntity`, `Directions`/`Direction`.
- Produces: `parse(input: string, vm: ViewModel): ParseResult`.

```ts
export type ParseResult =
  | { kind: "intent"; intent: Intent }
  | { kind: "query"; query: "look" | "inventory" | "exits" | "help"; }
  | { kind: "examine"; target: ScopeEntity }
  | { kind: "meta"; meta: "save" | "restore" | "undo" }
  | { kind: "ambiguous"; candidates: ScopeEntity[] }
  | { kind: "error"; message: string };
```

(The narrator renders `query`/`examine` locally from the viewmodel; the UI routes `meta` to the session. Keeping examine/query structured — not pre-rendered strings — lets a future GUI reuse the parser.)

- [ ] **Step 1: Write the failing tests**

```ts
// packages/play/src/text/parser.test.ts
import { describe, it, expect } from "vitest";
import { parse } from "./parser";
import { Directions } from "wickedways/lib/room";
import type { ViewModel, ScopeEntity } from "../core/viewmodel";

const ent = (id: string, name: string, aliases: string[], kind: ScopeEntity["kind"]): ScopeEntity => ({ id, name, aliases, kind });
const vm = (over: Partial<ViewModel> = {}): ViewModel => ({
  room: { id: "r", name: "Hall", description: "a hall", isLit: true },
  exits: [{ dir: Directions.North, toName: "Landing" }],
  lockedDoors: [],
  occupants: [],
  loot: [],
  inventory: { items: [], keys: [], equippedNames: [] },
  scope: [],
  status: { locationName: "Hall", turn: 1, maxTurns: 150, sanity: 10, health: 10 },
  outcome: "ongoing",
  finished: false,
  ...over,
});

describe("parser — movement", () => {
  it("maps directions and abbreviations to a move intent", () => {
    expect(parse("north", vm())).toEqual({ kind: "intent", intent: { kind: "move", dir: Directions.North } });
    expect(parse("n", vm())).toEqual({ kind: "intent", intent: { kind: "move", dir: Directions.North } });
    expect(parse("go north", vm())).toEqual({ kind: "intent", intent: { kind: "move", dir: Directions.North } });
  });
});

describe("parser — meta and queries", () => {
  it("recognizes look/inventory/exits/help and save/restore/undo", () => {
    expect(parse("look", vm())).toEqual({ kind: "query", query: "look" });
    expect(parse("i", vm())).toEqual({ kind: "query", query: "inventory" });
    expect(parse("save", vm())).toEqual({ kind: "meta", meta: "save" });
    expect(parse("undo", vm())).toEqual({ kind: "meta", meta: "undo" });
  });
});

describe("parser — noun resolution", () => {
  const key = ent("k1", "Brass Key", ["brass key", "brass", "key"], "item");
  it("strips articles and resolves a take by alias", () => {
    const v = vm({ scope: [key] });
    expect(parse("take the brass key", v)).toEqual({ kind: "intent", intent: { kind: "take", targetId: "k1" } });
  });
  it("returns an error when the noun is not in scope", () => {
    expect(parse("take lantern", vm()).kind).toBe("error");
  });
  it("disambiguates when an alias matches more than one entity", () => {
    const iron = ent("k2", "Iron Key", ["iron key", "iron", "key"], "item");
    const res = parse("take key", vm({ scope: [key, iron] }));
    expect(res.kind).toBe("ambiguous");
    if (res.kind === "ambiguous") expect(res.candidates.map((c) => c.id).sort()).toEqual(["k1", "k2"]);
  });
});

describe("parser — doors", () => {
  it("unlock targets a locked door; open on a door is a synonym for unlock", () => {
    const door = ent("study-door", "study door", ["study door", "door"], "door");
    const v = vm({ scope: [door], lockedDoors: [{ id: "study-door", name: "study door", dir: Directions.West }] });
    expect(parse("unlock study door", v)).toEqual({ kind: "intent", intent: { kind: "unlock", doorId: "study-door" } });
    expect(parse("open door", v)).toEqual({ kind: "intent", intent: { kind: "unlock", doorId: "study-door" } });
  });
  it("open on a loot box is an open intent", () => {
    const box = ent("b1", "a chest", ["chest", "box"], "loot");
    expect(parse("open chest", vm({ scope: [box] }))).toEqual({ kind: "intent", intent: { kind: "open", targetId: "b1" } });
  });
});
```

- [ ] **Step 2: Run; expect FAIL.**

Run: `pnpm vitest run packages/play/src/text/parser.test.ts`

- [ ] **Step 3: Implement `parser.ts`**

```ts
import { Directions, type Direction } from "wickedways/lib/room";
import type { Intent } from "../core/intent";
import type { ViewModel, ScopeEntity } from "../core/viewmodel";

export type ParseResult =
  | { kind: "intent"; intent: Intent }
  | { kind: "query"; query: "look" | "inventory" | "exits" | "help" }
  | { kind: "examine"; target: ScopeEntity }
  | { kind: "meta"; meta: "save" | "restore" | "undo" }
  | { kind: "ambiguous"; candidates: ScopeEntity[] }
  | { kind: "error"; message: string };

const DIRECTIONS: Record<string, Direction> = {
  north: Directions.North, n: Directions.North, south: Directions.South, s: Directions.South,
  east: Directions.East, e: Directions.East, west: Directions.West, w: Directions.West,
  northeast: Directions.Northeast, ne: Directions.Northeast, northwest: Directions.Northwest, nw: Directions.Northwest,
  southeast: Directions.Southeast, se: Directions.Southeast, southwest: Directions.Southwest, sw: Directions.Southwest,
};

const ARTICLES = new Set(["the", "a", "an", "at", "to", "with", "on"]);

// Verb → either a fixed result, or a function needing a resolved noun.
type NounVerb = (target: ScopeEntity) => Intent | { error: string };

const NOUN_VERBS: Record<string, NounVerb> = {
  take: (t) => t.kind === "loot" ? { error: "Open it first, then take what's inside." } : { kind: "take", targetId: t.id },
  get: (t) => t.kind === "loot" ? { error: "Open it first, then take what's inside." } : { kind: "take", targetId: t.id },
  drop: (t) => ({ kind: "drop", targetId: t.id }),
  examine: (t) => ({ kind: "examine-marker" } as never), // handled before resolution; see below
  attack: (t) => ({ kind: "attack", targetId: t.id }),
  kill: (t) => ({ kind: "attack", targetId: t.id }),
  hit: (t) => ({ kind: "attack", targetId: t.id }),
  equip: (t) => ({ kind: "equip", targetId: t.id }),
  wear: (t) => ({ kind: "equip", targetId: t.id }),
  wield: (t) => ({ kind: "equip", targetId: t.id }),
  light: (t) => ({ kind: "equip", targetId: t.id }),
  unequip: (t) => ({ kind: "unequip", targetId: t.id }),
  remove: (t) => ({ kind: "unequip", targetId: t.id }),
  extinguish: (t) => ({ kind: "unequip", targetId: t.id }),
  use: (t) => ({ kind: "use", targetId: t.id }),
  unlock: (t) => t.kind === "door" ? { kind: "unlock", doorId: t.id } : { error: "That isn't a door." },
  open: (t) => t.kind === "door" ? { kind: "unlock", doorId: t.id } : t.kind === "loot" ? { kind: "open", targetId: t.id } : { error: "You can't open that." },
};

export function parse(input: string, vm: ViewModel): ParseResult {
  const tokens = input.trim().toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return { kind: "error", message: "Say something." };

  const verb = tokens[0]!;

  // Bare direction or "go <dir>".
  if (DIRECTIONS[verb]) return { kind: "intent", intent: { kind: "move", dir: DIRECTIONS[verb]! } };
  if (verb === "go" || verb === "walk") {
    const d = tokens[1] !== undefined ? DIRECTIONS[tokens[1]] : undefined;
    return d ? { kind: "intent", intent: { kind: "move", dir: d } } : { kind: "error", message: "Go where?" };
  }

  // Meta verbs.
  if (verb === "save") return { kind: "meta", meta: "save" };
  if (verb === "restore" || verb === "load") return { kind: "meta", meta: "restore" };
  if (verb === "undo") return { kind: "meta", meta: "undo" };

  // Zero-noun queries.
  if (verb === "look" || verb === "l") return { kind: "query", query: "look" };
  if (verb === "inventory" || verb === "i" || verb === "inv") return { kind: "query", query: "inventory" };
  if (verb === "exits") return { kind: "query", query: "exits" };
  if (verb === "help" || verb === "?") return { kind: "query", query: "help" };
  if (verb === "wait" || verb === "z") return { kind: "intent", intent: { kind: "wait" } };

  const nounPhrase = tokens.slice(1).filter((t) => !ARTICLES.has(t)).join(" ");

  // examine is special: resolve then return an examine result (no engine call).
  if (verb === "examine" || verb === "x" || verb === "look-at") {
    if (!nounPhrase) return { kind: "query", query: "look" };
    return resolveThen(nounPhrase, vm, (t) => ({ kind: "examine", target: t }));
  }

  const handler = NOUN_VERBS[verb];
  if (!handler) return { kind: "error", message: `I don't know how to "${verb}".` };
  if (!nounPhrase) return { kind: "error", message: `${verb} what?` };

  return resolveThen(nounPhrase, vm, (t) => {
    const out = handler(t);
    return "error" in out ? { kind: "error", message: out.error } : { kind: "intent", intent: out };
  });
}

function resolveThen(nounPhrase: string, vm: ViewModel, build: (t: ScopeEntity) => ParseResult): ParseResult {
  const matches = resolve(nounPhrase, vm.scope);
  if (matches.length === 0) return { kind: "error", message: "You don't see that here." };
  if (matches.length > 1) return { kind: "ambiguous", candidates: matches };
  return build(matches[0]!);
}

// Match the phrase against each entity's name + aliases (substring/token match).
function resolve(phrase: string, scope: ScopeEntity[]): ScopeEntity[] {
  const exact = scope.filter((e) => e.aliases.some((a) => a === phrase) || e.name.toLowerCase() === phrase);
  if (exact.length > 0) return dedupe(exact);
  const partial = scope.filter((e) =>
    e.aliases.some((a) => a.includes(phrase) || phrase.includes(a)) || e.name.toLowerCase().includes(phrase),
  );
  return dedupe(partial);
}

function dedupe(entities: ScopeEntity[]): ScopeEntity[] {
  const seen = new Set<string>();
  return entities.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
}
```

Note: remove the bogus `examine` entry from `NOUN_VERBS` (examine is handled earlier) — delete that line so the map only holds engine-action verbs.

- [ ] **Step 4: Run; expect PASS.** Fix matching edge cases until green.

Run: `pnpm vitest run packages/play/src/text/parser.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/play/src/text/parser.ts packages/play/src/text/parser.test.ts
git commit -m "feat(play): command parser (verbs, directions, noun resolution, disambiguation)"
```

---

### Task 12: text/narrator

**Files:**
- Create: `packages/play/src/text/narrator.ts`
- Test: `packages/play/src/text/narrator.test.ts`

**Interfaces:**
- Consumes: `PresentationCue`, `ViewModel`, `ParseResult` (for `query`/`examine`).
- Produces: a `Narrator` class with:
  - `renderRoom(vm: ViewModel): string[]` — full description on first visit, terse on return (tracks visited room ids internally),
  - `renderCues(cues: PresentationCue[]): string[]`,
  - `renderExitDiff(before: ViewModel, after: ViewModel): string[]`,
  - `renderQuery(query, vm)` / `renderExamine(target, vm)` — local answers.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/play/src/text/narrator.test.ts
import { describe, it, expect } from "vitest";
import { Narrator } from "./narrator";
import { Directions } from "wickedways/lib/room";
import type { ViewModel } from "../core/viewmodel";
import type { PresentationCue } from "wickedways/lib/presentation";

const vm = (over: Partial<ViewModel> = {}): ViewModel => ({
  room: { id: "hall", name: "Hall", description: "A long central hall.", isLit: true },
  exits: [{ dir: Directions.North, toName: "Landing" }],
  lockedDoors: [], occupants: [], loot: [],
  inventory: { items: [], keys: [], equippedNames: [] }, scope: [],
  status: { locationName: "Hall", turn: 1, maxTurns: 150, sanity: 10, health: 10 },
  outcome: "ongoing", finished: false, ...over,
});

describe("Narrator.renderRoom", () => {
  it("gives the full description first, terse on return", () => {
    const n = new Narrator();
    const first = n.renderRoom(vm()).join("\n");
    expect(first).toContain("A long central hall.");
    const second = n.renderRoom(vm()).join("\n");
    expect(second).not.toContain("A long central hall.");
    expect(second).toContain("Hall");
  });
});

describe("Narrator.renderCues", () => {
  it("passes mechanic cue text through verbatim", () => {
    const n = new Narrator();
    const cues: PresentationCue[] = [{ kind: "mechanic", cue: { text: "The cellar reeks of old water." } }];
    expect(n.renderCues(cues)).toContain("The cellar reeks of old water.");
  });
  it("renders a resolution cue as the closing line", () => {
    const n = new Narrator();
    const cues: PresentationCue[] = [{ kind: "resolution", outcome: "won", narration: { text: "You may leave." } } as PresentationCue];
    expect(n.renderCues(cues).join("\n")).toContain("You may leave.");
  });
});

describe("Narrator.renderExitDiff", () => {
  it("announces a newly opened exit", () => {
    const n = new Narrator();
    const before = vm({ exits: [{ dir: Directions.North, toName: "Hall" }] });
    const after = vm({ exits: [{ dir: Directions.North, toName: "Hall" }, { dir: Directions.West, toName: "Study" }] });
    expect(n.renderExitDiff(before, after).join("\n")).toContain("Study");
  });
});
```

- [ ] **Step 2: Run; expect FAIL.**

Run: `pnpm vitest run packages/play/src/text/narrator.test.ts`

- [ ] **Step 3: Implement `narrator.ts`**

```ts
import type { PresentationCue } from "wickedways/lib/presentation";
import type { ViewModel, ScopeEntity } from "../core/viewmodel";

const sentence = (items: string[], head: string): string | null =>
  items.length === 0 ? null : `${head} ${items.join(", ")}.`;

export class Narrator {
  private readonly visited = new Set<string>();

  renderRoom(vm: ViewModel): string[] {
    const lines: string[] = [`*${vm.room.name}*`];
    const firstVisit = !this.visited.has(vm.room.id);
    this.visited.add(vm.room.id);
    if (firstVisit) lines.push(vm.room.description);
    if (!vm.room.isLit) { lines.push("It is pitch dark. You can see nothing."); return lines; }

    const occ = sentence(vm.occupants.map((o) => o.name), "You see");
    if (occ) lines.push(occ);
    const loot = sentence(vm.loot.map((l) => l.description), "Here:");
    if (loot) lines.push(loot);
    const exits = vm.exits.map((e) => e.dir);
    const locked = vm.lockedDoors.map((d) => `${d.dir} (the ${d.name}, locked)`);
    const ways = [...exits, ...locked];
    if (ways.length) lines.push(`Exits: ${ways.join(", ")}.`);
    return lines;
  }

  renderCues(cues: PresentationCue[]): string[] {
    const lines: string[] = [];
    for (const cue of cues) {
      switch (cue.kind) {
        case "mechanic": if (cue.cue.text) lines.push(cue.cue.text); break;
        case "encounter": lines.push(`A ${cue.mob.name} is here.`); break;
        case "visibility": lines.push(cue.lit ? "Light spills into the room." : "Darkness closes in."); break;
        case "resolution": if (cue.narration?.text) lines.push("", cue.narration.text); break;
        case "action": break; // movement/attack already implied by room re-render; keep terse
      }
    }
    return lines;
  }

  renderExitDiff(before: ViewModel, after: ViewModel): string[] {
    const had = new Set(before.exits.map((e) => `${e.dir}->${e.toName}`));
    const opened = after.exits.filter((e) => !had.has(`${e.dir}->${e.toName}`));
    return opened.map((e) => `With a grinding click, the way ${e.dir} to the ${e.toName} opens.`);
  }

  renderQuery(query: "look" | "inventory" | "exits" | "help", vm: ViewModel): string[] {
    switch (query) {
      case "look": { this.visited.delete(vm.room.id); return this.renderRoom(vm); }
      case "inventory": {
        const names = [...vm.inventory.items.map((i) => i.name), ...vm.inventory.keys.map((k) => k.name)];
        return names.length ? [`You are carrying: ${names.join(", ")}.`] : ["You are carrying nothing."];
      }
      case "exits": {
        const ways = [...vm.exits.map((e) => `${e.dir} to the ${e.toName}`), ...vm.lockedDoors.map((d) => `${d.dir} (the ${d.name}, locked)`)];
        return ways.length ? [`Exits: ${ways.join(", ")}.`] : ["There are no obvious exits."];
      }
      case "help":
        return ["Commands: go <dir> (or n/s/e/w/…), look, examine <thing>, take/drop <thing>, open <chest>, unlock <door>, equip/use <thing>, attack <foe>, inventory, exits, wait, save, restore, undo."];
    }
  }

  renderExamine(target: ScopeEntity, _vm: ViewModel): string[] {
    return [`You look closely at the ${target.name}. Nothing more reveals itself — yet.`];
  }
}
```

(The `examine` line is intentionally generic — per-entity examine text would be a content table; out of scope for v1. Keep it in-voice.)

- [ ] **Step 4: Run; expect PASS.**

Run: `pnpm vitest run packages/play/src/text/narrator.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/play/src/text/narrator.ts packages/play/src/text/narrator.test.ts
git commit -m "feat(play): narrator (room rendering, cue prose, exit diff, queries)"
```

---

### Task 13: text/ui + boot wiring

**Files:**
- Create: `packages/play/src/text/ui.ts`
- Modify: `packages/play/src/main.ts`

**Interfaces:**
- Consumes: `GameSession`, `parse`/`ParseResult`, `Narrator`, the campaign exports, `LocalStorageSaveStore`.
- Produces: a `mountTerminal(root, deps)` that renders the transcript + command line + compass + status line and drives the loop. (No unit tests — verified by playing.)

- [ ] **Step 1: Implement `ui.ts`**

```ts
import type { GameSession } from "../core/session";
import { parse } from "./parser";
import { Narrator } from "./narrator";

export function mountTerminal(root: HTMLElement, session: GameSession): void {
  const narrator = new Narrator();
  root.innerHTML = `
    <div class="screen">
      <div id="transcript" class="transcript" aria-live="polite"></div>
      <div id="compass" class="compass"></div>
      <div id="status" class="status"></div>
      <form id="prompt-form" class="prompt"><span class="caret">&gt;</span>
        <input id="cmd" autocomplete="off" autofocus /></form>
    </div>`;
  applyStyles(root);

  const transcript = root.querySelector<HTMLDivElement>("#transcript")!;
  const compass = root.querySelector<HTMLDivElement>("#compass")!;
  const status = root.querySelector<HTMLDivElement>("#status")!;
  const input = root.querySelector<HTMLInputElement>("#cmd")!;
  const form = root.querySelector<HTMLFormElement>("#prompt-form")!;
  const history: string[] = [];
  let historyIdx = 0;

  const print = (lines: string[], cls = "") => {
    for (const line of lines) {
      const el = document.createElement("div");
      el.className = `line ${cls}`.trim();
      renderClickable(el, line, input);
      transcript.appendChild(el);
    }
    transcript.scrollTop = transcript.scrollHeight;
  };

  const refresh = () => {
    const vm = session.view();
    status.textContent = `${vm.status.locationName}  ·  turn ${vm.status.turn}/${vm.status.maxTurns}  ·  Sanity ${vm.status.sanity}`;
    compass.innerHTML = "";
    for (const e of vm.exits) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.textContent = `${e.dir} → ${e.toName}`;
      chip.addEventListener("click", () => { input.value = `go ${e.dir}`; input.focus(); });
      compass.appendChild(chip);
    }
  };

  print(narrator.renderRoom(session.view()));
  refresh();

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const line = input.value.trim();
    if (!line) return;
    input.value = "";
    history.push(line); historyIdx = history.length;
    print([`> ${line}`], "echo");
    await handle(line);
  });

  input.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowUp" && historyIdx > 0) { historyIdx--; input.value = history[historyIdx] ?? ""; }
    else if (ev.key === "ArrowDown" && historyIdx < history.length) { historyIdx++; input.value = history[historyIdx] ?? ""; }
  });

  async function handle(line: string): Promise<void> {
    const before = session.view();
    const res = parse(line, before);
    switch (res.kind) {
      case "error": print([res.message], "error"); return;
      case "ambiguous": print([`Which do you mean — ${res.candidates.map((c) => c.name).join(", or ")}?`]); return;
      case "query": print(narrator.renderQuery(res.query, before)); return;
      case "examine": print(narrator.renderExamine(res.target, before)); return;
      case "meta": {
        if (res.meta === "save") { await session.save("slot1"); print(["Saved."]); }
        else if (res.meta === "restore") { const ok = await session.restore("slot1"); print([ok ? "Restored." : "No save found."]); if (ok) print(narrator.renderQuery("look", session.view())); }
        else { const ok = session.undo(); print([ok ? "The last moment unwinds." : "Nothing to undo."]); if (ok) print(narrator.renderQuery("look", session.view())); }
        refresh(); return;
      }
      case "intent": {
        const result = session.execute(res.intent);
        if (result.error) { print([result.error], "error"); return; }
        const after = session.view();
        print(narrator.renderExitDiff(before, after));
        print(narrator.renderCues(result.cues));
        if (res.intent.kind === "move") print(narrator.renderRoom(after));
        refresh();
        if (after.finished) print(["", "— THE END —"], "end");
        return;
      }
    }
  }
}

// Wrap known scope nouns in the printed line with clickable spans that pre-fill
// "examine <noun>" (confirm with Enter — never fires an action on click).
function renderClickable(el: HTMLElement, line: string, input: HTMLInputElement): void {
  el.textContent = line; // v1: plain text. (Clickable-noun span-wrapping can be layered on here.)
  void input;
}

function applyStyles(root: HTMLElement): void {
  const style = document.createElement("style");
  style.textContent = `
    .screen { max-width: 760px; margin: 0 auto; height: 100vh; display: flex; flex-direction: column; font: 15px/1.5 ui-monospace, Menlo, Consolas, monospace; color: #cdd2c4; background: #14130f; }
    .transcript { flex: 1; overflow-y: auto; padding: 1rem; }
    .line { white-space: pre-wrap; }
    .line.echo { color: #8a8f80; } .line.error { color: #c98b6b; } .line.end { color: #d9c27a; }
    .compass { display: flex; gap: .4rem; flex-wrap: wrap; padding: .4rem 1rem; }
    .chip { background: #25241d; color: #cdd2c4; border: 1px solid #3a382e; border-radius: 4px; padding: .15rem .5rem; cursor: pointer; font: inherit; }
    .status { padding: .3rem 1rem; color: #8a8f80; border-top: 1px solid #2a281f; }
    .prompt { display: flex; gap: .5rem; align-items: center; padding: .5rem 1rem 1rem; }
    .caret { color: #d9c27a; } #cmd { flex: 1; background: transparent; border: none; color: #e7e9df; font: inherit; outline: none; }
    body { margin: 0; background: #14130f; }`;
  root.appendChild(style);
}
```

- [ ] **Step 2: Wire `main.ts`**

```ts
import { GameSession } from "./core/session";
import { LocalStorageSaveStore } from "./core/savestore";
import { hauntedHouseTemplate, buildHauntedHouseRegistry, LOCKED_DOORS, ALIASES } from "./campaign/index";
import { Archetypes } from "./campaign/ids";
import { mountTerminal } from "./text/ui";

const app = document.getElementById("app");
if (app) {
  const session = GameSession.start({
    builder: hauntedHouseTemplate(),
    registry: buildHauntedHouseRegistry(),
    doors: LOCKED_DOORS,
    aliases: ALIASES,
    playerName: "Heir",
    archetype: Archetypes.Heir,
    saveStore: new LocalStorageSaveStore(),
    now: () => Date.now(),
  });
  mountTerminal(app, session);
}
```

- [ ] **Step 3: Typecheck and play it**

Run: `pnpm --filter @wickedways/play typecheck`
Expected: PASS.
Run: `pnpm --filter @wickedways/play dev`, open http://localhost:5174, and **play the winning path** end to end:
`take journal` → `n` → `take poker` → `equip poker` → `w` → `take lantern` → `equip lantern` → `e` → `e` → `open piano` (drawer) → `take brass key` → `w` → `n` → `unlock study door` → … fight the Revenant in the cellar for the iron key → unlock the attic door → enter the attic. Confirm the win text prints, the Sanity status drops when the lantern is unequipped, `save`/`restore`/`undo` work, and the compass updates.

- [ ] **Step 4: Commit**

```bash
git add packages/play/src/text/ui.ts packages/play/src/main.ts
git commit -m "feat(play): terminal UI shell and boot wiring"
```

---

### Task 14: Docs + full verification

**Files:**
- Create: `packages/play/README.md`

- [ ] **Step 1: Write `packages/play/README.md`**

Document: what the package is (single-player Infocom-style surface for the engine), how to run it (`pnpm --filter @wickedways/play dev`), the architecture (campaign / core / text), the one engine change (`CharacterView.hasItem`), the command vocabulary, and a one-line pointer that a future graphical UI reuses `campaign/` + `core/`.

- [ ] **Step 2: Run the whole suite + checks**

Run: `pnpm test`
Expected: PASS (engine + new package tests).
Run: `pnpm checks`
Expected: lint + root typecheck + per-package typecheck + tests all PASS. Fix any lint/type issues (e.g. unused imports, `noUncheckedIndexedAccess` undefined handling) until green.

- [ ] **Step 3: Commit**

```bash
git add packages/play/README.md
git commit -m "docs(play): package README and command reference"
```

---

## Self-Review

**Spec coverage:**
- Campaign content (9-room haunted house, lantern/Dread, journal/Storyteller, two keys, locked doors, one combat, win/lose/timeout) → Tasks 3–6. ✓
- One engine change (`hasItem`) → Task 1. ✓
- `packages/play` Vite package mirroring the client → Task 2. ✓
- UI-neutral core: Intent (7), SaveStore async + LocalStorage (8), viewmodel + scope + locked doors (9), GameSession assemble/seat/execute/save/restore/undo + one-command-one-turn + door reveals (10). ✓
- Text adapter: parser (11), narrator incl. exit-diff (12), terminal UI incl. compass/history/fill-on-click scaffold (13). ✓
- Save/restore/undo via the SaveStore seam → Tasks 8, 10, 13. ✓
- Tests: parser/narrator/viewmodel/session units + campaign winning/losing integration → throughout. ✓
- Acceptance criteria 1–7 → Tasks 13 (playable, win, sanity/timeout, save/restore/undo, fill-on-click), 14 (`pnpm checks`), 1 (engine-change scope). ✓

**Known follow-ups (intentionally deferred, not blockers):** clickable-noun span-wrapping in the transcript (scaffolded in `renderClickable`, plain-text in v1); per-entity examine text; audio cues. Each is additive and noted in-code.

**Type consistency:** `Intent`, `ViewModel`/`ScopeEntity`, `ParseResult`, `LockedDoor`, `SaveStore`, `ExecuteResult`, and `GameSession` signatures are defined once (Tasks 7–10) and consumed unchanged in Tasks 11–13. Engine signatures are cited at each first use with a "confirm against `src/...`" note, since the implementer should verify them against the engine rather than trust the plan.
