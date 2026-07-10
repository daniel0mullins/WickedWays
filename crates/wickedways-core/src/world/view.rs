//! ViewModel projections — widened (sub-plan 3a).
//!
//! `ViewModel` / `view` (sub-plan 3a): item display, loot, inventory, scope,
//! occupant health, health/sanity status fields.
//!
//! Mirrors `packages/play-runtime/src/viewmodel.ts:60-167`.
use alloc::collections::BTreeSet;
use alloc::format;
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
use crate::world::snapshot::{CharacterKind, ItemSnapshot};
use crate::world::World;

/// The room fields shared by the widened ViewModel.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct ThinRoom {
    pub id: String,
    pub name: String,
    pub description: String,
    pub is_lit: bool,
}

/// A passable exit as the surface lists it. Mirrors `ExitView` (viewmodel.ts:27).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct ExitView {
    pub dir: crate::world::direction::Direction,
    pub to_name: String,
}

/// An impassable (locked) exit. Mirrors `LockedDoorView` (viewmodel.ts:28).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct LockedDoorView {
    pub name: String,
    pub dir: crate::world::direction::Direction,
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
    pub health: Option<f64>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub defeated: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub talkable: Option<bool>,
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
    pub location_name: String,
    pub turn: i64,
    pub max_turns: i64,
    pub health: f64,
    pub sanity: f64,
}

/// The widened ViewModel (sub-plan 3a).
///
/// `exits` / `lockedDoors` / `status.locationName` shipped in Phase-2 Task 6.
/// `defeated` on occupants shipped in sub-plan 4a.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct ViewModel {
    pub room: ThinRoom,
    pub exits: Vec<ExitView>,
    pub locked_doors: Vec<LockedDoorView>,
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
        defeated: None,
        talkable: None,
    })
}


impl World {
    /// Returns `true` if the character is currently KO.
    /// Mirrors `o.status.includes(Status.KO)` in `viewmodel.ts`.
    pub fn is_ko(&self, id: &crate::world::ids::CharacterId) -> bool {
        self.characters
            .get(id)
            .map(|c| c.afflictions.is_active(crate::world::afflictions::Status::Ko))
            .unwrap_or(false)
    }

    /// Mirrors `mob.ts:101-104` (`seesInDark === lightAverse`): a character sees in
    /// the dark iff it is light-averse. Read only when the actor acts (attack/loot in
    /// the dark); mobs don't act in Phase 1, so this is exercised by unit tests here
    /// and by the differential gate in sub-plan 6 (mob turns).
    pub fn sees_in_dark(&self, actor: &crate::world::ids::CharacterId) -> bool {
        self.characters.get(actor).and_then(|c| c.light_averse).unwrap_or(false)
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
    ///   BTreeMap iteration order, no dedup — matches the TS straight `.map`);
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

        let is_lit = self.is_lit(&room_id, cat);

        // ── exits / lockedDoors (Phase 2 parity) ───────────────────────────
        // Canonical order: alphabetical by direction key (BTreeMap iteration);
        // the TS oracle sorts identically (viewmodel.ts, Phase-2 ordering decision).
        let actor_view = self
            .character_view(&active_id, cat)
            .ok_or_else(|| ProceduralViolation("active character not found".into()))?;
        let mut exits: Vec<ExitView> = Vec::new();
        let mut locked_doors: Vec<LockedDoorView> = Vec::new();
        for (dir_key, exit_id) in &room_snap.exits {
            let exit = self
                .exits
                .get(exit_id)
                .ok_or_else(|| ProceduralViolation("exit missing".into()))?;
            let dir: crate::world::direction::Direction =
                serde_json::from_value(serde_json::Value::String(dir_key.clone()))
                    .map_err(|_| ProceduralViolation(format!("unknown direction key '{dir_key}'")))?;
            let passable = match &exit.behavior_key {
                None => true,
                Some(key) => {
                    // Resolve native FIRST, then scripted catalog behaviors —
                    // identical to the `go` path (movement.rs:104) so the view's
                    // classification matches the TS oracle's `exit.canPass(pc)`
                    // for both native and scripted (catalog) doors.
                    let resolved = crate::world::exits::resolve_exit_behavior(key, cat)
                        .ok_or_else(|| {
                            ProceduralViolation(format!(
                                "Exit behavior '{key}' is not registered."
                            ))
                        })?;
                    resolved.as_behavior().can_pass(&actor_view, &exit.state)
                }
            };
            if passable {
                let a = exit.endpoint_ids[0].clone();
                let b = exit.endpoint_ids[1].clone();
                let dest = if a == room_id { b } else { a };
                let to_name = self.rooms.get(&dest).map(|r| r.name.clone()).unwrap_or_default();
                exits.push(ExitView { dir, to_name });
            } else {
                locked_doors.push(LockedDoorView {
                    name: exit.name.clone().unwrap_or_else(|| String::from("door")),
                    dir,
                });
            }
        }

        // ── occupants ──────────────────────────────────────────────────────────
        let occupants: Vec<ScopeEntity> = room_snap
            .occupant_ids
            .iter()
            // Drop the active character, and any invisible occupant (a hidden NPC):
            // absent from `occupants` and, since `scope` reuses this vec, from `scope`.
            .filter(|id| {
                *id != &active_id && self.characters.get(id).is_none_or(|c| c.visible)
            })
            .map(|id| {
                let name = self
                    .characters
                    .get(id)
                    .map(|c| c.name.clone())
                    .unwrap_or_default();
                let health = self.effective_stat(id, StatType::Health, cat);
                let talkable = if self
                    .characters
                    .get(id)
                    .map(|c| c.kind == CharacterKind::Npc)
                    .unwrap_or(false)
                {
                    Some(true)
                } else {
                    None
                };
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
                    defeated: Some(self.is_ko(id)),
                    talkable,
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
                defeated: None,
                talkable: None,
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
            exits,
            locked_doors,
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
                location_name: room_snap.name.clone(),
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
    // ── widened ViewModel (sub-plan 3a) tests ─────────────────────────────────

    use crate::world::descriptor::{
        Catalog, ItemDescriptor, ItemProperties, ItemType, SlotKind,
    };
    use crate::world::ids::{CharacterId, ItemId, LootId, RoomId};
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
        Catalog { items, aliases, behaviors: Default::default(), formations: Default::default(), recipes: Default::default() }
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
            stats: Stats { energy: 2.0, sanity: 0.0, health: 3.0 },
            actions_per_round: 1,
            actions_this_round: 0,
            current_room_id: Some(start_room.clone()),
            inventory: InventorySnapshot { slots: 0, item_ids: alloc::vec![], key_ids: alloc::vec![] },
            equipment: BTreeMap::new(),
            history: alloc::vec![],
            archetype_immunities: alloc::vec![],
            afflictions: crate::world::afflictions::Afflictions::default(),
            archetype_id: None,
            origin: None,
            base_escape_chance: None,
            material_drops: None,
            light_averse: None,
            natural_attack: None,
            npc_behavior_key: None,
            npc_state: serde_json::Value::Null,
            visible: true,
        };

        // Character: PC with equipment
        let mut pc_equipment = BTreeMap::new();
        pc_equipment.insert("hand".into(), sword2_id.clone());

        let pc = CharacterSnapshot {
            kind: CharacterKind::Player,
            id: pc_id.clone(),
            name: "Heir".into(),
            stats: Stats { energy: 5.0, sanity: 7.0, health: 10.0 },
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
            archetype_immunities: alloc::vec![],
            afflictions: crate::world::afflictions::Afflictions::default(),
            archetype_id: None,
            origin: None,
            base_escape_chance: None,
            material_drops: None,
            light_averse: None,
            natural_attack: None,
            npc_behavior_key: None,
            npc_state: serde_json::Value::Null,
            visible: true,
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
            win_conditions: alloc::vec::Vec::new(),
            lose_conditions: alloc::vec::Vec::new(),
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
            rng: crate::world::rng::Rng::seeded(0),
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
    fn view_key_in_inventory_not_equippable_not_usable_droppable_true() {
        // TS `createKey` omits `droppable` (undefined); resolve_item sets droppable: None;
        // item_scope_entity computes None != Some(false) = true, so droppable = Some(true).
        let w = build_world_for_view();
        let cat = build_catalog();
        let v = w.view(&cat, &BTreeSet::new()).unwrap();

        let key = &v.inventory.keys[0];
        assert_eq!(key.name, "Brass Key");
        assert_eq!(key.kind, "item");
        assert_eq!(key.equippable, Some(false));
        assert_eq!(key.usable, Some(false));
        assert_eq!(key.droppable, Some(true));
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
        assert_eq!(wraith.health, Some(3.0));
        assert_eq!(wraith.kind, "occupant");
        assert_eq!(wraith.aliases, alloc::vec!["wraith"]);
    }

    #[test]
    fn view_omits_invisible_occupant_from_occupants_and_scope() {
        let mut w = build_world_for_view();
        // Hide the co-located "Wraith" occupant.
        w.characters.get_mut(&char_id("npc1")).unwrap().visible = false;
        let cat = build_catalog();
        let v = w.view(&cat, &BTreeSet::new()).unwrap();

        // Absent from occupants...
        assert!(
            v.occupants.iter().all(|o| o.name != "Wraith"),
            "an invisible occupant must not appear in occupants"
        );
        // ...and from scope (scope reuses the occupants vec).
        assert!(
            v.scope.iter().all(|e| e.name != "Wraith"),
            "an invisible occupant must not appear in scope"
        );

        // Sanity: a visible occupant is still present (regression guard).
        let visible = build_world_for_view().view(&cat, &BTreeSet::new()).unwrap();
        assert!(visible.occupants.iter().any(|o| o.name == "Wraith"));
    }

    #[test]
    fn view_status_health_and_sanity() {
        let w = build_world_for_view();
        let cat = build_catalog();
        let v = w.view(&cat, &BTreeSet::new()).unwrap();

        // PC: health=10, sanity=7, no health/sanity accessories
        assert_eq!(v.status.health, 10.0);
        assert_eq!(v.status.sanity, 7.0);
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

    /// Task 6: `defeated` on occupant (character) entities, not on items.
    ///
    /// - A healthy occupant → `defeated == Some(false)`
    /// - A KO occupant → `defeated == Some(true)`
    /// - An item entity → `defeated == None`
    #[test]
    fn view_occupant_defeated_field() {
        use crate::world::afflictions::Status;

        let mut w = build_world_for_view();
        let cat = build_catalog();

        // Healthy NPC → defeated: Some(false)
        {
            let v = w.view(&cat, &BTreeSet::new()).unwrap();
            let wraith = v.occupants.iter().find(|o| o.name == "Wraith").unwrap();
            assert_eq!(wraith.defeated, Some(false), "healthy occupant should have defeated=Some(false)");

            // item entity in scope → defeated: None
            let potion = v.scope.iter().find(|e| e.name == "Healing Potion").unwrap();
            assert_eq!(potion.defeated, None, "item entity should have defeated=None");
        }

        // KO the NPC → defeated: Some(true)
        {
            let npc_id = char_id("npc1");
            w.characters.get_mut(&npc_id).unwrap().afflictions.set_active(Status::Ko, true);
            let v = w.view(&cat, &BTreeSet::new()).unwrap();
            let wraith = v.occupants.iter().find(|o| o.name == "Wraith").unwrap();
            assert_eq!(wraith.defeated, Some(true), "KO occupant should have defeated=Some(true)");
        }
    }

    /// PnC "Talk" affordance: `talkable` is `Some(true)` for NPC occupants ONLY,
    /// and `None` (→ omitted) for mobs, players, and items — byte-parity with the
    /// TS oracle's conditional-spread emission.
    #[test]
    fn view_occupant_talkable_field() {
        let mut w = build_world_for_view();
        let cat = build_catalog();
        let npc_id = char_id("npc1");

        // Wraith is a Mob → talkable omitted (None).
        {
            let v = w.view(&cat, &BTreeSet::new()).unwrap();
            let wraith = v.occupants.iter().find(|o| o.name == "Wraith").unwrap();
            assert_eq!(wraith.talkable, None, "a mob occupant should have talkable=None");

            // item entity in scope → talkable None
            let potion = v.scope.iter().find(|e| e.name == "Healing Potion").unwrap();
            assert_eq!(potion.talkable, None, "item entity should have talkable=None");
        }

        // Turn Wraith into an NPC → talkable Some(true).
        {
            w.characters.get_mut(&npc_id).unwrap().kind = CharacterKind::Npc;
            let v = w.view(&cat, &BTreeSet::new()).unwrap();
            let wraith = v.occupants.iter().find(|o| o.name == "Wraith").unwrap();
            assert_eq!(wraith.talkable, Some(true), "an NPC occupant should have talkable=Some(true)");
            // and in scope too (scope reuses the occupants vec)
            let scoped = v.scope.iter().find(|e| e.name == "Wraith").unwrap();
            assert_eq!(scoped.talkable, Some(true));
        }
    }

    /// Add a second room "crypt" named "Crypt" to the standard view world so
    /// exits can point somewhere with a real destination name.
    fn add_crypt(w: &mut crate::world::World) {
        let crypt = crate::world::snapshot::RoomSnapshot {
            id: room_id("crypt"),
            name: "Crypt".into(),
            description: "A cold vault.".into(),
            exits: BTreeMap::new(),
            dark: false,
            spawn_modifier: 0,
            occupant_ids: alloc::vec![],
            loot_ids: alloc::vec![],
            material_cache_ids: alloc::vec![],
            light_source_ids: alloc::vec![],
            scenes: alloc::vec![],
        };
        w.rooms.insert(room_id("crypt"), crypt);
    }

    #[test]
    fn view_lists_passable_exits_alphabetically_with_destination_names() {
        use crate::world::direction::Direction;
        use crate::world::ids::ExitId;
        use crate::world::snapshot::ExitSnapshot;
        use crate::world::view::{ExitView, LockedDoorView};
        // Behavior-free exit from "start" to "Crypt". Insertion order (south then
        // north) is reversed vs. the emitted order to prove the BTreeMap ordering
        // (alphabetical by direction key), not authoring order, is emitted.
        let mut w = build_world_for_view();
        add_crypt(&mut w);
        w.exits.insert(ExitId("e1".into()), ExitSnapshot {
            id: ExitId("e1".into()),
            endpoint_ids: [room_id("start"), room_id("crypt")],
            behavior_key: None,
            name: None,
            state: Value::Null,
        });
        let room = w.rooms.get_mut(&room_id("start")).unwrap();
        room.exits.insert("south".into(), ExitId("e1".into()));
        room.exits.insert("north".into(), ExitId("e1".into()));

        let vm = w.view(&build_catalog(), &BTreeSet::new()).unwrap();
        assert_eq!(vm.locked_doors, alloc::vec![] as Vec<LockedDoorView>);
        assert_eq!(
            vm.exits,
            alloc::vec![
                ExitView { dir: Direction::North, to_name: "Crypt".into() },
                ExitView { dir: Direction::South, to_name: "Crypt".into() },
            ],
            "alphabetical by direction key"
        );
        assert_eq!(vm.status.location_name, vm.room.name);
    }

    #[test]
    fn keyed_door_without_key_lists_as_locked_door_with_name_fallback() {
        use crate::world::direction::Direction;
        use crate::world::ids::ExitId;
        use crate::world::snapshot::ExitSnapshot;
        use crate::world::view::{ExitView, LockedDoorView};
        // conformance:keyed-door is registered under cfg(test) (exits.rs:23-27);
        // locked state + no matching key on the PC → can_pass false.
        let mut w = build_world_for_view();
        add_crypt(&mut w);
        w.exits.insert(ExitId("door".into()), ExitSnapshot {
            id: ExitId("door".into()),
            endpoint_ids: [room_id("start"), room_id("crypt")],
            behavior_key: Some("conformance:keyed-door".into()),
            name: None, // → "door" fallback (viewmodel.ts:131 `exit.name ?? "door"`)
            state: json!({ "unlocked": false }),
        });
        w.rooms.get_mut(&room_id("start")).unwrap()
            .exits.insert("north".into(), ExitId("door".into()));

        let vm = w.view(&build_catalog(), &BTreeSet::new()).unwrap();
        assert_eq!(vm.exits, alloc::vec![] as Vec<ExitView>);
        assert_eq!(vm.locked_doors, alloc::vec![
            LockedDoorView { name: "door".into(), dir: Direction::North },
        ]);
    }

    #[test]
    fn sees_in_dark_follows_light_averse() {
        use crate::world::test_support::world_with_party;
        let mut w = world_with_party(&["pc", "mob"], 10);
        // A light-averse mob sees in the dark; a plain PC does not.
        w.characters.get_mut(&CharacterId("mob".into())).unwrap().light_averse = Some(true);
        assert!(w.sees_in_dark(&CharacterId("mob".into())));
        assert!(!w.sees_in_dark(&CharacterId("pc".into())));
    }
}
