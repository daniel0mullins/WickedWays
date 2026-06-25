import { describe, it, expect } from "vitest";
import { assemble } from "wickedways/lib/authoring/assembler";
import { PlayerCharacter } from "wickedways/lib/character/player-character";
import { hauntedHouseTemplate } from "./index.js";
import { Rooms, Mobs, Archetypes } from "./ids.js";
import { Directions } from "wickedways/lib/room";
import { Status } from "wickedways/lib/status";
import type { Campaign } from "wickedways/lib/campaign";
import type { IRoom } from "wickedways/lib/room";

function boot(): { campaign: Campaign; rooms: Map<string, IRoom> } {
  const builder = hauntedHouseTemplate();
  const { campaign, rooms } = assemble(builder.description, builder.registry);
  const pc = new PlayerCharacter({ campaign, name: "Heir" });
  pc.joinCampaign();
  pc.selectArchetype(Archetypes.Heir as never);
  pc.move(rooms.get(Rooms.Foyer)!);
  campaign.gm = pc;
  campaign.beginCampaign();
  return { campaign, rooms };
}

const take = (pc: PlayerCharacter, name: string) => {
  const box = [...pc.currentRoom!.loot.values()].find((l) => l.contents.some((i) => i.name === name))!;
  pc.openLootBox(box);
  return pc.takeFromLootBox(box, box.contents.filter((i) => i.name === name));
};
const go = (pc: PlayerCharacter, room: IRoom) => { pc.startTurn(); pc.move(room); };

describe("The Hollow House — winning path", () => {
  it("is winnable: journal + lantern + poker, fell the Revenant for the iron key, iron-door → Attic", () => {
    const { campaign, rooms } = boot();
    const pc = campaign.activeCharacter as unknown as PlayerCharacter;

    take(pc, "Water-Stained Journal");              // Foyer loot (a regular item, allowed in loot)
    go(pc, rooms.get(Rooms.Hall)!); campaign.nextPlayer();
    take(pc, "Iron Fire-Poker"); pc.equip(pc.inventory.items.find((i) => i.name === "Iron Fire-Poker")!);
    go(pc, rooms.get(Rooms.Kitchen)!); campaign.nextPlayer();
    take(pc, "Brass Lantern"); pc.equip(pc.inventory.items.find((i) => i.name === "Brass Lantern")!);

    // Down to the cellar (lantern keeps Dread off), fell the Revenant, grab the iron key.
    go(pc, rooms.get(Rooms.Hall)!); campaign.nextPlayer();
    go(pc, rooms.get(Rooms.Foyer)!); campaign.nextPlayer();
    go(pc, rooms.get(Rooms.Cellar)!); campaign.nextPlayer();
    const revenant = pc.currentRoom!.occupants.find((o) => o.name === Mobs.Revenant)!;
    for (let i = 0; i < 12 && !revenant.status.includes(Status.KO); i++) { pc.startTurn(); pc.attack(revenant); campaign.nextPlayer(); }
    expect(revenant.status).toContain(Status.KO);
    take(pc, "Iron Key");                           // dropped into the cellar's loot on defeat

    // Back up to the landing, use the iron key to traverse the attic door, enter with the journal.
    go(pc, rooms.get(Rooms.Foyer)!); campaign.nextPlayer();
    go(pc, rooms.get(Rooms.Hall)!); campaign.nextPlayer();
    go(pc, rooms.get(Rooms.Landing)!); campaign.nextPlayer();
    // go(Directions.North) evaluates the attic door's precondition — the iron key passes it,
    // script fires (unlocked = true), and the character moves into the Attic.
    pc.startTurn(); pc.go(Directions.North); campaign.nextPlayer();

    expect(campaign.outcome).toBe("won");
  });

  it("the Wraith drops the brass key (the brass key is a mob drop, not loot)", () => {
    const { campaign, rooms } = boot();
    const pc = campaign.activeCharacter as unknown as PlayerCharacter;
    go(pc, rooms.get(Rooms.Hall)!); campaign.nextPlayer();
    take(pc, "Iron Fire-Poker"); pc.equip(pc.inventory.items.find((i) => i.name === "Iron Fire-Poker")!);
    // The Nursery is dark: pick up the lantern from the Kitchen first so the room is lit.
    go(pc, rooms.get(Rooms.Kitchen)!); campaign.nextPlayer();
    take(pc, "Brass Lantern"); pc.equip(pc.inventory.items.find((i) => i.name === "Brass Lantern")!);
    go(pc, rooms.get(Rooms.Hall)!); campaign.nextPlayer();
    go(pc, rooms.get(Rooms.Landing)!); campaign.nextPlayer();
    go(pc, rooms.get(Rooms.Nursery)!); campaign.nextPlayer();
    const wraith = pc.currentRoom!.occupants.find((o) => o.name === Mobs.Wraith)!;
    for (let i = 0; i < 12 && !wraith.status.includes(Status.KO); i++) { pc.startTurn(); pc.attack(wraith); campaign.nextPlayer(); }
    expect(wraith.status).toContain(Status.KO);
    take(pc, "Brass Key");
    expect(pc.inventory.keys.some((k) => k.keyCode === "brass")).toBe(true);
  });
});

describe("The Hollow House — losing path", () => {
  it("loses to Sanity drain when wandering the dark without the lantern", () => {
    const { campaign, rooms } = boot();
    const pc = campaign.activeCharacter as unknown as PlayerCharacter;
    // No lantern: Dread drains 1 Sanity per turn. Heir starts at Sanity 16.
    // Shuffle Foyer↔Hall until the bleed-out resolves the campaign.
    for (let i = 0; i < 40 && campaign.outcome === "ongoing"; i++) {
      pc.startTurn();
      pc.move(pc.currentRoom!.name === Rooms.Foyer ? rooms.get(Rooms.Hall)! : rooms.get(Rooms.Foyer)!);
      campaign.nextPlayer();
    }
    expect(campaign.outcome).toBe("lost");
  });
});
