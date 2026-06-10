import { describe, expect, it } from "vitest";

import {
  DEFAULT_EQUIPMENT_SLOTS,
  EquipmentSlot,
  SLOT_KIND,
  SlotKind,
} from "./equipment";

describe("equipment slots", () => {
  it("maps every named slot to a kind", () => {
    for (const slot of Object.values(EquipmentSlot)) {
      expect(SLOT_KIND[slot]).toBeDefined();
    }
  });

  it("maps hands, wrists, and fingers to their kinds", () => {
    expect(SLOT_KIND[EquipmentSlot.LeftHand]).toBe(SlotKind.Hand);
    expect(SLOT_KIND[EquipmentSlot.RightHand]).toBe(SlotKind.Hand);
    expect(SLOT_KIND[EquipmentSlot.LeftWrist]).toBe(SlotKind.Wrist);
    expect(SLOT_KIND[EquipmentSlot.LeftIndexFinger]).toBe(SlotKind.Finger);
    expect(SLOT_KIND[EquipmentSlot.RightRingFinger]).toBe(SlotKind.Finger);
    expect(SLOT_KIND[EquipmentSlot.Head]).toBe(SlotKind.Head);
  });

  it("has the default humanoid slot set: 2 hands, 2 wrists, 4 fingers, 4 single body slots", () => {
    const slots = DEFAULT_EQUIPMENT_SLOTS;
    expect(slots).toHaveLength(12);
    const fingers = slots.filter((s) => SLOT_KIND[s] === SlotKind.Finger);
    const hands = slots.filter((s) => SLOT_KIND[s] === SlotKind.Hand);
    expect(fingers).toHaveLength(4); // two per hand
    expect(hands).toHaveLength(2);
    // No duplicates.
    expect(new Set(slots).size).toBe(slots.length);
  });
});
