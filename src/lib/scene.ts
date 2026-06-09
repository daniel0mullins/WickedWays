import { Brand } from "./brand";
import { IRoom } from "./room";
import { generateId } from "./util";

/** Gate evaluated against a room; the scene only fires when all return `true`. */
type PreconditionFn = (r: IRoom) => boolean;
/** The scripted effect a scene runs against the room it fired in. */
type ScriptFn = (r: IRoom) => void;
/** Whether a scene triggers as a character enters or exits the room. */
type TriggerPhase = "enter" | "exit";

/** Unique identifier for a {@link Scene}. */
export type SceneId = Brand<string, "sceneId">;

/**
 * A scripted event attached to a room that may fire when a character enters or
 * exits, gated by preconditions.
 */
export interface IScene {
  id: SceneId;
  preconditions: PreconditionFn[];
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
 */
export class Scene implements IScene {
  id: SceneId;
  preconditions: PreconditionFn[];

  #script: ScriptFn;
  #triggerPhase: TriggerPhase;

  /**
   * @param config - Scene configuration.
   * @param config.phase - Phase that triggers the scene. Defaults to `"enter"`.
   * @param config.preconditions - Gates that must all pass for the script to run.
   * @param config.script - Effect to run against the room when the scene fires.
   */
  constructor({
    phase = "enter",
    preconditions,
    script,
  }: {
    phase?: TriggerPhase;
    preconditions: PreconditionFn[];
    script: ScriptFn;
  }) {
    this.id = generateId<SceneId>();
    this.preconditions = preconditions;
    this.#script = script;
    this.#triggerPhase = phase;
  }

  /**
   * Runs the scene's script against `room`, but only when `phase` equals the
   * scene's configured trigger phase and every precondition returns `true`.
   *
   * @param phase - The phase being played (`"enter"` or `"exit"`).
   * @param room - The room the triggering character is entering or exiting.
   */
  playScene(phase: TriggerPhase, room: IRoom) {
    if (
      this.#triggerPhase === phase &&
      this.preconditions.every((fn) => fn(room))
    ) {
      this.#script(room);
    }
  }
}
