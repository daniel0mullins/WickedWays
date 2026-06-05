import { Brand } from "./brand";
import { IRoom } from "./room";
import { generateId } from "./util";

type PreconditionFn = (r: IRoom) => boolean;
type ScriptFn = (r: IRoom) => void;
type TriggerPhase = "enter" | "exit";

export type SceneId = Brand<string, "sceneId">;
export interface IScene {
  id: SceneId;
  preconditions: PreconditionFn[];
  playScene: (phase: TriggerPhase, room: IRoom) => void;
}

export class Scene implements IScene {
  id: SceneId;
  preconditions: PreconditionFn[];

  #script: ScriptFn;
  #triggerPhase: TriggerPhase;

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

  playScene(phase: TriggerPhase, room: IRoom) {
    if (
      this.#triggerPhase === phase &&
      this.preconditions.every((fn) => fn(room))
    ) {
      this.#script(room);
    }
  }
}
