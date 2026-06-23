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
import { Status } from "../status";
import { Afflictions } from "./afflictions";
import { StatType } from "./stats";
import { setStartingStats } from "../../test-utils";

describe("Character serialization", () => {
  it("round-trips a player's stats, inventory, history, and afflictions", () => {
    const campaign = new Campaign({ title: "C", maxRounds: 10 });
    const ctx = new HydrateContext(new CampaignRegistry(), () => 0.5);
    const pc = new PlayerCharacter({ campaign, name: "Ada" });
    setStartingStats(campaign, pc, { [StatType.Health]: 8, [StatType.Sanity]: 5, [StatType.Energy]: 6 });
    const key = createKey({ name: "K", keyCode: "x", consumeOnUse: false });
    pc.receiveItem(key);

    const snap = pc[SERIALIZE]();
    expect(snap).toMatchObject({ kind: "player", name: "Ada", inventory: { keyIds: [key.id] } });

    const keySnap = key[SERIALIZE]();
    const hydratedKey = hydrateItem(keySnap, ctx);
    const restored = constructBareCharacter(snap, campaign);
    ctx.put(restored.id, restored);
    restored[HYDRATE](snap, ctx);
    expect(restored.id).toBe(pc.id);
    expect(restored.stats).toEqual({ health: 8, sanity: 5, energy: 6 });
    // The restored key in inventory is the same instance returned by hydrateItem.
    expect(restored.inventory.keys[0]).toBe(hydratedKey);

    // Afflictions round-trip: grant immunity to Confused and verify it survives.
    const aff = new Afflictions(() => 0.99);
    aff.grantImmunity([Status.Confused], 3);
    const affSnap = aff[SERIALIZE]();
    const aff2 = new Afflictions(() => 0.99);
    aff2[HYDRATE](affSnap);
    expect(aff2[SERIALIZE]()).toEqual(affSnap);
  });

  it("round-trips a mob's origin, escape chance, and drops", () => {
    const campaign = new Campaign({ title: "C", maxRounds: 10 });
    const ctx = new HydrateContext(new CampaignRegistry(), () => 0.5);
    const mob = new Mob({ campaign, name: "Ghoul", stats: { health: 5, sanity: 5, energy: 5 }, inventorySlots: 2, actionsPerRound: 2, drops: [], baseEscapeChance: 25, materialDrops: { metal: 3 }, lightAverse: true });

    const snap = mob[SERIALIZE]();
    expect(snap).toMatchObject({ kind: "mob", baseEscapeChance: 25, lightAverse: true });

    const restored = constructBareCharacter(snap, campaign) as Mob;
    ctx.put(restored.id, restored);
    restored[HYDRATE](snap, ctx);
    expect(restored.id).toBe(mob.id);

    // Re-serialize the restored mob to confirm all mob-specific fields survived hydrate.
    const restoredSnap = restored[SERIALIZE]();
    expect(restoredSnap.baseEscapeChance).toBe(snap.baseEscapeChance);
    expect(restoredSnap.lightAverse).toBe(snap.lightAverse);
    expect(restoredSnap.origin).toBe(snap.origin);
    expect(restoredSnap.materialDrops).toEqual(snap.materialDrops);
  });
});
