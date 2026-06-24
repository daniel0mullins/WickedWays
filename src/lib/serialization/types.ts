import type { Stats } from "../character/stats";
import type { Status } from "../status";
import type { MaterialMap } from "../inventory";
import type { ActionHistoryEntry } from "../character/history";
import type { MobOrigin } from "../character/mob";
import type { Archetype } from "../archetype";
import type { CodexEntry } from "../codex";
import type { ActionKind, AssetRef } from "../presentation";
import type { CampaignOutcome, OutcomeNarration } from "../victory";
import type { ChatPolicy } from "../chat-policy";
import type { AvPolicy } from "../av-policy";
import type { JsonValue } from "../mechanics/mechanic.js";

export const SCHEMA_VERSION = 5;

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
  /** Remaining materials (empty object once depleted). Confirmed against MaterialCache fields in Task 3. */
  contents: MaterialMap;
  /** Whether this cache has already been harvested. */
  depleted: boolean;
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
  kind: "player" | "mob" | "npc";
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
  npcBehaviorKey?: string; // npc-only: registry key its dialogue re-binds from
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
  outcome: CampaignOutcome;
  outcomeReason?: string;
  /** Win conditions as { registry key, authored prose } — the predicate is re-attached by key. */
  winConditions: { key: string; narration?: OutcomeNarration }[];
  /** Loss conditions as { registry key, authored prose }. */
  loseConditions: { key: string; narration?: OutcomeNarration }[];
  /** Fallback prose for the conditionless `timed-out` outcome. */
  timeoutNarration?: OutcomeNarration;
  /** Fallback prose for the conditionless `ended` (manual) outcome. */
  endedNarration?: OutcomeNarration;
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
  /** Per-campaign chat configuration (inert engine data; read by comms + UI). */
  chatPolicy: ChatPolicy;
  /** Per-campaign A/V configuration (inert engine data; read by comms + UI). */
  avPolicy: AvPolicy;
  /** Opted-in mechanics: registry key + serialized state. Behavior re-attaches by key. */
  mechanics: { key: string; state: JsonValue }[];
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
