import { describe, expect, it } from "vitest";

import { DEPLETE, MaterialCache } from "./material-cache";

describe("MaterialCache", () => {
  it("assigns an id and starts undepleted with the given contents", () => {
    const cache = new MaterialCache({ metal: 3, glass: 1 });

    expect(typeof cache.id).toBe("string");
    expect(cache.id.length).toBeGreaterThan(0);
    expect(cache.depleted).toBe(false);
    expect(cache.contents).toEqual({ metal: 3, glass: 1 });
  });

  it("copies the contents so later mutation of the source is ignored", () => {
    const source = { metal: 3 };
    const cache = new MaterialCache(source);

    source.metal = 99;

    expect(cache.contents).toEqual({ metal: 3 });
  });

  it("yields its contents and marks itself depleted on the first deplete", () => {
    const cache = new MaterialCache({ metal: 3 });

    expect(cache[DEPLETE]()).toEqual({ metal: 3 });
    expect(cache.depleted).toBe(true);
    expect(cache.contents).toEqual({});
  });

  it("yields nothing on a second deplete", () => {
    const cache = new MaterialCache({ metal: 3 });

    cache[DEPLETE]();

    expect(cache[DEPLETE]()).toEqual({});
  });
});
