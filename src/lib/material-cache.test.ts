import { describe, expect, it } from "vitest";

import { DEPLETE, MaterialCache } from "./material-cache";
import type { Presentation } from "./presentation";
import { HYDRATE } from "./serialization/symbols";

describe("MaterialCache", () => {
  it("assigns an id and starts undepleted with the given contents", () => {
    const cache = new MaterialCache({ contents: { metal: 3, glass: 1 } });

    expect(typeof cache.id).toBe("string");
    expect(cache.id.length).toBeGreaterThan(0);
    expect(cache.depleted).toBe(false);
    expect(cache.contents).toEqual({ metal: 3, glass: 1 });
  });

  it("copies the contents so later mutation of the source is ignored", () => {
    const source = { metal: 3 };
    const cache = new MaterialCache({ contents: source });

    source.metal = 99;

    expect(cache.contents).toEqual({ metal: 3 });
  });

  it("yields its contents and marks itself depleted on the first deplete", () => {
    const cache = new MaterialCache({ contents: { metal: 3 } });

    expect(cache[DEPLETE]()).toEqual({ metal: 3 });
    expect(cache.depleted).toBe(true);
    expect(cache.contents).toEqual({});
  });

  it("yields nothing on a second deplete", () => {
    const cache = new MaterialCache({ contents: { metal: 3 } });

    cache[DEPLETE]();

    expect(cache[DEPLETE]()).toEqual({});
  });

  it("exposes supplied presentation and is undefined when omitted", () => {
    const pres: Presentation = { image: "ore.png" };
    expect(new MaterialCache({ contents: { metal: 1 }, presentation: pres }).presentation).toBe(pres);
    expect(new MaterialCache({ contents: { metal: 1 } }).presentation).toBeUndefined();
  });
});

it("MaterialCache[HYDRATE] restores contents and depleted in place", () => {
  const cache = new MaterialCache({ contents: { metal: 2 } });
  cache[HYDRATE]({ id: cache.id, contents: {}, depleted: true });
  expect(cache.depleted).toBe(true);
  expect(cache.contents).toEqual({});
  // re-apply (idempotent)
  cache[HYDRATE]({ id: cache.id, contents: {}, depleted: true });
  expect(cache.depleted).toBe(true);
});
