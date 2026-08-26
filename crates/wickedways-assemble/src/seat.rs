//! Party seating: turns the player-less construct output into the seated genesis.
//!
//! The construct pass returns a player-less campaign; each PC is then built, given
//! `player:{name}`, joined, optionally given an archetype, and moved into `startRoom`
//! WITHOUT firing enter-scenes — those are `begin_campaign`'s job. The GM is the
//! first player. Genesis is captured before the campaign begins.
//!
//! Two side effects of that boot move (scenes suppressed) are reproduced here,
//! because the pre-begin genesis carries them:
//!   * the move records a budgeted `move` history entry and ticks
//!     `actionsThisRound` to 1;
//!   * the player-side move then notes encounters (recording every non-party
//!     start-room occupant into the codex as a `mob` entry — NPCs included — and into
//!     `campaign.encountered` as `"{pc}:{occ}"`) followed by a room encounter
//!     record. So the codex discovery order is
//!     `[occupants in occupant order..., room]`, first-write-wins per `kind::key`.
//!
//! DEFERRED — the KO-occupant skip. The oracle's encounter-noting step skips
//! occupants whose `status` includes `Status.KO`, for BOTH the codex entry and the
//! `encountered` push. This crate does NOT implement that skip, and deliberately so:
//! KO is DERIVED from stats/afflictions by a *reconcile* that runs only on
//! `takeDamage`/`startTurn`/`endTurn` — all post-begin. A character constructed by
//! the assembler never reconciles, so its `afflictions` are empty at genesis EVEN IF
//! authored with `health: 0` (verified: a health-0 mob's genesis `afflictions.active`
//! is `{}`, and the oracle records it in both `encountered` and the codex). No
//! occupant is ever KO in a pre-begin snapshot, so the skip is a no-op here and no
//! fixture can exercise it. This is fail-loud: were a genuinely-KO-at-genesis
//! occupant ever to become expressible, the oracle would drop it while this code
//! would keep it, and the byte-parity gate would fire — at which point the skip must
//! be implemented (compute KO from the occupant snapshot as the stats reconcile
//! does, and skip both the codex entry and the `encountered` push).
//!
//! The golden serialization seeds the character list with party members BEFORE room
//! occupants, and first insertion fixes position, so seated PCs sort to the FRONT
//! of `characters[]`, ahead of the mobs/npcs.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use wickedways_core::world::afflictions::{Afflictions, Status};
use wickedways_core::world::descriptor::Catalog;
use wickedways_core::world::history::{ActionHistoryEntry, RoomRef};
use wickedways_core::world::ids::{CharacterId, RoomId};
use wickedways_core::world::snapshot::{
    CampaignSnapshot, CharacterKind, CharacterSnapshot, InventorySnapshot, Stats,
};

use crate::description::{ArchetypeDef, CampaignDescription};
use crate::error::AssembleError;
use crate::{ids, Seat};

/// The default player statline — the baseline before any archetype override.
const DEFAULT_PLAYER_STATS: Stats = Stats {
    energy: 10.0,
    sanity: 10.0,
    health: 10.0,
};
/// Player inventory capacity default.
const DEFAULT_PLAYER_SLOTS: i64 = 5;
/// Player action budget.
const PLAYER_ACTIONS_PER_ROUND: i64 = 3;

/// Seats `party` into `snap` (mutating in place). An empty party is the pristine
/// genesis (`gm_id: None`, `party_ids: []`) and a no-op. The FIRST seat becomes GM.
pub(crate) fn seat_party(
    snap: &mut CampaignSnapshot,
    desc: &CampaignDescription,
    _catalog: &Catalog,
    party: &[Seat],
) -> Result<(), AssembleError> {
    if party.is_empty() {
        return Ok(()); // pristine genesis: gm_id None, party_ids []
    }

    // The boot move seats each PC into `startRoom`. Validation guarantees a valid
    // start room; if it is somehow absent there is nowhere to seat, so leave the
    // player-less snapshot untouched rather than panic.
    // (`let Some(x) = ... else { return }` is a guard clause: unwrap the Option
    // or bail — the same shape as `if (x == null) return;` in JS.)
    let Some(start_name) = desc.start_room.as_deref() else {
        return Ok(());
    };
    let start_room_id = ids::room_id(start_name);
    let Some(room_idx) = snap.rooms.iter().position(|r| r.id.0 == start_room_id) else {
        return Ok(());
    };
    // Clone these Strings out now. In JS you'd hold a reference into the room;
    // here a borrow of `snap.rooms[..]` would lock `snap` against the mutation
    // below, so we take owned copies and the borrow ends immediately.
    let room_name = snap.rooms[room_idx].name.clone();
    let room_description = snap.rooms[room_idx].description.clone();

    // Occupants already in the start room (construct's mobs then npcs, in occupant
    // order). Every seated PC "discovers" exactly these: encounter noting skips
    // party members, so PCs never discover one another.
    let discoverable: Vec<CharacterId> = snap.rooms[room_idx].occupant_ids.clone();

    // Codex discovery entries, appended after construct's recipe entries. Mob
    // entries (kind "mob" for ANY non-party occupant, NPCs included) are recorded
    // first, in occupant order, then the room — all first-write-wins per kind/key.
    let mut codex_entries: Vec<Value> = Vec::new();
    let mut seen_mob_keys: Vec<String> = Vec::new();
    let mut room_recorded = false;

    let mut pc_snaps: Vec<CharacterSnapshot> = Vec::new();
    let mut encountered: Vec<String> = Vec::new();

    for (i, seat) in party.iter().enumerate() {
        let pc_id = ids::player_id(&seat.name);

        // --- archetype selection ---
        let mut stats = DEFAULT_PLAYER_STATS;
        let mut slots = DEFAULT_PLAYER_SLOTS;
        let mut immunities: Vec<Status> = Vec::new();
        if let Some(arch_id) = &seat.archetype {
            if let Some(arch) = desc.archetypes.iter().find(|a| &a.id == arch_id) {
                apply_archetype(arch, &mut stats, &mut slots, &mut immunities);
            }
        }

        // --- codex + encountered from the boot move's encounter noting ---
        // Every discoverable occupant is recorded by every seat (distinct
        // characterId), so `encountered` is seat-major/occupant-minor.
        let first_seen = json!({
            "round": 0,
            "characterId": pc_id,
            "roomId": start_room_id,
        });
        for occ in &discoverable {
            encountered.push(format!("{}:{}", pc_id, occ.0));
            let Some(occ_snap) = snap.characters.iter().find(|c| c.id == *occ) else {
                continue;
            };
            let key = occ_snap.name.clone();
            if seen_mob_keys.iter().any(|k| k == &key) {
                continue; // first-write-wins per "mob::{name}"
            }
            seen_mob_keys.push(key.clone());
            codex_entries.push(json!({
                "kind": "mob",
                "key": key,
                "snapshot": {
                    "name": occ_snap.name,
                    "stats": {
                        "health": occ_snap.stats.health,
                        "sanity": occ_snap.stats.sanity,
                        "energy": occ_snap.stats.energy,
                    },
                },
                "firstSeen": first_seen,
            }));
        }
        // The room encounter record — after the occupant sweep, once.
        if !room_recorded {
            room_recorded = true;
            codex_entries.push(json!({
                "kind": "room",
                "key": start_room_id,
                "snapshot": {
                    "name": room_name,
                    "description": room_description,
                },
                "firstSeen": first_seen,
            }));
        }

        pc_snaps.push(CharacterSnapshot {
            kind: CharacterKind::Player,
            id: CharacterId(pc_id.clone()),
            name: seat.name.clone(),
            stats,
            actions_per_round: PLAYER_ACTIONS_PER_ROUND,
            // The boot move ticks the budget once.
            actions_this_round: 1,
            current_room_id: Some(RoomId(start_room_id.clone())),
            inventory: InventorySnapshot {
                slots,
                item_ids: Vec::new(),
                key_ids: Vec::new(),
            },
            equipment: BTreeMap::new(),
            // The boot move records one `move` history entry at round 0.
            history: vec![ActionHistoryEntry::Move {
                round: 0,
                room: RoomRef {
                    id: RoomId(start_room_id.clone()),
                    name: room_name.clone(),
                },
            }],
            archetype_immunities: immunities,
            afflictions: Afflictions::default(),
            archetype_id: seat.archetype.clone(),
            origin: None,
            base_escape_chance: None,
            material_drops: None,
            light_averse: None,
            natural_attack: None,
            npc_behavior_key: None,
            npc_state: Value::Null,
            visible: true,
        });

        // The PC joins the room's occupants at the end (after existing mobs/npcs
        // and any earlier-seated PC), and the party in seat order.
        snap.rooms[room_idx]
            .occupant_ids
            .push(CharacterId(pc_id.clone()));
        snap.campaign.party_ids.push(CharacterId(pc_id.clone()));
        if i == 0 {
            snap.campaign.gm_id = Some(CharacterId(pc_id.clone()));
        }
    }

    // Party members sort ahead of room occupants in `characters[]`.
    // `splice(0..0, pc_snaps)` inserts at the front — `arr.unshift(...pcs)`.
    snap.characters.splice(0..0, pc_snaps);
    snap.campaign.active_character_index = 0;
    snap.campaign.encountered = encountered;

    // The boot move runs the encounter spawn check, which marks the entered room
    // visited regardless of spawn outcome. Only the start room is entered, so
    // `visited` becomes `[startRoom]` — a set, deduped even across multiple
    // seated PCs.
    if let Value::Object(et) = &mut snap.campaign.encounter_table {
        et.insert("visited".to_string(), json!([start_room_id]));
    }

    // Append discovery entries after construct's (recipe) codex entries.
    if let Value::Array(existing) = &mut snap.codex {
        existing.extend(codex_entries);
    } else {
        snap.codex = Value::Array(codex_entries);
    }

    Ok(())
}

/// Archetype application: named base stats override, `inventorySlots` is a
/// floored delta (never below 0), immunities become a standing passive.
fn apply_archetype(
    arch: &ArchetypeDef,
    stats: &mut Stats,
    slots: &mut i64,
    immunities: &mut Vec<Status>,
) {
    if let Some(base) = &arch.base_stats {
        if let Some(&h) = base.get("health") {
            stats.health = h;
        }
        if let Some(&s) = base.get("sanity") {
            stats.sanity = s;
        }
        if let Some(&e) = base.get("energy") {
            stats.energy = e;
        }
    }
    if let Some(delta) = arch.inventory_slots {
        // `*slots` dereferences the `&mut i64` to assign through it — mutating
        // the caller's variable, which JS can't do with a number parameter.
        *slots = (*slots + delta).max(0);
    }
    // `filter_map(...ok())` = map each name through the parser and silently drop
    // failures — `.map(parse).filter(x => x !== undefined)` in one pass.
    *immunities = arch
        .immunities
        .iter()
        .filter_map(|s| serde_json::from_value::<Status>(Value::String(s.clone())).ok())
        .collect();
}
