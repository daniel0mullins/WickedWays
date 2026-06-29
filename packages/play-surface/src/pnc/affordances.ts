import type { Direction } from "wickedways/lib/room";
import type { ViewModel, ScopeEntity, Intent } from "@wickedways/play-runtime";

export type ActionDescriptor =
  | { label: string; kind: "intent"; intent: Intent }
  | { label: string; kind: "examine"; targetId: string };

export interface Hotspot {
  key: string;                 // stable: dir for exits/doors, entity id otherwise
  label: string;               // "North", "Revenant", "Chest", "Brass Key"
  kind: "exit" | "locked" | "occupant" | "loot" | "item";
  dir?: Direction;             // exits/locked doors
  image?: string;              // entity/room image if present
  actions: ActionDescriptor[]; // [] for locked doors (informational)
}

/** Capitalise a lowercase Direction string for display ("north" → "North"). */
const cap = (d: Direction): string =>
  (d[0] ?? "").toUpperCase() + d.slice(1);

/**
 * Derive all clickable hotspots for the current scene from a ViewModel.
 *
 * Order: exits, locked doors, occupants, loot containers, floor items.
 *
 * "Floor items" are scope entities with kind "item" that belong neither to
 * the player inventory (items + keys) nor to any loot container's contents.
 */
export function sceneHotspots(vm: ViewModel): Hotspot[] {
  const hotspots: Hotspot[] = [];

  // ── Exits ─────────────────────────────────────────────────────────────────
  for (const exit of vm.exits) {
    const label = cap(exit.dir);
    hotspots.push({
      key: exit.dir,
      label,
      kind: "exit",
      dir: exit.dir,
      actions: [
        { label: `Go ${label}`, kind: "intent", intent: { kind: "move", dir: exit.dir } },
      ],
    });
  }

  // ── Locked doors ──────────────────────────────────────────────────────────
  for (const door of vm.lockedDoors) {
    hotspots.push({
      key: door.dir,
      label: door.name,
      kind: "locked",
      dir: door.dir,
      actions: [],
    });
  }

  // ── Occupants ─────────────────────────────────────────────────────────────
  for (const occupant of vm.occupants) {
    const actions: ActionDescriptor[] = [
      { label: "Examine", kind: "examine", targetId: occupant.id },
    ];
    if (!occupant.defeated) {
      actions.push({
        label: "Attack",
        kind: "intent",
        intent: { kind: "attack", targetId: occupant.id },
      });
    }
    hotspots.push({
      key: occupant.id,
      label: occupant.name,
      kind: "occupant",
      ...(occupant.image !== undefined ? { image: occupant.image } : {}),
      actions,
    });
  }

  // ── Loot containers ───────────────────────────────────────────────────────
  for (const lootItem of vm.loot) {
    hotspots.push({
      key: lootItem.id,
      label: lootItem.description,
      kind: "loot",
      actions: [
        { label: "Examine", kind: "examine", targetId: lootItem.id },
        { label: "Open", kind: "intent", intent: { kind: "open", targetId: lootItem.id } },
      ],
    });
  }

  // ── Floor items ───────────────────────────────────────────────────────────
  // scope items that are NOT in inventory (items or keys) and NOT inside a
  // CLOSED (not yet opened) loot container.  Once a container is opened its
  // contents are revealed and become individually clickable floor items so the
  // player can pick them up.
  const inventoryIds = new Set<string>([
    ...vm.inventory.items.map((i) => i.id),
    ...vm.inventory.keys.map((k) => k.id),
  ]);
  const lootContentIds = new Set<string>(
    vm.loot.filter((l) => !l.opened).flatMap((l) => l.contents.map((c) => c.id)),
  );
  const floorItems = vm.scope.filter(
    (e) => e.kind === "item" && !inventoryIds.has(e.id) && !lootContentIds.has(e.id),
  );
  for (const item of floorItems) {
    hotspots.push({
      key: item.id,
      label: item.name,
      kind: "item",
      ...(item.image !== undefined ? { image: item.image } : {}),
      actions: [
        { label: "Examine", kind: "examine", targetId: item.id },
        { label: "Take", kind: "intent", intent: { kind: "take", targetId: item.id } },
      ],
    });
  }

  return hotspots;
}

/**
 * Returns the action verbs available for an inventory item.
 *
 * - Unequipped: Examine, Equip, Use, Drop
 * - Equipped: Examine, Unequip, Use, Drop
 */
export function inventoryActions(item: ScopeEntity, equipped: boolean): ActionDescriptor[] {
  return [
    { label: "Examine", kind: "examine", targetId: item.id },
    equipped
      ? { label: "Unequip", kind: "intent", intent: { kind: "unequip", targetId: item.id } }
      : { label: "Equip", kind: "intent", intent: { kind: "equip", targetId: item.id } },
    { label: "Use", kind: "intent", intent: { kind: "use", targetId: item.id } },
    { label: "Drop", kind: "intent", intent: { kind: "drop", targetId: item.id } },
  ];
}
