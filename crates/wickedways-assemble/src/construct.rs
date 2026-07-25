//! The construct pass (`src/lib/authoring/assembler.ts:170-359`).
//!
//! Order is load-bearing. Two orderings matter and they are DIFFERENT:
//!   * The *assembler* declaration order (`assembler.ts`) governs which entities
//!     exist and how ids/state are minted (mechanics run in declared order, etc.).
//!   * The snapshot's `Vec` ordering is the *serializer* traversal order
//!     (`src/lib/serialization/serializer.ts`), NOT the declaration order — the
//!     six entity arrays (`rooms`, `exits`, `characters`, `items`, `loot`,
//!     `materialCaches`) come out in BFS/first-encounter order. We reproduce that
//!     traversal exactly, because the byte-parity gate compares arrays by order.
//!
//! No randomness. No `HashMap`/`HashSet`. No panics/`unwrap`/`expect`.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Value};

use wickedways_core::presentation::CampaignOutcome;
use wickedways_core::world::afflictions::Afflictions;
use wickedways_core::world::descriptor::{Catalog, ItemType};
use wickedways_core::world::ids::{CharacterId, ExitId, ItemId, LootId, MaterialCacheId, RoomId};
use wickedways_core::world::snapshot::{
    CampaignCoreSnapshot, CampaignSnapshot, CharacterKind, CharacterSnapshot, ExitSnapshot,
    InventorySnapshot, ItemSnapshot, LootSnapshot, MaterialCacheSnapshot, MechanicSnapshot,
    RoomSnapshot, SceneSnapshot, VictoryConditionSnapshot, SCHEMA_VERSION,
};

use crate::description::{CampaignDescription, ConditionEntry, MobDef, NpcDef};
use crate::error::AssembleError;
use crate::ids;

/// `description + catalog -> CampaignSnapshot` (player-less, pre-begin).
///
/// Seating (party members, GM, `started`) is Task 7; this produces
/// `party_ids: []`, `gm_id: None`, `started: false`, `round: 0`.
pub fn construct(
    desc: &CampaignDescription,
    catalog: &Catalog,
) -> Result<CampaignSnapshot, AssembleError> {
    // ---- assembler.ts:171-198 — campaign-core scalar fields ----
    let win_conditions = desc.win_conditions.iter().map(condition_snapshot).collect();
    let lose_conditions = desc
        .lose_conditions
        .iter()
        .map(condition_snapshot)
        .collect();

    // Mechanics, in declared order. State == `catalog.behaviors[key].script.init`
    // (the scripted-ops DSL carries as data what TS computed via `initialState`).
    let mechanics: Vec<MechanicSnapshot> = desc
        .mechanics
        .iter()
        .map(|m| MechanicSnapshot {
            key: m.key.clone(),
            state: mechanic_init(catalog, &m.key),
        })
        .collect();

    // ---- Intermediate build structures (declaration order) ----
    // Rooms in declaration order; each accumulates its exits/occupants/loot/etc.
    let mut rooms: Vec<RoomBuild> = desc
        .rooms
        .iter()
        .map(|r| RoomBuild {
            id: ids::room_id(&r.name),
            name: r.name.clone(),
            description: r.description.clone(),
            dark: r.dark.unwrap_or(false),
            spawn_modifier: r.spawn_modifier.unwrap_or(1),
            exits: Vec::new(),
            occupant_ids: Vec::new(),
            loot: Vec::new(),
            caches: Vec::new(),
            light_items: Vec::new(),
            scenes: Vec::new(),
        })
        .collect();
    let room_index: BTreeMap<String, usize> = rooms
        .iter()
        .enumerate()
        .map(|(i, rb)| (rb.name.clone(), i))
        .collect();

    // Every character we build, keyed by id; only room occupants get serialized.
    let mut char_builds: BTreeMap<CharacterId, CharBuild> = BTreeMap::new();

    // caches (assembler.ts:211-216) — attached to their room below.
    // loot (assembler.ts:218-229) — box + contents, placed in its room.
    for l in &desc.loot {
        let Some(&idx) = room_index.get(&l.room) else {
            continue;
        };
        let box_id = ids::loot_id(&l.name);
        let mut contents: Vec<ItemSnapshot> = Vec::new();
        for (i, key) in l.items.iter().enumerate() {
            if let Some(snap) = item_snapshot(catalog, key, ids::loot_item_id(&l.name, i)) {
                contents.push(snap);
            }
        }
        let capacity = contents.len() as i64 + 2;
        rooms[idx].loot.push(LootBuild {
            snapshot: LootSnapshot {
                id: LootId(box_id),
                description: l.description.clone().unwrap_or_else(|| l.name.clone()),
                capacity,
                content_ids: contents.iter().map(|it| item_id(it).clone()).collect(),
            },
            contents,
        });
    }

    // caches (assembler.ts:211-216) — deposited into their room.
    for c in &desc.caches {
        let Some(&idx) = room_index.get(&c.room) else {
            continue;
        };
        rooms[idx].caches.push(MaterialCacheSnapshot {
            id: MaterialCacheId(ids::cache_id(&c.name)),
            contents: serde_json::to_value(&c.materials).unwrap_or_else(|_| json!({})),
            depleted: false,
        });
    }

    // room light sources (assembler.ts:249-253).
    for r in &desc.rooms {
        let Some(&idx) = room_index.get(&r.name) else {
            continue;
        };
        for (i, key) in r.lights.iter().enumerate() {
            if let Some(snap) = item_snapshot(catalog, key, ids::room_light_id(&r.name, i)) {
                rooms[idx].light_items.push(snap);
            }
        }
    }

    // mobs (assembler.ts:231-242) built, then wired into rooms (assembler.ts:269-273).
    // A mob with no room is never placed => unreachable => not serialized.
    for m in &desc.mobs {
        let Some(room) = &m.room else { continue };
        let Some(&idx) = room_index.get(room) else {
            continue;
        };
        let build = build_mob(m, catalog, &rooms[idx].id);
        rooms[idx].occupant_ids.push(build.snapshot.id.clone());
        char_builds.insert(build.snapshot.id.clone(), build);
    }

    // npcs (assembler.ts:277-301) — placed AFTER mobs, so a shared room lists
    // mobs before npcs in occupant order.
    for n in &desc.npcs {
        let Some(room) = &n.room else { continue };
        let Some(&idx) = room_index.get(room) else {
            continue;
        };
        let build = build_npc(n, catalog, &rooms[idx].id);
        rooms[idx].occupant_ids.push(build.snapshot.id.clone());
        char_builds.insert(build.snapshot.id.clone(), build);
    }

    // exits (assembler.ts:308-333) — dedup by unordered room-id pair; the FIRST
    // declaration for a pair wins (its from/to fix `endpointIds`).
    let mut exit_snaps: BTreeMap<String, ExitSnapshot> = BTreeMap::new();
    let mut wired: BTreeSet<String> = BTreeSet::new();
    for e in &desc.exits {
        let (Some(&from_idx), Some(&to_idx)) = (room_index.get(&e.from), room_index.get(&e.to))
        else {
            continue;
        };
        let from_id = rooms[from_idx].id.clone();
        let to_id = rooms[to_idx].id.clone();
        let mut pair = [from_id.clone(), to_id.clone()];
        pair.sort();
        let pair_key = format!("{}|{}", pair[0], pair[1]);
        if !wired.insert(pair_key) {
            continue;
        }
        let exit_id = ids::exit_id(&e.from, &e.to);
        exit_snaps.insert(
            exit_id.clone(),
            ExitSnapshot {
                id: ExitId(exit_id.clone()),
                endpoint_ids: [RoomId(from_id.clone()), RoomId(to_id.clone())],
                behavior_key: e.behavior_key.clone(),
                name: e.name.clone(),
                state: e.initial_state.clone().unwrap_or_else(|| json!({})),
            },
        );
        rooms[from_idx]
            .exits
            .push((e.direction.clone(), ExitId(exit_id.clone())));
        if !e.one_way.unwrap_or(false) {
            rooms[to_idx]
                .exits
                .push((reverse_direction(&e.direction), ExitId(exit_id.clone())));
        }
    }

    // scenes (assembler.ts:336-347) — registered on their room in declared order.
    for s in &desc.scenes {
        let Some(&idx) = room_index.get(&s.room) else {
            continue;
        };
        rooms[idx].scenes.push(SceneSnapshot {
            id: ids::scene_id(&s.room, &s.key, s.phase.as_deref()),
            behavior_key: s.key.clone(),
            phase: s.phase.clone().unwrap_or_else(|| "enter".to_string()),
            state: s.initial_state.clone().unwrap_or_else(|| json!({})),
        });
    }

    // ---- Serializer traversal (serializer.ts) — produces the ordered Vecs ----
    // Room BFS is seeded with every room in declaration order, so processing
    // order == declaration order.
    let room_snaps: Vec<RoomSnapshot> = rooms.iter().map(RoomBuild::to_snapshot).collect();

    // exits[]: first-encounter order across rooms, then each room's exits in
    // insertion order (serializer.ts:83-89).
    let mut exits: Vec<ExitSnapshot> = Vec::new();
    let mut seen_exits: BTreeSet<String> = BTreeSet::new();
    for rb in &rooms {
        for (_dir, id) in &rb.exits {
            if seen_exits.insert(id.0.clone()) {
                if let Some(snap) = exit_snaps.get(&id.0) {
                    exits.push(snap.clone());
                }
            }
        }
    }

    // characters[]: room-occupant discovery order (party is empty here).
    let mut char_order: Vec<CharacterId> = Vec::new();
    let mut seen_chars: BTreeSet<CharacterId> = BTreeSet::new();
    for rb in &rooms {
        for occ in &rb.occupant_ids {
            if seen_chars.insert(occ.clone()) {
                char_order.push(occ.clone());
            }
        }
    }
    let characters: Vec<CharacterSnapshot> = char_order
        .iter()
        .filter_map(|id| char_builds.get(id).map(|cb| cb.snapshot.clone()))
        .collect();

    // loot[] + materialCaches[]: room order, per-room insertion order.
    let mut loot: Vec<LootSnapshot> = Vec::new();
    let mut material_caches: Vec<MaterialCacheSnapshot> = Vec::new();
    for rb in &rooms {
        for lb in &rb.loot {
            loot.push(lb.snapshot.clone());
        }
        for c in &rb.caches {
            material_caches.push(c.clone());
        }
    }

    // items[]: (1) during room BFS — each room's loot contents then light sources;
    // (2) after rooms — each character's inventory items, keys, then equipment.
    let mut items: Vec<ItemSnapshot> = Vec::new();
    let mut seen_items: BTreeSet<String> = BTreeSet::new();
    let mut add_item = |items: &mut Vec<ItemSnapshot>, snap: &ItemSnapshot| {
        if seen_items.insert(item_id(snap).0.clone()) {
            items.push(snap.clone());
        }
    };
    for rb in &rooms {
        for lb in &rb.loot {
            for it in &lb.contents {
                add_item(&mut items, it);
            }
        }
        for it in &rb.light_items {
            add_item(&mut items, it);
        }
    }
    for id in &char_order {
        if let Some(cb) = char_builds.get(id) {
            for it in &cb.item_snaps {
                add_item(&mut items, it);
            }
            for it in &cb.key_snaps {
                add_item(&mut items, it);
            }
            for it in &cb.equip_snaps {
                add_item(&mut items, it);
            }
        }
    }

    // materials pool + claims (assembler.ts:354-357 -> Campaign.claimMaterials).
    let mut materials: BTreeMap<String, i64> = BTreeMap::new();
    let mut claims: Vec<String> = Vec::new();
    let mut claimed: BTreeSet<String> = BTreeSet::new();
    for entry in &desc.materials {
        if claimed.insert(entry.source.clone()) {
            claims.push(entry.source.clone());
            for (component, qty) in &entry.map {
                *materials.entry(component.clone()).or_insert(0) += *qty;
            }
        }
    }

    // encounterTable (assembler.ts:190 + EncounterTable[SERIALIZE]).
    let encounter_table = json!({
        "baseChance": desc.opts.base_encounter_chance.unwrap_or(20),
        "visited": [],
        "formations": desc.formations.iter().map(|f| json!({
            "behaviorKey": f.key,
            "weight": f.weight.unwrap_or(1),
        })).collect::<Vec<Value>>(),
    });

    let campaign = CampaignCoreSnapshot {
        id: ids::campaign_id(&desc.title),
        title: desc.title.clone(),
        max_rounds: desc.opts.max_rounds.unwrap_or(100),
        round: 0,
        started: false,
        outcome: CampaignOutcome::Ongoing,
        outcome_reason: None,
        win_conditions,
        lose_conditions,
        timeout_narration: desc
            .timeout_narration
            .clone()
            .and_then(|v| serde_json::from_value(v).ok()),
        ended_narration: desc
            .ended_narration
            .clone()
            .and_then(|v| serde_json::from_value(v).ok()),
        active_character_index: 0,
        party_ids: Vec::new(),
        acted_this_round: Vec::new(),
        gm_id: None,
        materials: serde_json::to_value(&materials).unwrap_or_else(|_| json!({})),
        claims,
        encountered: Vec::new(),
        // `knownRecipes` is populated straight from `desc.recipes` (the declared keys).
        // Recipe metadata (outputName/materials) for the codex is resolved separately
        // below from `catalog.recipes`; recipe-key *validation* is deferred to G2.
        known_recipes: desc.recipes.clone(),
        archetypes: serde_json::to_value(&desc.archetypes).unwrap_or_else(|_| json!([])),
        action_sounds: json!({}),
        encounter_table,
        chat_policy: desc.chat.clone().unwrap_or_else(default_chat_policy),
        av_policy: desc.av.clone().unwrap_or_else(default_av_policy),
        mechanics,
    };

    // Genesis codex: one recipe entry per declared recipe key (declaration
    // order), resolving `outputName`/`materials` from `catalog.recipes` (the
    // registry metadata the exporter now carries). `firstSeen` is `{round:0}`
    // only — the party/room discovery fields belong to seating's codex (Task 7),
    // appended after these. An unregistered recipe key is skipped (trust
    // boundary), not a panic.
    let codex = Value::Array(
        desc.recipes
            .iter()
            .filter_map(|key| {
                catalog.recipes.get(key).map(|meta| {
                    json!({
                        "kind": "recipe",
                        "key": key,
                        "snapshot": {
                            "id": meta.id,
                            "outputName": meta.output_name,
                            "materials": meta.materials,
                        },
                        "firstSeen": { "round": 0 },
                    })
                })
            })
            .collect(),
    );

    Ok(CampaignSnapshot {
        schema_version: SCHEMA_VERSION,
        campaign,
        rooms: room_snaps,
        exits,
        characters,
        items,
        loot,
        material_caches,
        codex,
    })
}

// ---------------------------------------------------------------------------
// Per-group helpers
// ---------------------------------------------------------------------------

/// Intermediate room accumulator (declaration order).
struct RoomBuild {
    id: String,
    name: String,
    description: String,
    dark: bool,
    spawn_modifier: i64,
    /// (direction, exitId) in insertion order.
    exits: Vec<(String, ExitId)>,
    occupant_ids: Vec<CharacterId>,
    loot: Vec<LootBuild>,
    caches: Vec<MaterialCacheSnapshot>,
    light_items: Vec<ItemSnapshot>,
    scenes: Vec<SceneSnapshot>,
}

impl RoomBuild {
    fn to_snapshot(&self) -> RoomSnapshot {
        RoomSnapshot {
            id: RoomId(self.id.clone()),
            name: self.name.clone(),
            description: self.description.clone(),
            exits: self.exits.iter().cloned().collect(),
            dark: self.dark,
            spawn_modifier: self.spawn_modifier,
            occupant_ids: self.occupant_ids.clone(),
            loot_ids: self.loot.iter().map(|lb| lb.snapshot.id.clone()).collect(),
            material_cache_ids: self.caches.iter().map(|c| c.id.clone()).collect(),
            light_source_ids: self
                .light_items
                .iter()
                .map(|it| item_id(it).clone())
                .collect(),
            scenes: self.scenes.clone(),
        }
    }
}

struct LootBuild {
    snapshot: LootSnapshot,
    contents: Vec<ItemSnapshot>,
}

/// A character plus the ordered item snapshots it holds (for the items[] pass).
struct CharBuild {
    snapshot: CharacterSnapshot,
    item_snaps: Vec<ItemSnapshot>,
    key_snaps: Vec<ItemSnapshot>,
    equip_snaps: Vec<ItemSnapshot>,
}

/// `campaign.mechanics[i].state` == `catalog.behaviors[key].script.init`.
/// Verified against goldens: dread -> {}, storyteller -> {"seen":{}}.
fn mechanic_init(catalog: &Catalog, key: &str) -> Value {
    catalog
        .behaviors
        .get(key)
        .and_then(|b| serde_json::to_value(b).ok())
        .and_then(|v| v.get("script").and_then(|s| s.get("init")).cloned())
        .unwrap_or_else(|| json!({}))
}

fn condition_snapshot(c: &ConditionEntry) -> VictoryConditionSnapshot {
    VictoryConditionSnapshot {
        key: c.key.clone(),
        narration: c
            .narration
            .clone()
            .and_then(|v| serde_json::from_value(v).ok()),
    }
}

/// Build an `ItemSnapshot` from a catalog descriptor. A `key`-typed descriptor
/// becomes the `Key` variant; everything else the `Item` variant (a fresh item's
/// `durability` starts at `maxDurability`). Returns `None` only if the key is
/// absent from the catalog (validation guarantees it is not, in practice).
fn item_snapshot(catalog: &Catalog, key: &str, id: String) -> Option<ItemSnapshot> {
    let d = catalog.items.get(key)?;
    Some(if matches!(d.r#type, ItemType::Key) {
        ItemSnapshot::Key {
            id: ItemId(id),
            name: d.name.clone(),
            key_code: d.key_code.clone().unwrap_or_default(),
            consume_on_use: d.consume_on_use.unwrap_or(false),
        }
    } else {
        ItemSnapshot::Item {
            id: ItemId(id),
            behavior_key: key.to_string(),
            durability: d.max_durability,
            modifier: d.modifier,
        }
    })
}

/// The item id, regardless of variant.
fn item_id(snap: &ItemSnapshot) -> &ItemId {
    match snap {
        ItemSnapshot::Item { id, .. } => id,
        ItemSnapshot::Key { id, .. } => id,
    }
}

fn build_mob(m: &MobDef, catalog: &Catalog, room_id: &str) -> CharBuild {
    let mut item_snaps = Vec::new();
    let mut key_snaps = Vec::new();
    let mut item_ids = Vec::new();
    let mut key_ids = Vec::new();
    for (i, key) in m.drops.iter().enumerate() {
        if let Some(snap) = item_snapshot(catalog, key, ids::mob_drop_id(&m.name, i)) {
            match &snap {
                ItemSnapshot::Key { id, .. } => {
                    key_ids.push(id.clone());
                    key_snaps.push(snap);
                }
                ItemSnapshot::Item { id, .. } => {
                    item_ids.push(id.clone());
                    item_snaps.push(snap);
                }
            }
        }
    }
    let slots = m.inventory_slots.unwrap_or(2).max(m.drops.len() as i64);
    let snapshot = CharacterSnapshot {
        kind: CharacterKind::Mob,
        id: CharacterId(ids::mob_id(&m.name)),
        name: m.name.clone(),
        stats: m.stats.clone(),
        actions_per_round: m.actions_per_round.unwrap_or(2),
        actions_this_round: 0,
        current_room_id: Some(RoomId(room_id.to_string())),
        inventory: InventorySnapshot {
            slots,
            item_ids,
            key_ids,
        },
        equipment: BTreeMap::new(),
        history: Vec::new(),
        archetype_immunities: Vec::new(),
        afflictions: Afflictions::default(),
        archetype_id: None,
        origin: Some(json!("room")),
        base_escape_chance: Some(m.base_escape_chance.unwrap_or(50)),
        material_drops: Some(m.material_drops.clone().unwrap_or_else(|| json!({}))),
        light_averse: Some(m.light_averse.unwrap_or(false)),
        natural_attack: Some(
            m.natural_attack
                .clone()
                .unwrap_or_else(|| json!({ "stat": "health", "power": 1 })),
        ),
        npc_behavior_key: None,
        npc_state: Value::Null,
        visible: true,
    };
    CharBuild {
        snapshot,
        item_snaps,
        key_snaps,
        equip_snaps: Vec::new(),
    }
}

fn build_npc(n: &NpcDef, catalog: &Catalog, room_id: &str) -> CharBuild {
    let mut item_snaps = Vec::new();
    let mut key_snaps = Vec::new();
    let mut item_ids = Vec::new();
    let mut key_ids = Vec::new();
    for (i, key) in n.holds.iter().enumerate() {
        if let Some(snap) = item_snapshot(catalog, key, ids::npc_item_id(&n.name, i)) {
            match &snap {
                ItemSnapshot::Key { id, .. } => {
                    key_ids.push(id.clone());
                    key_snaps.push(snap);
                }
                ItemSnapshot::Item { id, .. } => {
                    item_ids.push(id.clone());
                    item_snaps.push(snap);
                }
            }
        }
    }
    let snapshot = CharacterSnapshot {
        kind: CharacterKind::Npc,
        id: CharacterId(ids::npc_id(&n.name)),
        name: n.name.clone(),
        stats: n.stats.clone(),
        actions_per_round: 3,
        actions_this_round: 0,
        current_room_id: Some(RoomId(room_id.to_string())),
        inventory: InventorySnapshot {
            slots: 5,
            item_ids,
            key_ids,
        },
        equipment: BTreeMap::new(),
        history: Vec::new(),
        archetype_immunities: Vec::new(),
        afflictions: Afflictions::default(),
        archetype_id: None,
        origin: None,
        base_escape_chance: None,
        material_drops: None,
        light_averse: None,
        natural_attack: None,
        npc_behavior_key: Some(n.behavior.clone()),
        npc_state: Value::Null,
        visible: true,
    };
    CharBuild {
        snapshot,
        item_snaps,
        key_snaps,
        equip_snaps: Vec::new(),
    }
}

/// Compass opposite (`src/lib/room.ts` REVERSE) — used to place the auto-reverse
/// leg of a two-way exit into the destination room under the opposite direction.
fn reverse_direction(d: &str) -> String {
    match d {
        "north" => "south",
        "south" => "north",
        "east" => "west",
        "west" => "east",
        "northeast" => "southwest",
        "southwest" => "northeast",
        "northwest" => "southeast",
        "southeast" => "northwest",
        other => other,
    }
    .to_string()
}

/// `DEFAULT_CHAT_POLICY` (`src/lib/chat-policy.ts`).
fn default_chat_policy() -> Value {
    json!({
        "enabled": true,
        "whisper": true,
        "edit": true,
        "reactions": true,
        "readReceipts": true,
        "typing": true,
        "backfillWindow": 200,
    })
}

/// `DEFAULT_AV_POLICY` (`src/lib/av-policy.ts`).
fn default_av_policy() -> Value {
    json!({ "enabled": true, "video": true, "maxParticipants": 6 })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::description::CampaignDescription;
    use wickedways_core::world::descriptor::Catalog;

    fn minimal() -> CampaignDescription {
        serde_json::from_value(serde_json::json!({
            "title": "Crypt", "opts": {},
            "archetypes": [], "startRoom": "start",
            "rooms": [
                { "name": "start", "description": "entry" },
                { "name": "next",  "description": "onward" }
            ],
            "exits": [{ "from": "start", "direction": "north", "to": "next" }],
            "mobs": [], "loot": [], "caches": [], "npcs": [],
            "formations": [], "scenes": [], "recipes": [], "materials": [],
            "winConditions": [], "loseConditions": [], "mechanics": []
        }))
        .expect("parse")
    }

    #[test]
    fn builds_a_player_less_not_begun_campaign() {
        let snap = construct(&minimal(), &Catalog::default()).expect("construct");
        assert_eq!(snap.schema_version, 6);
        assert_eq!(snap.campaign.id, "campaign:Crypt");
        assert_eq!(snap.campaign.round, 0);
        assert!(!snap.campaign.started);
        assert!(snap.campaign.party_ids.is_empty());
        assert!(snap.campaign.gm_id.is_none());
        assert_eq!(snap.campaign.max_rounds, 100); // opts.maxRounds ?? 100
    }

    /// Branded ids are transparent tuple structs — `pub struct RoomId(pub String)`
    /// (`crates/wickedways-core/src/world/ids.rs`). Access the inner string with `.0`.
    #[test]
    fn mints_content_derived_ids() {
        let snap = construct(&minimal(), &Catalog::default()).expect("construct");
        let rooms: Vec<&str> = snap.rooms.iter().map(|r| r.id.0.as_str()).collect();
        assert_eq!(rooms, vec!["room:start", "room:next"]);
        assert_eq!(snap.exits.len(), 1);
        assert_eq!(snap.exits[0].id.0, "exit:next|start"); // sorted author names
    }

    /// A single exit is one ExitSnapshot, wired into BOTH rooms' `exits` maps
    /// (unless `oneWay`). assembler.ts:313-315 dedups by unordered endpoint pair.
    #[test]
    fn a_two_way_exit_appears_once_and_links_both_rooms() {
        let snap = construct(&minimal(), &Catalog::default()).expect("construct");
        assert_eq!(snap.exits.len(), 1);
        let start = snap
            .rooms
            .iter()
            .find(|r| r.id.0 == "room:start")
            .expect("start");
        assert!(start.exits.values().any(|e| e.0 == "exit:next|start"));
    }
}
