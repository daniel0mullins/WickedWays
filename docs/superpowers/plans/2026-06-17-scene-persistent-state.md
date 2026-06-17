# Scene Persistent State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each `Scene` a private, typed state bag that its own `preconditions` and `script` can read/mutate, persisting across room visits.

**Architecture:** Make `Scene` generic over `TState`. The scene owns a private `#state: TState` seeded by an optional `initialState` constructor option (defaulting to `{}`). `playScene` threads the live `#state` into every precondition (read-only) and the script (mutable); script mutations persist on the instance across enter/exit cycles. `IScene` stays non-generic, and `Room.registerScene` widens its parameter to `IScene` so any `Scene<TState>` can be registered.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`, `noImplicitOverride`, NodeNext), Vitest.

## Global Constraints

- TypeScript `strict` + `noUncheckedIndexedAccess` + `noImplicitOverride`, NodeNext resolution. Indexed access yields `T | undefined`; handle it, don't assert it away.
- **State is fully internal**: no public `scene.state` getter, no cross-scene shared world-state. Only the scene's own `preconditions`/`script` see it via an injected argument.
- **One general mechanism only**: no dedicated `once`/`maxFires` API — fire-once and counters are expressed in the state bag.
- **Script mutates, preconditions read**: `script` receives `TState`; `preconditions` receive `Readonly<TState>`.
- **Backward compatible**: `initialState` is optional (defaults to an empty object) and the second function argument is additive; existing stateless scenes keep working.
- **`IScene` stays non-generic**: the type parameter lives only on the concrete `Scene` class.
- Run `npm run checks` (lint + typecheck + test) before declaring work done.

---

### Task 1: Generic `Scene` with persistent state

**Files:**
- Modify: `src/lib/scene.ts` (whole file)
- Test: `src/lib/scene.test.ts`

**Interfaces:**
- Consumes: `IRoom` from `./room`, `generateId` + `Brand` (already imported in `scene.ts`).
- Produces:
  - `type PreconditionFn<TState> = (r: IRoom, state: Readonly<TState>) => boolean`
  - `type ScriptFn<TState> = (r: IRoom, state: TState) => void`
  - `interface IScene { id: SceneId; preconditions: PreconditionFn<never>[]; playScene: (phase: TriggerPhase, room: IRoom) => void }` (non-generic)
  - `class Scene<TState = Record<string, never>> implements IScene` with constructor option `initialState?: TState`. `playScene(phase, room)` passes the scene's persisted state to each precondition and the script.

- [ ] **Step 1: Add the failing persistent-state tests**

Append this `describe` block inside the top-level `describe("Scene", ...)` in `src/lib/scene.test.ts` (after the `"key-gated scene (authoring pattern)"` block, before the final closing `});` of `describe("Scene")`):

```ts
  describe("persistent state", () => {
    it("runs a fire-once scene's body only once across repeated visits", () => {
      const body = vi.fn();
      const scene = new Scene<{ fired: boolean }>({
        preconditions: [(_room, state) => !state.fired],
        script: (_room, state) => {
          body();
          state.fired = true;
        },
        initialState: { fired: false },
      });
      const room = makeRoom();

      scene.playScene("enter", room);
      scene.playScene("enter", room);
      scene.playScene("enter", room);

      expect(body).toHaveBeenCalledOnce();
    });

    it("accumulates a counter in state and can gate a precondition on it", () => {
      const body = vi.fn();
      const scene = new Scene<{ visits: number }>({
        preconditions: [(_room, state) => state.visits < 2],
        script: (_room, state) => {
          state.visits += 1;
          body();
        },
        initialState: { visits: 0 },
      });
      const room = makeRoom();

      scene.playScene("enter", room); // visits 0 -> 1
      scene.playScene("enter", room); // visits 1 -> 2
      scene.playScene("enter", room); // gate closed (visits === 2)

      expect(body).toHaveBeenCalledTimes(2);
    });

    it("passes the same live state object to preconditions and the script", () => {
      const initialState = { visits: 0 };
      const precondition = vi.fn(() => true);
      const script = vi.fn();
      const scene = new Scene<{ visits: number }>({
        preconditions: [precondition],
        script,
        initialState,
      });
      const room = makeRoom();

      scene.playScene("enter", room);

      expect(precondition).toHaveBeenCalledWith(room, initialState);
      expect(script).toHaveBeenCalledWith(room, initialState);
    });

    it("defaults to an empty state bag and fires every matching enter when stateless", () => {
      const script = vi.fn();
      const scene = new Scene({ preconditions: [], script });
      const room = makeRoom();

      scene.playScene("enter", room);
      scene.playScene("enter", room);

      expect(script).toHaveBeenCalledTimes(2);
      expect(script).toHaveBeenCalledWith(room, {});
    });
  });
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npx vitest run src/lib/scene.test.ts`
Expected: FAIL — the new tests error/fail because the current `Scene` neither accepts `initialState` nor passes a state argument (e.g. `state.fired`/`state.visits` reads on `undefined`, and `toHaveBeenCalledWith(room, …)` mismatches). The pre-existing tests still pass at this point.

- [ ] **Step 3: Rewrite `src/lib/scene.ts` with generic persistent state**

Replace the entire contents of `src/lib/scene.ts` with:

```ts
import { Brand } from "./brand";
import { IRoom } from "./room";
import { generateId } from "./util";

/**
 * Gate evaluated against a room and the scene's persisted state; the scene only
 * fires when all return `true`. State is read-only here — only the script mutates it.
 */
type PreconditionFn<TState> = (r: IRoom, state: Readonly<TState>) => boolean;
/** The scripted effect a scene runs against the room it fired in; may mutate the scene's persisted state. */
type ScriptFn<TState> = (r: IRoom, state: TState) => void;
/** Whether a scene triggers as a character enters or exits the room. */
type TriggerPhase = "enter" | "exit";

/** Unique identifier for a {@link Scene}. */
export type SceneId = Brand<string, "sceneId">;

/**
 * A scripted event attached to a room that may fire when a character enters or
 * exits, gated by preconditions. A {@link Scene} may carry private persistent
 * state that survives across room visits.
 *
 * `IScene` is intentionally non-generic: the state type lives only on the
 * concrete {@link Scene} class, and `playScene` never exposes it. This lets a
 * {@link Room} hold scenes of any state type in one `IScene[]`.
 */
export interface IScene {
  id: SceneId;
  preconditions: PreconditionFn<never>[];
  /**
   * Runs the scene's script if `phase` matches its trigger phase and every
   * precondition passes for `room`.
   */
  playScene: (phase: TriggerPhase, room: IRoom) => void;
}

/**
 * Default {@link IScene} implementation. A scene binds a script to a single
 * trigger phase; {@link Room} invokes registered scenes on enter/exit and the
 * scene runs its script only when the phase matches and its preconditions hold.
 *
 * A scene owns a private, typed state bag (`TState`, seeded by `initialState`)
 * that persists across room visits for the life of the scene instance. The
 * `script` receives it mutable and may write to it; `preconditions` receive it
 * read-only. This lets authors build fire-once events, world-state flags, visit
 * counters, and other cross-visit persistence — all expressed in state, with no
 * dedicated API. The state defaults to an empty object when `initialState` is
 * omitted; declare a non-empty `TState` together with its `initialState`.
 */
export class Scene<TState = Record<string, never>> implements IScene {
  id: SceneId;
  preconditions: PreconditionFn<TState>[];

  #script: ScriptFn<TState>;
  #triggerPhase: TriggerPhase;
  #state: TState;

  /**
   * @param config - Scene configuration.
   * @param config.phase - Phase that triggers the scene. Defaults to `"enter"`.
   * @param config.preconditions - Gates that must all pass for the script to run; receive the room and read-only state.
   * @param config.script - Effect to run against the room when the scene fires; may mutate the persisted state.
   * @param config.initialState - Initial persisted state. Defaults to an empty object.
   */
  constructor({
    phase = "enter",
    preconditions,
    script,
    initialState,
  }: {
    phase?: TriggerPhase;
    preconditions: PreconditionFn<TState>[];
    script: ScriptFn<TState>;
    initialState?: TState;
  }) {
    this.id = generateId<SceneId>();
    this.preconditions = preconditions;
    this.#script = script;
    this.#triggerPhase = phase;
    this.#state = initialState ?? ({} as TState);
  }

  /**
   * Runs the scene's script against `room`, but only when `phase` equals the
   * scene's configured trigger phase and every precondition returns `true`.
   * Preconditions and the script receive the scene's persisted state; the script
   * may mutate it, and those mutations persist across visits.
   *
   * @param phase - The phase being played (`"enter"` or `"exit"`).
   * @param room - The room the triggering character is entering or exiting.
   */
  playScene(phase: TriggerPhase, room: IRoom) {
    if (
      this.#triggerPhase === phase &&
      this.preconditions.every((fn) => fn(room, this.#state))
    ) {
      this.#script(room, this.#state);
    }
  }
}
```

- [ ] **Step 4: Update the pre-existing assertions that now receive a second argument**

In `src/lib/scene.test.ts`, the script/precondition mocks are now called with `(room, state)` instead of `(room)`. Update these four assertions to include the default empty state:

1. In `it("runs the script when the phase matches and all preconditions pass", ...)`, change:
   ```ts
   expect(script).toHaveBeenCalledWith(room);
   ```
   to:
   ```ts
   expect(script).toHaveBeenCalledWith(room, {});
   ```

2. In `it("passes the room to each precondition", ...)`, change:
   ```ts
   expect(first).toHaveBeenCalledWith(room);
   expect(second).toHaveBeenCalledWith(room);
   ```
   to:
   ```ts
   expect(first).toHaveBeenCalledWith(room, {});
   expect(second).toHaveBeenCalledWith(room, {});
   ```

3. In `it("fires once an occupant holds the matching key", ...)` (the `"key-gated scene (authoring pattern)"` block), change:
   ```ts
   expect(script).toHaveBeenCalledWith(room);
   ```
   to:
   ```ts
   expect(script).toHaveBeenCalledWith(room, {});
   ```

- [ ] **Step 5: Run the scene tests to verify they pass**

Run: `npx vitest run src/lib/scene.test.ts`
Expected: PASS — all tests (pre-existing + the four new persistent-state tests) green.

- [ ] **Step 6: Typecheck to confirm existing call sites still compile**

Run: `npm run typecheck`
Expected: PASS — `room.ts` (`registerScene(scene: Scene)`), `integration.test.ts`, and `room.test.ts` all still compile because every existing scene uses the default `TState`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/scene.ts src/lib/scene.test.ts
git commit -m "feat(scene): add persistent per-scene state across room visits

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Register stateful scenes on rooms

**Files:**
- Modify: `src/lib/room.ts:7` (import), `src/lib/room.ts:57` (interface signature), `src/lib/room.ts:230` (method signature)
- Test: `src/lib/room.test.ts:11` (import), plus a new test

**Interfaces:**
- Consumes: `IScene` and `Scene` from `./scene` (Task 1); `Room.enterRoom`, `Room.registerScene`.
- Produces: `Room.registerScene(scene: IScene): void` (widened from `Scene`), enabling any `Scene<TState>` to be registered and its state to persist across `enterRoom` calls.

- [ ] **Step 1: Write the failing end-to-end persistence test**

In `src/lib/room.test.ts`, change the scene import on line 11 from:

```ts
import type { IScene, Scene } from "./scene";
```

to:

```ts
import { Scene, type IScene } from "./scene";
```

Then add this test inside the existing `describe("registerScene", ...)` block (the block starting at the `registerScene` describe):

```ts
    it("persists a registered scene's state across repeated enterRoom calls", () => {
      const body = vi.fn();
      const scene = new Scene<{ fired: boolean }>({
        preconditions: [(_room, state) => !state.fired],
        script: (_room, state) => {
          body();
          state.fired = true;
        },
        initialState: { fired: false },
      });
      const room = makeRoom();
      room.registerScene(scene);

      room.enterRoom(makeCharacter());
      room.enterRoom(makeCharacter());

      expect(body).toHaveBeenCalledOnce();
    });
```

- [ ] **Step 2: Run typecheck to verify it fails to compile**

Run: `npm run typecheck`
Expected: FAIL — `Argument of type 'Scene<{ fired: boolean }>' is not assignable to parameter of type 'Scene<Record<string, never>>'` at the `room.registerScene(scene)` call, because `registerScene` still requires the default-state `Scene`.

- [ ] **Step 3: Widen `registerScene` to accept `IScene`**

In `src/lib/room.ts`, change the import on line 7 from:

```ts
import { IScene, Scene } from "./scene";
```

to:

```ts
import { IScene } from "./scene";
```

In the `IRoom` interface, change:

```ts
  /** Registers a scene to be considered on enter/exit. */
  registerScene: (scene: Scene) => void;
```

to:

```ts
  /** Registers a scene to be considered on enter/exit. */
  registerScene: (scene: IScene) => void;
```

In the `Room` class, change:

```ts
  /** Registers a scene to evaluate when characters enter or exit. */
  registerScene(scene: Scene) {
    this.#scenes.push(scene);
  }
```

to:

```ts
  /** Registers a scene to evaluate when characters enter or exit. */
  registerScene(scene: IScene) {
    this.#scenes.push(scene);
  }
```

- [ ] **Step 4: Run the room tests and typecheck to verify they pass**

Run: `npx vitest run src/lib/room.test.ts && npm run typecheck`
Expected: PASS — the new persistence test passes (script body fires once across two `enterRoom` calls), and the whole project typechecks (existing `as unknown as Scene` casts in `room.test.ts` and the default-state scenes in `integration.test.ts` remain assignable to `IScene`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/room.ts src/lib/room.test.ts
git commit -m "feat(room): accept any IScene in registerScene so stateful scenes persist

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Document persistent scene state

**Files:**
- Modify: `README.md:101-102`

**Interfaces:**
- Consumes: the `Scene` behavior from Tasks 1–2.
- Produces: nothing code-facing; living-documentation update per project convention.

- [ ] **Step 1: Update the Scene bullet in the README**

In `README.md`, replace the bullet at lines 101-102:

```markdown
- A `Scene` runs its `script(room)` only when the trigger phase (`"enter"` / `"exit"`) matches
  **and** all of its `preconditions` pass — preconditions short-circuit on the first failure.
```

with:

```markdown
- A `Scene` runs its `script(room, state)` only when the trigger phase (`"enter"` / `"exit"`)
  matches **and** all of its `preconditions` pass — preconditions short-circuit on the first
  failure. Each scene owns a private, typed **state bag** (seeded by `initialState`, empty by
  default) that persists across room visits for the life of the scene: the `script` may mutate
  it and `preconditions` read it (read-only), enabling fire-once events, world-state flags, and
  visit counters. The state is internal to the scene — nothing outside reads it.
```

- [ ] **Step 2: Run the full checks suite**

Run: `npm run checks`
Expected: PASS — lint + typecheck + the entire test suite green.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document persistent scene state

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- General typed state bag (all four use cases) → Task 1 (`#state`, `initialState`, threaded into preconditions/script); fire-once + counter tests prove flags & counters.
- Fully internal (no getter, no cross-scene sharing) → Task 1: no `state` getter added; state only reachable via the injected argument.
- Script mutates / preconditions read → Task 1 types `ScriptFn<TState>` (mutable) and `PreconditionFn<TState>` (`Readonly<TState>`).
- Backward compatible → Task 1 default `TState`/optional `initialState`; the stateless test + the Task 1 typecheck step + Task 2 confirm existing scenes are untouched.
- `IScene` non-generic, `registerScene` widened → Task 2.
- Docs (README + TSDoc) → TSDoc in Task 1's `scene.ts` rewrite; README in Task 3.
- Out-of-scope items (serialization, public inspection, reset) → not implemented. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows full code; commands have expected output. ✓

**3. Type consistency:** `PreconditionFn<TState>`/`ScriptFn<TState>`/`initialState?: TState`/`Scene<TState = Record<string, never>>` are used identically across Tasks 1–2. `IScene.preconditions: PreconditionFn<never>[]` accepts `Scene<TState>`'s `PreconditionFn<TState>[]` (parameter contravariance: `never` is assignable to any `Readonly<TState>`), so `implements IScene` holds and `Room.registerScene(scene: IScene)` accepts any `Scene<TState>`. ✓
