import { describe, it, expect } from "vitest";
import { PlayerCharacter } from "./player-character";
import { Mob } from "./mob";
import { Campaign } from "../campaign";
import { createKey } from "../inventory";
import { SERIALIZE, HYDRATE } from "../serialization/symbols";
import { constructBareCharacter } from "./hydrate";
import { hydrateItem } from "../inventory";
import { CampaignRegistry } from "../serialization/registry";
import { HydrateContext } from "../serialization/context";

describe("Character serialization", () => {
  it("round-trips a player's stats, inventory, history, and afflictions", () => {
    const campaign = new Campaign("C", 10);
    const ctx = new HydrateContext(new CampaignRegistry(), () => 0.5);
    const pc = new PlayerCharacter(campaign, "Ada", { health: 8, sanity: 5, energy: 6 });
    const key = createKey({ name: "K", keyCode: "x", consumeOnUse: false });
    pc.receiveItem(key);

    const snap = pc[SERIALIZE]();
    expect(snap).toMatchObject({ kind: "player", name: "Ada", inventory: { keyIds: [key.id] } });

    hydrateItem(key[SERIALIZE](), ctx);
    const restored = constructBareCharacter(snap, campaign);
    ctx.put(restored.id, restored);
    restored[HYDRATE](snap, ctx);
    expect(restored.id).toBe(pc.id);
    expect(restored.stats).toEqual({ health: 8, sanity: 5, energy: 6 });
    expect(restored.inventory.keys.map((k) => k.id)).toEqual([key.id]);
  });

  it("round-trips a mob's origin, escape chance, and drops", () => {
    const campaign = new Campaign("C", 10);
    const ctx = new HydrateContext(new CampaignRegistry(), () => 0.5);
    const mob = new Mob(campaign, "Ghoul", { health: 5, sanity: 5, energy: 5 }, 2, 2, [], { baseEscapeChance: 25, lightAverse: true });

    const snap = mob[SERIALIZE]();
    expect(snap).toMatchObject({ kind: "mob", baseEscapeChance: 25, lightAverse: true });

    const restored = constructBareCharacter(snap, campaign) as Mob;
    ctx.put(restored.id, restored);
    restored[HYDRATE](snap, ctx);
    expect(restored.id).toBe(mob.id);
    expect((restored as { baseEscapeChance?: number })).toBeDefined();
  });
});
