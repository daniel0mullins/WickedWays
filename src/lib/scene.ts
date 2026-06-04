import { Brand } from "./brand";
import { ICharacter } from "./character/character";
import { IRoom } from "./room";
import { generateId } from "./util";

type PreconditionFn = (r: IRoom) => boolean;
type ScriptFn = (r: IRoom) => void;

export type SceneId = Brand<string, "sceneId">;
export interface IScene {
  id: SceneId;
  room: IRoom;
  preconditions: PreconditionFn[];
  playScene: () => void;
}

export class Scene implements IScene {
  id: SceneId;
  room: IRoom;
  preconditions: PreconditionFn[];

  #script: ScriptFn;

  constructor({
    room,
    preconditions,
    script,
  }: {
    room: IRoom;
    preconditions: PreconditionFn[];
    script: ScriptFn;
  }) {
    this.id = generateId<SceneId>();
    this.room = room;
    this.preconditions = preconditions;
    this.#script = script;
  }

  playScene() {
    if (this.preconditions.every((fn) => fn(this.room))) {
      this.#script(this.room);
    }
  }
}
