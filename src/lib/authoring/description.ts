import type { Stats } from "../character/stats";
import type { NaturalAttack } from "../character/combatant";
import type { Status } from "../status";
import type { Direction } from "../room";
import type { MaterialMap } from "../inventory";
import type { OutcomeNarration } from "../victory";
import type { ChatPolicy } from "../chat-policy";
import type { AvPolicy } from "../av-policy";

/** Defines a player-character archetype to register with the campaign. */
export interface ArchetypeDef {
  id: string;
  name: string;
  baseStats?: Partial<Stats>;
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
  /** Registry exit-behavior key (preconditions + script). When set, the exit is a keyed/serializable door. */
  behaviorKey?: string;
  /** Optional display label for the exit (e.g. "Iron Door"). */
  name?: string;
  /** Initial persisted state for the exit. Defaults to `{}`. */
  initialState?: Record<string, unknown>;
  /** When true, the exit is placed only in the `from` room (not auto-reversed into `to`). */
  oneWay?: boolean;
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
  /** The mob's unarmed strike (stat + power). Defaults to a 1-point Health jab. */
  naturalAttack?: NaturalAttack;
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
 * Defines a non-player character placed in the world. Its dialogue (and the
 * precondition closures within it) comes from a registered `NpcBehavior`, keyed
 * so the NPC survives serialization — its dialogue re-binds from the registry on
 * hydrate, exactly like a scene's script.
 */
export interface NpcDef {
  name: string;
  stats: Stats;
  /** Room to seat the NPC in (optional; unplaced if omitted). */
  room?: string;
  /** Registry NPC-behavior key supplying this NPC's dialogue. */
  behavior: string;
}

/** Opts a roving encounter formation (by registry behavior key) into the campaign. */
export interface FormationDef {
  /** Registry formation-behavior key (a mob-spawning factory). */
  key: string;
  /** Selection weight among roving formations. Defaults to 1. */
  weight?: number;
}

/** Attaches a registered scene behavior to a room, fired on enter/exit. */
export interface SceneDef {
  /** Room the scene is attached to. */
  room: string;
  /** Registry scene-behavior key (preconditions + script). */
  key: string;
  /** Phase that triggers the scene. Defaults to `"enter"`. */
  phase?: "enter" | "exit";
  /** Initial persisted state for the scene. Defaults to `{}`. */
  initialState?: Record<string, unknown>;
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
  /** Non-player characters placed in the world. */
  npcs: NpcDef[];
  /** Roving encounter formations opted in by registry behavior key. */
  formations: FormationDef[];
  /** Scenes attached to rooms by registry behavior key. */
  scenes: SceneDef[];
  /** Registry recipe keys to unlock for the party from the start. */
  recipes: string[];
  /** Initial materials to deposit into the campaign's shared pool. */
  materials: { source: string; map: MaterialMap }[];
  /** Win conditions: registry condition keys + optional authored prose. */
  winConditions: { key: string; narration?: OutcomeNarration }[];
  /** Loss conditions: registry condition keys + optional authored prose. */
  loseConditions: { key: string; narration?: OutcomeNarration }[];
  /** Opted-in custom mechanics: registry keys + optional per-campaign config.
   *  Order is preserved and is the reducer/transformer execution order. */
  mechanics: { key: string; config?: unknown }[];
  /** Fallback prose for the conditionless `timed-out` outcome. */
  timeoutNarration?: OutcomeNarration;
  /** Fallback prose for the conditionless `ended` (manual) outcome. */
  endedNarration?: OutcomeNarration;
  /** Per-campaign chat configuration. Omitted ⇒ DEFAULT_CHAT_POLICY (all on). */
  chat?: ChatPolicy;
  /** Per-campaign A/V configuration. Omitted ⇒ DEFAULT_AV_POLICY (on, video, cap 6). */
  av?: AvPolicy;
}
