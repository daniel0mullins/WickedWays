import { ProceduralViolation } from "../util";
import { ItemAction } from "../inventory";
import { commandActorId, isTurnAction, isSetupCommand, isGmCommand, isJoinCommand } from "./types";
import { constructBareCharacter } from "../character/hydrate";
import type { Command } from "./types";
import type { EntityIndex } from "./entity-index";
import type { ICampaign } from "../campaign";
import type { IPlayerCharacter, PlayerCharacter } from "../character/player-character";
import type { IMob } from "../character/mob";
import type { ICombatant } from "../character/combatant";

/** Result of {@link Resolver.authorize}: pass or fail with a human-readable reason. */
export type AuthResult = { ok: true } | { ok: false; reason: string };

/**
 * The authority. {@link Resolver.authorize} runs the single-writer/GM gate;
 * {@link Resolver.apply} resolves arg ids and invokes the real engine (which
 * enforces the remaining rules via {@link ProceduralViolation}). Topology-
 * independent: the same code is the future authoritative server's authority, so
 * it holds all authority and never trusts the caller. Replicas never call
 * {@link Resolver.apply} — only the resolving authority does.
 */
export class Resolver {
  /**
   * The game-rule gate. Returns `{ ok: true }` if the command is permitted given
   * the campaign's lifecycle/turn/GM state, else `{ ok: false, reason }`. Deeper
   * validation is left to the engine's own guards in {@link Resolver.apply}.
   */
  authorize(campaign: ICampaign, command: Command): AuthResult {
    if (isTurnAction(command)) {
      if (!campaign.started) return { ok: false, reason: "Campaign has not begun." };
      if (campaign.finished) return { ok: false, reason: "Campaign has finished." };
      const actorId = commandActorId(command)!;
      if (actorId !== campaign.activeCharacter.id) {
        return { ok: false, reason: "Not the active character's turn." };
      }
      return { ok: true };
    }

    if (isSetupCommand(command)) {
      if (campaign.started) {
        return { ok: false, reason: "Setup is only allowed before the campaign begins." };
      }
      // Existence of the actor is resolved against the index at apply time.
      return { ok: true };
    }

    if (isJoinCommand(command)) {
      if (campaign.finished) return { ok: false, reason: "Campaign has finished." };
      if (command.character.kind !== "player") {
        return { ok: false, reason: "Only player characters can join a campaign." };
      }
      return { ok: true };
    }

    if (isGmCommand(command)) {
      if (campaign.gm === undefined) return { ok: false, reason: "No GM is set." };
      if (command.kind === "beginCampaign") {
        if (campaign.started) return { ok: false, reason: "Campaign already begun." };
        return { ok: true };
      }
      if (!campaign.started) return { ok: false, reason: "Campaign has not begun." };
      return { ok: true };
    }

    return { ok: false, reason: `Unrecognized command kind '${(command as Command).kind}'.` };
  }

  /**
   * Resolves the command's argument ids to live instances via {@link index} and
   * invokes the real engine action. Throws {@link ProceduralViolation} on illegal
   * engine state (the coordinator later turns that into a rejection). Assumes the
   * command already passed {@link Resolver.authorize}.
   */
  apply(campaign: ICampaign, command: Command, index: EntityIndex): void {
    switch (command.kind) {
      // ---- turn actions (actor is the active character) ----
      case "move": {
        const actor = index.character(command.actorId) as IPlayerCharacter;
        actor.move(index.room(command.roomId));
        return;
      }
      case "attack": {
        const actor = index.character(command.actorId) as ICombatant;
        actor.attack(index.character(command.targetId));
        return;
      }
      case "equip": {
        const actor = index.character(command.actorId);
        actor.equip(index.item(command.itemId), command.slot);
        return;
      }
      case "unequip": {
        index.character(command.actorId).unequip(index.item(command.itemId));
        return;
      }
      case "craft": {
        index.character(command.actorId).craft(command.recipeId);
        return;
      }
      case "repair": {
        index.character(command.actorId).repair(index.item(command.itemId));
        return;
      }
      case "pickUp": {
        const actor = index.character(command.actorId);
        actor.addToInventory(command.itemIds.map((id) => index.item(id)));
        return;
      }
      case "drop": {
        const actor = index.character(command.actorId);
        actor.removeFromInventory(command.itemIds.map((id) => index.item(id)));
        return;
      }
      case "takeFromLootBox": {
        const actor = index.character(command.actorId) as IPlayerCharacter;
        actor.takeFromLootBox(index.loot(command.lootId), command.itemIds.map((id) => index.item(id)));
        return;
      }
      case "putInLootBox": {
        const actor = index.character(command.actorId) as IPlayerCharacter;
        actor.putInLootBox(index.loot(command.lootId), command.itemIds.map((id) => index.item(id)));
        return;
      }
      case "transferKey": {
        const actor = index.character(command.actorId);
        actor.transferKey(index.item(command.itemId), index.character(command.recipientId));
        return;
      }
      case "consumeKey": {
        index.character(command.actorId).consumeKey(index.item(command.itemId));
        return;
      }
      case "use": {
        const actor = index.character(command.actorId);
        const item = index.item(command.itemId);
        if (!actor.inventory.items.includes(item)) {
          throw new ProceduralViolation("Cannot use an item the actor does not hold.");
        }
        item.actions[ItemAction.Use](actor); // wrapper resolves holder + gates KO
        return;
      }
      case "placeLight": {
        index.character(command.actorId).placeLight(index.item(command.itemId));
        return;
      }
      case "takeLight": {
        index.character(command.actorId).takeLight(index.item(command.itemId));
        return;
      }
      case "harvest": {
        index.character(command.actorId).harvest(index.materialCache(command.cacheId));
        return;
      }
      // ---- setup ----
      case "selectArchetype": {
        const actor = index.character(command.actorId) as IPlayerCharacter;
        actor.selectArchetype(command.archetypeId);
        return;
      }
      // ---- join (self-service) ----
      case "joinCampaign": {
        if (command.character.kind !== "player") {
          throw new ProceduralViolation("Only player characters can join a campaign.");
        }
        // Construct the player from the snapshot's identity + stats and join it.
        // The new character propagates to replicas via the created-delta; richer
        // initial state (archetype, items, placement) follows in later commands.
        const ch = constructBareCharacter(command.character, campaign) as PlayerCharacter;
        ch.joinCampaign();
        return;
      }
      // ---- GM / lifecycle / NPC ----
      case "beginCampaign":
        campaign.beginCampaign();
        return;
      case "endCampaign":
        campaign.endCampaign();
        return;
      case "nextPlayer":
        campaign.nextPlayer();
        return;
      case "leaveCampaign":
        campaign.leaveCampaign(index.character(command.characterId) as IPlayerCharacter);
        return;
      case "transferGM":
        campaign.transfer(index.character(command.characterId) as IPlayerCharacter);
        return;
      case "mobEscape":
        (index.character(command.mobId) as IMob).escape();
        return;
      case "mobAttack": {
        const mob = index.character(command.mobId) as ICombatant;
        mob.attack(index.character(command.targetId));
        return;
      }
    }
  }
}
