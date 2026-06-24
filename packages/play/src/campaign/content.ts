import { Directions, type Direction } from "wickedways/lib/room";
import { Rooms, Items, Keys } from "./ids.js";

export interface LockedDoor {
  id: string;
  from: string;
  dir: Direction;
  to: string;
  keyCode: string;
  consume: boolean;
  name: string;
}

export const LOCKED_DOORS: LockedDoor[] = [
  { id: "study-door", from: Rooms.Landing, dir: Directions.West, to: Rooms.Study, keyCode: "brass", consume: false, name: "study door" },
  { id: "attic-door", from: Rooms.Landing, dir: Directions.North, to: Rooms.Attic, keyCode: "iron", consume: false, name: "attic door" },
];

export const LORE: Record<string, string> = {
  [Rooms.Parlor]: "A page of the journal clears: 'They would not let me bury her properly. The parlor still smells of lilies.'",
  [Rooms.Study]: "The journal's hand grows frantic here: 'The thing in the cellar wears her face now. The iron key keeps it down.'",
  [Rooms.Nursery]: "An entry, water-blurred: 'The child never cried. That was the first wrong thing.'",
  [Rooms.Cellar]: "The last legible page: 'If you are reading this in the dark, you have already lost the light. I am sorry.'",
  [Rooms.Attic]: "The final entry is unfinished — but you understand it now, standing where it ends.",
};

export const ALIASES: Record<string, string[]> = {
  [Items.Lantern]: ["lantern", "lamp", "light"],
  [Items.Journal]: ["journal", "diary", "book"],
  [Items.Poker]: ["poker", "fire-poker", "iron"],
  [Items.Laudanum]: ["laudanum", "vial", "tonic"],
  [Keys.Brass]: ["brass key", "brass", "key"],
  [Keys.Iron]: ["iron key", "iron", "key"],
};
