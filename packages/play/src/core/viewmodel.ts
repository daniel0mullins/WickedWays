import type { Campaign } from "wickedways/lib/campaign";
import type { Direction } from "wickedways/lib/room";
import { StatType } from "wickedways/lib/character/stats";
import type { LockedDoor } from "../campaign/content.js";

export type ScopeKind = "occupant" | "item" | "loot" | "door";
export interface ScopeEntity { id: string; name: string; aliases: string[]; kind: ScopeKind; }
export interface ExitView { dir: Direction; toName: string; }
export interface LockedDoorView { id: string; name: string; dir: Direction; }
export interface LootView { id: string; description: string; opened: boolean; contents: ScopeEntity[]; }
export interface ViewModel {
  room: { id: string; name: string; description: string; isLit: boolean };
  exits: ExitView[];
  lockedDoors: LockedDoorView[];
  occupants: ScopeEntity[];
  loot: LootView[];
  inventory: { items: ScopeEntity[]; keys: ScopeEntity[]; equippedNames: string[] };
  scope: ScopeEntity[];
  status: { locationName: string; turn: number; maxTurns: number; sanity: number; health: number };
  outcome: string;
  finished: boolean;
}

const aliasesFor = (behaviorKey: string | undefined, name: string, aliases: Record<string, string[]>): string[] => {
  const fromTable = behaviorKey !== undefined ? aliases[behaviorKey] ?? [] : [];
  return [...new Set([name.toLowerCase(), ...fromTable])];
};

/**
 * Derives a plain {@link ViewModel} from the live engine `Campaign`.
 *
 * The engine tracks no "opened loot" flag, so callers pass the session-managed
 * set of opened loot ids via `openedLootIds` (defaults to empty). Loot
 * contents only enter `scope` once the box has been opened.
 */
export function view(
  campaign: Campaign,
  doors: LockedDoor[],
  aliases: Record<string, string[]>,
  openedLootIds: ReadonlySet<string> = new Set(),
): ViewModel {
  const pc = campaign.activeCharacter;
  const room = pc.currentRoom!;
  const roomName = room.name;

  const occupants: ScopeEntity[] = room.occupants
    .filter((o) => o.id !== pc.id)
    .map((o) => ({ id: o.id, name: o.name, aliases: [o.name.toLowerCase()], kind: "occupant" as const }));

  const loot: LootView[] = [...room.loot.values()].map((l) => {
    const opened = openedLootIds.has(l.id);
    return {
      id: l.id,
      description: l.description,
      opened,
      contents: l.contents.map((i) => ({
        id: i.id,
        name: i.name,
        aliases: aliasesFor(i.behaviorKey, i.name, aliases),
        kind: "item" as const,
      })),
    };
  });

  const items: ScopeEntity[] = pc.inventory.items.map((i) => ({
    id: i.id,
    name: i.name,
    aliases: aliasesFor(i.behaviorKey, i.name, aliases),
    kind: "item" as const,
  }));

  const keys: ScopeEntity[] = pc.inventory.keys.map((k) => ({
    id: k.id,
    name: k.name,
    aliases: aliasesFor(k.behaviorKey, k.name, aliases),
    kind: "item" as const,
  }));

  const exits: ExitView[] = [...room.exits.entries()].map(([dir, to]) => ({ dir, toName: to.name }));

  const lockedDoors: LockedDoorView[] = doors
    .filter((d) => d.from === roomName && !room.exits.has(d.dir))
    .map((d) => ({ id: d.id, name: d.name, dir: d.dir }));

  const doorScope: ScopeEntity[] = lockedDoors.map((d) => ({
    id: d.id,
    name: d.name,
    aliases: [d.name, "door"],
    kind: "door" as const,
  }));

  // Loot contents only enter scope once the box has been opened by the session.
  const lootContentScope = loot.filter((l) => l.opened).flatMap((l) => l.contents);
  const lootScope: ScopeEntity[] = loot.map((l) => ({
    id: l.id,
    name: l.description,
    aliases: ["chest", "box", "drawer", "container"],
    kind: "loot" as const,
  }));

  const scope: ScopeEntity[] = [...occupants, ...lootContentScope, ...items, ...keys, ...doorScope, ...lootScope];

  return {
    room: { id: room.id, name: roomName, description: room.description, isLit: room.isLit },
    exits,
    lockedDoors,
    occupants,
    loot,
    inventory: {
      items,
      keys,
      equippedNames: [...pc.equipment.values()].map((i) => i.name),
    },
    scope,
    status: {
      locationName: roomName,
      turn: campaign.round,
      maxTurns: campaign.maxRounds,
      sanity: pc.effectiveStat(StatType.Sanity),
      health: pc.effectiveStat(StatType.Health),
    },
    outcome: campaign.outcome,
    finished: campaign.finished,
  };
}
