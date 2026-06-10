/**
 * The kind of slot an item fits — the category, not a specific position. An item
 * declares its `slot` as one of these; a character has concrete named slots
 * ({@link EquipmentSlot}) of each kind.
 */
export const SlotKind = {
  Hand: "hand",
  Finger: "finger",
  Wrist: "wrist",
  Head: "head",
  Torso: "torso",
  Legs: "legs",
  Feet: "feet",
} as const;
export type SlotKind = (typeof SlotKind)[keyof typeof SlotKind];

/**
 * A character's discrete, named, single-occupancy equipment positions. Each holds
 * at most one item (a two-handed weapon spans both hands). Naming each position
 * explicitly — rather than pooling by capacity — lets a future spec remove an
 * individual slot (a lost finger or limb).
 */
export const EquipmentSlot = {
  Head: "head",
  Torso: "torso",
  Legs: "legs",
  Feet: "feet",
  LeftWrist: "leftWrist",
  RightWrist: "rightWrist",
  LeftHand: "leftHand",
  RightHand: "rightHand",
  LeftIndexFinger: "leftIndexFinger",
  LeftRingFinger: "leftRingFinger",
  RightIndexFinger: "rightIndexFinger",
  RightRingFinger: "rightRingFinger",
} as const;
export type EquipmentSlot = (typeof EquipmentSlot)[keyof typeof EquipmentSlot];

/** The kind each named slot belongs to. */
export const SLOT_KIND: Record<EquipmentSlot, SlotKind> = {
  [EquipmentSlot.Head]: SlotKind.Head,
  [EquipmentSlot.Torso]: SlotKind.Torso,
  [EquipmentSlot.Legs]: SlotKind.Legs,
  [EquipmentSlot.Feet]: SlotKind.Feet,
  [EquipmentSlot.LeftWrist]: SlotKind.Wrist,
  [EquipmentSlot.RightWrist]: SlotKind.Wrist,
  [EquipmentSlot.LeftHand]: SlotKind.Hand,
  [EquipmentSlot.RightHand]: SlotKind.Hand,
  [EquipmentSlot.LeftIndexFinger]: SlotKind.Finger,
  [EquipmentSlot.LeftRingFinger]: SlotKind.Finger,
  [EquipmentSlot.RightIndexFinger]: SlotKind.Finger,
  [EquipmentSlot.RightRingFinger]: SlotKind.Finger,
};

/**
 * The default humanoid set of named slots, in canonical fill order (used when
 * `equip` auto-assigns a free slot of a kind).
 */
export const DEFAULT_EQUIPMENT_SLOTS: readonly EquipmentSlot[] = [
  EquipmentSlot.Head,
  EquipmentSlot.Torso,
  EquipmentSlot.Legs,
  EquipmentSlot.Feet,
  EquipmentSlot.LeftWrist,
  EquipmentSlot.RightWrist,
  EquipmentSlot.LeftHand,
  EquipmentSlot.RightHand,
  EquipmentSlot.LeftIndexFinger,
  EquipmentSlot.LeftRingFinger,
  EquipmentSlot.RightIndexFinger,
  EquipmentSlot.RightRingFinger,
];
