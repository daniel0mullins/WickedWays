# Campaign Serialization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serialize a live `Campaign` to a plain-data snapshot and rebuild it into a fully wired, playable `Campaign` (save/load on one engine instance).

**Architecture:** A self-contained data snapshot keyed by entity ID, plus a `CampaignRegistry` that supplies the non-serializable author behaviors (scene `{script, preconditions}`, recipe `{create, …}`, formation `{build}`, and non-key item factories). Each serializable class gains gated `[SERIALIZE]` / `[HYDRATE]` symbol-seam methods. Reconstruction is two-pass: pass 1 constructs every entity and indexes it by ID; pass 2 wires all cross-references.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`, NodeNext), Vitest, co-located tests.

**Spec:** `docs/superpowers/specs/2026-06-17-campaign-serialization-design.md` — read it before starting.

## Global Constraints

- **Symbol seams only for protected state.** Reads/writes of private `#state` during (de)serialization go through gated `Symbol`s, never public setters. New seams live in `src/lib/serialization/symbols.ts`.
- **Illegal operations throw `ProceduralViolation`** (`src/lib/util.ts`) — used for fail-fast serialize/deserialize errors.
- **Branded IDs** (`CampaignId`, `CharacterId`, `ItemId`, `RoomId`, `LootId`, `SceneId`, `RecipeId`, `ArchetypeId`, `MaterialCacheId`): generate via `generateId<T>()`; when assigning a stored id, cast at the boundary (`data.id as ItemId`) — this is the one sanctioned cast site.
- **All randomness via injected `rng: () => number`** — `rng` is re-injected at restore, never serialized.
- **`noUncheckedIndexedAccess`:** indexed/Map/`.get` access yields `T | undefined`; handle undefined (throw a clear `ProceduralViolation` for an unresolved reference rather than `!`-asserting, except `#select`-style internal invariants).
- **TDD, one behavior per test, frequent commits.** Run `npm run checks` (lint + typecheck + test) before declaring any task done — not just typecheck+vitest.
- **Backward compatibility:** added constructor params are optional; existing construction/tests must keep passing.
- **Scope:** full-snapshot save/load only. No deltas, command log, cross-client IDs, seeded rng, or transport.

## File Structure

**New (`src/lib/serialization/`):**
- `symbols.ts` — `SERIALIZE`, `HYDRATE` symbols (+ `HYDRATE_CODEX` for the Codex entry-injection seam).
- `types.ts` — `SCHEMA_VERSION` and every `*Snapshot` interface. The shared vocabulary all seams use.
- `registry.ts` — `CampaignRegistry` class (four behavior namespaces + fail-fast lookups).
- `context.ts` — `HydrateContext` (the `id → instance` index + typed resolvers + registry + rng).
- `serializer.ts` — `serializeCampaign(campaign)`: validate behavior keys, walk graph, assemble snapshot.
- `deserializer.ts` — `deserializeCampaign(data, opts)`: version gate, two-pass reconstruction.
- Co-located `*.test.ts` for each.

**Modified (add `[SERIALIZE]`/`[HYDRATE]` seams):** `inventory.ts` (Item), `loot.ts` (Loot), `material-cache.ts` (MaterialCache), `scene.ts` (Scene + optional `behaviorKey`), `room.ts` (Room), `character/afflictions.ts` (Afflictions), `character/character.ts` (Character + `hydrateExtra` hook), `character/player-character.ts` (PlayerCharacter), `character/mob.ts` (Mob), `codex.ts` (Codex), `encounter-table.ts` (EncounterTable), `campaign.ts` (Campaign).

---

## Task 1: Serialization scaffolding (symbols, types, registry, context, stubs)

**Files:**
- Create: `src/lib/serialization/symbols.ts`, `src/lib/serialization/types.ts`, `src/lib/serialization/registry.ts`, `src/lib/serialization/context.ts`, `src/lib/serialization/serializer.ts`, `src/lib/serialization/deserializer.ts`
- Test: `src/lib/serialization/registry.test.ts`, `src/lib/serialization/deserializer.test.ts`

**Interfaces produced (consumed by all later tasks):**
- `SERIALIZE`, `HYDRATE`, `HYDRATE_CODEX: unique symbol`
- `SCHEMA_VERSION = 1`, and the `*Snapshot` interfaces below
- `CampaignRegistry` with `registerScene/registerRecipe/registerFormation/registerItem` and `scene/recipe/formation/item` lookups (throw `ProceduralViolation` on missing key)
- `HydrateContext` with `.registry`, `.rng`, `.index: Map<string, unknown>`, `.put(id, inst)`, and typed resolvers `.item(id)/.loot(id)/.materialCache(id)/.room(id)/.character(id)` (each throws on a dangling id)
- `serializeCampaign(campaign: ICampaign): CampaignSnapshot` and `deserializeCampaign(data: CampaignSnapshot, opts: { registry: CampaignRegistry; rng?: () => number }): Campaign` — stubs throwing `"not implemented"` except the version gate

- [ ] **Step 1: Write the failing tests**

`src/lib/serialization/registry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { CampaignRegistry } from "./registry";
import { ProceduralViolation } from "../util";

describe("CampaignRegistry", () => {
  it("returns a registered scene behavior", () => {
    const reg = new CampaignRegistry();
    const behavior = { preconditions: [], script: () => {} };
    reg.registerScene("crypt-trap", behavior);
    expect(reg.scene("crypt-trap")).toBe(behavior);
  });

  it("throws ProceduralViolation on an unknown key", () => {
    const reg = new CampaignRegistry();
    expect(() => reg.scene("missing")).toThrow(ProceduralViolation);
  });
});
```

`src/lib/serialization/deserializer.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { deserializeCampaign } from "./deserializer";
import { CampaignRegistry } from "./registry";

describe("deserializeCampaign version gate", () => {
  it("rejects an unknown schemaVersion", () => {
    const data = { schemaVersion: 999 } as never;
    expect(() =>
      deserializeCampaign(data, { registry: new CampaignRegistry() }),
    ).toThrow(/schemaVersion/);
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `npx vitest run src/lib/serialization/`
Expected: FAIL — modules not found.

- [ ] **Step 3: Create `symbols.ts`**

```ts
/** Gated reader: returns the entity's plain-data snapshot. */
export const SERIALIZE = Symbol("serialize");
/** Gated writer: applies snapshot data + wires references (two-pass-safe). */
export const HYDRATE = Symbol("hydrate");
/** Codex-only: inject an already-built, frozen CodexEntry directly. */
export const HYDRATE_CODEX = Symbol("hydrateCodex");
```

- [ ] **Step 4: Create `types.ts`**

```ts
import type { Stats } from "../character/stats";
import type { Status } from "../status";
import type { MaterialMap } from "../inventory";
import type { ActionHistoryEntry } from "../character/history";
import type { MobOrigin } from "../character/mob";
import type { Archetype } from "../archetype";
import type { CodexEntry } from "../codex";
import type { ActionKind, AssetRef } from "../presentation";

export const SCHEMA_VERSION = 1;

export interface AfflictionsSnapshot {
  active: Partial<Record<Status, boolean>>;
  turnsActive: Partial<Record<Status, number>>;
  shakenOff: Status[];
  immunity: Partial<Record<Status, number>>;
}

export type ItemSnapshot =
  | {
      kind: "item";
      id: string;
      behaviorKey: string;
      durability?: number;
      modifier: number;
    }
  | { kind: "key"; id: string; name: string; keyCode: string; consumeOnUse: boolean };

export interface LootSnapshot {
  id: string;
  description: string;
  capacity: number;
  contentIds: string[];
}

export interface MaterialCacheSnapshot {
  id: string;
  // exact fields confirmed against src/lib/material-cache.ts in Task 3
  type: keyof MaterialMap;
  quantity: number;
}

export interface SceneSnapshot {
  id: string;
  behaviorKey: string;
  phase: "enter" | "exit";
  state: Record<string, unknown>;
}

export interface RoomSnapshot {
  id: string;
  name: string;
  description: string;
  exits: Record<string, string>; // Direction -> roomId
  dark: boolean;
  spawnModifier: number;
  occupantIds: string[];
  lootIds: string[];
  materialCacheIds: string[];
  lightSourceIds: string[];
  scenes: SceneSnapshot[];
}

export interface CharacterSnapshot {
  kind: "player" | "mob";
  id: string;
  name: string;
  stats: Stats;
  actionsPerRound: number;
  actionsThisRound: number;
  currentRoomId: string | null;
  inventory: { slots: number; itemIds: string[]; keyIds: string[] };
  equipment: Record<string, string>; // EquipmentSlot -> itemId
  history: ActionHistoryEntry[];
  archetypeImmunities: Status[];
  afflictions: AfflictionsSnapshot;
  archetypeId?: string; // player-only
  origin?: MobOrigin; // mob-only
  baseEscapeChance?: number;
  materialDrops?: MaterialMap;
  lightAverse?: boolean;
}

export interface EncounterTableSnapshot {
  baseChance: number;
  visited: string[];
  formations: { behaviorKey: string; weight: number }[];
}

export interface CampaignCoreSnapshot {
  id: string;
  title: string;
  maxRounds: number;
  round: number;
  started: boolean;
  finished: boolean;
  activeCharacterIndex: number;
  partyIds: string[];
  actedThisRound: string[];
  gmId: string | null;
  materials: MaterialMap;
  claims: string[];
  encountered: string[];
  knownRecipes: string[]; // registry keys
  archetypes: Archetype[]; // pure data
  actionSounds: Partial<Record<ActionKind, AssetRef>>;
  encounterTable: EncounterTableSnapshot;
}

export interface CampaignSnapshot {
  schemaVersion: number;
  campaign: CampaignCoreSnapshot;
  rooms: RoomSnapshot[];
  characters: CharacterSnapshot[];
  items: ItemSnapshot[];
  loot: LootSnapshot[];
  materialCaches: MaterialCacheSnapshot[];
  codex: CodexEntry[];
}
```

> If an imported name (e.g. `MobOrigin`, `ActionKind`, `AssetRef`) is not exported, add the `export` keyword to its declaration in its source file as part of this step.

- [ ] **Step 5: Create `registry.ts`**

```ts
import { ProceduralViolation } from "../util";
import type { Item } from "../inventory";
import type { CraftingRecipe } from "../crafting";
import type { ICampaign } from "../campaign";
import type { IMob } from "../character/mob";
import type { IRoom } from "../room";

export interface SceneBehavior {
  preconditions: ((room: IRoom, state: never) => boolean)[];
  script: (room: IRoom, state: never) => void;
}
export interface FormationBehavior {
  build: (campaign: ICampaign) => IMob[];
}

/** Author-supplied behaviors, keyed by stable strings; the restore-side source of every closure. */
export class CampaignRegistry {
  #scenes = new Map<string, SceneBehavior>();
  #recipes = new Map<string, CraftingRecipe>();
  #formations = new Map<string, FormationBehavior>();
  #items = new Map<string, () => Item>();

  registerScene(key: string, behavior: SceneBehavior): void {
    this.#scenes.set(key, behavior);
  }
  registerRecipe(key: string, recipe: CraftingRecipe): void {
    this.#recipes.set(key, recipe);
  }
  registerFormation(key: string, behavior: FormationBehavior): void {
    this.#formations.set(key, behavior);
  }
  registerItem(key: string, factory: () => Item): void {
    this.#items.set(key, factory);
  }

  scene(key: string): SceneBehavior {
    return this.#require(this.#scenes.get(key), "scene", key);
  }
  recipe(key: string): CraftingRecipe {
    return this.#require(this.#recipes.get(key), "recipe", key);
  }
  formation(key: string): FormationBehavior {
    return this.#require(this.#formations.get(key), "formation", key);
  }
  item(key: string): () => Item {
    return this.#require(this.#items.get(key), "item", key);
  }

  #require<T>(value: T | undefined, kind: string, key: string): T {
    if (value === undefined) {
      throw new ProceduralViolation(`No ${kind} behavior registered for key '${key}'.`);
    }
    return value;
  }
}
```

- [ ] **Step 6: Create `context.ts`**

```ts
import { ProceduralViolation } from "../util";
import type { CampaignRegistry } from "./registry";
import type { IItem } from "../inventory";
import type { ILoot } from "../loot";
import type { IRoom } from "../room";
import type { ICharacter } from "../character/character";
import type { IMaterialCache } from "../material-cache";

/** Carries the id→instance index, the registry, and the rng through reconstruction. */
export class HydrateContext {
  readonly index = new Map<string, unknown>();
  constructor(
    readonly registry: CampaignRegistry,
    readonly rng: () => number,
  ) {}

  put(id: string, instance: unknown): void {
    this.index.set(id, instance);
  }
  #get<T>(id: string, kind: string): T {
    const found = this.index.get(id);
    if (found === undefined) {
      throw new ProceduralViolation(`Corrupt snapshot: dangling ${kind} id '${id}'.`);
    }
    return found as T;
  }
  item(id: string): IItem {
    return this.#get<IItem>(id, "item");
  }
  loot(id: string): ILoot {
    return this.#get<ILoot>(id, "loot");
  }
  materialCache(id: string): IMaterialCache {
    return this.#get<IMaterialCache>(id, "materialCache");
  }
  room(id: string): IRoom {
    return this.#get<IRoom>(id, "room");
  }
  character(id: string): ICharacter {
    return this.#get<ICharacter>(id, "character");
  }
}
```

- [ ] **Step 7: Create `serializer.ts` and `deserializer.ts` stubs**

`serializer.ts`:

```ts
import type { ICampaign } from "../campaign";
import type { CampaignSnapshot } from "./types";

export function serializeCampaign(_campaign: ICampaign): CampaignSnapshot {
  throw new Error("not implemented");
}
```

`deserializer.ts`:

```ts
import { ProceduralViolation } from "../util";
import { SCHEMA_VERSION } from "./types";
import type { CampaignSnapshot } from "./types";
import type { CampaignRegistry } from "./registry";
import type { Campaign } from "../campaign";

export function deserializeCampaign(
  data: CampaignSnapshot,
  _opts: { registry: CampaignRegistry; rng?: () => number },
): Campaign {
  migrate(data);
  throw new Error("not implemented");
}

/** Upgrades older snapshots to the current schema; rejects unknown/newer versions. */
export function migrate(data: CampaignSnapshot): CampaignSnapshot {
  if (data.schemaVersion !== SCHEMA_VERSION) {
    throw new ProceduralViolation(
      `Unsupported snapshot schemaVersion ${data.schemaVersion}; expected ${SCHEMA_VERSION}.`,
    );
  }
  return data;
}
```

- [ ] **Step 8: Run the tests, verify they pass**

Run: `npx vitest run src/lib/serialization/`
Expected: PASS (3 tests).

- [ ] **Step 9: Run full checks and commit**

```bash
npm run checks
git add src/lib/serialization/
git commit -m "feat(serialization): scaffolding — symbols, snapshot types, registry, context, version gate"
```

---

## Task 2: Item & key serialize/hydrate seams

**Files:**
- Modify: `src/lib/inventory.ts` (add `[SERIALIZE]`/`[HYDRATE]` to `Item`; export a `hydrateItem` helper or handle keys in the seam)
- Test: `src/lib/inventory.serialization.test.ts`

**Interfaces:**
- Consumes: `SERIALIZE`, `HYDRATE` (Task 1); `ItemSnapshot` (Task 1); `HydrateContext`; `CampaignRegistry.item`; existing `createKey`, `SET_DURABILITY`, `CLAIM`.
- Produces: `item[SERIALIZE](): ItemSnapshot`; a module export `hydrateItem(data: ItemSnapshot, ctx: HydrateContext): Item` that constructs the right item (key via `createKey`, non-key via `ctx.registry.item(behaviorKey)()`), assigns `id`, and overlays mutable state.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { Item, createKey, SET_DURABILITY, ItemType, StatType } from "./inventory";
import { SERIALIZE } from "./serialization/symbols";
import { hydrateItem } from "./inventory";
import { CampaignRegistry } from "./serialization/registry";
import { HydrateContext } from "./serialization/context";

function potionFactory() {
  return new Item(
    { type: ItemType.Consumable, recipe: { healing: 1 }, modifier: 2, stat: StatType.Health,
      name: "Healing Potion", maxDurability: 3, durability: 3 },
    { equippable: false, equipped: false, destroyable: true, usable: true },
    { pickUp: () => {}, equip: () => {}, unequip: () => {}, transfer: () => {},
      use: () => {}, destroy: () => null },
    { onPickUp: () => {} },
  );
}

describe("Item serialization", () => {
  it("round-trips a non-key item by behaviorKey, preserving mutable state", () => {
    const reg = new CampaignRegistry();
    reg.registerItem("healing-potion", potionFactory);
    const ctx = new HydrateContext(reg, () => 0.5);

    const item = potionFactory();
    (item as { behaviorKey?: string }).behaviorKey = "healing-potion"; // set via constructor in Step 3
    item[SET_DURABILITY](1);
    item.modifier = 4;

    const snap = item[SERIALIZE]();
    expect(snap).toMatchObject({ kind: "item", behaviorKey: "healing-potion", durability: 1, modifier: 4 });

    const restored = hydrateItem(snap, ctx);
    expect(restored.id).toBe(item.id);
    expect(restored.durability).toBe(1);
    expect(restored.modifier).toBe(4);
    expect(restored.name).toBe("Healing Potion");
  });

  it("round-trips a key via createKey config", () => {
    const ctx = new HydrateContext(new CampaignRegistry(), () => 0.5);
    const key = createKey({ name: "Brass Key", keyCode: "crypt", consumeOnUse: false });
    const snap = key[SERIALIZE]();
    expect(snap).toMatchObject({ kind: "key", keyCode: "crypt", consumeOnUse: false });
    const restored = hydrateItem(snap, ctx);
    expect(restored.id).toBe(key.id);
    expect(restored.keyCode).toBe("crypt");
  });

  it("throws when a non-key item lacks a behaviorKey", () => {
    const item = potionFactory(); // no behaviorKey
    expect(() => item[SERIALIZE]()).toThrow(/behaviorKey/);
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `npx vitest run src/lib/inventory.serialization.test.ts`
Expected: FAIL — `behaviorKey`, `[SERIALIZE]`, `hydrateItem` missing.

- [ ] **Step 3: Add `behaviorKey` to the `Item` constructor config and the `[SERIALIZE]` seam**

In `inventory.ts`, add `behaviorKey?: string` to the `Item` constructor's config-object type and store it: `this.behaviorKey = config.behaviorKey;` (declare `behaviorKey?: string;` as a public field). Then add the seam method on `Item` (import `SERIALIZE`, `HYDRATE` from `./serialization/symbols`):

```ts
[SERIALIZE](): ItemSnapshot {
  if (this.type === ItemType.Key) {
    return {
      kind: "key",
      id: this.id,
      name: this.name,
      keyCode: this.keyCode ?? "",
      consumeOnUse: this.consumeOnUse ?? false,
    };
  }
  if (this.behaviorKey === undefined) {
    throw new ProceduralViolation(
      `Item '${this.name}' (${this.id}) cannot be serialized: no behaviorKey. Register a factory and pass behaviorKey.`,
    );
  }
  return {
    kind: "item",
    id: this.id,
    behaviorKey: this.behaviorKey,
    ...(this.durability !== undefined ? { durability: this.durability } : {}),
    modifier: this.modifier,
  };
}
```

(`ProceduralViolation` is already imported in `inventory.ts`; import `ItemSnapshot` as a type from `./serialization/types`.)

- [ ] **Step 4: Add the `hydrateItem` helper**

```ts
export function hydrateItem(data: ItemSnapshot, ctx: HydrateContext): Item {
  let item: Item;
  if (data.kind === "key") {
    item = createKey({ name: data.name, keyCode: data.keyCode, consumeOnUse: data.consumeOnUse });
  } else {
    item = ctx.registry.item(data.behaviorKey)();
    item.behaviorKey = data.behaviorKey;
    if (data.durability !== undefined) item[SET_DURABILITY](data.durability);
    item.modifier = data.modifier;
  }
  item.id = data.id as ItemId;
  ctx.put(item.id, item);
  return item;
}
```

(Import `HydrateContext` from `./serialization/context`, `SET_DURABILITY` is local, `ItemId` from `./brand`. `item.id` is a public field — direct assignment is allowed.)

- [ ] **Step 5: Run, verify pass; then full checks and commit**

Run: `npx vitest run src/lib/inventory.serialization.test.ts` → PASS (3).

```bash
npm run checks
git add src/lib/inventory.ts src/lib/inventory.serialization.test.ts
git commit -m "feat(serialization): Item/key serialize + hydrate seams with behaviorKey"
```

---

## Task 3: Loot & MaterialCache serialize/hydrate seams

**Files:**
- Modify: `src/lib/loot.ts` (`Loot`), `src/lib/material-cache.ts` (`MaterialCache`)
- Test: `src/lib/loot.serialization.test.ts`, `src/lib/material-cache.serialization.test.ts`

**Interfaces:**
- Consumes: `SERIALIZE`/`HYDRATE`, `LootSnapshot`/`MaterialCacheSnapshot`, `HydrateContext`, `hydrateItem` (Task 2).
- Produces: `loot[SERIALIZE](): LootSnapshot`, `loot[HYDRATE](data, ctx)`; same for `MaterialCache`. Module exports `hydrateLoot(data, ctx): Loot` and `hydrateMaterialCache(data, ctx): MaterialCache` that construct, assign id, index via `ctx.put`, and (Loot) wire contents in the same call (contents already exist because items hydrate before containers — guaranteed by the deserializer ordering in Task 9).

> **First:** read `src/lib/material-cache.ts` for `MaterialCache`'s exact fields, constructor, and the gated mutator for its quantity (it likely mirrors the symbol-seam pattern). Confirm `MaterialCacheSnapshot` in `types.ts` matches (`type`, `quantity`); adjust the interface if the real fields differ, keeping it pure data.

- [ ] **Step 1: Write the failing test (Loot)**

```ts
import { describe, it, expect } from "vitest";
import { Loot } from "./loot";
import { createKey } from "./inventory";
import { SERIALIZE } from "./serialization/symbols";
import { hydrateLoot } from "./loot";
import { hydrateItem } from "./inventory";
import { CampaignRegistry } from "./serialization/registry";
import { HydrateContext } from "./serialization/context";

describe("Loot serialization", () => {
  it("round-trips a loot box and resolves its contents by id", () => {
    const ctx = new HydrateContext(new CampaignRegistry(), () => 0.5);
    const key = createKey({ name: "Key", keyCode: "x", consumeOnUse: false });
    const loot = new Loot("Chest", [key]);

    const snap = loot[SERIALIZE]();
    expect(snap.contentIds).toEqual([key.id]);

    hydrateItem(key[SERIALIZE](), ctx); // contents hydrated first (deserializer ordering)
    const restored = hydrateLoot(snap, ctx);
    expect(restored.id).toBe(loot.id);
    expect(restored.contents.map((i) => i.id)).toEqual([key.id]);
  });
});
```

- [ ] **Step 2: Run, verify fail.** `npx vitest run src/lib/loot.serialization.test.ts` → FAIL.

- [ ] **Step 3: Implement the Loot seams**

Read `loot.ts` for the `Loot` field names (`contents`, `capacity`, `description`) and the gated method to add an item (e.g. `stowItem`/`STASH_DROP`). Add:

```ts
[SERIALIZE](): LootSnapshot {
  return {
    id: this.id,
    description: this.description,
    capacity: this.capacity,
    contentIds: this.contents.map((i) => i.id),
  };
}
```

```ts
export function hydrateLoot(data: LootSnapshot, ctx: HydrateContext): Loot {
  const loot = new Loot(data.description, [], undefined);
  loot.id = data.id as LootId;
  // capacity: set via the same path the constructor uses; if capacity derives from
  // contents/argument, restore it directly (it is a public field on Loot).
  loot.capacity = data.capacity;
  for (const itemId of data.contentIds) loot.stowItem(ctx.item(itemId));
  ctx.put(loot.id, loot);
  return loot;
}
```

> Confirm `Loot`'s constructor signature (`description, contents, presentation?`) and whether `capacity` is a public field or derived. Use the existing content-insertion method (`stowItem` or the `STASH_DROP` seam) rather than pushing to a private array.

- [ ] **Step 4: Run Loot test → PASS.**

- [ ] **Step 5: Write + implement the MaterialCache seams (mirror Loot, pure data)**

Test that a `MaterialCache` round-trips `type` and `quantity` and restores its id. Implement `[SERIALIZE]` and `hydrateMaterialCache(data, ctx)` constructing via its real constructor, assigning id, restoring quantity via its gated mutator, and `ctx.put`.

- [ ] **Step 6: Run both tests, full checks, commit**

```bash
npm run checks
git add src/lib/loot.ts src/lib/material-cache.ts src/lib/loot.serialization.test.ts src/lib/material-cache.serialization.test.ts
git commit -m "feat(serialization): Loot + MaterialCache serialize/hydrate seams"
```

---

## Task 4: Scene serialize/hydrate seams (+ optional behaviorKey)

**Files:**
- Modify: `src/lib/scene.ts`
- Test: `src/lib/scene.serialization.test.ts`

**Interfaces:**
- Consumes: `SERIALIZE`/`HYDRATE`, `SceneSnapshot`, `HydrateContext`, `CampaignRegistry.scene`.
- Produces: `scene[SERIALIZE](): SceneSnapshot`; module export `hydrateScene(data, ctx): Scene` (constructs `new Scene` with registry behavior + `initialState: data.state`, assigns id).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { Scene } from "./scene";
import { SERIALIZE } from "./serialization/symbols";
import { hydrateScene } from "./scene";
import { CampaignRegistry } from "./serialization/registry";
import { HydrateContext } from "./serialization/context";

describe("Scene serialization", () => {
  it("round-trips phase + persisted state and reattaches behavior from the registry", () => {
    const script = vi.fn((_room, state: { fired: boolean }) => { state.fired = true; });
    const reg = new CampaignRegistry();
    reg.registerScene("trap", { preconditions: [], script: script as never });
    const ctx = new HydrateContext(reg, () => 0.5);

    const scene = new Scene<{ fired: boolean }>({
      phase: "enter", preconditions: [], script, initialState: { fired: true }, behaviorKey: "trap",
    });

    const snap = scene[SERIALIZE]();
    expect(snap).toMatchObject({ behaviorKey: "trap", phase: "enter", state: { fired: true } });

    const restored = hydrateScene(snap, ctx);
    expect(restored.id).toBe(scene.id);
    const room = {} as never;
    restored.playScene("enter", room); // precondition empty → script runs, mutates restored state
    expect(script).toHaveBeenCalled();
  });

  it("throws on serialize when behaviorKey is missing", () => {
    const scene = new Scene({ preconditions: [], script: () => {} });
    expect(() => scene[SERIALIZE]()).toThrow(/behaviorKey/);
  });
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Add `behaviorKey` to the Scene constructor and store the trigger phase/state access**

In `scene.ts`, extend the constructor options with `behaviorKey?: string` and store `this.#behaviorKey = behaviorKey;` (add `#behaviorKey?: string`). Add seams (the class already has `#triggerPhase` and `#state`):

```ts
[SERIALIZE](): SceneSnapshot {
  if (this.#behaviorKey === undefined) {
    throw new ProceduralViolation(`Scene ${this.id} cannot be serialized: no behaviorKey.`);
  }
  return {
    id: this.id,
    behaviorKey: this.#behaviorKey,
    phase: this.#triggerPhase,
    state: this.#state as Record<string, unknown>,
  };
}
```

- [ ] **Step 4: Add `hydrateScene`**

```ts
export function hydrateScene(data: SceneSnapshot, ctx: HydrateContext): Scene {
  const behavior = ctx.registry.scene(data.behaviorKey);
  const scene = new Scene({
    phase: data.phase,
    preconditions: behavior.preconditions,
    script: behavior.script,
    initialState: data.state as never,
    behaviorKey: data.behaviorKey,
  });
  scene.id = data.id as SceneId;
  return scene;
}
```

(Import `ProceduralViolation`, `SceneId`, `SERIALIZE`, `HydrateContext`, `SceneSnapshot`. Scenes are nested in their room's snapshot, so `hydrateScene` does not `ctx.put` — the room owns it. `scene.id` is a public field.)

- [ ] **Step 5: Run → PASS; full checks; commit**

```bash
npm run checks
git add src/lib/scene.ts src/lib/scene.serialization.test.ts
git commit -m "feat(serialization): Scene serialize/hydrate seams + optional behaviorKey"
```

---

## Task 5: Room serialize/hydrate seams

**Files:**
- Modify: `src/lib/room.ts`
- Test: `src/lib/room.serialization.test.ts`

**Interfaces:**
- Consumes: `SERIALIZE`/`HYDRATE`, `RoomSnapshot`, `HydrateContext`, `hydrateScene` (Task 4). `Room`'s public Maps `loot`/`materials`/`exits`; private `#occupants`/`#scenes`/`#lightSources`/`#dark`/`#presentation`; public `registerScene`.
- Produces: `room[SERIALIZE](): RoomSnapshot`; `room[HYDRATE](data, ctx)` (a class method — wires exits/loot/materials/lightSources/occupants/scenes from the index). Module export `constructBareRoom(data): Room` for pass 1.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { Room } from "./room";
import { Loot } from "./loot";
import { createKey } from "./inventory";
import { SERIALIZE, HYDRATE } from "./serialization/symbols";
import { constructBareRoom } from "./room";
import { hydrateLoot } from "./loot";
import { hydrateItem } from "./inventory";
import { CampaignRegistry } from "./serialization/registry";
import { HydrateContext } from "./serialization/context";

describe("Room serialization", () => {
  it("round-trips exits, loot, dark, and resolves references", () => {
    const ctx = new HydrateContext(new CampaignRegistry(), () => 0.5);
    const key = createKey({ name: "K", keyCode: "x", consumeOnUse: false });
    const chest = new Loot("Chest", [key]);
    const north = new Room("North", "n", [], {});
    const start = new Room("Start", "s", [chest], { north } as never, [], 1, [], undefined, true);

    const startSnap = start[SERIALIZE]();
    expect(startSnap).toMatchObject({ dark: true, lootIds: [chest.id], exits: { north: north.id } });

    // pass 1: bare rooms + contents indexed
    const startBare = constructBareRoom(startSnap);
    const northBare = constructBareRoom(north[SERIALIZE]());
    ctx.put(startBare.id, startBare);
    ctx.put(northBare.id, northBare);
    hydrateItem(key[SERIALIZE](), ctx);
    hydrateLoot(chest[SERIALIZE](), ctx);

    // pass 2: wire
    startBare[HYDRATE](startSnap, ctx);
    expect(startBare.id).toBe(start.id);
    expect(startBare.isLit).toBe(false); // dark restored
    expect(startBare.exits.get("north")!.id).toBe(north.id);
    expect([...startBare.loot.keys()]).toEqual([chest.id]);
  });
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement `[SERIALIZE]`**

```ts
[SERIALIZE](): RoomSnapshot {
  return {
    id: this.id,
    name: this.name,
    description: this.description,
    exits: Object.fromEntries([...this.exits].map(([dir, room]) => [dir, room.id])),
    dark: this.#dark,
    spawnModifier: this.spawnModifier,
    occupantIds: [...this.#occupants.keys()],
    lootIds: [...this.loot.keys()],
    materialCacheIds: [...this.materials.keys()],
    lightSourceIds: [...this.#lightSources.keys()],
    scenes: this.#scenes.map((s) => s[SERIALIZE]()),
  };
}
```

- [ ] **Step 4: Implement `constructBareRoom` (pass 1) and `[HYDRATE]` (pass 2)**

```ts
export function constructBareRoom(data: RoomSnapshot): Room {
  const room = new Room(data.name, data.description, [], {}, [], data.spawnModifier, [], undefined, data.dark);
  room.id = data.id as RoomId;
  return room;
}
```

`[HYDRATE]` (class method — private access):

```ts
[HYDRATE](data: RoomSnapshot, ctx: HydrateContext) {
  for (const [dir, roomId] of Object.entries(data.exits)) {
    this.exits.set(dir as Direction, ctx.room(roomId));
  }
  for (const lootId of data.lootIds) {
    const loot = ctx.loot(lootId);
    this.loot.set(loot.id, loot);
  }
  for (const cacheId of data.materialCacheIds) {
    const cache = ctx.materialCache(cacheId);
    this.materials.set(cache.id, cache);
  }
  for (const itemId of data.lightSourceIds) {
    const light = ctx.item(itemId);
    this.#lightSources.set(light.id, light);
  }
  for (const charId of data.occupantIds) {
    const character = ctx.character(charId);
    this.#occupants.set(character.id, character);
  }
  for (const sceneData of data.scenes) {
    this.registerScene(hydrateScene(sceneData, ctx));
  }
}
```

> `room.id`, `this.exits/.loot/.materials` are public; `#lightSources/#occupants/#scenes/#dark` are private but reachable here (class method). Do **not** call `enterRoom` for occupants — that would replay `"enter"` scenes; set the `#occupants` map directly. Confirm `isLit` reflects `#dark` with no light sources (used by the test). Import `Direction`, `RoomId`, `RoomSnapshot`, `HydrateContext`, `hydrateScene`, `SERIALIZE`, `HYDRATE`.

- [ ] **Step 5: Run → PASS; full checks; commit**

```bash
npm run checks
git add src/lib/room.ts src/lib/room.serialization.test.ts
git commit -m "feat(serialization): Room serialize/hydrate seams (two-pass wiring)"
```

---

## Task 6: Afflictions serialize/hydrate seam (full fidelity)

**Files:**
- Modify: `src/lib/character/afflictions.ts`
- Test: `src/lib/character/afflictions.serialization.test.ts`

**Interfaces:**
- Consumes: `SERIALIZE`/`HYDRATE`, `AfflictionsSnapshot`.
- Produces: `afflictions[SERIALIZE](): AfflictionsSnapshot`, `afflictions[HYDRATE](data)`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { Afflictions } from "./afflictions";
import { Status } from "../status";
import { SERIALIZE, HYDRATE } from "../serialization/symbols";

describe("Afflictions serialization", () => {
  it("round-trips active, turnsActive, shakenOff, and immunity verbatim", () => {
    const a = new Afflictions(() => 0.99); // high roll: never auto-clears
    // drive Fear active for 2 turns
    a.applyFromStats({ health: 10, sanity: 3, energy: 10 }, new Set());
    a.onTurnStart({ health: 10, sanity: 3, energy: 10 }, new Set());
    a.onTurnStart({ health: 10, sanity: 3, energy: 10 }, new Set());
    a.grantImmunity([Status.Confused], 3);

    const snap = a[SERIALIZE]();
    const b = new Afflictions(() => 0.99);
    b[HYDRATE](snap);
    expect(b[SERIALIZE]()).toEqual(snap);
    expect(b.list).toEqual(a.list);
  });
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement the seams**

In `afflictions.ts` (import `SERIALIZE`, `HYDRATE` from `../serialization/symbols`, `AfflictionsSnapshot` type, `Status`; `CLEARABLE` is module-local):

```ts
[SERIALIZE](): AfflictionsSnapshot {
  const active: Partial<Record<Status, boolean>> = {};
  for (const [s, on] of this.#active) if (on) active[s] = true;
  return {
    active,
    turnsActive: Object.fromEntries(this.#turnsActive) as Partial<Record<Status, number>>,
    shakenOff: [...this.#shakenOff],
    immunity: Object.fromEntries(this.#immunity) as Partial<Record<Status, number>>,
  };
}

[HYDRATE](data: AfflictionsSnapshot) {
  this.#active = new Map();
  for (const s of [Status.KO, ...CLEARABLE]) this.#active.set(s, data.active[s] ?? false);
  this.#turnsActive = new Map(Object.entries(data.turnsActive) as [Clearable, number][]);
  this.#shakenOff = new Set(data.shakenOff as Clearable[]);
  this.#immunity = new Map(Object.entries(data.immunity) as [Clearable, number][]);
}
```

- [ ] **Step 4: Run → PASS; full checks; commit**

```bash
npm run checks
git add src/lib/character/afflictions.ts src/lib/character/afflictions.serialization.test.ts
git commit -m "feat(serialization): Afflictions full-fidelity serialize/hydrate seam"
```

---

## Task 7: Character / PlayerCharacter / Mob serialize/hydrate seams

**Files:**
- Modify: `src/lib/character/character.ts` (`Character` seams + `hydrateExtra` hook), `src/lib/character/player-character.ts`, `src/lib/character/mob.ts`
- Test: `src/lib/character/character.serialization.test.ts`

**Interfaces:**
- Consumes: `SERIALIZE`/`HYDRATE`, `CharacterSnapshot`, `HydrateContext`; Afflictions seam (Task 6); item resolution via `ctx.item`; existing `CLAIM`, `[GRANT_IMMUNITY]`. Equipment is restored by direct `#equipment` map population — **not** via `[EQUIP]`.
- Produces: `character[SERIALIZE](): CharacterSnapshot`; `character[HYDRATE](data, ctx)` (base) + protected `hydrateExtra(data, ctx)` hook overridden by `PlayerCharacter` (archetype) and `Mob` (origin/escape/drops/lightAverse). Module exports `constructBareCharacter(data, campaign): Character` (pass 1) that builds the right subclass.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { PlayerCharacter } from "./player-character";
import { Mob } from "./mob";
import { Campaign } from "../campaign";
import { createKey } from "../inventory";
import { StatType } from "./stats";
import { SERIALIZE, HYDRATE } from "../serialization/symbols";
import { constructBareCharacter } from "./character";
import { hydrateItem } from "../inventory";
import { CampaignRegistry } from "../serialization/registry";
import { HydrateContext } from "../serialization/context";

describe("Character serialization", () => {
  it("round-trips a player's stats, inventory, history, and afflictions", () => {
    const campaign = new Campaign("C", 10);
    const ctx = new HydrateContext(new CampaignRegistry(), () => 0.5);
    const pc = new PlayerCharacter(campaign, "Ada", { health: 8, sanity: 5, energy: 6 });
    const key = createKey({ name: "K", keyCode: "x", consumeOnUse: false });
    pc.receiveItem(key);

    const snap = pc[SERIALIZE]();
    expect(snap).toMatchObject({ kind: "player", name: "Ada", inventory: { keyIds: [key.id] } });

    hydrateItem(key[SERIALIZE](), ctx);
    const restored = constructBareCharacter(snap, campaign);
    ctx.put(restored.id, restored);
    restored[HYDRATE](snap, ctx);
    expect(restored.id).toBe(pc.id);
    expect(restored.stats).toEqual({ health: 8, sanity: 5, energy: 6 });
    expect(restored.inventory.keys.map((k) => k.id)).toEqual([key.id]);
  });

  it("round-trips a mob's origin, escape chance, and drops", () => {
    const campaign = new Campaign("C", 10);
    const ctx = new HydrateContext(new CampaignRegistry(), () => 0.5);
    const mob = new Mob(campaign, "Ghoul", { health: 5, sanity: 5, energy: 5 }, 2, 2, [], { baseEscapeChance: 25, lightAverse: true });

    const snap = mob[SERIALIZE]();
    expect(snap).toMatchObject({ kind: "mob", baseEscapeChance: 25, lightAverse: true });

    const restored = constructBareCharacter(snap, campaign) as Mob;
    ctx.put(restored.id, restored);
    restored[HYDRATE](snap, ctx);
    expect(restored.id).toBe(mob.id);
    expect((restored as { baseEscapeChance?: number })).toBeDefined();
  });
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Add the base `Character` `[SERIALIZE]` seam**

In `character.ts` (import `SERIALIZE`, `HYDRATE`, `CharacterSnapshot`, `HydrateContext`; `Status`, `EquipmentSlot` already available):

```ts
[SERIALIZE](): CharacterSnapshot {
  const base = {
    kind: this.serializeKind(),
    id: this.id,
    name: this.name,
    stats: { ...this.stats },
    actionsPerRound: this.actionsPerRound,
    actionsThisRound: this.actionsThisRound,
    currentRoomId: this.#currentRoom?.id ?? null,
    inventory: {
      slots: this.#inventory.slots,
      itemIds: this.#inventory.items.map((i) => i.id),
      keyIds: this.#inventory.keys.map((k) => k.id),
    },
    equipment: Object.fromEntries([...this.#equipment].map(([slot, item]) => [slot, item.id])),
    history: [...this.#history],
    archetypeImmunities: [...this.archetypeImmunities],
    afflictions: this.#afflictions[SERIALIZE](),
  } as CharacterSnapshot;
  this.serializeExtra(base);
  return base;
}

/** Subclass discriminant. */
protected serializeKind(): "player" | "mob" { return "player"; }
/** Subclass hook to add its own fields to the snapshot. Base: none. */
protected serializeExtra(_snap: CharacterSnapshot): void {}
```

- [ ] **Step 4: Add the base `Character` `[HYDRATE]` seam + hook**

```ts
[HYDRATE](data: CharacterSnapshot, ctx: HydrateContext) {
  this.id = data.id as CharacterId;
  this.name = data.name;
  this.stats = { ...data.stats };
  this.actionsPerRound = data.actionsPerRound;
  this.actionsThisRound = data.actionsThisRound;
  this.archetypeImmunities = [...data.archetypeImmunities];
  this.#currentRoom = data.currentRoomId ? ctx.room(data.currentRoomId) : null;
  this.#inventory.slots = data.inventory.slots;
  for (const id of data.inventory.itemIds) {
    const item = ctx.item(id);
    this.#inventory.items.push(item);
    item[CLAIM](this);
  }
  for (const id of data.inventory.keyIds) {
    const key = ctx.item(id);
    this.#inventory.keys.push(key);
    key[CLAIM](this);
  }
  // Equipment: populate the map directly and mark equipped. Do NOT call [EQUIP]:
  // equip side-effects (and any derived bonuses) are already reflected in the
  // restored base stats / equipped flags, so replaying them would double-apply.
  for (const [slot, itemId] of Object.entries(data.equipment)) {
    const item = ctx.item(itemId);
    this.#equipment.set(slot as EquipmentSlot, item);
    item.properties.equipped = true;
  }
  this.#history = [...data.history];
  this.#afflictions[HYDRATE](data.afflictions);
  this.hydrateExtra(data, ctx);
}

/** Subclass hook to restore its own fields. Base: none. */
protected hydrateExtra(_data: CharacterSnapshot, _ctx: HydrateContext): void {}
```

> `item[CLAIM](this)` sets the `HELD_BY` back-reference — that is the holder wiring, so items need no separate holder field in their snapshot. Verify `effectiveStat` derives equipped bonuses from equipment-map/item state (not from an `[EQUIP]`-time mutation); the comment at `#floorAndSnapshot` ("base + equipped-accessory bonuses") and `#passiveImmunities` reading `item.properties.equipped` confirm this. If `#equipBehavior` mutates base stats, capture that instead — but it does not in the current engine.

- [ ] **Step 5: `constructBareCharacter` (pass 1) + subclass overrides**

In `character.ts`:

```ts
export function constructBareCharacter(data: CharacterSnapshot, campaign: ICampaign): Character {
  if (data.kind === "mob") {
    const mob = new Mob(campaign, data.name, { ...data.stats }, 0, data.actionsPerRound, [], {
      baseEscapeChance: data.baseEscapeChance,
      materialDrops: data.materialDrops,
      lightAverse: data.lightAverse,
    });
    mob.id = data.id as CharacterId;
    return mob;
  }
  const pc = new PlayerCharacter(campaign, data.name, { ...data.stats });
  pc.id = data.id as CharacterId;
  return pc;
}
```

> `constructBareCharacter` imports `Mob`/`PlayerCharacter`; if that creates an import cycle, place this factory in a small `src/lib/character/hydrate.ts` instead and import the classes there. The Mob constructor takes `drops: IItem[]` and seats them into inventory — pass `[]`; the real inventory is restored in `[HYDRATE]`.

`PlayerCharacter` (player-character.ts) — override the hooks:

```ts
protected override serializeKind(): "player" | "mob" { return "player"; }
protected override serializeExtra(snap: CharacterSnapshot): void {
  if (this.#archetype) snap.archetypeId = this.#archetype.id;
}
protected override hydrateExtra(data: CharacterSnapshot, _ctx: HydrateContext): void {
  if (data.archetypeId) {
    const archetype = this.campaign.archetypes.get(data.archetypeId as ArchetypeId);
    if (!archetype) throw new ProceduralViolation(`Unknown archetype '${data.archetypeId}' on restore.`);
    this.#archetype = archetype;
  }
}
```

> The archetype catalog is restored on the Campaign **before** characters hydrate (deserializer ordering, Task 9), so `this.campaign.archetypes.get` resolves. Setting `#archetype` directly (not via `selectArchetype`) avoids re-applying stat/slot deltas — those are already baked into the restored stats/slots.

`Mob` (mob.ts) — override the hooks (private fields `#origin`, `#baseEscapeChance`, `#materialDrops`, `#lightAverse`; `#origin` is otherwise set via `SET_ORIGIN`):

```ts
protected override serializeKind(): "player" | "mob" { return "mob"; }
protected override serializeExtra(snap: CharacterSnapshot): void {
  snap.origin = this.#origin;
  snap.baseEscapeChance = this.#baseEscapeChance;
  snap.materialDrops = { ...this.#materialDrops };
  snap.lightAverse = this.#lightAverse;
}
protected override hydrateExtra(data: CharacterSnapshot, _ctx: HydrateContext): void {
  if (data.origin) this.#origin = data.origin;
  // #baseEscapeChance/#materialDrops/#lightAverse were set from options in the bare ctor.
}
```

- [ ] **Step 6: Run → PASS; full checks; commit**

```bash
npm run checks
git add src/lib/character/character.ts src/lib/character/player-character.ts src/lib/character/mob.ts src/lib/character/character.serialization.test.ts
git commit -m "feat(serialization): Character/Player/Mob serialize/hydrate seams"
```

---

## Task 8: Codex / EncounterTable / Archetype serialize/hydrate seams

**Files:**
- Modify: `src/lib/codex.ts` (Codex hydrate seam), `src/lib/encounter-table.ts`
- Test: `src/lib/codex.serialization.test.ts`, `src/lib/encounter-table.serialization.test.ts`

**Interfaces:**
- Consumes: `SERIALIZE`/`HYDRATE`/`HYDRATE_CODEX`, `EncounterTableSnapshot`, `CampaignRegistry.formation`, the existing module-local `deepFreeze` in codex.ts.
- Produces: `codex[HYDRATE_CODEX](entries: CodexEntry[])` (inject pre-built frozen entries, preserving `firstSeen`); `encounterTable[SERIALIZE](): EncounterTableSnapshot`, `encounterTable[HYDRATE](data, registry)`. Archetypes are pure data — serialized/restored inline by the Campaign seam (Task 9), no seam here.

- [ ] **Step 1: Write the failing tests**

Codex:

```ts
import { describe, it, expect } from "vitest";
import { Codex } from "./codex";
import { HYDRATE_CODEX } from "./serialization/symbols";

describe("Codex hydrate", () => {
  it("injects pre-built entries preserving firstSeen and order", () => {
    const codex = new Codex();
    const entry = { kind: "material", key: "metal", snapshot: { type: "metal" },
      firstSeen: { round: 2, characterId: undefined, roomId: undefined } } as never;
    codex[HYDRATE_CODEX]([entry]);
    expect(codex.size).toBe(1);
    expect(codex.all[0]).toBe(entry);
  });
});
```

EncounterTable:

```ts
import { describe, it, expect } from "vitest";
import { EncounterTable } from "./encounter-table";
import { SERIALIZE, HYDRATE } from "./serialization/symbols";
import { CampaignRegistry } from "./serialization/registry";

describe("EncounterTable serialization", () => {
  it("round-trips baseChance, visited rooms, and formation keys", () => {
    const reg = new CampaignRegistry();
    reg.registerFormation("pack", { build: () => [] });
    const table = new EncounterTable(() => 0.5, 30);
    // mark a room visited via maybeSpawn (no formations → no spawn, but marks visited)
    table.maybeSpawn({ id: "room-1", spawnModifier: 1, occupants: [] } as never, { party: [] } as never);

    const snap = table[SERIALIZE]();
    snap.formations.push({ behaviorKey: "pack", weight: 3 });

    const restored = new EncounterTable(() => 0.5, 0);
    restored[HYDRATE](snap, reg);
    const round = restored[SERIALIZE]();
    expect(round.baseChance).toBe(30);
    expect(round.visited).toContain("room-1");
    expect(round.formations).toEqual([{ behaviorKey: "pack", weight: 3 }]);
  });
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement the Codex hydrate seam**

In `codex.ts` (import `HYDRATE_CODEX`; `deepFreeze` and `#entries` are in-file):

```ts
[HYDRATE_CODEX](entries: CodexEntry[]) {
  for (const entry of entries) {
    deepFreeze(entry);
    this.#entries.set(`${entry.kind}::${entry.key}`, entry);
  }
}
```

- [ ] **Step 4: Implement the EncounterTable seams**

In `encounter-table.ts` (import `SERIALIZE`, `HYDRATE`, `EncounterTableSnapshot`, `CampaignRegistry` type):

```ts
[SERIALIZE](): EncounterTableSnapshot {
  return {
    baseChance: this.#baseChance,
    visited: [...this.#visited],
    formations: this.#formations.map((f) => ({ behaviorKey: f.id, weight: f.weight })),
  };
}

[HYDRATE](data: EncounterTableSnapshot, registry: CampaignRegistry) {
  this.#baseChance = data.baseChance;
  for (const id of data.visited) this.#visited.add(id);
  for (const f of data.formations) {
    this.#formations.push({ id: f.behaviorKey, weight: f.weight, build: registry.formation(f.behaviorKey).build });
  }
}
```

> Restores formations directly into `#formations`, bypassing `addFormation`'s key-drop validation (a restore is not a fresh registration). The formation's stable `id` doubles as its registry key.

- [ ] **Step 5: Run both → PASS; full checks; commit**

```bash
npm run checks
git add src/lib/codex.ts src/lib/encounter-table.ts src/lib/codex.serialization.test.ts src/lib/encounter-table.serialization.test.ts
git commit -m "feat(serialization): Codex inject + EncounterTable serialize/hydrate seams"
```

---

## Task 9: Campaign seam + top-level orchestration (serialize + two-pass deserialize)

**Files:**
- Modify: `src/lib/campaign.ts` (`Campaign` `[SERIALIZE]`/`[HYDRATE]`), `src/lib/serialization/serializer.ts`, `src/lib/serialization/deserializer.ts`
- Test: `src/lib/serialization/roundtrip.test.ts`

**Interfaces:**
- Consumes: every seam from Tasks 2–8; `CampaignRegistry`, `HydrateContext`.
- Produces: `serializeCampaign(campaign): CampaignSnapshot` (validate + walk) and `deserializeCampaign(data, { registry, rng }): Campaign` (version gate → pass 1 construct+index → pass 2 hydrate). `campaign[SERIALIZE]()` returns the `CampaignCoreSnapshot`; `campaign[HYDRATE](core, ctx)` restores campaign-level state and wires party/gm/recipes/archetypes/encounterTable/codex.

- [ ] **Step 1: Write the failing integration test**

```ts
import { describe, it, expect } from "vitest";
import { Campaign } from "../campaign";
import { PlayerCharacter } from "../character/player-character";
import { Room } from "../room";
import { serializeCampaign } from "./serializer";
import { deserializeCampaign } from "./deserializer";
import { CampaignRegistry } from "./registry";

function buildCampaign() {
  const campaign = new Campaign("Crypt", 10);
  const start = new Room("Start", "entrance", [], {});
  const pc = new PlayerCharacter(campaign, "Ada", { health: 8, sanity: 5, energy: 6 });
  pc.joinCampaign();
  campaign.setGM(pc); // use the engine's real GM-assignment API
  return { campaign, start, pc };
}

describe("campaign round-trip", () => {
  it("serializes and restores a campaign that keeps playing identically", () => {
    const { campaign, pc } = buildCampaign();
    const snap = serializeCampaign(campaign);
    expect(snap.schemaVersion).toBe(1);

    const restored = deserializeCampaign(snap, { registry: new CampaignRegistry(), rng: () => 0.5 });
    expect(restored.title).toBe("Crypt");
    expect(restored.party.map((p) => p.name)).toEqual(["Ada"]);
    expect(restored.party[0]!.id).toBe(pc.id);
  });

  it("rejects a dangling reference and an unknown version", () => {
    const { campaign } = buildCampaign();
    const snap = serializeCampaign(campaign);
    const broken = structuredClone(snap);
    broken.campaign.partyIds = ["nope"];
    expect(() => deserializeCampaign(broken, { registry: new CampaignRegistry() })).toThrow(/dangling/);
    expect(() => deserializeCampaign({ ...snap, schemaVersion: 7 }, { registry: new CampaignRegistry() })).toThrow(/schemaVersion/);
  });
});
```

> Use the engine's actual GM-assignment and party APIs — read `campaign.ts` for the real method names (`setGM`/`assignGM`/a setter) and adjust the test. Keep the build minimal so the test is about round-tripping, not content.

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement `campaign[SERIALIZE]()`**

In `campaign.ts` (class method — full private access; import `SERIALIZE`, `HYDRATE`, `CampaignCoreSnapshot`, `HydrateContext`):

```ts
[SERIALIZE](): CampaignCoreSnapshot {
  return {
    id: this.id,
    title: this.title,
    maxRounds: this.maxRounds,
    round: this.#round,
    started: this.#started,
    finished: this.#finished,
    activeCharacterIndex: this.#activeCharacterIndex,
    partyIds: this.party.map((p) => p.id),
    actedThisRound: this.party.filter((p) => this.#actedThisRound.get(p)).map((p) => p.id),
    gmId: this.#gm?.id ?? null,
    materials: { ...this.#materials },
    claims: [...this.#claims],
    encountered: [...this.#encountered],
    knownRecipes: [...this.#knownRecipes.keys()],
    archetypes: [...this.#archetypes.values()].map((a) => ({ ...a })),
    actionSounds: { ...this.#actionSounds },
    encounterTable: this.#encounterTable[SERIALIZE](),
  };
}
```

> `knownRecipes` stores recipe **ids as registry keys** — the recipe's `RecipeId` is its registry key; authors must `registerRecipe(recipe.id, recipe)`. Confirm `#actedThisRound` is the `WeakMap<IPlayerCharacter, boolean>`; serialize it by filtering the party. Confirm exact private field names against `campaign.ts:111-131`.

- [ ] **Step 4: Implement `serializeCampaign` (walk + validate)**

In `serializer.ts`:

```ts
export function serializeCampaign(campaign: ICampaign): CampaignSnapshot {
  const c = campaign as Campaign;
  const rooms: RoomSnapshot[] = [];
  const characters: CharacterSnapshot[] = [];
  const items: ItemSnapshot[] = [];
  const loot: LootSnapshot[] = [];
  const materialCaches: MaterialCacheSnapshot[] = [];
  const seenItems = new Set<string>();

  const addItem = (item: IItem) => {
    if (seenItems.has(item.id)) return;
    seenItems.add(item.id);
    items.push(item[SERIALIZE]()); // throws if a non-key item lacks behaviorKey (fail-fast validation)
  };

  // Characters (party + room occupants), their items, and equipment
  const allCharacters = new Map<string, ICharacter>();
  for (const p of c.party) allCharacters.set(p.id, p);
  // rooms reachable from each character's currentRoom + exits (BFS)
  const roomQueue: IRoom[] = [];
  const seenRooms = new Set<string>();
  const enqueueRoom = (r: IRoom) => { if (!seenRooms.has(r.id)) { seenRooms.add(r.id); roomQueue.push(r); } };
  for (const p of c.party) if (p.currentRoom) enqueueRoom(p.currentRoom);
  while (roomQueue.length) {
    const r = roomQueue.shift()!;
    rooms.push(r[SERIALIZE]());
    for (const [, dest] of r.exits) enqueueRoom(dest);
    for (const occ of r.occupants) allCharacters.set(occ.id, occ);
    for (const [, box] of r.loot) { loot.push(box[SERIALIZE]()); for (const it of box.contents) addItem(it); }
    for (const [, cache] of r.materials) materialCaches.push(cache[SERIALIZE]());
  }
  for (const ch of allCharacters.values()) {
    characters.push(ch[SERIALIZE]());
    for (const it of ch.inventory.items) addItem(it);
    for (const k of ch.inventory.keys) addItem(k);
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    campaign: c[SERIALIZE](),
    rooms, characters, items, loot, materialCaches,
    codex: [...c.codex.all],
  };
}
```

> This BFS assumes rooms are reachable from a party member's `currentRoom` via `exits`. If the campaign can hold rooms no one occupies and nothing links to, add a room registry to walk; for the spec's save/load of an in-play campaign, reachable-from-party is sufficient — **log this assumption** in the task report. Import all `*Snapshot` types, `SERIALIZE`, `SCHEMA_VERSION`, `Campaign`, and the entity interfaces.

- [ ] **Step 5: Implement `campaign[HYDRATE]` + `deserializeCampaign` (two-pass)**

`deserializer.ts`:

```ts
export function deserializeCampaign(
  data: CampaignSnapshot,
  opts: { registry: CampaignRegistry; rng?: () => number },
): Campaign {
  migrate(data);
  const rng = opts.rng ?? Math.random;
  const ctx = new HydrateContext(opts.registry, rng);

  // Campaign shell first (characters need the back-reference)
  const core = data.campaign;
  const campaign = new Campaign(core.title, core.maxRounds, [], { rng });
  campaign.id = core.id as CampaignId;
  ctx.put(campaign.id, campaign);

  // PASS 1 — construct + index every entity (no refs yet)
  for (const itemData of data.items) hydrateItem(itemData, ctx);          // also ctx.put
  for (const lootData of data.loot) hydrateLoot(lootData, ctx);
  for (const cacheData of data.materialCaches) hydrateMaterialCache(cacheData, ctx);
  const rooms = data.rooms.map((r) => { const room = constructBareRoom(r); ctx.put(room.id, room); return { room, data: r }; });
  const chars = data.characters.map((d) => { const ch = constructBareCharacter(d, campaign); ctx.put(ch.id, ch); return { ch, data: d }; });

  // PASS 2 — wire references
  campaign[HYDRATE](core, ctx);                       // restores archetypes (needed by PCs), party, gm, recipes, codex, encounterTable
  for (const { ch, data: d } of chars) ch[HYDRATE](d, ctx);
  for (const { room, data: r } of rooms) room[HYDRATE](r, ctx);

  return campaign;
}
```

`campaign[HYDRATE]` (class method):

```ts
[HYDRATE](core: CampaignCoreSnapshot, ctx: HydrateContext) {
  this.#round = core.round;
  this.#started = core.started;
  this.#finished = core.finished;
  this.#activeCharacterIndex = core.activeCharacterIndex;
  this.#materials = { ...core.materials };
  for (const k of core.claims) this.#claims.add(k);
  for (const k of core.encountered) this.#encountered.add(k);
  this.#actionSounds = { ...core.actionSounds };
  for (const a of core.archetypes) this.#archetypes.set(a.id, { ...a }); // before PCs hydrate? see ordering note
  for (const key of core.knownRecipes) {
    const recipe = ctx.registry.recipe(key);
    this.#knownRecipes.set(recipe.id, recipe);
  }
  for (const id of core.partyIds) this.party.push(ctx.character(id) as IPlayerCharacter);
  this.#gm = core.gmId ? (ctx.character(core.gmId) as IPlayerCharacter) : undefined;
  for (const id of core.actedThisRound) this.#actedThisRound.set(ctx.character(id) as IPlayerCharacter, true);
  this.#encounterTable[HYDRATE](core.encounterTable, ctx.registry);
  this.#codex[HYDRATE_CODEX](data.codex); // pass the full snapshot's codex array — see note
}
```

> **Ordering subtlety:** `PlayerCharacter.hydrateExtra` resolves `campaign.archetypes.get(...)`, so archetypes must be populated before characters hydrate. Two clean options: (a) split campaign hydration into `campaign[HYDRATE_CATALOG](core)` (archetypes + recipes) called in pass 1 right after the shell, and `campaign[HYDRATE](core, ctx)` (party/gm/refs) in pass 2; or (b) populate `#archetypes` when constructing the shell. Pick (a) — it keeps "catalog before instances" explicit. Adjust the seam split accordingly, and pass `data.codex` into the campaign hydrate (thread it through, or hydrate the codex directly in `deserializeCampaign` via `campaign.codex` — but `#codex` is private, so use a small `campaign[HYDRATE_CODEX_ENTRIES](entries)` delegating to `this.#codex[HYDRATE_CODEX]`). Confirm `campaign.id`, `party`, `setGM` and private field names against `campaign.ts`.

- [ ] **Step 6: Run integration tests → PASS; then add a "continue playing" assertion**

Extend `roundtrip.test.ts`: after restore, advance a turn / move the PC and assert no throw and consistent state. Run `npx vitest run src/lib/serialization/roundtrip.test.ts` → PASS.

- [ ] **Step 7: Full checks and commit**

```bash
npm run checks
git add src/lib/campaign.ts src/lib/serialization/serializer.ts src/lib/serialization/deserializer.ts src/lib/serialization/roundtrip.test.ts
git commit -m "feat(serialization): Campaign seam + top-level two-pass serialize/deserialize"
```

---

## Task 10: Documentation (README + TSDoc)

**Files:**
- Modify: `README.md`, TSDoc on the new public surface (`serializeCampaign`, `deserializeCampaign`, `CampaignRegistry`, the `behaviorKey` constructor params).

**Interfaces:** none (docs only).

- [ ] **Step 1: Add a "Serialization & save/load" section to `README.md`**

Document: the snapshot is self-contained data; the `CampaignRegistry` supplies the four author-behavior namespaces (scenes, recipes, formations, non-key items); every serializable scene/recipe/formation/non-key item needs a `behaviorKey` (keys exempt — rebuilt via `createKey`); `serializeCampaign` / `deserializeCampaign(data, { registry, rng })`; `rng` is re-injected, never stored; afflictions restore in full; `schemaVersion`/`migrate` for forward-compat; and the out-of-scope note (no deltas/sync/transport yet). Include a short code example: register behaviors, `const snap = serializeCampaign(c); const c2 = deserializeCampaign(snap, { registry });`.

- [ ] **Step 2: Add TSDoc**

Add concise TSDoc to `serializeCampaign`, `deserializeCampaign`, `CampaignRegistry` (and each `register*`), and a one-line note on the `behaviorKey` constructor params of `Item` and `Scene` pointing to the registry.

- [ ] **Step 3: Verify and commit**

```bash
npm run checks   # ensure no broken doc code fences / type references
git add README.md src/lib/
git commit -m "docs: document campaign serialization, registry, and behaviorKeys"
```

---

## Self-Review Notes (for the executor)

- **Spec coverage:** Tasks 2–9 cover every entity in the snapshot shape; Task 6 covers full affliction fidelity; Task 8 covers the Codex hydrate seam; Task 9 covers two-pass wiring, validation (dangling ref + version), and continue-playing. Task 10 covers the docs requirement.
- **Reference-resolution ordering** is the load-bearing invariant: pass 1 indexes *all* entities before pass 2 wires *any* references, and the campaign **catalog** (archetypes/recipes) is restored before characters hydrate. If a `dangling id` throws during pass 2, the cause is almost always an entity missing from pass 1 (check the deserializer's pass-1 list).
- **Equipment must not replay `[EQUIP]`** (Task 7) — direct map population only. Re-running equip would double-apply author effects.
- **`behaviorKey` is required at serialize time** for non-key items, scenes, recipes (by id), and formations (by id) — serialize throws, naming the offender, when one is missing (Tasks 2, 4; recipes/formations validated by the registry lookup raising on restore).
