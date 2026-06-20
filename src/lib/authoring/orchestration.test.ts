import { describe, it, expect } from "vitest";
import { instantiate, startSession } from "./orchestration";
import { authorTemplate } from "./template-builder";
import { defineRegistry } from "./registry";
import { Directions } from "../room";
import { StatType } from "../character/stats";

const stats = () => ({ [StatType.Health]: 10, [StatType.Sanity]: 10, [StatType.Energy]: 10 });
function seedBuilder() {
  const reg = defineRegistry({ items: {} });
  return authorTemplate("Crypt", reg, { rng: () => 0.5, maxRounds: 10 })
    .archetype({ id: "delver", name: "Delver", statModifiers: { [StatType.Health]: 2 } })
    .room("start", { description: "the entrance" }).room("next", { description: "next" })
    .startRoom("start").exit("start", Directions.North, "next");
}

describe("instantiate", () => {
  it("gives a fresh campaign id but the same world", () => {
    const template = seedBuilder().toSnapshot();
    const inst = instantiate(template);
    expect(inst.campaign.id).not.toBe(template.campaign.id);
    expect(inst.rooms.length).toBe(template.rooms.length);
  });
});

describe("startSession", () => {
  it("joins players, selects archetypes, sets gm, begins", () => {
    const campaign = startSession(seedBuilder(), {
      players: [{ name: "Ada", stats: stats(), archetype: "delver" }, { name: "Ben", stats: stats(), archetype: "delver" }],
      gm: 0,
    });
    expect(campaign.started).toBe(true);
    expect(campaign.party.length).toBe(2);
    expect(campaign.activeCharacter.name).toBe("Ada");
  });
});
