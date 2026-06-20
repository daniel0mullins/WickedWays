# Campaign Authoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fluent, type-safe builder that authors reusable, player-less campaign **templates** over the real engine constructors, plus the thin orchestration (`instantiate` + `startSession`) that turns a template into a playable instance the existing comms/persistence layers run.

**Architecture:** A new engine module `src/lib/authoring/`. A `TypedRegistry` (from `defineRegistry({...})`) carries inferred item/recipe key literals; `authorTemplate(title, registry, opts)` is generic over it, so `drops`/`items`/`lights`/`.recipe` are compile-time-checked. The builder accumulates a description; `assemble(description, registry)` validates (collect-all → `AuthoringError`) then constructs real `Campaign`/`Room`/`Mob`/`Item`/`Loot`/`MaterialCache` instances in the engine's required order, returning a live **player-less, not-begun** `Campaign`. `instantiate` clones a template snapshot with a fresh campaign id; `startSession` scripts the existing `joinCampaign`/`begin` engine APIs for fixtures + the demo.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`, `NodeNext`), pnpm workspaces, vitest.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-19-campaign-authoring-design.md`. Re-read the relevant section before each task.
- **Additive / behavior-preserving.** The authoring module is new; the seed reuse (Task 5) must keep `buildSeedCampaign`'s observable output equivalent (2 PCs, Ada active + GM, started, `delver` archetype, widget recipe + materials, `Start`→North→`Next`) so existing server/client tests stay green. Every task ends fully green (`pnpm checks`).
- **Behaviors stay code; keys are typed.** Item factories / recipe `create()` / scenes / formations are hand-written and registered via `defineRegistry`; the builder references them by key (compile-time-checked). Archetypes are authored inline as data.
- **The builder produces a player-less, not-begun `Campaign`** — no players, no GM, not begun. Players/GM/begin are `startSession`/comms concerns.
- **Branded ids** via the engine's helpers; archetype/recipe ids are author-chosen strings. Illegal engine states throw `ProceduralViolation`. All randomness via the injected `rng`.
- **Commits:** end every commit message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Commit only at the end of each task. Do not push / open a PR unless the user asks.
- Full verification each task: `pnpm checks` (= `pnpm run lint && pnpm run typecheck && pnpm -r run typecheck && pnpm run test`).

---

## File Structure

- `src/lib/authoring/registry.ts` — **new.** `defineRegistry({ items, recipes?, scenes?, formations? })` + the `TypedRegistry` type + `ItemKeyOf`/`RecipeKeyOf` extractors. Inference over a runtime `CampaignRegistry`.
- `src/lib/authoring/errors.ts` — **new.** `AuthoringError` (aggregates a list of problem messages).
- `src/lib/authoring/description.ts` — **new.** The authoring-description types (`CampaignTemplateDescription`, `RoomDef`, `MobDef`, `LootDef`, `CacheDef`, `ExitDef`, `ArchetypeDef`) — plain `string` keys (the builder layers the compile-time typing on top).
- `src/lib/authoring/assembler.ts` — **new.** `assemble(description, registry)` → validate-all (`AuthoringError`) → construct in order → `{ campaign, rooms }` (name→`Room` map for `startSession`).
- `src/lib/authoring/template-builder.ts` — **new.** `authorTemplate(title, registry, opts)` fluent API (generic over the registry), `.build()`/`.toSnapshot()`, and access to the description + registry for `startSession`.
- `src/lib/authoring/orchestration.ts` — **new.** `instantiate(template)` + `startSession(builder, opts)`.
- `packages/seed/src/index.ts` — **modify.** `buildSeedRegistry` via `defineRegistry`; `buildSeedCampaign` via `startSession`; add `seedTemplate`/`demoTemplate`.

---

### Task 1: `defineRegistry` + `TypedRegistry`

The typed-registry foundation: a const-map definition whose key literals are inferred into the type, over a runtime `CampaignRegistry`. Additive; workspace green.

**Files:**
- Create: `src/lib/authoring/registry.ts`
- Create: `src/lib/authoring/registry.test.ts`

**Interfaces:**
- Consumes: `CampaignRegistry` (`../serialization/registry`), `Item` (`../inventory`), `CraftingRecipe` (`../crafting`), `SceneBehavior`/`FormationBehavior` (`../serialization/registry`).
- Produces:
  ```ts
  export type TypedRegistry<IK extends string, RK extends string> = CampaignRegistry & {
    readonly [ITEM_KEYS]?: IK; readonly [RECIPE_KEYS]?: RK;
  };
  export type ItemKeyOf<R> = R extends { readonly [ITEM_KEYS]?: infer K extends string } ? K : string;
  export type RecipeKeyOf<R> = R extends { readonly [RECIPE_KEYS]?: infer K extends string } ? K : string;
  export function defineRegistry<
    I extends Record<string, () => Item>,
    R extends Record<string, CraftingRecipe> = Record<string, never>,
  >(defs: { items: I; recipes?: R; scenes?: Record<string, SceneBehavior>; formations?: Record<string, FormationBehavior> }):
    TypedRegistry<keyof I & string, keyof R & string>;
  ```

- [ ] **Step 1: Write the failing tests (runtime + type-level)**

Create `src/lib/authoring/registry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { defineRegistry, type ItemKeyOf, type RecipeKeyOf } from "./registry";
import { Item } from "../inventory";
import { StatType } from "../character/stats";
import { SlotKind } from "../equipment";

function makeWidget(): Item {
  const noop = () => {};
  return new Item(
    { type: "weapon", recipe: { item: 1 }, modifier: 0, stat: StatType.Health, name: "Widget", slot: SlotKind.Hand, behaviorKey: "widget-item" },
    { equippable: true, equipped: false, destroyable: true, usable: false },
    { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    { onPickUp: noop },
  );
}
const widgetRecipe = { id: "widget" as never, materials: { metal: 2 }, create: makeWidget };

describe("defineRegistry", () => {
  it("produces a runtime CampaignRegistry with the items/recipes registered", () => {
    const reg = defineRegistry({ items: { "widget-item": makeWidget }, recipes: { "widget": widgetRecipe } });
    expect(reg.item("widget-item")()).toBeInstanceOf(Item); // factory resolves + runs
    expect(reg.recipe("widget")).toBe(widgetRecipe);
  });

  it("infers the key-literal unions into the type (compile-time)", () => {
    const reg = defineRegistry({ items: { a: makeWidget, b: makeWidget }, recipes: { r: widgetRecipe } });
    type IK = ItemKeyOf<typeof reg>;
    type RK = RecipeKeyOf<typeof reg>;
    const ik: IK = "a"; const rk: RK = "r"; // OK
    // @ts-expect-error "c" is not a registered item key
    const bad: IK = "c";
    void ik; void rk; void bad;
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `pnpm vitest run src/lib/authoring/registry.test.ts`
Expected: FAIL — `Cannot find module './registry'`.

- [ ] **Step 3: Implement `registry.ts`**

```ts
import { CampaignRegistry, type SceneBehavior, type FormationBehavior } from "../serialization/registry";
import type { Item } from "../inventory";
import type { CraftingRecipe } from "../crafting";

declare const ITEM_KEYS: unique symbol;
declare const RECIPE_KEYS: unique symbol;

/** A {@link CampaignRegistry} whose item/recipe key literals are carried in the type (phantom — no runtime field). */
export type TypedRegistry<IK extends string, RK extends string> = CampaignRegistry & {
  readonly [ITEM_KEYS]?: IK;
  readonly [RECIPE_KEYS]?: RK;
};

/** The registered item-factory key union of a {@link TypedRegistry} (falls back to `string`). */
export type ItemKeyOf<R> = R extends { readonly [ITEM_KEYS]?: infer K extends string } ? K : string;
/** The registered recipe key union of a {@link TypedRegistry} (falls back to `string`). */
export type RecipeKeyOf<R> = R extends { readonly [RECIPE_KEYS]?: infer K extends string } ? K : string;

/**
 * Defines a campaign registry from a const map of behaviors. Builds a normal
 * runtime {@link CampaignRegistry} (consumed unchanged by the server / Authority /
 * serialization) but returns it typed as a {@link TypedRegistry} carrying the
 * inferred item/recipe key literals, so {@link authorTemplate} can compile-time-check
 * every key argument.
 */
export function defineRegistry<
  I extends Record<string, () => Item>,
  R extends Record<string, CraftingRecipe> = Record<string, never>,
>(defs: {
  items: I;
  recipes?: R;
  scenes?: Record<string, SceneBehavior>;
  formations?: Record<string, FormationBehavior>;
}): TypedRegistry<keyof I & string, keyof R & string> {
  const reg = new CampaignRegistry();
  for (const [key, factory] of Object.entries(defs.items)) reg.registerItem(key, factory);
  for (const [key, recipe] of Object.entries(defs.recipes ?? {})) reg.registerRecipe(key, recipe);
  for (const [key, scene] of Object.entries(defs.scenes ?? {})) reg.registerScene(key, scene);
  for (const [key, formation] of Object.entries(defs.formations ?? {})) reg.registerFormation(key, formation);
  return reg as unknown as TypedRegistry<keyof I & string, keyof R & string>;
}
```

> If the `@ts-expect-error` type-level test does not behave (the phantom-key extraction is finicky), iterate on the `ItemKeyOf`/`RecipeKeyOf` conditional types until: a registered key assigns cleanly AND a misspelled key is a `@ts-expect-error`. That type-level test passing is the acceptance criterion for the typing.

- [ ] **Step 4: Run the tests — verify they pass**

Run: `pnpm vitest run src/lib/authoring/registry.test.ts`
Expected: PASS (the runtime test + the type-level test compiling with the `@ts-expect-error` honored).

- [ ] **Step 5: Full checks + commit**

Run: `pnpm checks` → green.

```bash
git add src/lib/authoring/registry.ts src/lib/authoring/registry.test.ts
git commit -m "$(cat <<'EOF'
feat(authoring): defineRegistry + TypedRegistry (typed key inference)

A const-map registry definition whose item/recipe key literals are inferred into
the type (phantom keys over a runtime CampaignRegistry), so the upcoming builder
can compile-time-check every key argument.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Authoring description + assembler + `AuthoringError`

The core: validate a template description (collect-all → `AuthoringError`) and construct a live player-less `Campaign` in the engine's required order. Tested with hand-built descriptions (no fluent API yet). Additive; green.

**Files:**
- Create: `src/lib/authoring/errors.ts`
- Create: `src/lib/authoring/description.ts`
- Create: `src/lib/authoring/assembler.ts`
- Create: `src/lib/authoring/assembler.test.ts`

**Interfaces:**
- Consumes: `Campaign`/`Room`/`PlayerCharacter`-free (no players), `Mob` (`../character/mob`), `Item` via `registry.item(key)()`, `Loot` (`../loot`), `MaterialCache` (`../material-cache`), `Directions`/`Direction` (`../room`), `Stats`/`StatType` (`../character/stats`), `MaterialMap` (`../inventory`), `Status` (`../status`), `CampaignRegistry`.
- Produces:
  ```ts
  // errors.ts
  export class AuthoringError extends Error { constructor(problems: string[]); readonly problems: string[]; }
  // description.ts
  export interface ArchetypeDef { id: string; name: string; statModifiers?: Partial<Stats>; inventorySlots?: number; immunities?: Status[] }
  export interface RoomDef { name: string; description: string; dark?: boolean; spawnModifier?: number; lights?: string[] }
  export interface ExitDef { from: string; direction: Direction; to: string }
  export interface MobDef { name: string; stats: Stats; room?: string; inventorySlots?: number; actionsPerRound?: number; drops?: string[]; baseEscapeChance?: number; materialDrops?: MaterialMap; lightAverse?: boolean }
  export interface LootDef { name: string; room: string; items: string[]; description?: string }
  export interface CacheDef { name: string; room: string; materials: MaterialMap }
  export interface CampaignTemplateDescription {
    title: string;
    opts: { rng?: () => number; maxRounds?: number; baseEncounterChance?: number };
    archetypes: ArchetypeDef[]; rooms: RoomDef[]; startRoom?: string; exits: ExitDef[];
    mobs: MobDef[]; loot: LootDef[]; caches: CacheDef[]; recipes: string[];
    materials: { source: string; map: MaterialMap }[];
  }
  // assembler.ts
  export function assemble(desc: CampaignTemplateDescription, registry: CampaignRegistry): { campaign: Campaign; rooms: Map<string, Room> };
  ```

- [ ] **Step 1: Write `errors.ts` + `description.ts`**

`src/lib/authoring/errors.ts`:
```ts
/** Aggregates all template-validation problems found during {@link assemble}'s validate pass. */
export class AuthoringError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Campaign template is invalid:\n- ${problems.join("\n- ")}`);
    this.name = "AuthoringError";
    this.problems = problems;
  }
}
```

`src/lib/authoring/description.ts`: the interfaces from **Produces** above. Import the supporting types: `Stats` from `../character/stats`, `Status` from `../status`, `Direction` from `../room`, `MaterialMap` from `../inventory` (`export type MaterialMap = Partial<Record<ItemComponentType, number>>`).

- [ ] **Step 2: Write the failing assembler tests**

Create `src/lib/authoring/assembler.test.ts`. Build a description by hand and assert the constructed campaign:

```ts
import { describe, it, expect } from "vitest";
import { assemble } from "./assembler";
import { AuthoringError } from "./errors";
import { defineRegistry } from "./registry";
import { Directions } from "../room";
import { StatType } from "../character/stats";
import { Item } from "../inventory";
import { SlotKind } from "../equipment";
import { serializeCampaign } from "../serialization/serializer";
import type { CampaignTemplateDescription } from "./description";

const makeCoin = () => new Item(
  { type: "consumable", recipe: { item: 1 }, modifier: 0, stat: StatType.Health, name: "Coin", behaviorKey: "coin-item" },
  { equippable: false, equipped: false, destroyable: true, usable: false },
  { pickUp: () => {}, equip: () => {}, unequip: () => {}, transfer: () => {}, use: () => {}, destroy: () => null },
  { onPickUp: () => {} },
);
const registry = defineRegistry({ items: { "coin-item": makeCoin } });
const stats = () => ({ [StatType.Health]: 10, [StatType.Sanity]: 10, [StatType.Energy]: 10 });

function baseDesc(over: Partial<CampaignTemplateDescription> = {}): CampaignTemplateDescription {
  return {
    title: "Crypt", opts: { rng: () => 0.5, maxRounds: 10 },
    archetypes: [], rooms: [{ name: "start", description: "the entrance" }, { name: "next", description: "next" }],
    startRoom: "start", exits: [{ from: "start", direction: Directions.North, to: "next" }],
    mobs: [], loot: [], caches: [], recipes: [], materials: [], ...over,
  };
}

describe("assemble", () => {
  it("constructs a player-less, not-begun campaign with rooms + exit", () => {
    const { campaign, rooms } = assemble(baseDesc(), registry);
    expect(campaign.started).toBe(false);
    expect(campaign.party.length).toBe(0);          // no players
    expect(rooms.get("start")!.exits.get(Directions.North)).toBe(rooms.get("next"));
    expect(serializeCampaign(campaign)).toBeDefined(); // serializable
  });

  it("places a mob's drops + a loot box's items from registry keys", () => {
    const { campaign } = assemble(baseDesc({
      mobs: [{ name: "goblin", stats: stats(), room: "next", drops: ["coin-item"] }],
      loot: [{ name: "chest", room: "next", items: ["coin-item"] }],
    }), registry);
    const snap = serializeCampaign(campaign);
    expect(snap.items.length).toBeGreaterThanOrEqual(2); // a fresh instance per reference
  });

  it("collects ALL validation problems into one AuthoringError", () => {
    let err: AuthoringError | null = null;
    try {
      assemble(baseDesc({
        exits: [{ from: "start", direction: Directions.North, to: "nowhere" }], // dangling room
        rooms: [{ name: "start", description: "x" }, { name: "start", description: "dup" }], // duplicate
        startRoom: "ghost", // unknown
      }), registry);
    } catch (e) { err = e as AuthoringError; }
    expect(err).toBeInstanceOf(AuthoringError);
    expect(err!.problems.length).toBeGreaterThanOrEqual(3); // all collected, not fail-fast
  });
});
```

- [ ] **Step 3: Run them — verify they fail**

Run: `pnpm vitest run src/lib/authoring/assembler.test.ts`
Expected: FAIL — `Cannot find module './assembler'`.

- [ ] **Step 4: Implement `assemble`**

Create `src/lib/authoring/assembler.ts`. Read the seed (`packages/seed/src/index.ts`) and the engine constructors for `Mob`/`Loot`/`MaterialCache`/`Room` for exact params. Structure:

```ts
import { Campaign } from "../campaign";
import { Room, Directions } from "../room";
import { Mob } from "../character/mob";
import { Loot } from "../loot";
import { MaterialCache } from "../material-cache";
import { AuthoringError } from "./errors";
import type { CampaignRegistry } from "../serialization/registry";
import type { CampaignTemplateDescription } from "./description";

const NO_EXITS = {} as Record<import("../room").Direction, Room>; // empty exits; wired via addExit

export function assemble(
  desc: CampaignTemplateDescription,
  registry: CampaignRegistry,
): { campaign: Campaign; rooms: Map<string, Room> } {
  // ---- Pass 1: validate-all ----
  const problems: string[] = [];
  const roomNames = new Set<string>();
  const dupCheck = (kind: string, names: string[]) => {
    const seen = new Set<string>();
    for (const n of names) { if (seen.has(n)) problems.push(`Duplicate ${kind} name '${n}'.`); seen.add(n); }
  };
  for (const r of desc.rooms) roomNames.add(r.name);
  dupCheck("room", desc.rooms.map((r) => r.name));
  dupCheck("mob", desc.mobs.map((m) => m.name));
  dupCheck("loot", desc.loot.map((l) => l.name));
  dupCheck("cache", desc.caches.map((c) => c.name));
  const requireRoom = (name: string | undefined, ctx: string) => {
    if (name !== undefined && !roomNames.has(name)) problems.push(`${ctx} references undefined room '${name}'.`);
  };
  if (desc.startRoom !== undefined) requireRoom(desc.startRoom, "startRoom");
  for (const e of desc.exits) { requireRoom(e.from, `exit.from`); requireRoom(e.to, `exit.to`); }
  for (const m of desc.mobs) requireRoom(m.room, `mob '${m.name}'`);
  for (const l of desc.loot) requireRoom(l.room, `loot '${l.name}'`);
  for (const c of desc.caches) requireRoom(c.room, `cache '${c.name}'`);
  // Defensive runtime key guard (compile-time-checked at the builder level):
  const requireItemKey = (k: string, ctx: string) => { try { registry.item(k); } catch { problems.push(`${ctx} references unregistered item key '${k}'.`); } };
  for (const m of desc.mobs) for (const k of m.drops ?? []) requireItemKey(k, `mob '${m.name}' drop`);
  for (const l of desc.loot) for (const k of l.items) requireItemKey(k, `loot '${l.name}' item`);
  for (const r of desc.rooms) for (const k of r.lights ?? []) requireItemKey(k, `room '${r.name}' light`);
  for (const k of desc.recipes) { try { registry.recipe(k); } catch { problems.push(`recipe references unregistered recipe key '${k}'.`); } }
  if (problems.length > 0) throw new AuthoringError(problems);

  // ---- Pass 2: construct in order ----
  const campaign = new Campaign(desc.title, desc.opts.maxRounds ?? 100, [], {
    rng: desc.opts.rng, baseEncounterChance: desc.opts.baseEncounterChance,
  });
  for (const a of desc.archetypes) campaign.registerArchetype({ id: a.id as never, name: a.name, statModifiers: a.statModifiers, inventorySlots: a.inventorySlots, immunities: a.immunities });

  const caches = new Map<string, MaterialCache>();
  for (const c of desc.caches) caches.set(c.name, new MaterialCache(c.materials));

  const loot = new Map<string, Loot>();
  for (const l of desc.loot) loot.set(l.name, new Loot(l.description ?? l.name, l.items.map((k) => registry.item(k)())));

  const mobs = new Map<string, Mob>();
  for (const m of desc.mobs) {
    mobs.set(m.name, new Mob(campaign, m.name, m.stats, m.inventorySlots ?? 2, m.actionsPerRound ?? 2,
      (m.drops ?? []).map((k) => registry.item(k)()),
      { baseEscapeChance: m.baseEscapeChance, materialDrops: m.materialDrops, lightAverse: m.lightAverse }));
  }

  const rooms = new Map<string, Room>();
  for (const r of desc.rooms) {
    const roomLoot = desc.loot.filter((l) => l.room === r.name).map((l) => loot.get(l.name)!);
    const roomCaches = desc.caches.filter((c) => c.room === r.name).map((c) => caches.get(c.name)!);
    const lights = (r.lights ?? []).map((k) => registry.item(k)());
    rooms.set(r.name, new Room(r.name, r.description, roomLoot, NO_EXITS, roomCaches, r.spawnModifier ?? 1, [], undefined, r.dark ?? false, lights));
  }
  for (const m of desc.mobs) if (m.room !== undefined) rooms.get(m.room)!.placeMob(mobs.get(m.name)!);
  for (const e of desc.exits) rooms.get(e.from)!.addExit(e.direction, rooms.get(e.to)!);

  for (const k of desc.recipes) campaign.discoverRecipe(registry.recipe(k));
  for (const mat of desc.materials) campaign.claimMaterials(mat.source, mat.map);

  return { campaign, rooms };
}
```

The constructor argument lists above match the engine's signatures (`Mob(campaign, name, stats, inventorySlots, actionsPerRound, drops, options)`; `Room(name, description, loot, exits, materials, spawnModifier, mobs, presentation, dark, lightSources)`; `Loot(description, contents, presentation?)`; `MaterialCache(contents, presentation?)`); confirm them against the files if a constructor has changed.

- [ ] **Step 5: Run the tests — verify they pass**

Run: `pnpm vitest run src/lib/authoring/assembler.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Full checks + commit**

Run: `pnpm checks` → green.

```bash
git add src/lib/authoring/errors.ts src/lib/authoring/description.ts src/lib/authoring/assembler.ts src/lib/authoring/assembler.test.ts
git commit -m "$(cat <<'EOF'
feat(authoring): description types + assembler (validate-all -> construct)

assemble(description, registry) collects every validation problem into one
AuthoringError, then constructs a live player-less, not-begun Campaign in the
engine's required order (caches, loot, mobs, rooms, placeMob, exits, recipes,
materials), returning the campaign + a name->Room map for orchestration.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: The fluent `authorTemplate` builder

The chainable, type-safe front-end that accumulates the description and delegates to `assemble`. Additive; green.

**Files:**
- Create: `src/lib/authoring/template-builder.ts`
- Create: `src/lib/authoring/template-builder.test.ts`
- Modify: `src/lib/serialization/serializer.ts` (optional `rootRooms` — see Step 0)
- Modify: `src/lib/serialization/serializer.test.ts` (a `rootRooms` test)

> **Why the serializer change (discovered during Task 2):** `serializeCampaignWithIndex` roots its room-discovery BFS at **party members' rooms** (serializer.ts:68), so a **player-less** template serializes to an *empty* world (no rooms/items/mobs). Its own docstring notes "a campaign holding orphaned rooms would need a room registry." The fix is to let a caller supply explicit root rooms; the builder roots from the template's rooms in `.toSnapshot()`. Backward-compatible (no `rootRooms` ⇒ today's party-rooted behavior; `serializeCampaign(startedCampaign)` is unchanged).

**Interfaces:**
- Consumes: `assemble` (Task 2), `CampaignTemplateDescription` + the `*Def` types (Task 2), `TypedRegistry`/`ItemKeyOf`/`RecipeKeyOf` (Task 1), `serializeCampaign` (now with optional `rootRooms`).
- Produces:
  ```ts
  export function authorTemplate<R extends CampaignRegistry>(
    title: string, registry: R, opts?: { rng?: () => number; maxRounds?: number; baseEncounterChance?: number },
  ): TemplateBuilder<ItemKeyOf<R>, RecipeKeyOf<R>>;

  export class TemplateBuilder<IK extends string, RK extends string> {
    archetype(def: ArchetypeDef): this;
    room(name: string, opts: { description: string; dark?: boolean; spawnModifier?: number; lights?: IK[] }): this;
    startRoom(name: string): this;
    exit(from: string, direction: Direction, to: string): this;
    mob(name: string, opts: { stats: Stats; room?: string; inventorySlots?: number; actionsPerRound?: number; drops?: IK[]; baseEscapeChance?: number; materialDrops?: MaterialMap; lightAverse?: boolean }): this;
    loot(name: string, opts: { room: string; items: IK[]; description?: string }): this;
    cache(name: string, opts: { room: string; materials: MaterialMap }): this;
    materials(source: string, map: MaterialMap): this;
    recipe(key: RK): this;
    build(): Campaign;
    toSnapshot(): CampaignSnapshot;
    /** @internal for orchestration */ readonly description: CampaignTemplateDescription;
    /** @internal for orchestration */ readonly registry: CampaignRegistry;
  }
  ```

- [ ] **Step 0: Add optional `rootRooms` to the serializer (the player-less fix)**

In `src/lib/serialization/serializer.ts`, give `serializeCampaignWithIndex` an optional second arg and seed the BFS queue with the supplied rooms in addition to party rooms:
```ts
export function serializeCampaignWithIndex(
  campaign: ICampaign,
  opts: { rootRooms?: Iterable<IRoom> } = {},
): { snapshot: CampaignSnapshot; index: Map<string, unknown> } {
  // ...unchanged setup...
  for (const p of c.party) if (p.currentRoom) enqueueRoom(p.currentRoom);
  for (const r of opts.rootRooms ?? []) enqueueRoom(r);   // <-- explicit roots (e.g. a player-less template)
  // ...rest unchanged...
}
export function serializeCampaign(campaign: ICampaign, opts?: { rootRooms?: Iterable<IRoom> }): CampaignSnapshot {
  return serializeCampaignWithIndex(campaign, opts).snapshot;
}
```
Add a test to `src/lib/serialization/serializer.test.ts`: build a campaign with a room but NO party member in it (or no party), serialize WITHOUT `rootRooms` → that room is absent; serialize WITH `rootRooms: [thatRoom]` → the room (and its loot/caches/lights) is present. (This proves the new root path without weakening the existing party-rooted tests, which must stay green.)

- [ ] **Step 1: Write the failing builder tests**

```ts
import { describe, it, expect } from "vitest";
import { authorTemplate } from "./template-builder";
import { defineRegistry } from "./registry";
import { Directions } from "../room";
import { StatType } from "../character/stats";
// reuse makeCoin from a shared local helper or inline as in assembler.test.ts

describe("authorTemplate", () => {
  it("builds an equivalent campaign regardless of author order (forward refs resolve)", () => {
    const reg = defineRegistry({ items: { "coin-item": makeCoin } });
    const campaign = authorTemplate("Crypt", reg, { rng: () => 0.5, maxRounds: 10 })
      .exit("start", Directions.North, "next")          // forward ref: "next" defined below
      .room("next", { description: "next" })
      .room("start", { description: "the entrance" })
      .startRoom("start")
      .loot("chest", { room: "next", items: ["coin-item"] })
      .build();
    expect(campaign.started).toBe(false);
    expect(campaign.party.length).toBe(0);
  });

  it("toSnapshot captures the player-less template world (rooted from template rooms)", () => {
    const reg = defineRegistry({ items: { "coin-item": makeCoin } });
    const snap = authorTemplate("Crypt", reg, { rng: () => 0.5 })
      .room("start", { description: "the entrance" }).room("next", { description: "next" })
      .startRoom("start").exit("start", Directions.North, "next")
      .loot("chest", { room: "next", items: ["coin-item"] })
      .toSnapshot();
    expect(snap.rooms.length).toBe(2);          // NOT empty — the fix
    expect(snap.loot.length).toBe(1);
    expect(snap.items.length).toBe(1);
  });

  it("type-checks item/recipe keys against the registry", () => {
    const reg = defineRegistry({ items: { "coin-item": makeCoin } });
    authorTemplate("X", reg)
      .room("r", { description: "d" })
      // @ts-expect-error "nope" is not a registered item key
      .loot("chest", { room: "r", items: ["nope"] });
  });
});
```

- [ ] **Step 2: Run them — verify they fail**

Run: `pnpm vitest run src/lib/authoring/template-builder.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `authorTemplate` + `TemplateBuilder`**

The builder accumulates the `CampaignTemplateDescription`; each method pushes to the relevant array and returns `this`. `.build()` returns `assemble(this.description, this.registry).campaign`. **`.toSnapshot()` must root from the template's rooms** (a player-less campaign is empty otherwise): `const { campaign, rooms } = assemble(this.description, this.registry); return serializeCampaign(campaign, { rootRooms: rooms.values() });`. `authorTemplate` constructs the builder typed via `ItemKeyOf<R>`/`RecipeKeyOf<R>`. The method option types use `IK`/`RK` for the key fields (`lights`, `drops`, `items`, `recipe`). Keep `description`/`registry` accessible (e.g. `readonly`) for `startSession`. Provide the full class.

- [ ] **Step 4: Run the tests — verify they pass**

Run: `pnpm vitest run src/lib/authoring/template-builder.test.ts`
Expected: PASS (incl. the `@ts-expect-error` honored).

- [ ] **Step 5: Full checks + commit**

Run: `pnpm checks` → green.

```bash
git add src/lib/authoring/template-builder.ts src/lib/authoring/template-builder.test.ts src/lib/serialization/serializer.ts src/lib/serialization/serializer.test.ts
git commit -m "$(cat <<'EOF'
feat(authoring): fluent authorTemplate builder + serializer rootRooms

Chainable, ordering-agnostic API generic over the TypedRegistry, so
drops/items/lights/.recipe are compile-time-checked. .build() -> live player-less
Campaign; .toSnapshot() roots serialization from the template's rooms so a
player-less template captures its full world (serializer gains an optional,
backward-compatible rootRooms; party-rooted serialization unchanged).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Orchestration — `instantiate` + `startSession`

Template → instance genesis, and the fixture/demo session helper. Additive; green.

**Files:**
- Create: `src/lib/authoring/orchestration.ts`
- Create: `src/lib/authoring/orchestration.test.ts`

**Interfaces:**
- Consumes: `TemplateBuilder` + `assemble` (Tasks 2/3), `CampaignSnapshot` (`../serialization/types`), `deserializeCampaign`, `serializeCampaign`, `PlayerCharacter` (`../character/player-character`), `generateId`/`CampaignId` for the fresh id, `Stats`.
- Produces:
  ```ts
  export function instantiate(template: CampaignSnapshot): CampaignSnapshot;   // fresh campaign-core id, world unchanged
  export interface SessionPlayer { name: string; stats: Stats; archetype: string }
  export function startSession(builder: TemplateBuilder<string, string>, opts: { players: SessionPlayer[]; gm: number; startRoom?: string }): Campaign;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { instantiate, startSession } from "./orchestration";
import { authorTemplate } from "./template-builder";
import { defineRegistry } from "./registry";
import { Directions } from "../room";
import { StatType } from "../character/stats";

const stats = () => ({ [StatType.Health]: 10, [StatType.Sanity]: 10, [StatType.Energy]: 10 });
function seedBuilder() {
  const reg = defineRegistry({ items: {} });
  return authorTemplate("Crypt", reg, { rng: () => 0.5, maxRounds: 10 })
    .archetype({ id: "delver", name: "Delver", statModifiers: { [StatType.Health]: 2 } })
    .room("start", { description: "the entrance" }).room("next", { description: "next" })
    .startRoom("start").exit("start", Directions.North, "next");
}

describe("instantiate", () => {
  it("gives a fresh campaign id but the same world", () => {
    const template = seedBuilder().toSnapshot();
    const inst = instantiate(template);
    expect(inst.campaign.id).not.toBe(template.campaign.id);
    expect(inst.rooms.length).toBe(template.rooms.length);
  });
});

describe("startSession", () => {
  it("joins players, selects archetypes, sets gm, begins", () => {
    const campaign = startSession(seedBuilder(), {
      players: [{ name: "Ada", stats: stats(), archetype: "delver" }, { name: "Ben", stats: stats(), archetype: "delver" }],
      gm: 0,
    });
    expect(campaign.started).toBe(true);
    expect(campaign.party.length).toBe(2);
    expect(campaign.activeCharacter.name).toBe("Ada");
  });
});
```

- [ ] **Step 2: Run them — verify they fail**

Run: `pnpm vitest run src/lib/authoring/orchestration.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement orchestration**

`instantiate(template)`: structuredClone the snapshot, set `clone.campaign.id = generateId<CampaignId>()`, return it (entity ids unchanged — each instance is isolated). `startSession(builder, { players, gm, startRoom })`: `const { campaign, rooms } = assemble(builder.description, builder.registry)`; resolve the start room (`rooms.get(startRoom ?? builder.description.startRoom!)`); for each player `new PlayerCharacter(campaign, p.name, p.stats)` → `joinCampaign()` → `selectArchetype(p.archetype as ArchetypeId)` → `move(startRoomInstance)`; `campaign.gm = <the gm-th joined player>`; `campaign.beginCampaign()`; return `campaign`. (Read `src/lib/campaign.ts` for the `gm` setter + `beginCampaign`.)

- [ ] **Step 4: Run the tests — verify they pass**

Run: `pnpm vitest run src/lib/authoring/orchestration.test.ts`
Expected: PASS.

- [ ] **Step 5: Full checks + commit**

Run: `pnpm checks` → green.

```bash
git add src/lib/authoring/orchestration.ts src/lib/authoring/orchestration.test.ts
git commit -m "$(cat <<'EOF'
feat(authoring): orchestration — instantiate + startSession

instantiate(template) clones a template snapshot with a fresh campaign id (world
unchanged; instances are isolated). startSession(builder, {players, gm}) scripts
the existing engine join/begin APIs into a started session for fixtures + the demo.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Reuse — rebuild the seed on the builder

Prove the builder by rebuilding `packages/seed` on it, preserving observable behavior so every existing server/client test stays green. Additive (behavior-preserving); green.

**Files:**
- Modify: `packages/seed/src/index.ts`
- Modify (if needed): `packages/seed/src/seed.test.ts`

**Interfaces:**
- Consumes: `defineRegistry`, `authorTemplate`, `startSession` (Tasks 1/3/4), `serializeCampaign`.
- Produces (unchanged public surface): `buildSeedRegistry()`, `buildSeedCampaign(): { campaign, registry }`, `demoGenesis()`; **new** `seedTemplate()` (the `TemplateBuilder`) / `demoTemplate(): CampaignSnapshot` (player-less template snapshot).

- [ ] **Step 1: Rebuild `buildSeedRegistry` via `defineRegistry`**

In `packages/seed/src/index.ts`, replace the imperative `new CampaignRegistry()` + `registerRecipe`/`registerItem` with:
```ts
export function buildSeedRegistry() {
  return defineRegistry({
    items: { [WIDGET_BEHAVIOR_KEY]: makeWidgetItem },
    recipes: { [String(WIDGET_RECIPE_ID)]: makeWidgetRecipe() },
  });
}
```
(keep `makeWidgetItem`/`makeWidgetRecipe`/the widget constants).

- [ ] **Step 2: Add `seedTemplate` + rebuild `buildSeedCampaign` via `startSession`**

```ts
export function seedTemplate() {
  return authorTemplate("Crypt", buildSeedRegistry(), { rng: () => 0.5, maxRounds: 10 })
    .archetype({ id: "delver", name: "Delver", statModifiers: { [StatType.Health]: 2 } })
    .room("start", { description: "the entrance" })
    .room("next",  { description: "an adjoining chamber" })
    .startRoom("start")
    .exit("start", Directions.North, "next")
    .recipe(String(WIDGET_RECIPE_ID))
    .materials("seed", { metal: 2 });
}

export function buildSeedCampaign(): { campaign: Campaign; registry: CampaignRegistry } {
  const registry = buildSeedRegistry();
  const campaign = startSession(seedTemplate(), {
    players: [
      { name: "Ada", stats: makeStats(), archetype: "delver" },
      { name: "Ben", stats: makeStats(), archetype: "delver" },
    ],
    gm: 0,
  });
  return { campaign, registry };
}

/** The player-less template snapshot (for a template-driven genesisFor / instantiate). */
export function demoTemplate(): CampaignSnapshot {
  return seedTemplate().toSnapshot();
}
```
`demoGenesis()` stays `serializeCampaign(buildSeedCampaign().campaign)` — the demo genesis remains the started 2-PC campaign, so `genesisFor("demo")` and the server tests are unchanged. (Switching the demo to a player-less instance via `instantiate(demoTemplate())` is deferred — it would require a join flow in the demo client; out of scope here.)

- [ ] **Step 3: Run the full suite — verify behavior is preserved**

Run: `pnpm checks`
Expected: green — the rebuilt seed must produce an equivalent started campaign (Ada active + GM, Ben, started, `delver`, widget recipe + materials, `Start`→North→`Next`). If a server/client test fails, diff the serialized seed campaign before/after to find the structural difference and fix the template to match. Do **not** weaken any test to accommodate a drift.

- [ ] **Step 4: Commit**

```bash
git add packages/seed/src/index.ts packages/seed/src/seed.test.ts
git commit -m "$(cat <<'EOF'
refactor(seed): rebuild the seed on the authoring builder

buildSeedRegistry via defineRegistry; buildSeedCampaign via startSession over a
seedTemplate; add seedTemplate/demoTemplate. Observable output preserved
(demoGenesis unchanged), so the server/client suites stay green — proving the
builder end-to-end.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document campaign authoring**

Read the README's architecture section; add a "Campaign authoring" subsection in the existing tone covering: the **template** (player-less, reusable world) vs **instance/session** (players join, GM begins) split; the fluent `authorTemplate(title, registry, opts)` builder over the real constructors (validate-all → `AuthoringError` → live `Campaign`); the **typed registry** via `defineRegistry` giving compile-time-checked `drops`/`items`/`lights`/`.recipe`; behaviors-stay-code (archetypes are data); `instantiate` (template → instance genesis for `genesisFor`/`CampaignStore`) and `startSession` (the existing `joinCampaign`/`beginCampaign` flow); and the deferred items (YAML format, UI, live authoring-commands, procedural generation, a template store, codex authoring (the codex is gameplay-generated), and the `buildStartedCampaign` migration).

- [ ] **Step 2: Full checks + commit**

Run: `pnpm checks` → green.

```bash
git add README.md
git commit -m "$(cat <<'EOF'
docs(authoring): document the campaign-authoring template builder

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review notes (for the executor)

- **Spec coverage:** typed registry §"Registry boundary" → Task 1; assembler/validate-all/`AuthoringError` §"The assembler" → Task 2; fluent builder §"template builder API" → Task 3; `instantiate`/`startSession` §"Orchestration" → Task 4; reuse §"Reuse" + genesis fit §"Genesis…" → Task 5; docs → Task 6.
- **Deviations from the spec, called out:** (a) `startSession` takes the **builder** (not the post-build `Campaign`) so it can resolve the `startRoom` name without an engine change — the spec's `startSession(campaign,…)` is refined to `startSession(builder,…)`. (b) The demo's `genesisFor` is **left on the started campaign** (not switched to `instantiate(demoTemplate())`), because a player-less demo needs a client join flow; `demoTemplate`/`instantiate` are added + tested but not wired into the live demo. (c) `buildStartedCampaign` migration is **not** done (it spans the engine suite); the builder is proven by its own tests + the seed rebuild, per the spec's hedge.
- **Out of scope honored:** no YAML, no UI, no live authoring-commands, no procedural generation, no template store, behaviors stay hand-written.
- **Type consistency:** `TypedRegistry`/`ItemKeyOf`/`RecipeKeyOf` (Task 1) → the builder's generics (Task 3); the `*Def`/`CampaignTemplateDescription` types (Task 2) are consumed verbatim by the builder (Task 3) and orchestration (Task 4); `assemble` returns `{ campaign, rooms }` used by `startSession`.
- **No red window:** every task is additive or behavior-preserving; the full suite stays green each task.
- **Lookups the implementer must resolve:** the campaign `gm` setter + `beginCampaign` + `claimMaterials`/`discoverRecipe`/`registerArchetype` APIs (all on `src/lib/campaign.ts`, confirmed present) and `generateId<CampaignId>` (`../util` + `../brand.d`) for `instantiate`. Type locations are pinned: `MaterialMap` (`../inventory`), `Status` (`../status`), `Stats`/`StatType` (`../character/stats`), `Direction`/`Directions` (`../room`). Codex authoring is out of scope — the codex is gameplay-generated (no public authoring API).
