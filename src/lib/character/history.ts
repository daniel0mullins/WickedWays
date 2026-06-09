import type { ItemId } from "../inventory";
import type { RoomId } from "../room";
import type { CharacterId } from "./character";
import type { StatType } from "./stats";

export type ActionHistoryEntry =
  | { kind: "attack"; round: number; target: { id: CharacterId; name: string } }
  | { kind: "move"; round: number; room: { id: RoomId; name: string } }
  | { kind: "pickUp"; round: number; items: { id: ItemId; name: string }[] }
  | { kind: "drop"; round: number; items: { id: ItemId; name: string }[] }
  | { kind: "escape"; round: number }
  | { kind: "takeDamage"; round: number; amount: number; stat: StatType };

// The entry minus `round`; `round` is stamped by Character.recordAction.
type DistributiveOmit<T, K extends keyof T> = T extends unknown
  ? Omit<T, K>
  : never;
export type ActionDetail = DistributiveOmit<ActionHistoryEntry, "round">;

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
      return "escaped";
    case "takeDamage":
      return `took ${entry.amount} ${entry.stat} damage`;
  }
}
