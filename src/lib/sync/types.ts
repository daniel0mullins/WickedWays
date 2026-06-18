import type { CharacterId } from "../character/character";
import type { RoomId } from "../room";
import type { ItemId } from "../inventory";
import type { LootId } from "../loot";
import type { MaterialCacheId } from "../material-cache";
import type { RecipeId } from "../crafting";
import type { ArchetypeId } from "../archetype";
import type { EquipmentSlot } from "../equipment";
import type { CodexEntry } from "../codex";
import type {
  RoomSnapshot,
  CharacterSnapshot,
  ItemSnapshot,
  LootSnapshot,
  MaterialCacheSnapshot,
  CampaignCoreSnapshot,
} from "../serialization/types";

/** A serializable player/GM/NPC intent. Every entity reference is an id. */
export type Command =
  // turn-actions — a PlayerCharacter, only legal on its turn
  | { kind: "move"; actorId: CharacterId; roomId: RoomId }
  | { kind: "attack"; actorId: CharacterId; targetId: CharacterId }
  | { kind: "equip"; actorId: CharacterId; itemId: ItemId; slot?: EquipmentSlot }
  | { kind: "unequip"; actorId: CharacterId; itemId: ItemId }
  | { kind: "craft"; actorId: CharacterId; recipeId: RecipeId }
  | { kind: "repair"; actorId: CharacterId; itemId: ItemId }
  | { kind: "pickUp"; actorId: CharacterId; itemIds: ItemId[] }
  | { kind: "drop"; actorId: CharacterId; itemIds: ItemId[] }
  | { kind: "takeFromLootBox"; actorId: CharacterId; lootId: LootId; itemIds: ItemId[] }
  | { kind: "putInLootBox"; actorId: CharacterId; lootId: LootId; itemIds: ItemId[] }
  | { kind: "transferKey"; actorId: CharacterId; itemId: ItemId; recipientId: CharacterId }
  | { kind: "consumeKey"; actorId: CharacterId; itemId: ItemId }
  | { kind: "use"; actorId: CharacterId; itemId: ItemId }
  | { kind: "placeLight"; actorId: CharacterId; itemId: ItemId }
  | { kind: "takeLight"; actorId: CharacterId; itemId: ItemId }
  | { kind: "harvest"; actorId: CharacterId; cacheId: MaterialCacheId }
  // setup — pre-start, on your own character
  | { kind: "selectArchetype"; actorId: CharacterId; archetypeId: ArchetypeId }
  // join — self-service; carries the new character's bare snapshot so it can be
  // constructed on the resolving client and propagated to replicas via the delta
  | { kind: "joinCampaign"; character: CharacterSnapshot }
  // GM / lifecycle / NPC — issued by the GM
  | { kind: "beginCampaign" }
  | { kind: "endCampaign" }
  | { kind: "nextPlayer" }
  | { kind: "leaveCampaign"; characterId: CharacterId }
  | { kind: "transferGM"; characterId: CharacterId }
  | { kind: "mobEscape"; mobId: CharacterId }
  | { kind: "mobAttack"; mobId: CharacterId; targetId: CharacterId };

/** A per-entity snapshot tagged so the applier can dispatch by entity type. */
export type EntitySnapshot =
  | { type: "room"; data: RoomSnapshot }
  | { type: "character"; data: CharacterSnapshot }
  | { type: "item"; data: ItemSnapshot }
  | { type: "loot"; data: LootSnapshot }
  | { type: "materialCache"; data: MaterialCacheSnapshot };

/** Campaign-level change payload: core fields plus the codex (both are campaign-scoped). */
export type CampaignCoreDelta = { core: CampaignCoreSnapshot; codex: CodexEntry[] };

/** The state change produced by an accepted command. */
export type Delta = {
  changed: EntitySnapshot[];
  created: EntitySnapshot[];
  removed: string[];
  campaignCore?: CampaignCoreDelta;
};

/** An ordered, broadcast entry: the command and the delta it produced. */
export type LogEntry = { seq: number; baseSeq: number; command: Command; delta: Delta };

/** The outcome of submitting a command. */
export type CommandResult =
  | { ok: true; seq: number; delta: Delta }
  | { ok: false; rejected: true; reason: string }
  | { ok: false; conflict: true; reason: string };

const TURN_ACTION_KINDS = new Set<Command["kind"]>([
  "move", "attack", "equip", "unequip", "craft", "repair", "pickUp", "drop",
  "takeFromLootBox", "putInLootBox", "transferKey", "consumeKey", "use",
  "placeLight", "takeLight", "harvest",
]);
const SETUP_KINDS = new Set<Command["kind"]>(["selectArchetype"]);
const GM_KINDS = new Set<Command["kind"]>([
  "beginCampaign", "endCampaign", "nextPlayer", "leaveCampaign", "transferGM",
  "mobEscape", "mobAttack",
]);

/** Returns `true` for player turn-actions (move, attack, equip, etc.). */
export function isTurnAction(command: Command): boolean {
  return TURN_ACTION_KINDS.has(command.kind);
}
/** Returns `true` for pre-start setup commands (selectArchetype). */
export function isSetupCommand(command: Command): boolean {
  return SETUP_KINDS.has(command.kind);
}
/** Returns `true` for GM/lifecycle/NPC commands (beginCampaign, mobAttack, etc.). */
export function isGmCommand(command: Command): boolean {
  return GM_KINDS.has(command.kind);
}
/** Self-service join carrying a new character's bare snapshot. */
export function isJoinCommand(command: Command): command is Extract<Command, { kind: "joinCampaign" }> {
  return command.kind === "joinCampaign";
}

/** The acting player's id for turn/setup commands; null for GM/lifecycle/NPC commands. */
export function commandActorId(command: Command): CharacterId | null {
  if (isTurnAction(command) || isSetupCommand(command)) {
    return (command as Extract<Command, { actorId: CharacterId }>).actorId;
  }
  return null;
}
