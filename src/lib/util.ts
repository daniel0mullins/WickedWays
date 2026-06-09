import { Brand } from "./brand";
import { v4 as uuid } from "uuid";
import { LootId } from "./loot";

/** A generic branded id, used where a more specific id brand is not required. */
export type BaseId = Brand<string, "Id">;

/**
 * Generates a fresh UUID v4 cast to the requested branded id type.
 *
 * @typeParam T - The branded id type to produce (e.g. `CharacterId`).
 * @returns A new unique id of type `T`.
 *
 * @example
 * ```ts
 * const id = generateId<CharacterId>();
 * ```
 */
export function generateId<T extends Brand<string, string>>() {
  return uuid() as T;
}

/** Tuple list of an object's own entries, preserving each key/value type. */
export type Entries<T> = {
  [K in keyof T]: [K, T[K]];
}[keyof T][];

/**
 * `Object.entries` with precise typing: the returned key/value tuples retain
 * the object's key and value types rather than collapsing to `[string, V]`.
 *
 * @param obj - The object whose entries to return.
 * @returns The object's entries as strongly typed tuples.
 */
export function typedEntries<T extends object>(obj: T): Entries<T> {
  return Object.entries(obj) as Entries<T>;
}

/**
 * Thrown when game logic is driven into an invalid state that the rules forbid
 * — for example acting out of turn, or operating on an item the actor does not
 * hold. Signals a misuse of the engine's API rather than a recoverable runtime
 * condition.
 */
export class ProceduralViolation extends Error {
  /** @param message - Human-readable description of the rule that was violated. */
  constructor(message: string) {
    super(message);
    this.name = "ProceduralViolation";
  }
}

/** Thrown when an item is stowed into a container that is already at capacity. */
export class ContainerFullException extends Error {
  /** @param containerId - Id of the container that could not accept the item. */
  constructor(containerId: LootId) {
    super(`Container ${containerId} is full`);
    this.name = "ContainerFullException";
  }
}
