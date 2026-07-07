import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate, type TemplateBuilder } from "wickedways/lib/authoring/template-builder";
import type { CampaignRegistry } from "wickedways/lib/serialization/registry";
import type { ICampaign } from "wickedways/lib/campaign";
import { StatType } from "wickedways/lib/character/stats";
import { Status } from "wickedways/lib/status";
import { Directions } from "wickedways/lib/room";
import { ITEM_FACTORIES } from "./items.js";
import { dread, makeStoryteller } from "./mechanics.js";
import { statusBar } from "./status.js";
import { LORE, doorBehavior } from "./content.js";
import { Rooms, Items, Keys, Mobs, Mechanics, Archetypes, Conditions, ExitBehaviors } from "./ids.js";

export { LORE, ALIASES, TITLE, INTRO } from "./content.js";
export { hollowHouse } from "./manifest.js";
export { hollowHouseBehaviors } from "./scripted.js";
export { Rooms, Archetypes } from "./ids.js";

export function buildHauntedHouseRegistry(): CampaignRegistry {
  return defineRegistry({
    items: ITEM_FACTORIES,
    mechanics: { [Mechanics.Dread]: dread, [Mechanics.Storyteller]: makeStoryteller(LORE), [Mechanics.StatusBar]: statusBar },
    conditions: {
      [Conditions.ReachedAtticWithJournal]: (c: ICampaign) => {
        const pc = c.party[0];
        return pc?.currentRoom?.name === Rooms.Attic && pc.inventory.items.some((i) => i.behaviorKey === Items.Journal);
      },
      [Conditions.SanityZero]: (c: ICampaign) => c.party.some((p) => p.effectiveStat(StatType.Sanity) <= 0),
      [Conditions.PartyDown]: (c: ICampaign) => c.party.length > 0 && c.party.every((p) => p.status.includes(Status.KO)),
    },
    exits: {
      [ExitBehaviors.StudyDoor]: doorBehavior("brass", "study door", "The brass key turns; the study door swings open."),
      [ExitBehaviors.AtticDoor]: doorBehavior("iron", "attic door", "The iron key grinds in the lock; the attic stairs open above you."),
    },
  });
}

export function hauntedHouseTemplate(): TemplateBuilder<string, string> {
  return authorTemplate("The Hollow House", buildHauntedHouseRegistry(), { maxRounds: 150, baseEncounterChance: 0, rng: () => 0.5 })
    // Energy 5 makes the Sanity-damage multiplier exactly 1.0 (max(0,10-5)*0.2),
    // so a mob's Sanity `power` lands as whole points — the house preys on a frail will.
    // inventorySlots is a delta on the base capacity (default 5), so +1 → 6 total.
    .archetype({ id: Archetypes.Heir, name: "Heir", baseStats: { [StatType.Health]: 12, [StatType.Sanity]: 16, [StatType.Energy]: 5 }, inventorySlots: 1, immunities: [Status.Fear] })
    // Rooms
    .room(Rooms.Foyer, { description: "The entrance hall of the Hollow House. Dust sheets shroud the furniture; the front door has locked itself behind you." })
    .room(Rooms.Cellar, { description: "A low brick cellar, black as a throat. Water seeps somewhere unseen.", dark: true })
    .room(Rooms.Hall, { description: "A long central hall. Portraits watch from the walls, their eyes scratched out." })
    .room(Rooms.Kitchen, { description: "A cold scullery. Copper pots hang in rows; one still sways." })
    .room(Rooms.Parlor, { description: "A receiving parlor gone to mildew. A piano sits with its lid nailed shut." })
    .room(Rooms.Landing, { description: "The upstairs landing. Two doors face you — one to the west, one leading further up — and a nursery stands open to the east." })
    .room(Rooms.Study, { description: "A cramped study, papers everywhere, as if someone left mid-sentence." })
    .room(Rooms.Nursery, { description: "A child's nursery. A rocking horse moves, very slightly, on its own.", dark: true })
    .room(Rooms.Attic, { description: "The attic, under the bare ribs of the roof. This is where the journal ends." })
    .startRoom(Rooms.Foyer)
    // Exits are shared bidirectional Exit objects; the assembler links both rooms and
    // dedupes by room-pair. Corridors are declared both ways below; KEYED DOORS are
    // declared ONCE (a reverse declaration would shadow the door's behaviorKey).
    .exit(Rooms.Foyer, Directions.North, Rooms.Hall).exit(Rooms.Hall, Directions.South, Rooms.Foyer)
    .exit(Rooms.Foyer, Directions.South, Rooms.Cellar).exit(Rooms.Cellar, Directions.North, Rooms.Foyer)
    .exit(Rooms.Hall, Directions.West, Rooms.Kitchen).exit(Rooms.Kitchen, Directions.East, Rooms.Hall)
    .exit(Rooms.Hall, Directions.East, Rooms.Parlor).exit(Rooms.Parlor, Directions.West, Rooms.Hall)
    .exit(Rooms.Hall, Directions.North, Rooms.Landing).exit(Rooms.Landing, Directions.South, Rooms.Hall)
    .exit(Rooms.Landing, Directions.East, Rooms.Nursery).exit(Rooms.Nursery, Directions.West, Rooms.Landing)
    // Keyed doors: Landing↔Study (west) and Landing↔Attic (north)
    .exit(Rooms.Landing, Directions.West, Rooms.Study, { behaviorKey: ExitBehaviors.StudyDoor, name: "study door", initialState: { unlocked: false } })
    .exit(Rooms.Landing, Directions.North, Rooms.Attic, { behaviorKey: ExitBehaviors.AtticDoor, name: "attic door", initialState: { unlocked: false } })
    // Loot
    .loot("foyer-table", { room: Rooms.Foyer, items: [Items.Journal], description: "A hall table with a single drawer." })
    .loot("hall-stand", { room: Rooms.Hall, items: [Items.Poker], description: "A fireplace stand." })
    .loot("kitchen-hook", { room: Rooms.Kitchen, items: [Items.Lantern], description: "A lantern hangs from a hook." })
    // NOTE: The brief placed Keys.Brass in parlor-piano loot, but the engine forbids
    // keys in loot containers (ProceduralViolation). Keys.Brass moved to Wraith drops;
    // study-desk retains the brief's laudanum.
    .loot("study-desk", { room: Rooms.Study, items: [Items.Laudanum], description: "A writing desk with a locked-open drawer." })
    // Mobs — Wraith drops the brass key (guards study door), Revenant drops iron key
    .mob(Mobs.Wraith, { stats: { [StatType.Health]: 6, [StatType.Sanity]: 5, [StatType.Energy]: 5 }, room: Rooms.Nursery, drops: [Keys.Brass], naturalAttack: { stat: StatType.Sanity, power: 3 } })
    .mob(Mobs.Revenant, { stats: { [StatType.Health]: 10, [StatType.Sanity]: 8, [StatType.Energy]: 6 }, room: Rooms.Cellar, drops: [Keys.Iron], naturalAttack: { stat: StatType.Sanity, power: 2 } })
    // Mechanics + outcomes
    .useMechanic(Mechanics.Dread)
    .useMechanic(Mechanics.Storyteller)
    .useMechanic(Mechanics.StatusBar)
    .winWhen(Conditions.ReachedAtticWithJournal, { text: "You climb into the attic with the journal in hand, and at last the house is only a house. You understand. You may leave." })
    .loseWhen(Conditions.SanityZero, { text: "The dark gets in. Your thoughts come apart like wet paper, and the Hollow House keeps what is left of you." })
    .loseWhen(Conditions.PartyDown, { text: "You fall, and do not rise. The house is patient. It has all the time there is." })
    .onTimeout({ text: "Dawn never comes. You realize, slowly, that it never will — and that you stopped looking for the door some hours ago." });
}
