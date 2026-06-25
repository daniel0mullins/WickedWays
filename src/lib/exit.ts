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

/**
 * Pass-1 factory: builds a bare {@link Exit} from a snapshot with id and state
 * seeded but endpoints unset (wired in pass 2 via {@link SET_ENDPOINTS}).
 */
export function constructBareExit(data: ExitSnapshot): Exit {
  const exit = new Exit<Record<string, unknown>>({
    preconditions: [],
    initialState: data.state,
    behaviorKey: data.behaviorKey,
  });
  exit.id = data.id as ExitId;
  return exit as unknown as Exit;
}
