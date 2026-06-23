import { describe, it, expect } from "vitest";
import { EncounterTable } from "./encounter-table";
import { SERIALIZE, HYDRATE } from "./serialization/symbols";
import { CampaignRegistry } from "./serialization/registry";

describe("EncounterTable serialization", () => {
  it("round-trips baseChance, visited rooms, and formation keys", () => {
    const reg = new CampaignRegistry();
    reg.registerFormation("pack", { build: () => [] });
    const table = new EncounterTable({ rng: () => 0.5, baseChance: 30 });
    // mark a room visited via maybeSpawn (no formations → no spawn, but marks visited)
    table.maybeSpawn({ id: "room-1", spawnModifier: 1, occupants: [] } as never, { party: [] } as never);

    const snap = table[SERIALIZE]();
    snap.formations.push({ behaviorKey: "pack", weight: 3 });

    const restored = new EncounterTable({ rng: () => 0.5, baseChance: 0 });
    restored[HYDRATE](snap, reg);
    const round = restored[SERIALIZE]();
    expect(round.baseChance).toBe(30);
    expect(round.visited).toContain("room-1");
    expect(round.formations).toEqual([{ behaviorKey: "pack", weight: 3 }]);
  });
});
