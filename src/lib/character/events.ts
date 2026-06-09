import { ICharacter } from "./character";

/** Handler invoked on a turn-lifecycle event, receiving the owning character. */
type CharacterEventFn = (opts: { character?: ICharacter }) => void;

/**
 * Turn-lifecycle event hub for a single character. Handlers can be registered
 * against the start and end of the character's turn; {@link Character} fires
 * them via {@link ICharacterEvents.onTurnStart} / {@link ICharacterEvents.onTurnEnd}.
 */
export interface ICharacterEvents {
  /** The character these events belong to. */
  readonly character: ICharacter;
  /** Invokes every handler registered for the start phase. */
  onTurnStart: () => void;
  /** Invokes every handler registered for the end phase. */
  onTurnEnd: () => void;
  /** Registers `fn` to run during the given turn `phase`. */
  addEvent: (phase: EventPhase, fn: CharacterEventFn) => void;
  /** Removes a previously registered handler for the given turn `phase`. */
  removeEvent: (phase: EventPhase, fn: CharacterEventFn) => void;
}

/** Point in a character's turn at which handlers fire. */
type EventPhase = "start" | "end";

/**
 * Default {@link ICharacterEvents} implementation, holding the registered
 * start/end handlers for one character and dispatching them on demand.
 */
export class CharacterEvents implements ICharacterEvents {
  // A Record keyed by the closed `EventPhase` union is always fully populated,
  // so handler lookups are non-nullable and need no presence guards.
  #events: Record<EventPhase, CharacterEventFn[]>;
  character: ICharacter;

  /**
   * @param character - The character whose turn events these are.
   * @param events - Optional initial handlers for each phase; both phases start
   *   empty when omitted.
   */
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

  /**
   * Registers a handler to run during the given turn `phase`.
   *
   * @param phase - `"start"` or `"end"`.
   * @param fn - Handler to add.
   */
  addEvent(phase: EventPhase, fn: CharacterEventFn) {
    this.#events[phase].push(fn);
  }

  /**
   * Removes a previously registered handler from the given turn `phase`.
   * Matches by reference; passing a different function instance has no effect.
   *
   * @param phase - `"start"` or `"end"`.
   * @param fn - The same handler reference that was registered.
   */
  removeEvent(phase: EventPhase, fn: CharacterEventFn) {
    this.#events[phase] = this.#events[phase].filter(
      (eventFn) => eventFn !== fn,
    );
  }

  /** Invokes every start-phase handler with the owning character. */
  onTurnStart() {
    for (const handler of this.#events.start) {
      handler({ character: this.character });
    }
  }

  /** Invokes every end-phase handler with the owning character. */
  onTurnEnd() {
    for (const handler of this.#events.end) {
      handler({ character: this.character });
    }
  }
}
