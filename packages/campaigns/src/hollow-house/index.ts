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
// scripted.ts is a leaf module (imports only ./ids.js + ./content.js), so this
// index.ts→scripted.ts edge is one-way — no barrel cycle. These consts are the
// SINGLE source of the caretaker's shared prose, so the native twins below stay
// byte-identical to the DSL twins the Rust core interprets from catalog.behaviors.
import { CARETAKER_HANDOFF, CARETAKER_INTRO_CUE } from "./scripted.js";
import { Rooms, Items, Keys, Mobs, Mechanics, Archetypes, Conditions, ExitBehaviors, Formations, Npcs, Scenes } from "./ids.js";
// Relative import: the package export map (`"./*": "./src/*/index.ts"`) does NOT
// resolve `@wickedways/campaigns/formations`, so reach the sibling module directly.
import { descriptorToFormation } from "../formations.js";
import type { FormationDescriptor } from "../../../../generated/bindings/FormationDescriptor.ts";
import type { MobSpec } from "../../../../generated/bindings/MobSpec.ts";

export { LORE, ALIASES, TITLE, INTRO } from "./content.js";
export { hollowHouse } from "./manifest.js";
export { hollowHouseBehaviors } from "./scripted.js";
export { Rooms, Archetypes } from "./ids.js";

// ── Roving Rats ──────────────────────────────────────────────────────────────
// Data-driven encounter mob. Health 2 / Sanity 2 / Energy 3, a 1-power Health
// bite, drops a rat-tail (usable +1 Sanity, NOT a key → legal formation drop),
// escape 50, dark-agnostic, no material drops, mob-default 2 actions/round. The
// numeric shapes (bigints, `stat: "health"`) mirror the ts-rs bindings so the
// descriptor round-trips byte-faithfully to the Rust `Catalog.formations` side.
const ratSpec: MobSpec = {
  name: "Rat",
  stats: { health: 2, sanity: 2, energy: 3 },
  naturalAttack: { stat: "health", power: 1 },
  drops: [Items.RatTail],
  baseEscapeChance: 50n,
  lightAverse: false,
  materialDrops: {},
  actionsPerRound: 2n,
};

const ratSingle: FormationDescriptor = { mobs: [ratSpec] };
const ratPair: FormationDescriptor = { mobs: [ratSpec, ratSpec] };

/**
 * The campaign's data-driven encounter formations (raw {@link FormationDescriptor}s),
 * threaded onto the manifest → `Catalog.formations` so the Rust `World::maybe_spawn`
 * can resolve them. The TS-side `FormationBehavior`s live in the registry (see
 * {@link buildHauntedHouseRegistry}); these are the serializable descriptors.
 */
export function hollowHouseFormations(): Record<string, FormationDescriptor> {
  return { [Formations.RatSingle]: ratSingle, [Formations.RatPair]: ratPair };
}

export function buildHauntedHouseRegistry(): CampaignRegistry {
  const registry = defineRegistry({
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
      [ExitBehaviors.CellarDoor]: doorBehavior("cellar", "cellar door", "The cellar key turns; the cellar door swings open."),
    },
    // NPC + scene native twins. The Rust engine resolves the caretaker / intro
    // scene from catalog.behaviors (the DSL twins in scripted.ts); these native
    // registry entries are what the TS assembler/oracle consumes when building
    // genesis and firing the start-room enter scene at begin_campaign. The scene
    // `script` MUST emit the same cue text as the DSL `cue` (shared const), and
    // `preconditions: []` matches the DSL's null canPlay (always plays).
    npcs: {
      [Npcs.Caretaker]: { initialDialogue: CARETAKER_HANDOFF, dialogue: [] },
    },
    scenes: {
      [Scenes.CaretakerIntro]: { preconditions: [], script: () => [{ text: CARETAKER_INTRO_CUE }] },
    },
  });
  // Formation → FormationBehavior. `descriptorToFormation` needs the item registry
  // to realize `MobSpec.drops`, but only dereferences it lazily inside `build()`
  // (at spawn/assembly time) — so registering AFTER the registry object exists
  // resolves the chicken-and-egg (a formation that references the registry that
  // owns it) with a plain, already-live reference. rat-tail is not a key, so the
  // encounter-table key-drop guard accepts these at assembly.
  registry.registerFormation(Formations.RatSingle, descriptorToFormation(ratSingle, registry));
  registry.registerFormation(Formations.RatPair, descriptorToFormation(ratPair, registry));
  return registry;
}

export function hauntedHouseTemplate(): TemplateBuilder<string, string> {
  return authorTemplate("The Hollow House", buildHauntedHouseRegistry(), { maxRounds: 150, baseEncounterChance: 20, rng: () => 0.5 })
    // Energy 5 makes the Sanity-damage multiplier exactly 1.0 (max(0,10-5)*0.2),
    // so a mob's Sanity `power` lands as whole points — the house preys on a frail will.
    // inventorySlots is a delta on the base capacity (default 5), so +1 → 6 total.
    .archetype({ id: Archetypes.Heir, name: "Heir", baseStats: { [StatType.Health]: 12, [StatType.Sanity]: 16, [StatType.Energy]: 5 }, inventorySlots: 1, immunities: [Status.Fear] })
    // Rooms
    .room(Rooms.Foyer, { description: "The entrance hall of the Hollow House. Dust sheets shroud the furniture; the front door has locked itself behind you." })
    .room(Rooms.Cellar, { description: "A low brick cellar, black as a throat. Water seeps somewhere unseen.", dark: true })
    // spawnModifier bumps the roving-Rat encounter chance in the trafficked
    // ground-floor rooms + the landing (Cellar/Nursery/Foyer keep the default 0).
    .room(Rooms.Hall, { description: "A long central hall. Portraits watch from the walls, their eyes scratched out.", spawnModifier: 1 })
    .room(Rooms.Kitchen, { description: "A cold scullery. Copper pots hang in rows; one still sways.", spawnModifier: 1 })
    .room(Rooms.Parlor, { description: "A receiving parlor gone to mildew. A piano sits with its lid nailed shut.", spawnModifier: 1 })
    .room(Rooms.Landing, { description: "The upstairs landing. Two doors face you — one to the west, one leading further up — and a nursery stands open to the east.", spawnModifier: 1 })
    .room(Rooms.Study, { description: "A cramped study, papers everywhere, as if someone left mid-sentence." })
    .room(Rooms.Nursery, { description: "A child's nursery. A rocking horse moves, very slightly, on its own.", dark: true })
    .room(Rooms.Attic, { description: "The attic, under the bare ribs of the roof. This is where the journal ends." })
    .startRoom(Rooms.Foyer)
    // Exits are shared bidirectional Exit objects; the assembler links both rooms and
    // dedupes by room-pair. Corridors are declared both ways below; KEYED DOORS are
    // declared ONCE (a reverse declaration would shadow the door's behaviorKey).
    .exit(Rooms.Foyer, Directions.North, Rooms.Hall).exit(Rooms.Hall, Directions.South, Rooms.Foyer)
    .exit(Rooms.Foyer, Directions.South, Rooms.Cellar, { behaviorKey: ExitBehaviors.CellarDoor, name: "cellar door", initialState: { unlocked: false } })
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
    // Caretaker — the foyer NPC. Never fights (minimal statline); holds the cellar
    // key and hands it over on the first `talk`, then vanishes (setVisible false).
    // The intro scene fires on entering the Foyer (the start room) at begin_campaign.
    .npc("Caretaker", { stats: { [StatType.Health]: 1, [StatType.Sanity]: 1, [StatType.Energy]: 1 }, room: Rooms.Foyer, behavior: Npcs.Caretaker, holds: [Keys.Cellar] })
    .scene(Rooms.Foyer, Scenes.CaretakerIntro, { phase: "enter" })
    // Mechanics + outcomes
    .useMechanic(Mechanics.Dread)
    .useMechanic(Mechanics.Storyteller)
    .useMechanic(Mechanics.StatusBar)
    // Roving Rats — a single rat is three times as likely as a breeding pair.
    .formation(Formations.RatSingle, { weight: 3 })
    .formation(Formations.RatPair, { weight: 1 })
    .winWhen(Conditions.ReachedAtticWithJournal, { text: "You climb into the attic with the journal in hand, and at last the house is only a house. You understand. You may leave." })
    .loseWhen(Conditions.SanityZero, { text: "The dark gets in. Your thoughts come apart like wet paper, and the Hollow House keeps what is left of you." })
    .loseWhen(Conditions.PartyDown, { text: "You fall, and do not rise. The house is patient. It has all the time there is." })
    .onTimeout({ text: "Dawn never comes. You realize, slowly, that it never will — and that you stopped looking for the door some hours ago." });
}
