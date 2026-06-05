import { ICharacter } from "./character";

type CharacterEventFn = (opts: { character?: ICharacter }) => void;
export interface ICharacterEvents {
  readonly character: ICharacter;
  onTurnStart: () => void;
  onTurnEnd: () => void;
  addEvent: (phase: EventPhase, fn: CharacterEventFn) => void;
  removeEvent: (phase: EventPhase, fn: CharacterEventFn) => void;
}

type EventPhase = "start" | "end";

export class CharacterEvents implements ICharacterEvents {
  // A Record keyed by the closed `EventPhase` union is always fully populated,
  // so handler lookups are non-nullable and need no presence guards.
  #events: Record<EventPhase, CharacterEventFn[]>;
  character: ICharacter;

  constructor(
    character: ICharacter,
    events?: Record<EventPhase, CharacterEventFn[]>,
  ) {
    this.character = character;
    this.#events = {
      start: events ? events.start : [],
      end: events ? events.end : [],
    };
  }

  addEvent(phase: EventPhase, fn: CharacterEventFn) {
    this.#events[phase].push(fn);
  }

  removeEvent(phase: EventPhase, fn: CharacterEventFn) {
    this.#events[phase] = this.#events[phase].filter(
      (eventFn) => eventFn !== fn,
    );
  }

  onTurnStart() {
    for (const handler of this.#events.start) {
      handler({ character: this.character });
    }
  }

  onTurnEnd() {
    for (const handler of this.#events.end) {
      handler({ character: this.character });
    }
  }
}
