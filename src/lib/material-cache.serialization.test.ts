import { describe, it, expect } from "vitest";
import { MaterialCache, DEPLETE } from "./material-cache";
import { SERIALIZE } from "./serialization/symbols";
import { hydrateMaterialCache } from "./material-cache";
import { CampaignRegistry } from "./serialization/registry";
import { HydrateContext } from "./serialization/context";

describe("MaterialCache serialization", () => {
  it("round-trips an intact cache, preserving id and contents", () => {
    const ctx = new HydrateContext(new CampaignRegistry(), () => 0.5);
    const cache = new MaterialCache({ metal: 3, healing: 1 });

    const snap = cache[SERIALIZE]();
    expect(snap.contents).toEqual({ metal: 3, healing: 1 });
    expect(snap.depleted).toBe(false);

    const restored = hydrateMaterialCache(snap, ctx);
    expect(restored.id).toBe(cache.id);
    expect(restored.contents).toEqual({ metal: 3, healing: 1 });
    expect(restored.depleted).toBe(false);
  });

  it("round-trips a depleted cache", () => {
    const ctx = new HydrateContext(new CampaignRegistry(), () => 0.5);
    const cache = new MaterialCache({ metal: 5 });
    cache[DEPLETE]();

    const snap = cache[SERIALIZE]();
    expect(snap.depleted).toBe(true);
    expect(snap.contents).toEqual({});

    const restored = hydrateMaterialCache(snap, ctx);
    expect(restored.id).toBe(cache.id);
    expect(restored.depleted).toBe(true);
    expect(restored.contents).toEqual({});
  });
});
