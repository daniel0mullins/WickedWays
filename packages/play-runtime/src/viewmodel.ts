/**
 * ViewModel types over the GENERATED core bindings (single source of truth —
 * master-design invariant 1). The core never emits presentation images for
 * rooms/occupants (presentation is not serialized); GameSession.view() overlays
 * them host-side, hence the widened `image?: string` fields here.
 * The live-campaign view() implementation now lives in the Rust core
 * (world/view.rs); its frozen TS oracle copy is conformance/fixtures/oracle-view.ts.
 */
import type { ViewModel as CoreViewModel } from "../../../generated/bindings/ViewModel.ts";
import type { ScopeEntity as CoreScopeEntity } from "../../../generated/bindings/ScopeEntity.ts";
import type { LootView as CoreLootView } from "../../../generated/bindings/LootView.ts";
import type { ExitView } from "../../../generated/bindings/ExitView.ts";
import type { LockedDoorView } from "../../../generated/bindings/LockedDoorView.ts";
import type { Inventory as CoreInventory } from "../../../generated/bindings/Inventory.ts";
import type { StatusView as CoreStatusView } from "../../../generated/bindings/StatusView.ts";

export type ScopeKind = "occupant" | "item" | "loot";

/** Core ScopeEntity with the image narrowed to the string AssetRef surfaces use. */
export type ScopeEntity = Omit<CoreScopeEntity, "image" | "kind"> & {
  kind: ScopeKind;
  image?: string;
};
export type LootView = Omit<CoreLootView, "contents"> & { contents: ScopeEntity[] };

/** Core StatusView with the JSON-boundary counters as plain `number` — ts-rs
 *  types u64/usize as `bigint`, but `JSON.parse` yields JS numbers at runtime. */
export type StatusView = Omit<CoreStatusView, "turn" | "maxTurns"> & { turn: number; maxTurns: number };
/** Core Inventory widened to host scope entities; `slots` narrowed to `number`. */
export type Inventory = Omit<CoreInventory, "items" | "keys" | "slots"> & {
  items: ScopeEntity[];
  keys: ScopeEntity[];
  slots: number;
};
export type { ExitView, LockedDoorView };

export type ViewModel = Omit<CoreViewModel, "room" | "occupants" | "loot" | "scope" | "inventory" | "status" | "outcome"> & {
  room: CoreViewModel["room"] & { image?: string };
  occupants: ScopeEntity[];
  loot: LootView[];
  scope: ScopeEntity[];
  inventory: Inventory;
  status: StatusView;
  outcome: string;
};
