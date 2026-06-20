import type { Stats } from "../character/stats";
import type { Status } from "../status";
import type { Direction } from "../room";
import type { MaterialMap } from "../inventory";
import type { OutcomeNarration } from "../victory";

/** Defines a player-character archetype to register with the campaign. */
export interface ArchetypeDef {
  id: string;
  name: string;
  statModifiers?: Partial<Stats>;
  inventorySlots?: number;
  immunities?: Status[];
}

/** Defines a room in the game world. */
export interface RoomDef {
  name: string;
  description: string;
  dark?: boolean;
  spawnModifier?: number;
  /** Registry item keys for light sources placed in this room. */
  lights?: string[];
}

/** Defines a one-way directional exit between two rooms. */
export interface ExitDef {
  from: string;
  direction: Direction;
  to: string;
}

/** Defines a non-player mob to place in the world. */
export interface MobDef {
  name: string;
  stats: Stats;
  /** The room name to place the mob in (optional; unplaced if omitted). */
  room?: string;
  inventorySlots?: number;
  actionsPerRound?: number;
  /** Registry item keys for items the mob drops on defeat. */
  drops?: string[];
  baseEscapeChance?: number;
  materialDrops?: MaterialMap;
  lightAverse?: boolean;
}

/** Defines a loot container placed in a room. */
export interface LootDef {
  name: string;
  room: string;
  /** Registry item keys for items inside the container. */
  items: string[];
  description?: string;
}

/** Defines a material cache placed in a room. */
export interface CacheDef {
  name: string;
  room: string;
  materials: MaterialMap;
}

/**
 * A complete, author-written template for a campaign. Pass to {@link assemble}
 * to validate and construct a live, player-less, not-begun {@link Campaign}.
 */
export interface CampaignTemplateDescription {
  title: string;
  opts: {
    rng?: () => number;
    maxRounds?: number;
    baseEncounterChance?: number;
  };
  archetypes: ArchetypeDef[];
  rooms: RoomDef[];
  /** The name of the room where players will start. */
  startRoom?: string;
  exits: ExitDef[];
  mobs: MobDef[];
  loot: LootDef[];
  caches: CacheDef[];
  /** Registry recipe keys to unlock for the party from the start. */
  recipes: string[];
  /** Initial materials to deposit into the campaign's shared pool. */
  materials: { source: string; map: MaterialMap }[];
  /** Win conditions: registry condition keys + optional authored prose. */
  winConditions: { key: string; narration?: OutcomeNarration }[];
  /** Loss conditions: registry condition keys + optional authored prose. */
  loseConditions: { key: string; narration?: OutcomeNarration }[];
  /** Fallback prose for the conditionless `timed-out` outcome. */
  timeoutNarration?: OutcomeNarration;
  /** Fallback prose for the conditionless `ended` (manual) outcome. */
  endedNarration?: OutcomeNarration;
}
