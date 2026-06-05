import { afterEach, describe, expect, it, vi } from "vitest";

import { CLAIM, type IItem, type ItemId } from "./inventory";
import { Loot } from "./loot";
import { ContainerFullException, generateId } from "./util";

const HELD_BY = Symbol.for("heldBy");

// Reads the holder an item stub recorded through its HELD_BY getter.
function heldBy(item: IItem): unknown {
  return (item as unknown as Record<symbol, unknown>)[HELD_BY];
}

// `Loot` reads each item's `id` and claims it as holder, so the stub supports
// the CLAIM symbol and the HELD_BY getter.
function makeItem(id: ItemId = generateId<ItemId>()): IItem {
  let holder: unknown = null;
  return {
    id,
    [CLAIM]: (h: unknown) => {
      holder = h;
    },
    get [HELD_BY]() {
      return holder;
    },
  } as unknown as IItem;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Loot", () => {
  describe("constructor", () => {
    it("assigns an id and stores the description and contents", () => {
      const contents = [makeItem(), makeItem()];
      const loot = new Loot("a dusty chest", contents);

      expect(typeof loot.id).toBe("string");
      expect(loot.id.length).toBeGreaterThan(0);
      expect(loot.description).toBe("a dusty chest");
      expect(loot.contents).toBe(contents);
    });

    it("sizes capacity to two more than the initial contents", () => {
      expect(new Loot("empty", []).capacity).toBe(2);
      expect(
        new Loot("packed", [makeItem(), makeItem(), makeItem()]).capacity,
      ).toBe(5);
    });

    it("does not recompute capacity when contents change after construction", () => {
      const loot = new Loot("empty", []);

      loot.stowItem(makeItem());

      expect(loot.capacity).toBe(2);
    });
  });

  describe("removeItems", () => {
    it("returns the matching item for a single id", () => {
      const target = makeItem();
      const loot = new Loot("chest", [makeItem(), target, makeItem()]);

      expect(loot.removeItems(target.id)).toEqual([target]);
    });

    it("returns the matching items for an array of ids", () => {
      const first = makeItem();
      const second = makeItem();
      const loot = new Loot("chest", [first, makeItem(), second]);

      expect(loot.removeItems([first.id, second.id])).toEqual([first, second]);
    });

    it("skips and warns for an id that is not present, returning only the found items", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const present = makeItem();
      const loot = new Loot("chest", [present]);
      const missingId = generateId<ItemId>();

      expect(loot.removeItems([present.id, missingId])).toEqual([present]);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        "Attempted to remove an item from a container, but it was not there",
      );
    });

    it("returns an empty array when no id matches", () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const loot = new Loot("chest", [makeItem()]);

      expect(loot.removeItems(generateId<ItemId>())).toEqual([]);
    });

    it("removes the matched items from contents", () => {
      const target = makeItem();
      const other = makeItem();
      const loot = new Loot("chest", [target, other]);

      loot.removeItems(target.id);

      expect(loot.contents).toEqual([other]);
    });

    it("leaves contents untouched when nothing matches", () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const present = makeItem();
      const loot = new Loot("chest", [present]);

      loot.removeItems(generateId<ItemId>());

      expect(loot.contents).toEqual([present]);
    });
  });

  describe("stowItem", () => {
    it("adds an item while there is space", () => {
      const loot = new Loot("empty", []);
      const item = makeItem();

      loot.stowItem(item);

      expect(loot.contents).toContain(item);
    });

    it("throws ContainerFullException once the container is full", () => {
      // Empty contents => capacity === 2, so the third stow overflows.
      const loot = new Loot("empty", []);
      loot.stowItem(makeItem());
      loot.stowItem(makeItem());

      expect(() => loot.stowItem(makeItem())).toThrow(ContainerFullException);
    });

    it("includes the container id in the overflow error message", () => {
      const loot = new Loot("packed", [makeItem(), makeItem()]);
      // capacity === 4, contents already at 2, so two more fit and the next throws.
      loot.stowItem(makeItem());
      loot.stowItem(makeItem());

      expect(() => loot.stowItem(makeItem())).toThrow(loot.id);
    });
  });

  describe("IItemHolder conformance", () => {
    it("identifies itself as a loot holder", () => {
      expect(new Loot("chest", []).holderKind).toBe("loot");
    });

    it("claims its initial contents as their holder", () => {
      const item = makeItem();
      const loot = new Loot("chest", [item]);

      expect(heldBy(item)).toBe(loot);
    });

    it("receiveItem stows the item and claims it", () => {
      const loot = new Loot("chest", []);
      const item = makeItem();

      loot.receiveItem(item);

      expect(loot.contents).toContain(item);
      expect(heldBy(item)).toBe(loot);
    });

    it("relinquishItem removes the item from contents", () => {
      const item = makeItem();
      const loot = new Loot("chest", [item]);

      loot.relinquishItem(item);

      expect(loot.contents).not.toContain(item);
    });

    it("relinquishItem leaves contents untouched when the item is absent", () => {
      const present = makeItem();
      const loot = new Loot("chest", [present]);

      loot.relinquishItem(makeItem());

      expect(loot.contents).toEqual([present]);
    });

    it("reports no room once at capacity", () => {
      const loot = new Loot("chest", []); // capacity 2
      expect(loot.hasRoomForItem()).toBe(true);
      loot.stowItem(makeItem());
      loot.stowItem(makeItem());
      expect(loot.hasRoomForItem()).toBe(false);
    });
  });
});
