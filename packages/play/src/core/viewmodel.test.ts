// packages/play/src/core/viewmodel.test.ts
import { describe, it, expect } from "vitest";
import { assemble } from "wickedways/lib/authoring/assembler";
import { PlayerCharacter } from "wickedways/lib/character/player-character";
import { hauntedHouseTemplate, ALIASES } from "../campaign/index.js";
import { Rooms, Archetypes } from "../campaign/ids.js";
import { view } from "./viewmodel.js";

function bootInLanding() {
  const builder = hauntedHouseTemplate();
  const { campaign, rooms } = assemble(builder.description, builder.registry);
  const pc = new PlayerCharacter({ campaign, name: "Heir" });
  pc.joinCampaign(); pc.selectArchetype(Archetypes.Heir as never);
  pc.move(rooms.get(Rooms.Landing)!); campaign.gm = pc; campaign.beginCampaign();
  return { campaign, rooms };
}

describe("viewmodel", () => {
  it("reports the room, open exits, and locked doors classified by canPass", () => {
    const { campaign } = bootInLanding();
    const vm = view(campaign, ALIASES);
    expect(vm.room.name).toBe(Rooms.Landing);
    // The Landing↔Nursery corridor is open (no preconditions)
    expect(vm.exits.map((e) => e.toName)).toContain(Rooms.Nursery);
    // The Landing↔Hall corridor is also open
    expect(vm.exits.map((e) => e.toName)).toContain(Rooms.Hall);
    // The Study and Attic doors are locked (canPass=false for keyless PC)
    expect(vm.exits.map((e) => e.toName)).not.toContain(Rooms.Study);
    expect(vm.exits.map((e) => e.toName)).not.toContain(Rooms.Attic);
    // Both locked doors appear in lockedDoors
    expect(vm.lockedDoors.map((d) => d.name).sort()).toEqual(["attic door", "study door"]);
  });
  it("includes the Foyer's start-room journal loot in scope once opened", () => {
    const builder = hauntedHouseTemplate();
    const { campaign, rooms } = assemble(builder.description, builder.registry);
    const pc = new PlayerCharacter({ campaign, name: "Heir" });
    pc.joinCampaign(); pc.selectArchetype(Archetypes.Heir as never);
    pc.move(rooms.get(Rooms.Foyer)!); campaign.gm = pc; campaign.beginCampaign();
    const box = [...pc.currentRoom!.loot.values()][0]!;
    pc.openLootBox(box);
    // The engine tracks no "opened" flag; the session passes opened loot ids.
    const openedLootIds = new Set([box.id]);
    const vm = view(campaign, ALIASES, openedLootIds);
    expect(vm.loot[0]!.opened).toBe(true);
    expect(vm.scope.some((s) => s.kind === "item" && s.name === "Water-Stained Journal")).toBe(true);
  });
});
