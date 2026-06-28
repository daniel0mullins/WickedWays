import { describe, it, expect } from "vitest";
import { ITEM_FACTORIES } from "./items.js";
import { Items, Keys } from "./ids.js";

describe("campaign items", () => {
  it("registers a factory for every item and key id", () => {
    for (const id of [...Object.values(Items), ...Object.values(Keys)]) {
      expect(typeof ITEM_FACTORIES[id]).toBe("function");
    }
  });
  it("the lantern emits light and is equippable; the journal carries its behaviorKey", () => {
    const lantern = ITEM_FACTORIES[Items.Lantern]!();
    expect(lantern.emitsLight).toBe(true);
    expect(lantern.properties.equippable).toBe(true);
    const journal = ITEM_FACTORIES[Items.Journal]!();
    expect(journal.behaviorKey).toBe(Items.Journal);
  });
  it("keys carry their keyCode", () => {
    expect(ITEM_FACTORIES[Keys.Brass]!().keyCode).toBe("brass");
    expect(ITEM_FACTORIES[Keys.Iron]!().keyCode).toBe("iron");
  });
});
