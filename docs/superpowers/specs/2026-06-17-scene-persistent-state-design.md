# Scene Persistent State — Design

**Date:** 2026-06-17
**Status:** Approved

## Problem

`Scene`s are currently **stateless**. Each time a character enters or exits a
room, the room calls `scene.playScene(phase, room)`, which re-evaluates the
scene's `preconditions` and re-runs its `script` — both receiving only the
room. A scene has no way to remember anything across visits: it cannot tell
"I already fired", "the lever was pulled last time", or "this is the 3rd
visit". We want scenes to carry persistent state across room visits so authors
can build fire-once events, world-state flags, counters, and arbitrary
author-defined data.

## Goal

Give each `Scene` a private, typed state bag that its own `preconditions` and
`script` can read and (for the script) mutate, with mutations persisting across
enter → exit → re-enter for the life of the scene instance.

## Decisions

These were settled during brainstorming:

- **One general mechanism, not special cases.** A single typed state bag covers
  all desired use cases — fire-once / N-times, flags & switches, counters &
  accumulators, and arbitrary structured state. There is **no** dedicated
  `once`/`maxFires` API; fire-once is expressed in state
  (`precondition: (r, s) => !s.fired` + script sets `s.fired = true`).
- **State is fully internal.** The persisted state is private plumbing visible
  only to the scene's own `preconditions` and `script` via an injected
  argument. There is no public `scene.state` getter and no cross-scene shared
  world-state. Nothing outside the scene can read it.
- **Script mutates, preconditions read.** The `script` receives the state as
  mutable `TState`; `preconditions` receive it as `Readonly<TState>` — a
  compile-time signal (zero runtime cost) that gates are pure reads.
- **Backward compatible.** `initialState` is optional and the second function
  argument is additive, so existing stateless scenes keep working untouched.

## Architecture

`Scene` becomes generic over a state type `TState`. The scene owns a private
`#state: TState`, seeded from a new optional `initialState` constructor option
(defaulting to `{}` when omitted). On every `playScene`, the scene passes its
**live** `#state` object to each precondition and to the script. The script
mutates that object in place; because the state lives on the *Scene instance*
(not on the room, and not recreated per visit), the mutations survive across
visits. That persistence is the entire feature.

`IScene` stays **non-generic** — `playScene(phase, room)` never mentions state,
so the type parameter lives only on the concrete `Scene` class. `Room`
continues to store `IScene[]`, and `registerScene` widens its parameter from
`Scene` to `IScene` so it accepts any `Scene<TState>` regardless of state type.

## Types

```ts
/** Gate evaluated against a room and the scene's persisted state (read-only). */
type PreconditionFn<TState> = (room: IRoom, state: Readonly<TState>) => boolean;
/** The scripted effect; may mutate the scene's persisted state. */
type ScriptFn<TState> = (room: IRoom, state: TState) => void;

// IScene: unchanged shape (id, preconditions, playScene) — no type parameter.

export class Scene<TState = Record<string, never>> implements IScene {
  id: SceneId;
  preconditions: PreconditionFn<TState>[];
  #script: ScriptFn<TState>;
  #triggerPhase: TriggerPhase;
  #state: TState;

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

`TState` is inferred from `initialState` at the call site. Stateless scenes omit
it → `TState` defaults to `Record<string, never>` and `#state` is `{}`.

## Data flow

1. Author constructs `new Scene({ preconditions, script, initialState })`.
2. `Room.enterRoom` / `Room.exitRoom` → `scene.playScene(phase, room)`.
3. `playScene`: if `phase` matches the scene's trigger phase **and** every
   `precondition(room, #state)` returns `true` → `script(room, #state)`.
4. The script mutates `#state`; the same object is handed to the next visit's
   preconditions and script.

## Error handling

No new throw paths. State is in-memory and author-owned. The `Readonly<TState>`
parameter on preconditions is the only guard, and it is compile-time only. No
`ProceduralViolation` is involved — nothing here is an illegal lifecycle
transition.

## Testing

- **Fire-once**: `initialState: { fired: false }`, precondition `!s.fired`,
  script sets `fired = true`; enter twice → script body runs once.
- **N-times counter**: script does `s.visits++`; enter 3× → `visits === 3`, and
  a precondition gated on `visits < 2` stops the script firing after the 2nd.
- **Flag persistence**: script sets a flag on enter; a precondition reads it on a
  later visit and changes behavior.
- **Backward compat**: a scene built with no `initialState` fires on every
  matching enter (existing behavior preserved).
- **Type-level**: state is typed inside both functions (verified by usage
  compiling under strict mode + `noUncheckedIndexedAccess`).

## Out of scope

- **Serialization / save-load.** The engine has no save/load today; scene state
  lives in memory on the instance. (If save/load is added later, author state
  would need to be plain serializable data.)
- **Public state inspection** (a `scene.state` getter) and **cross-scene shared
  world-state** — both explicitly declined in favor of full internal
  encapsulation.
- **State reset/clear** — no API to reset a scene's state; YAGNI.

## Docs

Per the project's living-documentation convention, the README's Scene coverage
and the `Scene`/`IScene` TSDoc must be updated to describe persistent state once
implemented.
