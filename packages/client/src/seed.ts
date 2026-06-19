import { Campaign } from "wickedways/lib/campaign";
import { PlayerCharacter } from "wickedways/lib/character/player-character";
import { Room, Directions, type Direction, type IRoom } from "wickedways/lib/room";
import { StatType } from "wickedways/lib/character/stats";
import { Item } from "wickedways/lib/inventory";
import { SlotKind } from "wickedways/lib/equipment";
import { CampaignRegistry } from "wickedways/lib/serialization/registry";
import type { ArchetypeId } from "wickedways/lib/archetype";
import type { RecipeId } from "wickedways/lib/crafting";

const WIDGET_RECIPE_ID = "widget" as RecipeId;
const WIDGET_BEHAVIOR_KEY = "widget-item";
// The Room constructor tolerates a partial/empty exits object (it iterates
// Object.entries); an empty cast keeps a room exit-free without the test-only
// `ExitsArg` alias.
const NO_EXITS = {} as Record<Direction, IRoom>;

function makeStats() {
  return { [StatType.Health]: 10, [StatType.Sanity]: 10, [StatType.Energy]: 10 };
}

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

function makeWidgetRecipe() {
  return { id: WIDGET_RECIPE_ID, materials: { metal: 2 }, create: makeWidgetItem };
}

/** The registry every client reconstructs from code so snapshots/deltas can hydrate. */
export function buildSeedRegistry(): CampaignRegistry {
  const registry = new CampaignRegistry();
  registry.registerRecipe(String(WIDGET_RECIPE_ID), makeWidgetRecipe());
  registry.registerItem(WIDGET_BEHAVIOR_KEY, makeWidgetItem);
  return registry;
}

/**
 * The shared demo campaign the first client seeds. Ported from the engine's
 * `buildStartedCampaign` test helper (test-only, so it cannot be imported into
 * production client code). Two PCs (Ada active, then Ben) stand in "Start", which
 * has a North exit to "Next"; the widget recipe is discovered and its materials
 * claimed so `craft` is legal.
 */
export function buildSeedCampaign(): { campaign: Campaign; registry: CampaignRegistry } {
  const campaign = new Campaign("Crypt", 10, [], { rng: () => 0.5 });
  campaign.registerArchetype({
    id: "delver" as ArchetypeId,
    name: "Delver",
    statModifiers: { [StatType.Health]: 2 },
  });

  const start = new Room("Start", "the entrance", [], NO_EXITS);
  const next = new Room("Next", "an adjoining chamber", [], NO_EXITS);
  start.addExit(Directions.North, next);

  const ada = new PlayerCharacter(campaign, "Ada", makeStats());
  ada.joinCampaign();
  ada.selectArchetype("delver" as ArchetypeId);
  ada.move(start);

  const ben = new PlayerCharacter(campaign, "Ben", makeStats());
  ben.joinCampaign();
  ben.selectArchetype("delver" as ArchetypeId);
  ben.move(start);

  campaign.discoverRecipe(makeWidgetRecipe());
  campaign.claimMaterials("seed", { metal: 2 });

  campaign.gm = ada;
  campaign.beginCampaign();

  return { campaign, registry: buildSeedRegistry() };
}
