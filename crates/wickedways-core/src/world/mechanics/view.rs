//! Owned read-only projections handed to mechanic hooks (`CampaignView` etc.).
//! Built once before a dispatch loop so hooks borrow only `state`+`rng` of `World`.
use alloc::collections::BTreeSet;
use alloc::string::String;
use alloc::vec::Vec;

use crate::stats::StatType;
use crate::world::afflictions::Status;
use crate::world::descriptor::Catalog;
use crate::world::ids::CharacterId;
use crate::world::ids::RoomId;
use crate::world::snapshot::ItemSnapshot;
use crate::world::World;

#[derive(Clone, Debug, PartialEq)]
pub struct CampaignView {
    pub round: i64,
    pub max_rounds: i64,
    pub party: Vec<CharacterView>,
    /// Always empty in v1 (`#campaignView` returns `rooms: []`).
    pub rooms: Vec<RoomView>,
    /// The campaign's world-scoped script state (`campaign.world_state`),
    /// readable from every DSL context via `worldGet(...)`. `Null` = empty.
    pub world_state: serde_json::Value,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CharacterView {
    pub id: CharacterId,
    pub name: String,
    pub health: f64,
    pub sanity: f64,
    pub energy: f64,
    pub status: Vec<Status>,
    pub room_id: Option<String>,
    // No `pub` on these three: visible only inside this module, so outside code
    // must go through the `has_*` accessors below — encapsulation without a class.
    equipped_keys: BTreeSet<String>,
    held_keys: BTreeSet<String>,
    key_codes: BTreeSet<String>,
}

impl CharacterView {
    /// `CharacterView.hasEquipped(itemKey)` — matches on item `behaviorKey`.
    pub fn has_equipped(&self, key: &str) -> bool {
        self.equipped_keys.contains(key)
    }
    /// `CharacterView.hasItem(itemKey)` — matches held (inventory) item `behaviorKey`.
    pub fn has_item(&self, key: &str) -> bool {
        self.held_keys.contains(key)
    }
    /// True if the character's keyring holds a key with this `keyCode`
    /// (`c.inventory.keys.some((k) => k.keyCode === code)`).
    pub fn has_key(&self, code: &str) -> bool {
        self.key_codes.contains(code)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct RoomView {
    pub id: String,
    pub name: String,
    pub lit: bool,
    pub occupant_ids: Vec<String>,
    /// Occupants as views (`room.occupants`), projected in `occupant_ids` order.
    pub occupants: Vec<CharacterView>,
}

/// `DamageView` — the in-flight damage a `modify_damage` transform observes.
/// `source` is the attacking character (populated on the attack path, absent
/// for source-less damage such as a critical-miss stumble); `room` is the
/// TARGET's current room id, so a transform can reason about co-location
/// (`some(party, element.roomId == damage.room && …)`) without a room resolver.
#[derive(Clone, Debug, PartialEq)]
pub struct DamageView {
    pub amount: f64,
    pub target: CharacterId,
    pub stat: StatType,
    pub source: Option<CharacterId>,
    pub room: Option<String>,
}

impl World {
    /// Build the owned party projection (`#campaignView` + `#characterView`).
    /// `party_ids` order is preserved. `rooms` is intentionally empty (v1).
    pub fn build_campaign_view(&self, cat: &Catalog) -> CampaignView {
        // `filter_map` maps and drops the `None`s in one pass — a fused
        // `.map(...).filter(x => x != null)`.
        let party = self
            .campaign
            .party_ids
            .iter()
            .filter_map(|id| self.character_view(id, cat))
            .collect();
        CampaignView {
            round: self.campaign.round,
            max_rounds: self.campaign.max_rounds,
            party,
            rooms: Vec::new(),
            world_state: self.campaign.world_state.clone(),
        }
    }

    /// Owned projection of a single room for scene hooks (`room` handed to
    /// scene preconditions/scripts). `occupants` are projected in `occupant_ids`
    /// order via `character_view`. `None` if the room is absent.
    pub fn room_view(&self, room_id: &RoomId, cat: &Catalog) -> Option<RoomView> {
        // `?` on an `Option` early-returns `None` from the whole function —
        // optional chaining's short-circuit, at statement level.
        let r = self.rooms.get(room_id)?;
        let occupant_ids: Vec<String> = r.occupant_ids.iter().map(|id| id.0.clone()).collect();
        let occupants: Vec<CharacterView> = r
            .occupant_ids
            .iter()
            .filter_map(|id| self.character_view(id, cat))
            .collect();
        Some(RoomView {
            id: room_id.0.clone(),
            name: r.name.clone(),
            lit: self.is_lit(room_id, cat),
            occupant_ids,
            occupants,
        })
    }

    pub(crate) fn character_view(&self, id: &CharacterId, cat: &Catalog) -> Option<CharacterView> {
        let c = self.characters.get(id)?;
        let status = ALL_STATUSES_LOCAL
            .iter()
            .copied()
            .filter(|s| c.afflictions.is_active(*s))
            .collect();
        let equipped_keys = c
            .equipment
            .values()
            .filter_map(|iid| self.behavior_key_of(iid))
            .collect();
        let held_keys = c
            .inventory
            .item_ids
            .iter()
            .chain(c.inventory.key_ids.iter())
            .filter_map(|iid| self.behavior_key_of(iid))
            .collect();
        let key_codes = c
            .inventory
            .key_ids
            .iter()
            .filter_map(|iid| match self.items.get(iid) {
                Some(ItemSnapshot::Key { key_code, .. }) => Some(key_code.clone()),
                _ => None,
            })
            .collect();
        Some(CharacterView {
            id: id.clone(),
            name: c.name.clone(),
            health: self.effective_stat(id, StatType::Health, cat),
            sanity: self.effective_stat(id, StatType::Sanity, cat),
            energy: self.effective_stat(id, StatType::Energy, cat),
            status,
            room_id: c.current_room_id.as_ref().map(|r| r.0.clone()),
            equipped_keys,
            held_keys,
            key_codes,
        })
    }

    /// The `behaviorKey` an item matches on (`item.behaviorKey`). Only catalog-backed
    /// `Item`s carry one; keys resolve `None`.
    fn behavior_key_of(&self, iid: &crate::world::ids::ItemId) -> Option<String> {
        match self.items.get(iid) {
            Some(ItemSnapshot::Item { behavior_key, .. }) => Some(behavior_key.clone()),
            _ => None,
        }
    }
}

// Local copy to avoid a cross-module const import cycle in this file.
const ALL_STATUSES_LOCAL: [Status; 4] = [Status::Confused, Status::Fear, Status::Ko, Status::Panic];

#[cfg(test)]
mod tests {
    use crate::world::descriptor::Catalog;
    use crate::world::test_support::cid;

    use crate::world::test_support::world_with_party;

    #[test]
    fn campaign_view_projects_party_effective_stats() {
        // world_with_party(ids, max_rounds) gives every character uniform
        // stats: health 5.0 / sanity 5.0 / energy 5.0 (see test_support.rs);
        // the `10` here is max_rounds, not a stat (confirmed against every
        // other call site in this crate, e.g. turn.rs's `/*max_rounds*/ 10`).
        let w = world_with_party(&["pc"], 10);
        let v = w.build_campaign_view(&Catalog::default());
        assert_eq!(v.round, w.campaign.round);
        assert_eq!(v.max_rounds, w.campaign.max_rounds);
        assert_eq!(v.party.len(), 1);
        let pc = &v.party[0];
        assert_eq!(pc.id, cid("pc"));
        assert_eq!(pc.health, 5.0);
        assert_eq!(pc.sanity, 5.0);
        assert_eq!(pc.energy, 5.0);
        assert!(v.rooms.is_empty(), "rooms stays empty in v1 (matches TS)");
        assert!(!pc.has_equipped("anything"));
        assert!(!pc.has_item("anything"));
    }

    #[test]
    fn room_view_projects_lit_and_occupants() {
        use crate::world::ids::RoomId;
        // world_two_rooms seats "pc" (Heir) in "start" (lit); "next" may be dark.
        let w = crate::world::test_support::world_two_rooms(/*next_dark=*/ true);
        let cat = Catalog::default();
        let start = w
            .room_view(&RoomId("start".into()), &cat)
            .expect("start room");
        assert_eq!(start.id, "start");
        assert!(start.lit);
        assert_eq!(start.occupant_ids, alloc::vec!["pc".to_string()]);
        assert_eq!(start.occupants.len(), 1);
        assert_eq!(start.occupants[0].id, cid("pc"));

        let next = w
            .room_view(&RoomId("next".into()), &cat)
            .expect("next room");
        assert!(!next.lit); // dark, no light sources
        assert!(next.occupants.is_empty());

        assert!(w.room_view(&RoomId("nope".into()), &cat).is_none());
    }

    #[test]
    fn character_view_has_key_matches_inventory_key_code() {
        use crate::world::ids::ItemId;
        use crate::world::snapshot::ItemSnapshot;
        let mut w = world_with_party(&["pc"], 10);
        w.items.insert(
            ItemId("k1".into()),
            ItemSnapshot::Key {
                id: ItemId("k1".into()),
                name: "Brass Key".into(),
                key_code: "brass".into(),
                consume_on_use: false,
            },
        );
        w.characters
            .get_mut(&cid("pc"))
            .unwrap()
            .inventory
            .key_ids
            .push(ItemId("k1".into()));
        let v = w.character_view(&cid("pc"), &Catalog::default()).unwrap();
        assert!(v.has_key("brass"));
        assert!(!v.has_key("iron"));
    }
}
