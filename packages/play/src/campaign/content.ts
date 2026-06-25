import type { ExitBehavior } from "wickedways/lib/exit";
import { Rooms, Items, Keys } from "./ids.js";

export const TITLE = "The Hollow House";

export const INTRO =
  "Word came that the last of your kin had died alone in the old estate — and that the house would not give the body back. You arrive at dusk to settle what remains. The Hollow House has been waiting, and it remembers everything. Find the truth it keeps — before the dark finds you first.";

/**
 * Returns an {@link ExitBehavior} for a keyed door. The door is passable if the
 * character carries a key with `keyCode === keyCode` OR if `state.unlocked` is
 * already `true` (set by the script on first successful pass).
 */
export function doorBehavior(keyCode: string, name: string, opened: string): ExitBehavior {
  return {
    preconditions: [
      (c, s) =>
        (s as { unlocked: boolean }).unlocked ||
        c.inventory.keys.some((k) => k.keyCode === keyCode),
    ],
    script: (_c, s) => {
      const state = s as { unlocked: boolean };
      if (!state.unlocked) {
        state.unlocked = true;
        return opened;
      }
    },
    failMessage: `The ${name} won't budge — it's locked.`,
  };
}

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
