//! ViewModel projections — thin (sub-plan 2) and widened (sub-plan 3a).
//!
//! `ThinViewModel` / `view_thin` (sub-plan 2): room scalars, occupants (id/name/kind),
//! status turn/maxTurns, outcome, finished.
//!
//! `ViewModel` / `view` (sub-plan 3a): item display, loot, inventory, scope,
//! occupant health, health/sanity status fields.
//!
//! Mirrors `packages/play-runtime/src/viewmodel.ts:60-167`.
use alloc::collections::BTreeSet;
use alloc::string::String;
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

use crate::error::ProceduralViolation;
use crate::presentation::{AssetRef, CampaignOutcome};
use crate::stats::StatType;
use crate::world::descriptor::Catalog;
use crate::world::resolve::resolve_item;
use crate::world::snapshot::ItemSnapshot;
use crate::world::World;

/// The room fields populated in the thin slice.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct ThinRoom {
    pub id: String,
    pub name: String,
    pub description: String,
    pub is_lit: bool,
}

/// An occupant (non-active character) in the thin slice.
/// `kind` is always the literal string `"occupant"`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct ThinOccupant {
    pub id: String,
    pub name: String,
    pub kind: String,
}

/// Turn counters in the thin slice.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct ThinStatus {
    pub turn: i64,
    pub max_turns: i64,
}

/// The thin ViewModel — only the fields available in sub-plan 2.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct ThinViewModel {
    pub room: ThinRoom,
    pub occupants: Vec<ThinOccupant>,
    pub status: ThinStatus,
    pub outcome: CampaignOutcome,
    pub finished: bool,
}

// ─── sub-plan 3a: widened ViewModel ──────────────────────────────────────────

/// A named entity that can appear in the scope (occupant, item, loot container).
/// Mirrors `ScopeEntity` in `viewmodel.ts`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct ScopeEntity {
    pub id: String,
    pub name: String,
    pub aliases: Vec<String>,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub health: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional, type = "unknown"))]
    pub image: Option<AssetRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub equippable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub usable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub has_lore: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub droppable: Option<bool>,
}

/// A loot container with its resolved contents.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct LootView {
    pub id: String,
    pub description: String,
    pub opened: bool,
    pub contents: Vec<ScopeEntity>,
}

/// The player's inventory in the widened ViewModel.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct Inventory {
    pub items: Vec<ScopeEntity>,
    pub keys: Vec<ScopeEntity>,
    pub equipped_names: Vec<String>,
    pub slots: i64,
}

/// Full turn/health/sanity status for the widened ViewModel.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct StatusView {
    pub turn: i64,
    pub max_turns: i64,
    pub health: i64,
    pub sanity: i64,
}

/// The widened ViewModel (sub-plan 3a).
///
/// `exits` and `lockedDoors` are deferred to sub-plan 4/6.
/// `defeated` on occupants is deferred to sub-plan 4.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct ViewModel {
    pub room: ThinRoom,
    pub occupants: Vec<ScopeEntity>,
    pub loot: Vec<LootView>,
    pub inventory: Inventory,
    pub scope: Vec<ScopeEntity>,
    pub status: StatusView,
    pub outcome: CampaignOutcome,
    pub finished: bool,
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/// `aliasesFor(behaviorKey, name, aliases)` — mirror of `viewmodel.ts:aliasesFor`.
///
/// Returns a deduplicated list: lowercased `name` first, then any catalog alias
/// entries for `behavior_key`. If `behavior_key` is `None` (keys), returns just
/// the lowercased name.
fn aliases_for(behavior_key: Option<&str>, name: &str, catalog: &Catalog) -> Vec<String> {
    let name_lc = name.to_lowercase();
    let mut out: Vec<String> = alloc::vec![name_lc];
    if let Some(key) = behavior_key {
        if let Some(table_aliases) = catalog.aliases.get(key) {
            for a in table_aliases {
                // Catalog alias entries are pushed verbatim (NOT lowercased) —
                // mirrors TS `[...new Set([name.toLowerCase(), ...fromTable])]`
                // where fromTable is spread as-is.
                if !out.contains(a) {
                    out.push(a.clone());
                }
            }
        }
    }
    out
}

/// Resolve one item snapshot (item or key) to a `ScopeEntity`.
fn item_scope_entity(
    snap: &ItemSnapshot,
    cat: &Catalog,
) -> Result<ScopeEntity, ProceduralViolation> {
    let resolved = resolve_item(snap, cat)?;
    let behavior_key = match snap {
        ItemSnapshot::Item { behavior_key, .. } => Some(behavior_key.as_str()),
        ItemSnapshot::Key { .. } => None,
    };
    let aliases = aliases_for(behavior_key, &resolved.name, cat);
    Ok(ScopeEntity {
        id: resolved.id,
        name: resolved.name,
        aliases,
        kind: "item".into(),
        health: None,
        image: resolved.presentation.as_ref().and_then(|p| p.image.clone()),
        equippable: Some(resolved.properties.equippable),
        usable: Some(resolved.properties.usable),
        has_lore: Some(resolved.lore.is_some()),
        droppable: Some(resolved.properties.droppable != Some(false)),
    })
}


impl World {
    /// Build the thin ViewModel for the active character's current state.
    ///
    /// - Active character determined by `campaign.active_character_index` in `party_ids`.
    /// - `occupants` = room's `occupant_ids` minus the active character, each mapped to
    ///   `{ id, name, kind: "occupant" }`.
    /// - `status.turn` = `campaign.round`; `status.max_turns` = `campaign.max_rounds`.
    /// - `outcome` / `finished` mirror `campaign.outcome` and `outcome != Ongoing`.
    pub fn view_thin(&self) -> Result<ThinViewModel, ProceduralViolation> {
        let active_id = self.active_character_id()?;

        let room_id = self
            .characters
            .get(&active_id)
            .and_then(|c| c.current_room_id.clone())
            .ok_or_else(|| ProceduralViolation("active character has no current room".into()))?;

        let room_snap = self
            .rooms
            .get(&room_id)
            .ok_or_else(|| ProceduralViolation("current room not found in world".into()))?;

        let is_lit = self.is_lit(&room_id);

        let occupants: Vec<ThinOccupant> = room_snap
            .occupant_ids
            .iter()
            .filter(|id| *id != &active_id)
            .map(|id| {
                let name = self
                    .characters
                    .get(id)
                    .map(|c| c.name.clone())
                    .unwrap_or_default();
                ThinOccupant { id: id.0.clone(), name, kind: "occupant".into() }
            })
            .collect();

        let outcome = self.campaign.outcome;
        let finished = outcome != CampaignOutcome::Ongoing;

        Ok(ThinViewModel {
            room: ThinRoom {
                id: room_id.0.clone(),
                name: room_snap.name.clone(),
                description: room_snap.description.clone(),
                is_lit,
            },
            occupants,
            status: ThinStatus {
                turn: self.campaign.round,
                max_turns: self.campaign.max_rounds,
            },
            outcome,
            finished,
        })
    }

    /// Build the widened ViewModel (sub-plan 3a).
    ///
    /// Mirrors `view()` in `packages/play-runtime/src/viewmodel.ts:60-167`.
    ///
    /// - `occupants`: room occupants minus the active character, with `health`
    ///   from `effective_stat(occupant, Health, cat)`.
    /// - `loot`: each loot container, with `opened` from `opened_loot` and
    ///   `contents` resolved to `ScopeEntity`.
    /// - `inventory`: player's `item_ids` + `key_ids` as `ScopeEntity`;
    ///   `equipped_names` = names of items in the equipment slot map (in
    ///   BTreeMap iteration order, deduped preserving first occurrence);
    ///   `slots` from `inventory.slots`.
    /// - `scope` (order matches TS exactly):
    ///   occupants ++ loot-contents ++ inventory items ++ keys ++ loot containers.
    /// - `status`: `turn`, `max_turns`, `health`, `sanity` for active character.
    pub fn view(
        &self,
        cat: &Catalog,
        opened_loot: &BTreeSet<String>,
    ) -> Result<ViewModel, ProceduralViolation> {
        let active_id = self.active_character_id()?;

        let room_id = self
            .characters
            .get(&active_id)
            .and_then(|c| c.current_room_id.clone())
            .ok_or_else(|| ProceduralViolation("active character has no current room".into()))?;

        let room_snap = self
            .rooms
            .get(&room_id)
            .ok_or_else(|| ProceduralViolation("current room not found in world".into()))?;

        let is_lit = self.is_lit(&room_id);

        // ── occupants ──────────────────────────────────────────────────────────
        let occupants: Vec<ScopeEntity> = room_snap
            .occupant_ids
            .iter()
            .filter(|id| *id != &active_id)
            .map(|id| {
                let name = self
                    .characters
                    .get(id)
                    .map(|c| c.name.clone())
                    .unwrap_or_default();
                let health = self.effective_stat(id, StatType::Health, cat);
                ScopeEntity {
                    id: id.0.clone(),
                    name: name.clone(),
                    aliases: alloc::vec![name.to_lowercase()],
                    kind: "occupant".into(),
                    health: Some(health),
                    image: None,
                    equippable: None,
                    usable: None,
                    has_lore: None,
                    droppable: None,
                }
            })
            .collect();

        // ── loot ──────────────────────────────────────────────────────────────
        let active_char = self
            .characters
            .get(&active_id)
            .ok_or_else(|| ProceduralViolation("active character not found".into()))?;

        let loot: Vec<LootView> = room_snap
            .loot_ids
            .iter()
            .filter_map(|loot_id| self.loot.get(loot_id))
            .map(|container| {
                let opened = opened_loot.contains(&container.id.0);
                let contents: Vec<ScopeEntity> = container
                    .content_ids
                    .iter()
                    .filter_map(|item_id| self.items.get(item_id))
                    .filter_map(|snap| item_scope_entity(snap, cat).ok())
                    .collect();
                LootView {
                    id: container.id.0.clone(),
                    description: container.description.clone(),
                    opened,
                    contents,
                }
            })
            .collect();

        // ── inventory items ────────────────────────────────────────────────────
        let inv_items: Vec<ScopeEntity> = active_char
            .inventory
            .item_ids
            .iter()
            .filter_map(|item_id| self.items.get(item_id))
            .filter_map(|snap| item_scope_entity(snap, cat).ok())
            .collect();

        // ── inventory keys ─────────────────────────────────────────────────────
        let inv_keys: Vec<ScopeEntity> = active_char
            .inventory
            .key_ids
            .iter()
            .filter_map(|item_id| self.items.get(item_id))
            .filter_map(|snap| item_scope_entity(snap, cat).ok())
            .collect();

        // ── equipped_names (BTreeMap order, no dedup — matches TS straight map) ─
        let mut equipped_names: Vec<String> = Vec::new();
        for item_id in active_char.equipment.values() {
            if let Some(snap) = self.items.get(item_id) {
                if let Ok(resolved) = resolve_item(snap, cat) {
                    equipped_names.push(resolved.name);
                }
            }
        }

        // ── loot container scope entities ──────────────────────────────────────
        let loot_scope: Vec<ScopeEntity> = loot
            .iter()
            .map(|lv| ScopeEntity {
                id: lv.id.clone(),
                name: lv.description.clone(),
                aliases: alloc::vec![
                    "chest".into(),
                    "box".into(),
                    "drawer".into(),
                    "container".into(),
                ],
                kind: "loot".into(),
                health: None,
                image: None,
                equippable: None,
                usable: None,
                has_lore: None,
                droppable: None,
            })
            .collect();

        // ── scope (mirrors TS order exactly) ──────────────────────────────────
        // occupants ++ lootContentScope ++ items ++ keys ++ lootScope
        let loot_content_scope: Vec<ScopeEntity> =
            loot.iter().flat_map(|lv| lv.contents.clone()).collect();

        let mut scope: Vec<ScopeEntity> = Vec::new();
        scope.extend(occupants.clone());
        scope.extend(loot_content_scope);
        scope.extend(inv_items.clone());
        scope.extend(inv_keys.clone());
        scope.extend(loot_scope);

        // ── status ────────────────────────────────────────────────────────────
        let health = self.effective_stat(&active_id, StatType::Health, cat);
        let sanity = self.effective_stat(&active_id, StatType::Sanity, cat);

        let outcome = self.campaign.outcome;
        let finished = outcome != CampaignOutcome::Ongoing;

        Ok(ViewModel {
            room: ThinRoom {
                id: room_id.0.clone(),
                name: room_snap.name.clone(),
                description: room_snap.description.clone(),
                is_lit,
            },
            occupants,
            loot,
            inventory: Inventory {
                items: inv_items,
                keys: inv_keys,
                equipped_names,
                slots: active_char.inventory.slots,
            },
            scope,
            status: StatusView {
                turn: self.campaign.round,
                max_turns: self.campaign.max_rounds,
                health,
                sanity,
            },
            outcome,
            finished,
        })
    }
}

#[cfg(test)]
mod tests {
    use crate::presentation::CampaignOutcome;
    use crate::world::ids::CharacterId;
    use crate::world::test_support::world_two_rooms;

    #[test]
    fn view_thin_reports_room_status_and_outcome() {
        let w = world_two_rooms(false); // pc "Heir" in "start"="Start"
        let v = w.view_thin().unwrap();
        assert_eq!(v.room.name, "Start");
        assert!(v.room.is_lit);
        assert_eq!(v.status.turn, 0);
        assert_eq!(v.outcome, CampaignOutcome::Ongoing);
        assert!(!v.finished);
        assert!(v.occupants.is_empty()); // only the pc, filtered out
    }

    #[test]
    fn view_thin_room_id_and_description() {
        let w = world_two_rooms(false);
        let v = w.view_thin().unwrap();
        assert_eq!(v.room.id, "start");
        assert_eq!(v.status.max_turns, 20);
    }

    #[test]
    fn view_thin_finished_when_outcome_not_ongoing() {
        let mut w = world_two_rooms(false);
        w.campaign.outcome = CampaignOutcome::Won;
        let v = w.view_thin().unwrap();
        assert_eq!(v.outcome, CampaignOutcome::Won);
        assert!(v.finished);
    }

    #[test]
    fn view_thin_excludes_active_character_from_occupants() {
        let mut w = world_two_rooms(false);
        // Add a second character to the "start" room's occupant list
        let npc_id = CharacterId("npc1".into());
        use crate::world::snapshot::{CharacterKind, CharacterSnapshot, InventorySnapshot, Stats};
        use alloc::collections::BTreeMap;
        use serde_json::Value;
        let npc = CharacterSnapshot {
            kind: CharacterKind::Mob,
            id: npc_id.clone(),
            name: "Wraith".into(),
            stats: Stats { energy: 2, sanity: 0, health: 3 },
            actions_per_round: 1,
            actions_this_round: 0,
            current_room_id: Some(crate::world::ids::RoomId("start".into())),
            inventory: InventorySnapshot { slots: 0, item_ids: alloc::vec![], key_ids: alloc::vec![] },
            equipment: BTreeMap::new(),
            history: alloc::vec![],
            archetype_immunities: Value::Array(alloc::vec![]),
            afflictions: serde_json::json!({ "active": {}, "turnsActive": {}, "shakenOff": [], "immunity": {} }),
            archetype_id: None,
            origin: None,
            base_escape_chance: None,
            material_drops: None,
            light_averse: None,
            natural_attack: None,
            npc_behavior_key: None,
        };
        w.characters.insert(npc_id.clone(), npc);
        if let Some(room) = w.rooms.get_mut(&crate::world::ids::RoomId("start".into())) {
            room.occupant_ids.push(npc_id.clone());
        }

        let v = w.view_thin().unwrap();
        assert_eq!(v.occupants.len(), 1);
        assert_eq!(v.occupants[0].id, "npc1");
        assert_eq!(v.occupants[0].name, "Wraith");
        assert_eq!(v.occupants[0].kind, "occupant");
    }

    #[test]
    fn view_thin_dark_room_is_not_lit() {
        let mut w = world_two_rooms(false);
        // Make the start room dark
        if let Some(room) = w.rooms.get_mut(&crate::world::ids::RoomId("start".into())) {
            room.dark = true;
        }
        let v = w.view_thin().unwrap();
        assert!(!v.room.is_lit);
    }

    // ── widened ViewModel (sub-plan 3a) tests ─────────────────────────────────

    use crate::world::descriptor::{
        Catalog, ItemDescriptor, ItemProperties, ItemType, SlotKind,
    };
    use crate::world::ids::{ItemId, LootId, RoomId};
    use crate::world::snapshot::{
        CharacterKind, CharacterSnapshot, InventorySnapshot, LootSnapshot, Stats,
    };
    use crate::stats::StatType;
    use alloc::collections::{BTreeMap, BTreeSet};
    use serde_json::{json, Value};

    fn item_id(s: &str) -> ItemId {
        serde_json::from_value(json!(s)).unwrap()
    }

    fn loot_id(s: &str) -> LootId {
        serde_json::from_value(json!(s)).unwrap()
    }

    fn room_id(s: &str) -> RoomId {
        RoomId(s.into())
    }

    fn char_id(s: &str) -> CharacterId {
        CharacterId(s.into())
    }

    fn sword_descriptor() -> ItemDescriptor {
        ItemDescriptor {
            name: "Iron Sword".into(),
            r#type: ItemType::Weapon,
            stat: StatType::Health,
            modifier: 3,
            properties: ItemProperties {
                equippable: true,
                equipped: false,
                destroyable: true,
                usable: false,
                droppable: None,
            },
            slot: Some(SlotKind::Hand),
            two_handed: None,
            emits_light: None,
            max_durability: Some(8),
            lore: Some("A trusty blade.".into()),
            presentation: None,
            key_code: None,
            consume_on_use: None,
            recipe: json!({}),
            teaches: json!(null),
            immunities: json!([]),
            grants_immunity: json!(null),
        }
    }

    fn potion_descriptor() -> ItemDescriptor {
        ItemDescriptor {
            name: "Healing Potion".into(),
            r#type: ItemType::Consumable,
            stat: StatType::Health,
            modifier: 2,
            properties: ItemProperties {
                equippable: false,
                equipped: false,
                destroyable: false,
                usable: true,
                droppable: Some(false), // not droppable
            },
            slot: None,
            two_handed: None,
            emits_light: None,
            max_durability: None,
            lore: None,
            presentation: None,
            key_code: None,
            consume_on_use: None,
            recipe: json!({}),
            teaches: json!(null),
            immunities: json!([]),
            grants_immunity: json!(null),
        }
    }

    fn build_catalog() -> Catalog {
        let mut items = BTreeMap::new();
        items.insert("items/sword".into(), sword_descriptor());
        items.insert("items/potion".into(), potion_descriptor());
        let mut aliases: BTreeMap<alloc::string::String, alloc::vec::Vec<alloc::string::String>> = BTreeMap::new();
        aliases.insert("items/sword".into(), alloc::vec!["sword".into(), "blade".into()]);
        Catalog { items, aliases }
    }

    /// Build a world that has:
    /// - pc "Heir" (stats: energy=5, sanity=7, health=10) in room "start"
    /// - npc "Wraith" (health=3) in room "start"
    /// - room "start" has one loot container "chest1" with sword item "sword-1"
    /// - pc inventory has "potion-1" and key "key-1"
    /// - pc has "sword-2" equipped in "hand" slot
    fn build_world_for_view() -> crate::world::World {
        use crate::world::snapshot::ItemSnapshot;
        // Keys are ItemSnapshot::Key variant — no separate type
        let pc_id = char_id("pc");
        let npc_id = char_id("npc1");
        let start_room = room_id("start");
        let chest_id = loot_id("chest1");
        let sword1_id = item_id("sword-1");  // in loot chest
        let sword2_id = item_id("sword-2");  // equipped by pc
        let potion1_id = item_id("potion-1"); // in inventory
        let key1_id = item_id("key-1");       // key in inventory

        // Character: NPC
        let npc = CharacterSnapshot {
            kind: CharacterKind::Mob,
            id: npc_id.clone(),
            name: "Wraith".into(),
            stats: Stats { energy: 2, sanity: 0, health: 3 },
            actions_per_round: 1,
            actions_this_round: 0,
            current_room_id: Some(start_room.clone()),
            inventory: InventorySnapshot { slots: 0, item_ids: alloc::vec![], key_ids: alloc::vec![] },
            equipment: BTreeMap::new(),
            history: alloc::vec![],
            archetype_immunities: Value::Array(alloc::vec![]),
            afflictions: json!({ "active": {}, "turnsActive": {}, "shakenOff": [], "immunity": {} }),
            archetype_id: None,
            origin: None,
            base_escape_chance: None,
            material_drops: None,
            light_averse: None,
            natural_attack: None,
            npc_behavior_key: None,
        };

        // Character: PC with equipment
        let mut pc_equipment = BTreeMap::new();
        pc_equipment.insert("hand".into(), sword2_id.clone());

        let pc = CharacterSnapshot {
            kind: CharacterKind::Player,
            id: pc_id.clone(),
            name: "Heir".into(),
            stats: Stats { energy: 5, sanity: 7, health: 10 },
            actions_per_round: 3,
            actions_this_round: 0,
            current_room_id: Some(start_room.clone()),
            inventory: InventorySnapshot {
                slots: 6,
                item_ids: alloc::vec![potion1_id.clone()],
                key_ids: alloc::vec![key1_id.clone()],
            },
            equipment: pc_equipment,
            history: alloc::vec![],
            archetype_immunities: Value::Array(alloc::vec![]),
            afflictions: json!({ "active": {}, "turnsActive": {}, "shakenOff": [], "immunity": {} }),
            archetype_id: None,
            origin: None,
            base_escape_chance: None,
            material_drops: None,
            light_averse: None,
            natural_attack: None,
            npc_behavior_key: None,
        };

        // Room
        let room = crate::world::snapshot::RoomSnapshot {
            id: start_room.clone(),
            name: "Start".into(),
            description: "A dark corridor.".into(),
            exits: BTreeMap::new(),
            dark: false,
            spawn_modifier: 0,
            occupant_ids: alloc::vec![pc_id.clone(), npc_id.clone()],
            loot_ids: alloc::vec![chest_id.clone()],
            material_cache_ids: alloc::vec![],
            light_source_ids: alloc::vec![],
            scenes: alloc::vec![],
        };

        // Loot
        let chest = LootSnapshot {
            id: chest_id.clone(),
            description: "An old chest".into(),
            capacity: 4,
            content_ids: alloc::vec![sword1_id.clone()],
        };

        // Items
        let sword1_snap = ItemSnapshot::Item {
            id: sword1_id.clone(),
            behavior_key: "items/sword".into(),
            durability: Some(8),
            modifier: 3,
        };
        let sword2_snap = ItemSnapshot::Item {
            id: sword2_id.clone(),
            behavior_key: "items/sword".into(),
            durability: Some(6),
            modifier: 3,
        };
        let potion1_snap = ItemSnapshot::Item {
            id: potion1_id.clone(),
            behavior_key: "items/potion".into(),
            durability: None,
            modifier: 2,
        };
        let key1_snap = ItemSnapshot::Key {
            id: key1_id.clone(),
            name: "Brass Key".into(),
            key_code: "door-east".into(),
            consume_on_use: true,
        };

        // Campaign
        let campaign = crate::world::snapshot::CampaignCoreSnapshot {
            id: "test".into(),
            title: "Test".into(),
            max_rounds: 20,
            round: 3,
            started: true,
            outcome: crate::presentation::CampaignOutcome::Ongoing,
            outcome_reason: None,
            win_conditions: Value::Array(alloc::vec![]),
            lose_conditions: Value::Array(alloc::vec![]),
            timeout_narration: None,
            ended_narration: None,
            active_character_index: 0,
            party_ids: alloc::vec![pc_id.clone()],
            acted_this_round: alloc::vec![],
            gm_id: None,
            materials: json!({}),
            claims: alloc::vec![],
            encountered: alloc::vec![],
            known_recipes: alloc::vec![],
            archetypes: Value::Array(alloc::vec![]),
            action_sounds: json!({}),
            encounter_table: json!({"baseChance":0,"visited":[],"formations":[]}),
            chat_policy: json!({}),
            av_policy: json!({}),
            mechanics: alloc::vec![],
        };

        let mut characters = BTreeMap::new();
        characters.insert(pc_id, pc);
        characters.insert(npc_id, npc);

        let mut rooms = BTreeMap::new();
        rooms.insert(start_room, room);

        let mut items = BTreeMap::new();
        items.insert(sword1_id, sword1_snap);
        items.insert(sword2_id, sword2_snap);
        items.insert(potion1_id, potion1_snap);
        items.insert(key1_id, key1_snap);

        let mut loot = BTreeMap::new();
        loot.insert(chest_id, chest);

        crate::world::World {
            characters,
            rooms,
            items,
            loot,
            material_caches: BTreeMap::new(),
            exits: BTreeMap::new(),
            campaign,
            codex: Value::Array(alloc::vec![]),
        }
    }

    #[test]
    fn view_inventory_potion_scope_entity_equippable_usable_lore_droppable() {
        let w = build_world_for_view();
        let cat = build_catalog();
        let v = w.view(&cat, &BTreeSet::new()).unwrap();

        // Healing Potion: not equippable, usable, no lore, droppable:Some(false) => false
        let potion = v.inventory.items.iter().find(|i| i.name == "Healing Potion").unwrap();
        assert_eq!(potion.kind, "item");
        assert_eq!(potion.equippable, Some(false));
        assert_eq!(potion.usable, Some(true));
        assert_eq!(potion.has_lore, Some(false));
        assert_eq!(potion.droppable, Some(false)); // droppable: Some(false) => false
    }

    #[test]
    fn view_loot_sword_scope_entity_equippable_has_lore_droppable_none_is_true() {
        let w = build_world_for_view();
        let cat = build_catalog();
        let v = w.view(&cat, &BTreeSet::new()).unwrap();

        // Iron Sword in loot chest: droppable:None => true (None != Some(false)),
        // equippable:true, usable:false, has_lore:true (lore is Some("A trusty blade."))
        let sword = v.loot[0].contents.iter().find(|i| i.name == "Iron Sword").unwrap();
        assert_eq!(sword.kind, "item");
        assert_eq!(sword.equippable, Some(true));
        assert_eq!(sword.usable, Some(false));
        assert_eq!(sword.has_lore, Some(true));
        assert_eq!(sword.droppable, Some(true)); // droppable: None != Some(false) => true
    }

    #[test]
    fn view_item_aliases_include_name_and_catalog_entries() {
        let w = build_world_for_view();
        let cat = build_catalog();
        let v = w.view(&cat, &BTreeSet::new()).unwrap();

        // inventory has potion (no aliases in catalog for potion) — just lowercased name
        let potion = v.inventory.items.iter().find(|i| i.name == "Healing Potion").unwrap();
        assert_eq!(potion.aliases, alloc::vec!["healing potion"]);
    }

    #[test]
    fn view_loot_content_has_aliases_from_catalog() {
        let w = build_world_for_view();
        let cat = build_catalog();
        let v = w.view(&cat, &BTreeSet::new()).unwrap();

        // sword in the chest has catalog aliases
        let loot = &v.loot[0];
        let sword = &loot.contents[0];
        assert_eq!(sword.name, "Iron Sword");
        // aliases: lowercased name first, then catalog entries (sword, blade)
        // "iron sword" is first, then "sword" (if not duplicate), then "blade"
        assert_eq!(sword.aliases[0], "iron sword");
        assert!(sword.aliases.contains(&"sword".into()));
        assert!(sword.aliases.contains(&"blade".into()));
        // "sword" should not appear twice even if in catalog and name-lower would match
        let count = sword.aliases.iter().filter(|a| a.as_str() == "sword").count();
        assert_eq!(count, 1);
    }

    #[test]
    fn view_key_in_inventory_not_equippable_not_usable_not_droppable() {
        let w = build_world_for_view();
        let cat = build_catalog();
        let v = w.view(&cat, &BTreeSet::new()).unwrap();

        let key = &v.inventory.keys[0];
        assert_eq!(key.name, "Brass Key");
        assert_eq!(key.kind, "item");
        assert_eq!(key.equippable, Some(false));
        assert_eq!(key.usable, Some(false));
        assert_eq!(key.droppable, Some(false));
    }

    #[test]
    fn view_loot_opened_reflects_opened_loot_set() {
        let w = build_world_for_view();
        let cat = build_catalog();

        let closed = w.view(&cat, &BTreeSet::new()).unwrap();
        assert!(!closed.loot[0].opened);

        let mut opened_set = BTreeSet::new();
        opened_set.insert("chest1".into());
        let opened = w.view(&cat, &opened_set).unwrap();
        assert!(opened.loot[0].opened);
    }

    #[test]
    fn view_loot_description_and_contents() {
        let w = build_world_for_view();
        let cat = build_catalog();
        let v = w.view(&cat, &BTreeSet::new()).unwrap();

        assert_eq!(v.loot[0].description, "An old chest");
        assert_eq!(v.loot[0].id, "chest1");
        assert_eq!(v.loot[0].contents.len(), 1);
        assert_eq!(v.loot[0].contents[0].name, "Iron Sword");
    }

    #[test]
    fn view_inventory_equipped_names() {
        let w = build_world_for_view();
        let cat = build_catalog();
        let v = w.view(&cat, &BTreeSet::new()).unwrap();

        // PC has sword-2 equipped in "hand"
        assert_eq!(v.inventory.equipped_names, alloc::vec!["Iron Sword"]);
        assert_eq!(v.inventory.slots, 6);
    }

    #[test]
    fn view_occupant_has_health() {
        let w = build_world_for_view();
        let cat = build_catalog();
        let v = w.view(&cat, &BTreeSet::new()).unwrap();

        // The npc "Wraith" (health=3, no equipment) should appear in occupants
        let wraith = v.occupants.iter().find(|o| o.name == "Wraith").unwrap();
        assert_eq!(wraith.health, Some(3));
        assert_eq!(wraith.kind, "occupant");
        assert_eq!(wraith.aliases, alloc::vec!["wraith"]);
    }

    #[test]
    fn view_status_health_and_sanity() {
        let w = build_world_for_view();
        let cat = build_catalog();
        let v = w.view(&cat, &BTreeSet::new()).unwrap();

        // PC: health=10, sanity=7, no health/sanity accessories
        assert_eq!(v.status.health, 10);
        assert_eq!(v.status.sanity, 7);
        assert_eq!(v.status.turn, 3);
        assert_eq!(v.status.max_turns, 20);
    }

    #[test]
    fn view_scope_order_matches_ts() {
        let w = build_world_for_view();
        let cat = build_catalog();
        let v = w.view(&cat, &BTreeSet::new()).unwrap();

        // Scope order: occupants ++ loot-contents ++ inv-items ++ keys ++ loot-containers
        // We have: 1 occupant (Wraith), 1 loot content (Iron Sword in chest), 1 inv item (Healing Potion),
        //          1 key (Brass Key), 1 loot container (chest1)
        assert_eq!(v.scope.len(), 5);
        assert_eq!(v.scope[0].kind, "occupant");  // Wraith
        assert_eq!(v.scope[0].name, "Wraith");
        assert_eq!(v.scope[1].kind, "item");       // Iron Sword from chest
        assert_eq!(v.scope[1].name, "Iron Sword");
        assert_eq!(v.scope[2].kind, "item");       // Healing Potion from inventory
        assert_eq!(v.scope[2].name, "Healing Potion");
        assert_eq!(v.scope[3].kind, "item");       // Brass Key
        assert_eq!(v.scope[3].name, "Brass Key");
        assert_eq!(v.scope[4].kind, "loot");       // chest container
        assert_eq!(v.scope[4].name, "An old chest");
        assert_eq!(v.scope[4].aliases, alloc::vec!["chest", "box", "drawer", "container"]);
    }
}
