import type { Stats } from "../character/stats";
import type { Status } from "../status";
import type { MaterialMap } from "../inventory";
import type { ActionHistoryEntry } from "../character/history";
import type { MobOrigin } from "../character/mob";
import type { Archetype } from "../archetype";
import type { CodexEntry } from "../codex";
import type { ActionKind, AssetRef } from "../presentation";

export const SCHEMA_VERSION = 1;

export interface AfflictionsSnapshot {
  active: Partial<Record<Status, boolean>>;
  turnsActive: Partial<Record<Status, number>>;
  shakenOff: Status[];
  immunity: Partial<Record<Status, number>>;
}

export type ItemSnapshot =
  | {
      kind: "item";
      id: string;
      behaviorKey: string;
      durability?: number;
      modifier: number;
    }
  | { kind: "key"; id: string; name: string; keyCode: string; consumeOnUse: boolean };

export interface LootSnapshot {
  id: string;
  description: string;
  capacity: number;
  contentIds: string[];
}

export interface MaterialCacheSnapshot {
  id: string;
  // exact fields confirmed against src/lib/material-cache.ts in Task 3
  type: keyof MaterialMap;
  quantity: number;
}

export interface SceneSnapshot {
  id: string;
  behaviorKey: string;
  phase: "enter" | "exit";
  state: Record<string, unknown>;
}

export interface RoomSnapshot {
  id: string;
  name: string;
  description: string;
  exits: Record<string, string>; // Direction -> roomId
  dark: boolean;
  spawnModifier: number;
  occupantIds: string[];
  lootIds: string[];
  materialCacheIds: string[];
  lightSourceIds: string[];
  scenes: SceneSnapshot[];
}

export interface CharacterSnapshot {
  kind: "player" | "mob";
  id: string;
  name: string;
  stats: Stats;
  actionsPerRound: number;
  actionsThisRound: number;
  currentRoomId: string | null;
  inventory: { slots: number; itemIds: string[]; keyIds: string[] };
  equipment: Record<string, string>; // EquipmentSlot -> itemId
  history: ActionHistoryEntry[];
  archetypeImmunities: Status[];
  afflictions: AfflictionsSnapshot;
  archetypeId?: string; // player-only
  origin?: MobOrigin; // mob-only
  baseEscapeChance?: number;
  materialDrops?: MaterialMap;
  lightAverse?: boolean;
}

export interface EncounterTableSnapshot {
  baseChance: number;
  visited: string[];
  formations: { behaviorKey: string; weight: number }[];
}

export interface CampaignCoreSnapshot {
  id: string;
  title: string;
  maxRounds: number;
  round: number;
  started: boolean;
  finished: boolean;
  activeCharacterIndex: number;
  partyIds: string[];
  actedThisRound: string[];
  gmId: string | null;
  materials: MaterialMap;
  claims: string[];
  encountered: string[];
  knownRecipes: string[]; // registry keys
  archetypes: Archetype[]; // pure data
  actionSounds: Partial<Record<ActionKind, AssetRef>>;
  encounterTable: EncounterTableSnapshot;
}

export interface CampaignSnapshot {
  schemaVersion: number;
  campaign: CampaignCoreSnapshot;
  rooms: RoomSnapshot[];
  characters: CharacterSnapshot[];
  items: ItemSnapshot[];
  loot: LootSnapshot[];
  materialCaches: MaterialCacheSnapshot[];
  codex: CodexEntry[];
}
