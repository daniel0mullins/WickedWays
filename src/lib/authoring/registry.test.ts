import { describe, it, expect } from "vitest";
import { defineRegistry, type ItemKeyOf, type RecipeKeyOf } from "./registry";
import { Item } from "../inventory";
import { StatType } from "../character/stats";
import { SlotKind } from "../equipment";

function makeWidget(): Item {
  const noop = () => {};
  return new Item(
    { type: "weapon", recipe: { item: 1 }, modifier: 0, stat: StatType.Health, name: "Widget", slot: SlotKind.Hand, behaviorKey: "widget-item" },
    { equippable: true, equipped: false, destroyable: true, usable: false },
    { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    { onPickUp: noop },
  );
}
const widgetRecipe = { id: "widget" as never, materials: { metal: 2 }, create: makeWidget };

describe("defineRegistry", () => {
  it("produces a runtime CampaignRegistry with the items/recipes registered", () => {
    const reg = defineRegistry({ items: { "widget-item": makeWidget }, recipes: { "widget": widgetRecipe } });
    expect(reg.item("widget-item")()).toBeInstanceOf(Item); // factory resolves + runs
    expect(reg.recipe("widget")).toBe(widgetRecipe);
  });

  it("infers the key-literal unions into the type (compile-time)", () => {
    const _reg = defineRegistry({ items: { a: makeWidget, b: makeWidget }, recipes: { r: widgetRecipe } });
    type IK = ItemKeyOf<typeof _reg>;
    type RK = RecipeKeyOf<typeof _reg>;
    const ik: IK = "a"; const rk: RK = "r"; // OK
    // @ts-expect-error "c" is not a registered item key
    const bad: IK = "c";
    void ik; void rk; void bad;
  });
});
