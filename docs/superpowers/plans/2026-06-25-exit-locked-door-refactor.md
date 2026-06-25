# Exit / Locked-Door Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the play package's "locked door = absent exit revealed at runtime via session `addExit`" mechanism with a first-class engine **`Exit`** entity that carries author-defined preconditions + script + persisted state, traversed via a new **`Character.go(direction)`** — fixing the save→unlock crash class by construction.

**Architecture:** A door becomes an engine concern. `Room.exits` changes from `Map<Direction, IRoom>` to `Map<Direction, Exit>`. One shared `Exit` instance is registered in *both* connected rooms' maps (so unlocked-state is shared from both sides). `Exit` is shaped like the existing `Scene`: `preconditions` + `#script` + `#state` + a registry `behaviorKey` for serialization. `go(direction)` evaluates the exit's preconditions, runs its script on a pass (which may flip `state.unlocked` and narrate a one-time line), moves on success, and soft-fails with the exit's `failMessage` cue on failure. The exit serializes as a top-level entity (like items/loot), so lock state round-trips natively and the room graph stays permanently connected.

**Tech Stack:** TypeScript (engine `src/`, NodeNext for `packages/play`), Vitest, pnpm workspace.

## Global Constraints

- This is the **revised locked-door model** from spec `docs/superpowers/specs/2026-06-24-haunted-house-play-surface-design.md` (revised 2026-06-25, commit 78e2976). The spec's *Locked doors — first-class `Exit` entities* section is authoritative.
- **Data-hiding is a top goal** (standing user convention): new class fields are `#private` with public getters; state that must not be forged is written only through an exported mutation `Symbol`, mirroring `SET_DURABILITY` in `src/lib/inventory.ts`. No public mutable fields for `Exit` state.
- **One shared `Exit` per edge**, registered in both rooms' `exits` maps — never two objects for one door.
- **No `unlock` verb, no `unlock` intent, no locked-door table, no session `addExit`/`reindex`.** Doors open by walking through them (`go`).
- **All randomness through the injected `rng`.** Illegal operations throw `ProceduralViolation`.
- **Branded ids** via helpers; never cast raw strings to branded ids.
- Engine intra-`src` imports are extensionless (the engine is not NodeNext-relative); **`packages/play` intra-package relative imports MUST carry `.js`** and cross-package imports use the bare `wickedways/lib/...` specifier.
- Run `pnpm checks` (lint + typecheck + test) before declaring a task done; a task is not complete with a red suite.
- Per the project convention, update `README.md` (+ relevant TSDoc) when engine mechanics change — folded into Task 4.
- **Branch:** continue on `feature/authoring-get-wicked`. The play package Tasks (scaffold, items, mechanics, savestore, narrator, UI) from the prior plan are already committed and stay; this plan only covers the locked-door delta.

---

## File Structure

**Engine (`src/lib/`):**
- `exit.ts` *(new)* — the `Exit<TState>` entity, `IExit`, `ExitConfig`, `ExitBehavior`, `SET_EXIT_STATE` symbol, `hydrateExit`.
- `room.ts` *(modify)* — `exits: Map<Direction, Exit>`; `addExit` builds/links the shared bidirectional `Exit`; `RoomExits`/constructor; `SERIALIZE`/`HYDRATE` use exit ids.
- `serialization/types.ts` *(modify)* — `RoomSnapshot.exits: Record<string,string>` (dir→exitId); new `ExitSnapshot`; `CampaignSnapshot.exits: ExitSnapshot[]`; `SCHEMA_VERSION = 6`.
- `serialization/serializer.ts` *(modify)* — collect shared exits once by id into the top-level array while walking rooms.
- `serialization/deserializer.ts` *(modify)* — pass-1 build exits from `data.exits`, index them; `migrate` v5→v6.
- `serialization/context.ts` *(modify)* — `exit(id): IExit` accessor.
- `serialization/registry.ts` *(modify)* — `ExitBehavior`, `registerExit`/`exit(key)`.
- `authoring/registry.ts` *(modify)* — `defineRegistry` gains `exits?` + `ExitKeyOf`.
- `authoring/description.ts` *(modify)* — `ExitDef` gains `behaviorKey?`, `name?`, `initialState?`, `oneWay?`.
- `authoring/template-builder.ts` *(modify)* — `.exit(from, dir, to, opts?)` records the new fields.
- `authoring/assembler.ts` *(modify)* — wire one shared `Exit` per `ExitDef` (auto-reverse), attaching behavior by key.
- `character/character.ts` *(modify)* — `go(direction)`; register it in `isActionMap`.
- `character/mob.ts`, `utils/build-map.ts` *(modify)* — update `.exits` readers to the `Exit` shape.
- `README.md` *(modify)* — document the `Exit` model.

**Play package (`packages/play/src/`):**
- `campaign/content.ts` *(modify)* — declare keyed exits; `LORE`/`ALIASES` stay; remove `LOCKED_DOORS` + `LockedDoor`.
- `campaign/index.ts`, `campaign/ids.ts` *(modify)* — register exit behaviors; door behavior keys.
- `core/intent.ts` *(modify)* — remove `unlock`.
- `core/viewmodel.ts` *(modify)* — classify exits via `exit.canPass(pc)`; drop `doors` param.
- `core/session.ts` *(modify)* — `move`→`pc.go(dir)`; delete `unlock`/`reindex`/`doors`/`REVERSE`.
- `text/parser.ts` *(modify)* — drop the `unlock`/`open <door>` path + door noun resolution.
- `campaign/campaign.test.ts` *(modify)* — win path uses `go`, not `addExit`.
- `core/capstone.test.ts` *(new)* — committed end-to-end regression (save → walk a still-locked door → win).

---

## ENGINE PHASE

### Task 1: `Exit` entity (`src/lib/exit.ts`)

**Files:**
- Create: `src/lib/exit.ts`
- Test: `src/lib/exit.test.ts`

**Interfaces:**
- Consumes: `IRoom`, `RoomId` (`./room`); `ICharacter` (`./character/character`); `Brand` (`./brand`); `generateId`, `ProceduralViolation` (`./util`); `SERIALIZE` (`./serialization/symbols`); `ExitSnapshot` (`./serialization/types` — added in Task 2); `HydrateContext` (`./serialization/context`).
- Produces:
  - `class Exit<TState = Record<string, never>> implements IExit` with `id: ExitId`, `preconditions: ExitPrecondition<TState>[]`, getter `state: Readonly<TState>`, `failMessage?: string`, `passMessage?: string`, `otherSide(from: IRoom): IRoom`, `endpoints(): readonly [IRoom, IRoom]`, `canPass(character: ICharacter): boolean`, `runScript(character: ICharacter): void`, `[SET_ENDPOINTS](a, b)`, `[SET_EXIT_STATE](mutate)`, `[SERIALIZE](): ExitSnapshot`.
  - `interface IExit` (non-generic, like `IScene`).
  - `interface ExitBehavior { preconditions: ExitPrecondition<never>[]; script?: ExitScript<never>; passMessage?: string; failMessage?: string }`.
  - `type ExitPrecondition<TState> = (character: ICharacter, state: Readonly<TState>) => boolean`.
  - `type ExitScript<TState> = (character: ICharacter, state: TState) => string | void` (return value, if a string, is the one-time pass narration).
  - `export const SET_EXIT_STATE: unique symbol`, `export const SET_ENDPOINTS: unique symbol`.
  - `function constructBareExit(data: ExitSnapshot): Exit` and `function hydrateExit(data, ctx, behavior): Exit` (used by the deserializer in Task 2).
  - `type ExitId = Brand<string, "ExitId">`.

> Note: `ExitSnapshot` is defined in Task 2's `types.ts` change. Implement Task 1 and Task 2 in the same task branch ordering so `exit.ts` compiles; the test below stubs rooms/characters and does not require serialization wiring to pass. If you implement strictly in order, add the `ExitSnapshot` type stub from Task 2 first (it is small).

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/exit.test.ts
import { describe, it, expect } from "vitest";
import { Exit, SET_ENDPOINTS, SET_EXIT_STATE } from "./exit";
import type { IRoom } from "./room";
import type { ICharacter } from "./character/character";

const room = (name: string): IRoom => ({ name } as unknown as IRoom);
const charWithKey = (code: string | null): ICharacter =>
  ({ inventory: { keys: code ? [{ keyCode: code }] : [] } } as unknown as ICharacter);

describe("Exit", () => {
  it("otherSide returns the far endpoint, both ways", () => {
    const a = room("A"), b = room("B");
    const e = new Exit({ preconditions: [] });
    e[SET_ENDPOINTS](a, b);
    expect(e.otherSide(a)).toBe(b);
    expect(e.otherSide(b)).toBe(a);
  });

  it("canPass is true with no preconditions and pure (no side effects)", () => {
    const e = new Exit({ preconditions: [] });
    expect(e.canPass(charWithKey(null))).toBe(true);
  });

  it("a keyed precondition gates on the character's keys", () => {
    const e = new Exit<{ unlocked: boolean }>({
      initialState: { unlocked: false },
      preconditions: [(c, s) => s.unlocked || c.inventory.keys.some((k) => k.keyCode === "iron")],
    });
    expect(e.canPass(charWithKey(null))).toBe(false);
    expect(e.canPass(charWithKey("iron"))).toBe(true);
  });

  it("runScript can flip persisted state so the door later opens for anyone", () => {
    const e = new Exit<{ unlocked: boolean }>({
      initialState: { unlocked: false },
      preconditions: [(c, s) => s.unlocked || c.inventory.keys.some((k) => k.keyCode === "iron")],
      script: (_c, s) => { s.unlocked = true; return "The iron key turns."; },
    });
    expect(e.canPass(charWithKey(null))).toBe(false);
    const line = e.runScript(charWithKey("iron"));
    expect(line).toBe("The iron key turns.");
    expect(e.state.unlocked).toBe(true);
    expect(e.canPass(charWithKey(null))).toBe(true); // now open for the keyless
  });

  it("state is only writable through the SET_EXIT_STATE seam", () => {
    const e = new Exit<{ unlocked: boolean }>({ initialState: { unlocked: false }, preconditions: [] });
    // @ts-expect-error — no public setter
    e.state = { unlocked: true };
    e[SET_EXIT_STATE]((s) => { s.unlocked = true; });
    expect(e.state.unlocked).toBe(true);
  });
});
```

- [ ] **Step 2: Run; expect FAIL** — `pnpm vitest run src/lib/exit.test.ts` → fails (module not found).

- [ ] **Step 3: Implement `src/lib/exit.ts`**

```ts
import { Brand } from "./brand";
import type { IRoom } from "./room";
import type { ICharacter } from "./character/character";
import { generateId, ProceduralViolation } from "./util";
import { SERIALIZE } from "./serialization/symbols";
import type { ExitSnapshot } from "./serialization/types";

/** Unique identifier for an {@link Exit}. */
export type ExitId = Brand<string, "ExitId">;

/** Gate evaluated against the traversing character and the exit's persisted state. */
export type ExitPrecondition<TState> = (character: ICharacter, state: Readonly<TState>) => boolean;
/** Effect run when a character successfully passes; may mutate state and return a one-time narration line. */
export type ExitScript<TState> = (character: ICharacter, state: TState) => string | void;

/** Registry-resolved behavior for a serializable exit (mirrors `SceneBehavior`). */
export interface ExitBehavior {
  preconditions: ExitPrecondition<never>[];
  script?: ExitScript<never>;
  passMessage?: string;
  failMessage?: string;
}

/** Construction config for an {@link Exit}. */
export interface ExitConfig<TState = Record<string, never>> {
  preconditions: ExitPrecondition<TState>[];
  script?: ExitScript<TState>;
  passMessage?: string;
  failMessage?: string;
  initialState?: TState;
  behaviorKey?: string;
}

/** Engine-internal seam: set the two rooms an exit connects (pass-2 hydration / authoring). */
export const SET_ENDPOINTS = Symbol("setExitEndpoints");
/** Engine-internal seam: mutate the exit's persisted state (script path only). */
export const SET_EXIT_STATE = Symbol("setExitState");

/**
 * A single shared, bidirectional connection between two rooms, registered in BOTH
 * rooms' `exits` maps. Shaped like {@link Scene}: author-defined preconditions gate
 * traversal, an optional script runs on a successful pass (and may flip persisted
 * state — e.g. `unlocked` — so the door then opens for everyone), and a `behaviorKey`
 * makes it serializable. Mutable `#state` is private and written only via
 * {@link SET_EXIT_STATE}, per the repo's data-hiding convention.
 */
export interface IExit {
  id: ExitId;
  preconditions: ExitPrecondition<never>[];
  get state(): Readonly<Record<string, unknown>>;
  failMessage?: string;
  passMessage?: string;
  otherSide(from: IRoom): IRoom;
  endpoints(): readonly [IRoom, IRoom];
  canPass(character: ICharacter): boolean;
  runScript(character: ICharacter): string | void;
  [SET_ENDPOINTS](a: IRoom, b: IRoom): void;
  [SET_EXIT_STATE](mutate: (state: Record<string, unknown>) => void): void;
  [SERIALIZE](): ExitSnapshot;
}

export class Exit<TState = Record<string, never>> implements IExit {
  id: ExitId;
  preconditions: ExitPrecondition<TState>[];
  failMessage?: string;
  passMessage?: string;

  #a?: IRoom;
  #b?: IRoom;
  #script?: ExitScript<TState>;
  #state: TState;
  #behaviorKey?: string;

  constructor({ preconditions, script, passMessage, failMessage, initialState, behaviorKey }: ExitConfig<TState>) {
    this.id = generateId<ExitId>();
    this.preconditions = preconditions;
    this.#script = script;
    this.passMessage = passMessage;
    this.failMessage = failMessage;
    this.#state = initialState ?? ({} as TState);
    this.#behaviorKey = behaviorKey;
  }

  get state(): Readonly<Record<string, unknown>> {
    return this.#state as Record<string, unknown>;
  }

  endpoints(): readonly [IRoom, IRoom] {
    if (this.#a === undefined || this.#b === undefined) {
      throw new ProceduralViolation(`Exit ${this.id} has no endpoints set.`);
    }
    return [this.#a, this.#b];
  }

  otherSide(from: IRoom): IRoom {
    const [a, b] = this.endpoints();
    if (from === a) return b;
    if (from === b) return a;
    throw new ProceduralViolation(`Room '${from.name}' is not an endpoint of exit ${this.id}.`);
  }

  canPass(character: ICharacter): boolean {
    return this.preconditions.every((p) => p(character, this.#state as Readonly<TState>));
  }

  runScript(character: ICharacter): string | void {
    return this.#script?.(character, this.#state);
  }

  [SET_ENDPOINTS](a: IRoom, b: IRoom) {
    this.#a = a;
    this.#b = b;
  }

  [SET_EXIT_STATE](mutate: (state: Record<string, unknown>) => void) {
    mutate(this.#state as Record<string, unknown>);
  }

  [SERIALIZE](): ExitSnapshot {
    const [a, b] = this.endpoints();
    return {
      id: this.id,
      endpointIds: [a.id, b.id],
      behaviorKey: this.#behaviorKey,
      state: this.#state as Record<string, unknown>,
    };
  }
}
```

- [ ] **Step 4: Run; expect PASS** — `pnpm vitest run src/lib/exit.test.ts`.
- [ ] **Step 5: Commit** — `git add src/lib/exit.ts src/lib/exit.test.ts && git commit -m "feat(engine): Exit entity — shared bidirectional, scene-shaped, precondition-gated"`

---

### Task 2: Flip `Room.exits` to `Map<Direction, Exit>` + serialize exits as top-level entities

**This is the atomic core change** — it must land green in one commit because the `Room.exits` type, its serialization, and every reader change together.

**Files:**
- Modify: `src/lib/serialization/types.ts`, `src/lib/serialization/context.ts`, `src/lib/serialization/serializer.ts`, `src/lib/serialization/deserializer.ts`, `src/lib/room.ts`, `src/lib/character/mob.ts`, `src/lib/utils/build-map.ts`, `src/lib/authoring/assembler.ts`
- Modify (tests to fix): `src/lib/room.test.ts`, `src/lib/room.serialization.test.ts`, `src/utils/build-map.test.ts`, `src/integration.test.ts`, `src/lib/sync/resolver.test.ts`, `src/lib/sync/coordinator.test.ts`, `src/lib/authoring/roundtrip.test.ts`, `src/lib/authoring/assembler.test.ts`

**Interfaces:**
- Consumes: `Exit`, `ExitId`, `SET_ENDPOINTS`, `constructBareExit` (Task 1).
- Produces:
  - `RoomSnapshot.exits: Record<string, string>` (now dir→**exitId**).
  - `interface ExitSnapshot { id: string; endpointIds: [string, string]; behaviorKey?: string; state: Record<string, unknown> }`.
  - `CampaignSnapshot.exits: ExitSnapshot[]`.
  - `SCHEMA_VERSION = 6`.
  - `Room.addExit(direction, to, opts?: { behaviorKey?: string; passMessage?: string; failMessage?: string; initialState?: Record<string, unknown>; preconditions?: ExitPrecondition<never>[]; script?: ExitScript<never>; oneWay?: boolean })` — builds ONE shared `Exit`, sets its endpoints to `[this, to]`, places it in `this.exits[direction]` and (unless `oneWay`) in `to.exits[reverse(direction)]`.
  - `HydrateContext.exit(id): IExit`.
  - `reverseDirection(d: Direction): Direction` exported from `room.ts`.

- [ ] **Step 1: Add the snapshot types** in `src/lib/serialization/types.ts`:
  - bump `export const SCHEMA_VERSION = 6;`
  - change `RoomSnapshot.exits` doc to "Direction -> exitId".
  - add:
    ```ts
    export interface ExitSnapshot {
      id: string;
      endpointIds: [string, string];
      behaviorKey?: string;
      state: Record<string, unknown>;
    }
    ```
  - add `exits: ExitSnapshot[];` to `CampaignSnapshot` (place it right after `rooms`).

- [ ] **Step 2: Add `exit(id)` to `HydrateContext`** (`src/lib/serialization/context.ts`), mirroring `room`:
    ```ts
    exit(id: string): IExit { return this.#get<IExit>(id, "exit"); }
    ```
  (import `IExit` from `../exit`.)

- [ ] **Step 3: Write/adjust the failing serialization round-trip test** in `src/lib/room.serialization.test.ts` — assert a shared exit round-trips and stays shared:

```ts
// add to src/lib/room.serialization.test.ts
it("a shared exit round-trips as one entity referenced by both rooms", () => {
  // Build two rooms joined by one shared exit, serialize the campaign, deserialize,
  // and confirm BOTH rooms point at the SAME restored exit instance.
  // (Use the existing harness in this file for building+serializing a campaign;
  //  mirror the sibling test that round-trips rooms.)
});
```
> Implementer: model this on the existing room round-trip test already in the file. The assertion that matters: after deserialize, `restoredRoomA.exits.get(dir)` === `restoredRoomB.exits.get(reverse(dir))` (same object), and `exit.otherSide(restoredRoomA) === restoredRoomB`.

- [ ] **Step 4: Run; expect FAIL** (`Map<Direction, Exit>` shape not yet in place).

- [ ] **Step 5: Implement `room.ts`** — change the field + addExit + serialize/hydrate:
  - `exits: Map<Direction, Exit>;` on `IRoom` and `Room`. `RoomExits` becomes `Partial<Record<Direction, Exit>>` (constructor `exits` option still accepted; default empty).
  - Add the reverse map + helper:
    ```ts
    const REVERSE: Record<Direction, Direction> = {
      north: "south", south: "north", east: "west", west: "east",
      northeast: "southwest", southwest: "northeast", northwest: "southeast", southeast: "northwest",
    };
    export function reverseDirection(d: Direction): Direction { return REVERSE[d]; }
    ```
  - Rewrite `addExit` to build the shared exit:
    ```ts
    addExit(direction: Direction, to: IRoom, opts: AddExitOptions = {}) {
      const exit = new Exit({
        preconditions: opts.preconditions ?? [],
        script: opts.script,
        passMessage: opts.passMessage,
        failMessage: opts.failMessage,
        initialState: opts.initialState,
        behaviorKey: opts.behaviorKey,
      });
      exit[SET_ENDPOINTS](this, to);
      this.exits.set(direction, exit);
      if (!opts.oneWay) to.exits.set(reverseDirection(direction), exit);
    }
    ```
    (Define `AddExitOptions` with the fields above; import `Exit`, `SET_ENDPOINTS`, `ExitPrecondition`, `ExitScript` from `./exit`.)
  - `removeExit(direction)` deletes only this room's entry (leave the partner; doors are not removed in this campaign — keep behavior minimal).
  - `[SERIALIZE]`: `exits: Object.fromEntries([...this.exits].map(([dir, exit]) => [dir, exit.id]))`.
  - `[HYDRATE]`: `for (const [dir, exitId] of Object.entries(data.exits)) this.exits.set(dir as Direction, ctx.exit(exitId) as Exit);`.
  - `constructBareRoom`: keep `exits: {}`.

- [ ] **Step 6: Implement serializer exit collection** (`src/lib/serialization/serializer.ts`): inside the room-walk loop, collect each room's exits' shared `Exit` objects into a `Map<exitId, Exit>` (dedupe), then push `[...exitsById.values()].map((e) => e[SERIALIZE]())` into the snapshot as `exits`. Also enqueue `exit.otherSide(r)` (or both endpoints) so the BFS reaches connected rooms exactly as before. Update the existing `for (const [, dest] of r.exits)` line to `for (const [, exit] of r.exits) enqueueRoom(exit.otherSide(r));`.

- [ ] **Step 7: Implement deserializer pass-1 exit construction** (`src/lib/serialization/deserializer.ts`): after rooms are constructed bare and before pass-2, build exits:
    ```ts
    for (const exitData of data.exits) {
      const exit = constructBareExit(exitData); // sets id + state + behaviorKey; endpoints wired in pass 2
      if (exitData.behaviorKey !== undefined) {
        const behavior = opts.registry.exit(exitData.behaviorKey); // Task 4 adds registry.exit
        exit.preconditions = behavior.preconditions;
        /* attach script/messages from behavior */
      }
      ctx.put(exit.id, exit);
    }
    ```
  In pass 2, after rooms hydrate, wire each exit's endpoints: `exit[SET_ENDPOINTS](ctx.room(a), ctx.room(b))`. **In this task** no exit has a `behaviorKey` yet (plain corridors), so the `registry.exit` branch is dormant — guard it so a missing `registry.exit` method does not break (Task 4 adds it). Simplest: in Task 2, only handle `behaviorKey === undefined`; add the behavior branch in Task 4.
  - Add `migrate` step v5→v6: a v5 snapshot has `RoomSnapshot.exits` as dir→**roomId** and **no** top-level `exits`. Convert: synthesize an `ExitSnapshot` per unique room-pair edge, rewrite room exit maps to exitIds. Implement:
    ```ts
    if (data.schemaVersion === 5) {
      const exits: ExitSnapshot[] = [];
      const byPair = new Map<string, string>(); // "a|b" sorted -> exitId
      for (const room of data.rooms) {
        const newExits: Record<string, string> = {};
        for (const [dir, toId] of Object.entries(room.exits as Record<string, string>)) {
          const pair = [room.id, toId].sort().join("|");
          let id = byPair.get(pair);
          if (id === undefined) {
            id = `exit-${exits.length}`;
            byPair.set(pair, id);
            exits.push({ id, endpointIds: [room.id, toId], behaviorKey: undefined, state: {} });
          }
          newExits[dir] = id;
        }
        room.exits = newExits;
      }
      (data as CampaignSnapshot).exits = exits;
      data.schemaVersion = 6;
    }
    ```

- [ ] **Step 8: Update the remaining `.exits` readers (engine):**
  - `src/lib/utils/build-map.ts` — any `room.exits.get(dir)` / iteration now yields `Exit`; use `.otherSide(room)`.
  - `src/lib/character/mob.ts` — the wander/movement code that reads `currentRoom.exits` to pick a destination must map through `exit.otherSide(currentRoom)`.
  - `src/lib/authoring/template-builder.ts` — only if it reads `.exits` (it builds `description.exits`, not room maps; likely no change here — confirm).
  Run `grep -rn "\.exits" src/lib --include="*.ts" | grep -v test` and update each site to the `Exit` shape.

- [ ] **Step 9: Update the assembler exit-wiring** (`src/lib/authoring/assembler.ts`): replace
    ```ts
    for (const e of desc.exits) rooms.get(e.from)!.addExit(e.direction, rooms.get(e.to)!);
    ```
  with a version that creates ONE shared bidirectional exit per `ExitDef` and **de-duplicates reverse declarations**. Because existing templates declare both directions, dedupe by unordered room-pair+the fact a shared exit already connects them:
    ```ts
    const wired = new Set<string>();
    for (const e of desc.exits) {
      const from = rooms.get(e.from)!, to = rooms.get(e.to)!;
      const pair = [from.id, to.id].sort().join("|");
      if (wired.has(pair)) continue;          // reverse already created the shared exit
      wired.add(pair);
      from.addExit(e.direction, to);          // auto-reverse places it in `to` too
    }
    ```
  (Task 4 extends this to pass behavior options; Task 2 keeps it behavior-less.)

- [ ] **Step 10: Fix engine tests.** Run `pnpm vitest run` and update every test that reads `room.exits.get(dir)` expecting a room: change to `room.exits.get(dir)!.otherSide(room)`. The 8 test files are listed under **Files**. Update `room.serialization.test.ts` expectations to the new snapshot shape (exits by id + top-level `exits`).

- [ ] **Step 11: Run the whole engine suite green** — `pnpm vitest run` (no `packages/play` regressions expected yet — play still imports `room.exits`; if `packages/play` fails to typecheck, that is expected and fixed in the Play phase. Scope this task's green bar to `pnpm vitest run src/` + `pnpm tsc --noEmit -p tsconfig.json` for the engine. Note any play breakage for the Play phase.)

- [ ] **Step 12: Commit** — `git add -A && git commit -m "feat(engine)!: Room.exits holds shared Exit objects; exits serialize as top-level entities (schema 6)"`

---

### Task 3: `Character.go(direction)`

**Files:**
- Modify: `src/lib/character/character.ts`
- Test: `src/lib/character/character.test.ts` (add a `describe("go")` block)

**Interfaces:**
- Consumes: `Room.exits` / `Exit` (Task 2), `EMIT_CUE` (`../presentation`), `Direction` (`../room`).
- Produces: `go(direction: Direction): void` on `Character` (and inherited by `PlayerCharacter`). Registered in `isActionMap` (budgeted, like `move`).

- [ ] **Step 1: Write the failing test** (uses the file's existing campaign/room harness):

```ts
describe("go", () => {
  it("moves through an open exit", () => {
    // two rooms joined by an open exit; character.go(dir) -> currentRoom is the far room
  });
  it("does NOT move through an exit whose precondition fails, and emits the failMessage cue", () => {
    // exit with precondition () => false and failMessage "The door won't budge.";
    // capture cues via campaign.onCue; assert currentRoom unchanged and a mechanic/door cue carrying the failMessage
  });
  it("runs the exit script on a successful pass and emits its one-time line", () => {
    // exit precondition gated on a held key; script flips state.unlocked + returns a line;
    // first go emits the line and moves; a second character with no key also passes
  });
  it("a missing exit in that direction does not move and reports it", () => {
    // go(dir) with no exit -> stays put, soft message
  });
});
```
> Implementer: mirror the existing movement tests in `character.test.ts` for harness setup (campaign, rooms, `startTurn`). Door pass/fail narration is emitted as a `{ kind: "mechanic", cue: { text } }` cue (reuse the mechanic cue shape the narrator already renders) — emit via `this.campaign[EMIT_CUE]({ kind: "mechanic", cue: { text } })`.

- [ ] **Step 2: Run; expect FAIL.**

- [ ] **Step 3: Implement `go`** in `character.ts`:

```ts
go(direction: Direction) {
  if (!this.attemptAction(this.go, true)) return;
  const here = this.currentRoom;
  if (here == null) throw new ProceduralViolation("Cannot move: not in any room.");
  const exit = here.exits.get(direction);
  if (exit === undefined) {
    this.campaign[EMIT_CUE]({ kind: "mechanic", cue: { text: "You can't go that way." } });
    return;
  }
  if (!exit.canPass(this)) {
    if (exit.failMessage) this.campaign[EMIT_CUE]({ kind: "mechanic", cue: { text: exit.failMessage } });
    return;
  }
  const line = exit.runScript(this) ?? exit.passMessage;
  if (line) this.campaign[EMIT_CUE]({ kind: "mechanic", cue: { text: line } });
  this.move(exit.otherSide(here));
}
```
- Register it budgeted in the constructor where `isActionMap` is populated: `this.isActionMap.set(this.go, true);` (find the existing `isActionMap.set(this.move, …)` line and mirror it). `go` delegates to `this.move`, which records the `"move"` action — to avoid double-recording, do **not** also `recordAction` in `go`; the `attemptAction(this.go, true)` gate is for the fizzle/budget check, and `move` records the actual movement. Confirm via the test that one `go` produces one move action in history.

> Edge: `move` itself calls `attemptAction(this.move, …)`. Calling `move` from `go` will gate twice. Use `this.withGateSuppressed(() => this.move(...))` for the inner move so the affliction gate is evaluated once (in `go`), matching the `escape -> move` precedent already in the codebase (`mob.ts` uses `withGateSuppressed`).

- [ ] **Step 4: Run; expect PASS.**
- [ ] **Step 5: Commit** — `git add src/lib/character/character.ts src/lib/character/character.test.ts && git commit -m "feat(engine): Character.go(direction) — precondition-gated traversal with pass/fail narration"`

---

### Task 4: Authoring API for keyed exits + registry exit behaviors + README

**Files:**
- Modify: `src/lib/serialization/registry.ts`, `src/lib/authoring/registry.ts`, `src/lib/authoring/description.ts`, `src/lib/authoring/template-builder.ts`, `src/lib/authoring/assembler.ts`, `src/lib/serialization/deserializer.ts` (activate the behavior branch), `README.md`
- Test: `src/lib/authoring/roundtrip.test.ts` (add a keyed-exit case)

**Interfaces:**
- Consumes: `ExitBehavior` (Task 1), `Exit` serialization (Task 2).
- Produces:
  - `CampaignRegistry.registerExit(key, behavior: ExitBehavior)` + `exit(key): ExitBehavior` (mirror `registerScene`/`scene`).
  - `defineRegistry({ ..., exits?: Record<string, ExitBehavior> })` + `ExitKeyOf` typed-registry key (mirror `scenes`/`SceneKeyOf`).
  - `ExitDef` (`description.ts`) gains `behaviorKey?: string; name?: string; initialState?: Record<string, unknown>; oneWay?: boolean`.
  - `TemplateBuilder.exit(from, direction, to, opts?: { behaviorKey?: ExitKey; name?: string; initialState?: Record<string, unknown>; oneWay?: boolean })`.

- [ ] **Step 1: Write the failing test** in `src/lib/authoring/roundtrip.test.ts` — author a template with a keyed locked exit, assemble, confirm the exit is locked for a keyless character and open for a key-holder, then round-trip through serialize/deserialize and confirm `state.unlocked` and behavior survive:

```ts
it("a keyed exit round-trips: locked, opens with the key, stays unlocked across save/load", () => {
  // registry.exits = { "iron-door": { preconditions: [(c,s) => s.unlocked || c.inventory.keys.some(k=>k.keyCode==="iron")],
  //                                   script: (_c,s)=>{ s.unlocked = true; return "It opens."; },
  //                                   failMessage: "Locked." } }
  // template: .room(A).room(B).exit(A, "north", B, { behaviorKey: "iron-door", initialState: { unlocked: false } })
  // assemble; assert A.exits.get("north")!.canPass(keylessChar) === false, canPass(ironChar) === true
  // run the script (or go), serialize, deserialize, assert restored exit.canPass(keylessChar) === true (unlocked persisted)
});
```

- [ ] **Step 2: Run; expect FAIL.**

- [ ] **Step 3: Implement** the registry + authoring + assembler wiring:
  - `registry.ts`: `#exits = new Map<string, ExitBehavior>()`, `registerExit`, `exit(key)` (use `#require`).
  - `authoring/registry.ts`: add `Exits extends Record<string, ExitBehavior>` generic + `exits?: Exits` param; register each into the `CampaignRegistry` via `registerExit`; add `ExitKeyOf` + `EXIT_KEYS` phantom symbol mirroring `SceneKeyOf`/`SCENE_KEYS`.
  - `description.ts`: extend `ExitDef`.
  - `template-builder.ts`: `.exit(from, direction, to, opts = {})` pushes `{ from, direction, to, ...opts }`.
  - `assembler.ts`: when wiring each (deduped) exit, pass the behavior. If `e.behaviorKey` is set, resolve `registry.exit(e.behaviorKey)` and pass `{ behaviorKey, preconditions, script, passMessage, failMessage, initialState: e.initialState, name: e.name, oneWay: e.oneWay }` into `addExit`. (Add `name` to `AddExitOptions`/`Exit` if you want the label on the exit; the play viewmodel reads `exit.name`. Store `name` as a public field on `Exit`.)
  - `deserializer.ts`: activate the `behaviorKey !== undefined` branch from Task 2 Step 7 — attach `behavior.preconditions/script/passMessage/failMessage` from `registry.exit(behaviorKey)`.

- [ ] **Step 4: Run; expect PASS** — `pnpm vitest run src/lib/authoring/roundtrip.test.ts`.

- [ ] **Step 5: Update `README.md`** — in the rooms/exits section, document: exits are first-class shared `Exit` objects; authoring via `.exit(from, dir, to, { behaviorKey })`; door behavior (preconditions + script + state) registered in the registry under `exits`; traversal via `go(direction)`; lock state serializes natively. Keep it consistent with the Scene documentation's voice.

- [ ] **Step 6: Run full engine checks** — `pnpm vitest run src/` + `pnpm typecheck` green.
- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat(engine): authoring + registry support for keyed Exit behaviors; document the Exit model"`

---

## PLAY-ADAPTATION PHASE

### Task 5: Revise campaign content — keyed exits, drop the locked-door table

**Files:**
- Modify: `packages/play/src/campaign/content.ts`, `packages/play/src/campaign/index.ts`, `packages/play/src/campaign/ids.ts`
- Test: `packages/play/src/campaign/campaign.test.ts` (updated in Task 9 — here just keep it compiling)

**Interfaces:**
- Consumes: `.exit(..., { behaviorKey })` + registry `exits` (Task 4).
- Produces: door behavior keys (`ExitBehaviors = { StudyDoor, AtticDoor }` in `ids.ts`); `buildHauntedHouseRegistry` registers them under `exits`; `hauntedHouseTemplate` declares the Study/Attic exits with `behaviorKey` + `initialState: { unlocked: false }`. `LOCKED_DOORS`/`LockedDoor` removed from `content.ts`.

- [ ] **Step 1:** Add door behavior keys to `ids.ts`:
  ```ts
  export const ExitBehaviors = { StudyDoor: "study-door", AtticDoor: "attic-door" } as const;
  ```
- [ ] **Step 2:** In `content.ts`, remove `LockedDoor` + `LOCKED_DOORS`. Add a `DOOR_BEHAVIORS` map (or build inline in `index.ts`):
  ```ts
  // one behavior per keyed door
  export const doorBehavior = (keyCode: string, name: string, opened: string) => ({
    preconditions: [(c, s) => s.unlocked || c.inventory.keys.some((k) => k.keyCode === keyCode)],
    script: (_c, s) => { if (!s.unlocked) { s.unlocked = true; return opened; } },
    failMessage: `The ${name} won't budge — it's locked.`,
  });
  ```
  (Type the precondition/script via the engine's `ExitBehavior`; `s` is the `{ unlocked: boolean }` state.)
- [ ] **Step 3:** In `index.ts`, register under `defineRegistry({ ..., exits: { [ExitBehaviors.StudyDoor]: doorBehavior("brass", "study door", "The brass key turns; the study door swings open."), [ExitBehaviors.AtticDoor]: doorBehavior("iron", "attic door", "The iron key grinds in the lock; the attic stairs open above you.") } })`.
- [ ] **Step 4:** In `hauntedHouseTemplate`, declare the two doors as exits (replacing the omitted-exit note):
  ```ts
  .exit(Rooms.Landing, Directions.West, Rooms.Study, { behaviorKey: ExitBehaviors.StudyDoor, name: "study door", initialState: { unlocked: false } })
  .exit(Rooms.Landing, Directions.North, Rooms.Attic, { behaviorKey: ExitBehaviors.AtticDoor, name: "attic door", initialState: { unlocked: false } })
  ```
  Remove any now-duplicate reverse `.exit` for ordinary corridors **only if** the assembler dedupe (Task 2 Step 9) would double-create — since the assembler dedupes by room-pair, leaving the existing both-direction declarations is harmless, but the cleaner form declares each edge once. Keep the existing corridor declarations as-is (dedupe handles them); only the two doors are new.
- [ ] **Step 5:** `pnpm --filter @wickedways/play typecheck` — expect failures in viewmodel/session/parser/intent (fixed in later tasks). The **content + index** files themselves must typecheck against the engine. Commit once content/index/ids compile in isolation (the package as a whole is green only after Task 9).
- [ ] **Step 6: Commit** — `git add packages/play/src/campaign && git commit -m "feat(play): author Study/Attic as keyed Exit behaviors; remove the locked-door table"`

### Task 6: Remove the `unlock` intent (`core/intent.ts`)

- [ ] Remove the `{ kind: "unlock"; doorId }` arm from the `Intent` union and from `isTimeAdvancing` (it stays time-advancing via `move`). Update `intent.test.ts` to drop the unlock assertion. Run `pnpm vitest run packages/play/src/core/intent.test.ts`. Commit: `refactor(play): drop the unlock intent (doors open via go)`.

### Task 7: Viewmodel classifies via `exit.canPass` (`core/viewmodel.ts`)

- [ ] Replace the `doors`-table-derived `lockedDoors` and the `room.exits` mapping. New logic, per current room and active character `pc`:
  - `exits`: `[...room.exits.entries()].filter(([, exit]) => exit.canPass(pc)).map(([dir, exit]) => ({ dir, toName: exit.otherSide(room).name }))`.
  - `lockedDoors`: `[...room.exits.entries()].filter(([, exit]) => !exit.canPass(pc)).map(([dir, exit]) => ({ name: exit.name ?? "door", dir }))`.
  - Remove the `doors: LockedDoor[]` parameter from `view(...)`. Update the door scope entities to derive from the locked exits (`id` = `\`door:${dir}\``, aliases `[name, "door"]`) **only if** the parser still needs them — since Task 8 drops the unlock verb, door scope entities can be removed entirely.
- [ ] Update `viewmodel.test.ts` to build rooms with `Exit`s (via `addExit`) and assert classification. Run its tests. Commit: `refactor(play): viewmodel classifies exits via exit.canPass; drop the doors param`.

### Task 8: Parser drops the unlock/door path (`text/parser.ts`)

- [ ] Remove `unlock` from `NOUN_VERBS`; remove the `open`→`unlock` door branch (keep `open` for loot only); remove door-noun handling. `go`/bare-direction still emit `{ kind: "move", dir }`. Update `parser.test.ts` (remove unlock/door cases; the prior "Minor" dead `look-at` alias can be cleaned here too). Run its tests. Commit: `refactor(play): parser drops the unlock verb and door resolution`.

### Task 9: Session `move`→`go`; delete unlock/reindex/doors (`core/session.ts`)

**Files:** Modify `core/session.ts`; update `core/session.test.ts` and `campaign/campaign.test.ts`.

- [ ] In `dispatch`, change the `move` case to `this.campaign.activeCharacter.go(intent.dir)` (remove the manual `room.exits.get(dir)` + `pc.move`). Remove the entire `unlock` case, the `unlock` private method, the `REVERSE` map, the `doors` option from `SessionOptions`/`start`, and the `view()` call's `doors` argument. `reindexRooms` may stay (it is now correct since the graph is always connected) but the `rooms` map is no longer needed for unlocking — keep it only if `save` still seeds `rootRooms` with it; since the graph is connected, `serializeCampaign(this.campaign)` (party-rooted BFS) now reaches every room, so **drop the `rootRooms` seeding and the `rooms` map entirely** unless a test shows a room is unreachable.
- [ ] Update `session.test.ts`: replace the two unlock tests (`unlock fails without key`, `unlock reveals study door`) with a `go`-through-a-locked-door test (blocked without key → no move + fail cue; opens with key → moves). Keep save/restore/undo tests.
- [ ] Update `campaign/campaign.test.ts`: the winning-path test currently calls `rooms.get(...).addExit(...)` to reveal the attic door. Replace with the key-driven `go`: arm with the iron key, then `pc.go(Directions.North)` from the Landing opens and enters the Attic. Drop the local `reverse` helper + manual `addExit`. The Wraith/brass-key and losing-path tests stay (brass key now opens the Study door via `go`, but the win path doesn't need it).
- [ ] Run `pnpm --filter @wickedways/play test` — expect the whole play package green now. Commit: `refactor(play)!: session moves via go(); remove unlock/doors/reindex glue`.

### Task 10: Committed capstone regression test (`core/capstone.test.ts`)

**Files:** Create `packages/play/src/core/capstone.test.ts`.

- [ ] Write a committed end-to-end test that drives the real `parse → session.execute → Narrator` stack with typed command strings through the full winning path, **including a mid-path `save` then `undo`, then walking through the still-locked attic door**, asserting: final `outcome === "won"`, `finished === true`, the win narration is rendered, the attic-door pass line appears, and the save/undo meta lines appear. (This is the exact scenario that crashed under the old model — it must pass now.) Model the driver loop on the UI's `handle()` in `text/ui.ts`. Use an in-memory `SaveStore` stub and `now: () => 0`.
- [ ] Run `pnpm vitest run packages/play/src/core/capstone.test.ts` — expect PASS.
- [ ] Commit: `test(play): committed capstone — save/undo then walk a locked door to a win`.

### Task 11: Docs + full `pnpm checks`

- [ ] Update `packages/play/README.md` (if present) and any TSDoc referencing the old locked-door/`unlock` model. Confirm the engine `README.md` Exit section (Task 4) is accurate.
- [ ] Run `pnpm checks` (lint + typecheck + test) across the whole workspace — must be fully green. Fix any stragglers.
- [ ] Commit: `docs(play): document the Exit-based door model; checks green`.

---

## Self-Review

**Spec coverage:** Exit entity (T1), shared bidirectional + native serialization + connected graph (T2), `go` traversal with soft-fail (T3), authoring/registry + README (T4), content keyed exits / no door table (T5), no unlock intent (T6), viewmodel `canPass` (T7), parser no unlock (T8), session `go` / no glue (T9), committed save→locked-door→win regression (T10), docs + checks (T11). Acceptance criteria #6 (two engine changes) is satisfied by T1–T4 + the prior `hasItem`.

**Type consistency:** `Exit`/`IExit`/`ExitBehavior`/`ExitPrecondition`/`ExitScript`/`ExitSnapshot`/`ExitId`, `addExit(dir,to,opts)`, `canPass`, `otherSide`, `runScript`, `SET_EXIT_STATE`, `SET_ENDPOINTS`, `reverseDirection`, `HydrateContext.exit`, `registry.exit`/`registerExit`, `defineRegistry.exits`, `ExitKeyOf`, `Character.go`, `ExitBehaviors` keys — names used consistently across tasks.

**Known sequencing note:** Task 2 is the large atomic engine change (type flip + serialization + reader/test sweep). Task 5 leaves the play package non-green until Task 9; that is intended (engine-first) and each play task's green bar is scoped to its own files until Task 9 closes the package.
