import type { ItemId } from "../inventory";
import type { RoomId } from "../room";
import type { CharacterId } from "./character";
import type { StatType } from "./stats";

/**
 * A single recorded action in a character's history, discriminated by `kind`.
 * Every entry carries the `round` it occurred in (stamped by
 * `Character.recordAction`) plus kind-specific details.
 */
export type ActionHistoryEntry =
  | { kind: "attack"; round: number; target: { id: CharacterId; name: string } }
  | { kind: "move"; round: number; room: { id: RoomId; name: string } }
  | { kind: "pickUp"; round: number; items: { id: ItemId; name: string }[] }
  | { kind: "drop"; round: number; items: { id: ItemId; name: string }[] }
  | { kind: "escape"; round: number; success: boolean }
  | { kind: "takeDamage"; round: number; amount: number; stat: StatType }
  | { kind: "fumble"; round: number; action: string };

// The entry minus `round`; `round` is stamped by Character.recordAction.
type DistributiveOmit<T, K extends keyof T> = T extends unknown
  ? Omit<T, K>
  : never;

/**
 * The payload passed to `Character.recordAction`: an {@link ActionHistoryEntry}
 * without its `round`, which the character stamps from the current campaign
 * round when the action is logged.
 */
export type ActionDetail = DistributiveOmit<ActionHistoryEntry, "round">;

/**
 * Renders an {@link ActionHistoryEntry} as a short past-tense phrase suitable
 * for a log or recap (e.g. `"attacked Goblin"`, `"took 3 health damage"`).
 *
 * @param entry - The history entry to describe.
 * @returns A human-readable description of the action.
 */
export function describeAction(entry: ActionHistoryEntry): string {
  switch (entry.kind) {
    case "attack":
      return `attacked ${entry.target.name}`;
    case "move":
      return `moved to ${entry.room.name}`;
    case "pickUp":
      return `picked up ${entry.items.map((i) => i.name).join(", ")}`;
    case "drop":
      return `dropped ${entry.items.map((i) => i.name).join(", ")}`;
    case "escape":
      return entry.success ? "escaped" : "failed to escape";
    case "takeDamage":
      return `took ${entry.amount} ${entry.stat} damage`;
    case "fumble":
      return `fumbled ${entry.action}`;
  }
}
