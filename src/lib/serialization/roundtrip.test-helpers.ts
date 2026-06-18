/**
 * Shared helpers for serialization round-trip tests.
 * Extracted so Tasks 5, 6, 9 (and others) can reuse the same campaign fixture.
 */
import { Campaign } from "../campaign";
import { PlayerCharacter } from "../character/player-character";
import { Room } from "../room";
import { StatType } from "../character/stats";
import { Item } from "../inventory";
import { SlotKind } from "../equipment";
import type { ArchetypeId } from "../archetype";
import type { RecipeId } from "../crafting";
import type { ExitsArg } from "../../test-utils";
import { CampaignRegistry } from "./registry";

export function makeStats() {
  return {
    [StatType.Health]: 10,
    [StatType.Sanity]: 10,
    [StatType.Energy]: 10,
  };
}

/**
 * Builds a minimal but fully-wired campaign suitable for serialization tests.
 * Returns the campaign and a fresh {@link CampaignRegistry} (with no custom
 * registrations — suitable for default round-trips).
 */
export function buildSerializableCampaign(): { campaign: Campaign; registry: CampaignRegistry } {
  const campaign = new Campaign("Crypt", 10, [], { rng: () => 0.5 });
  campaign.registerArchetype({
    id: "delver" as ArchetypeId,
    name: "Delver",
    statModifiers: { [StatType.Health]: 2 },
  });
  const start = new Room("Start", "the entrance", [], {} as ExitsArg);
  const pc = new PlayerCharacter(campaign, "Ada", makeStats());
  pc.joinCampaign();
  campaign.gm = pc;
  pc.selectArchetype("delver" as ArchetypeId);
  pc.move(start);

  const registry = new CampaignRegistry();
  return { campaign, registry };
}

/** Registry key / id for the craftable widget in {@link buildStartedCampaign}. */
export const WIDGET_RECIPE_ID = "widget" as RecipeId;
/** behaviorKey of the item the widget recipe mints (must be registered to survive serialization). */
export const WIDGET_BEHAVIOR_KEY = "widget-item";

/** Builds a fresh, serializable item carrying the widget behaviorKey. */
function makeWidgetItem(): Item {
  const noop = () => {};
  return new Item(
    {
      type: "weapon",
      recipe: { item: 1 },
      modifier: 0,
      stat: StatType.Health,
      name: "Widget",
      slot: SlotKind.Hand,
      behaviorKey: WIDGET_BEHAVIOR_KEY,
    },
    { equippable: true, equipped: false, destroyable: true, usable: false },
    { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    { onPickUp: noop },
  );
}

/**
 * Builds a started campaign whose active character can immediately craft a
 * serializable item via `activeCharacter.craft(WIDGET_RECIPE_ID)`: the widget
 * recipe is discovered, its materials are claimed, and both the recipe and the
 * item's behaviorKey are registered so the crafted item survives serialization
 * and can be hydrated on a replica.
 */
export function buildStartedCampaign(): { campaign: Campaign; registry: CampaignRegistry } {
  const campaign = new Campaign("Crypt", 10, [], { rng: () => 0.5 });
  campaign.registerArchetype({
    id: "delver" as ArchetypeId,
    name: "Delver",
    statModifiers: { [StatType.Health]: 2 },
  });
  const start = new Room("Start", "the entrance", [], {} as ExitsArg);
  const pc = new PlayerCharacter(campaign, "Ada", makeStats());
  pc.joinCampaign();
  campaign.gm = pc;
  pc.selectArchetype("delver" as ArchetypeId);
  pc.move(start);

  const recipe = {
    id: WIDGET_RECIPE_ID,
    materials: { metal: 2 },
    create: makeWidgetItem,
  };
  campaign.discoverRecipe(recipe);
  campaign.claimMaterials("seed", { metal: 2 });
  campaign.beginCampaign();

  const registry = new CampaignRegistry();
  registry.registerRecipe(String(WIDGET_RECIPE_ID), recipe);
  registry.registerItem(WIDGET_BEHAVIOR_KEY, makeWidgetItem);
  return { campaign, registry };
}
