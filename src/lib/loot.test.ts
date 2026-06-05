import { afterEach, describe, expect, it, vi } from "vitest";

import type { IItem, ItemId } from "./inventory";
import { Loot } from "./loot";
import { ContainerFullException, generateId } from "./util";

// `Loot` only ever reads `id` off the items it holds, so a minimal stub cast to
// `IItem` is enough and keeps the tests free of the full `Item` machinery.
function makeItem(id: ItemId = generateId<ItemId>()): IItem {
  return { id } as unknown as IItem;
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

    it("sizes spaces to two more than the initial contents", () => {
      expect(new Loot("empty", []).spaces).toBe(2);
      expect(new Loot("packed", [makeItem(), makeItem(), makeItem()]).spaces).toBe(5);
    });

    it("does not recompute spaces when contents change after construction", () => {
      const loot = new Loot("empty", []);

      loot.stowItem(makeItem());

      expect(loot.spaces).toBe(2);
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
      // Empty contents => spaces === 2, so the third stow overflows.
      const loot = new Loot("empty", []);
      loot.stowItem(makeItem());
      loot.stowItem(makeItem());

      expect(() => loot.stowItem(makeItem())).toThrow(ContainerFullException);
    });

    it("includes the container id in the overflow error message", () => {
      const loot = new Loot("packed", [makeItem(), makeItem()]);
      // spaces === 4, contents already at 2, so two more fit and the next throws.
      loot.stowItem(makeItem());
      loot.stowItem(makeItem());

      expect(() => loot.stowItem(makeItem())).toThrow(loot.id);
    });
  });
});
