import { typedEntries } from "../util";
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
type EventsConstructorArgs = {
  [K in EventPhase]: CharacterEventFn[];
};

export class CharacterEvents implements ICharacterEvents {
  #events: Map<EventPhase, CharacterEventFn[]>;
  character: ICharacter;

  constructor(
    character: ICharacter,
    events?: Record<EventPhase, CharacterEventFn[]>,
  ) {
    this.character = character;
    this.#events = new Map<EventPhase, CharacterEventFn[]>();
    this.#events.set("start", []);
    this.#events.set("end", []);

    if (events) {
      for (const [phase, functions] of typedEntries<EventsConstructorArgs>(
        events,
      )) {
        switch (phase) {
          case "end": {
            this.#events.set("end", functions);
            break;
          }
          case "start": {
            this.#events.set("start", functions);
            break;
          }
        }
      }
    }
  }

  addEvent(phase: EventPhase, fn: CharacterEventFn) {
    const currentEvents = this.#events.get(phase) ?? [];
    currentEvents.push(fn);
    this.#events.set(phase, currentEvents);
  }

  removeEvent(phase: EventPhase, fn: CharacterEventFn) {
    const currentEvents = this.#events.get(phase);
    if (currentEvents) {
      this.#events.set(
        phase,
        currentEvents.filter((eventFn) => eventFn !== fn),
      );
    }
  }

  onTurnStart() {
    const events = this.#events.get("start");
    if (events) {
      for (const handler of events) {
        handler({ character: this.character });
      }
    }
  }

  onTurnEnd() {
    const events = this.#events.get("end");
    if (events) {
      for (const handler of events) {
        handler({ character: this.character });
      }
    }
  }
}
