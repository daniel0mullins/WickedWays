import { StatType } from "wickedways/lib/character/stats";
import { Item } from "wickedways/lib/inventory";
import { SlotKind } from "wickedways/lib/equipment";
import { CampaignRegistry } from "wickedways/lib/serialization/registry";
import type { RecipeId } from "wickedways/lib/crafting";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import type { CampaignSnapshot } from "wickedways/lib/serialization/types";
import type { Campaign } from "wickedways/lib/campaign";
import { Directions } from "wickedways/lib/room";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate, type TemplateBuilder } from "wickedways/lib/authoring/template-builder";
import { startSession } from "wickedways/lib/authoring/orchestration";

const WIDGET_RECIPE_ID = "widget" as RecipeId;
const WIDGET_BEHAVIOR_KEY = "widget-item";

function makeStats() {
  return { [StatType.Health]: 10, [StatType.Sanity]: 10, [StatType.Energy]: 10 };
}

function makeWidgetItem(): Item {
  const noop = () => {};
  return new Item({
    descriptor: {
      type: "weapon",
      recipe: { item: 1 },
      modifier: 0,
      stat: StatType.Health,
      name: "Widget",
      slot: SlotKind.Hand,
      behaviorKey: WIDGET_BEHAVIOR_KEY,
    },
    properties: { equippable: true, equipped: false, destroyable: true, usable: false },
    actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    events: { onPickUp: noop },
  });
}

function makeWidgetRecipe() {
  return { id: WIDGET_RECIPE_ID, materials: { metal: 2 }, create: makeWidgetItem };
}

/** The registry every client reconstructs from code so snapshots/deltas can hydrate. */
export function buildSeedRegistry(): CampaignRegistry {
  return defineRegistry({
    items: { [WIDGET_BEHAVIOR_KEY]: makeWidgetItem },
    recipes: { [String(WIDGET_RECIPE_ID)]: makeWidgetRecipe() },
  });
}

/**
 * The player-less world template — rooms, exits, archetype, recipe, and materials
 * defined without any PCs joined or the campaign begun.
 */
export function seedTemplate(): TemplateBuilder<string, string> {
  return authorTemplate("Crypt", buildSeedRegistry(), { rng: () => 0.5, maxRounds: 10 })
    .archetype({ id: "delver", name: "Delver", statModifiers: { [StatType.Health]: 2 } })
    .room("Start", { description: "the entrance" })
    .room("Next", { description: "an adjoining chamber" })
    .startRoom("Start")
    .exit("Start", Directions.North, "Next")
    .recipe(String(WIDGET_RECIPE_ID))
    .materials("seed", { metal: 2 });
}

/**
 * The shared demo campaign the first client seeds. Two PCs (Ada active, then Ben)
 * stand in "Start", which has a North exit to "Next"; the widget recipe is discovered
 * and its materials claimed so `craft` is legal.
 */
export function buildSeedCampaign(): { campaign: Campaign; registry: CampaignRegistry } {
  const registry = buildSeedRegistry();
  const campaign = startSession(seedTemplate(), {
    players: [
      { name: "Ada", stats: makeStats(), archetype: "delver" },
      { name: "Ben", stats: makeStats(), archetype: "delver" },
    ],
    gm: 0,
  });
  return { campaign, registry };
}

/** The player-less template snapshot (for a template-driven genesisFor / instantiate). */
export function demoTemplate(): CampaignSnapshot {
  return seedTemplate().toSnapshot();
}

/** The demo campaign serialized to a genesis snapshot — the server's Authority is built from this. */
export function demoGenesis(): CampaignSnapshot {
  return serializeCampaign(buildSeedCampaign().campaign);
}
