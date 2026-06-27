import type { Campaign } from "wickedways/lib/campaign";
import type { Direction } from "wickedways/lib/room";
import { StatType } from "wickedways/lib/character/stats";
import { Status } from "wickedways/lib/status";

export type ScopeKind = "occupant" | "item" | "loot";
export interface ScopeEntity {
  id: string;
  name: string;
  aliases: string[];
  kind: ScopeKind;
  /** Occupants only: current effective Health, for combat-damage feedback. */
  health?: number;
  /** Occupants only: true once knocked out (a defeated mob the engine keeps in the room). */
  defeated?: boolean;
}
export interface ExitView { dir: Direction; toName: string; }
export interface LockedDoorView { name: string; dir: Direction; }
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
 * Exits are classified by the active character's ability to pass them:
 * passable exits appear in `exits`; impassable ones appear in `lockedDoors`.
 *
 * The engine tracks no "opened loot" flag, so callers pass the session-managed
 * set of opened loot ids via `openedLootIds` (defaults to empty). Loot
 * contents are always in `scope` so items can be taken directly; the
 * `opened` flag on {@link LootView} is still set once explicitly opened or
 * auto-opened by a `take`.
 */
export function view(
  campaign: Campaign,
  aliases: Record<string, string[]>,
  openedLootIds: ReadonlySet<string> = new Set(),
): ViewModel {
  const pc = campaign.activeCharacter;
  const room = pc.currentRoom!;
  const roomName = room.name;

  const occupants: ScopeEntity[] = room.occupants
    .filter((o) => o.id !== pc.id)
    .map((o) => ({
      id: o.id,
      name: o.name,
      aliases: [o.name.toLowerCase()],
      kind: "occupant" as const,
      health: o.effectiveStat(StatType.Health),
      defeated: o.status.includes(Status.KO),
    }));

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

  const exits: ExitView[] = [...room.exits.entries()]
    .filter(([, exit]) => exit.canPass(pc))
    .map(([dir, exit]) => ({ dir, toName: exit.otherSide(room).name }));

  const lockedDoors: LockedDoorView[] = [...room.exits.entries()]
    .filter(([, exit]) => !exit.canPass(pc))
    .map(([dir, exit]) => ({ name: exit.name ?? "door", dir }));

  // All container contents are in scope regardless of opened state; take auto-opens.
  const lootContentScope = loot.flatMap((l) => l.contents);
  const lootScope: ScopeEntity[] = loot.map((l) => ({
    id: l.id,
    name: l.description,
    aliases: ["chest", "box", "drawer", "container"],
    kind: "loot" as const,
  }));

  const scope: ScopeEntity[] = [...occupants, ...lootContentScope, ...items, ...keys, ...lootScope];

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
