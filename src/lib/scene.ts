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
