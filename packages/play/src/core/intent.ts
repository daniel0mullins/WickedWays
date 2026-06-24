import type { Direction } from "wickedways/lib/room";

export type Intent =
  | { kind: "move"; dir: Direction }
  | { kind: "take"; targetId: string }
  | { kind: "drop"; targetId: string }
  | { kind: "open"; targetId: string }
  | { kind: "unlock"; doorId: string }
  | { kind: "attack"; targetId: string }
  | { kind: "equip"; targetId: string }
  | { kind: "unequip"; targetId: string }
  | { kind: "use"; targetId: string }
  | { kind: "talk"; npcId: string; prompt?: string }
  | { kind: "wait" };

const TIME_ADVANCING = new Set(["move", "take", "drop", "use", "attack", "unlock", "wait", "talk"]);

export function isTimeAdvancing(intent: Intent): boolean {
  return TIME_ADVANCING.has(intent.kind);
}
