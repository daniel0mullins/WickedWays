//! Owned read-only projections handed to mechanic hooks (TS `CampaignView` etc.).
//! Built once before a dispatch loop so hooks borrow only `state`+`rng` of `World`.
use alloc::collections::BTreeSet;
use alloc::string::String;
use alloc::vec::Vec;

use crate::stats::StatType;
use crate::world::afflictions::Status;
use crate::world::descriptor::Catalog;
use crate::world::ids::CharacterId;
use crate::world::snapshot::ItemSnapshot;
use crate::world::World;

#[derive(Clone, Debug, PartialEq)]
pub struct CampaignView {
    pub round: i64,
    pub max_rounds: i64,
    pub party: Vec<CharacterView>,
    /// Always empty in v1 (TS `#campaignView` returns `rooms: []`).
    pub rooms: Vec<RoomView>,
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
    equipped_keys: BTreeSet<String>,
    held_keys: BTreeSet<String>,
}

impl CharacterView {
    /// TS `CharacterView.hasEquipped(itemKey)` — matches on item `behaviorKey`.
    pub fn has_equipped(&self, key: &str) -> bool { self.equipped_keys.contains(key) }
    /// TS `CharacterView.hasItem(itemKey)` — matches held (inventory) item `behaviorKey`.
    pub fn has_item(&self, key: &str) -> bool { self.held_keys.contains(key) }
}

#[derive(Clone, Debug, PartialEq)]
pub struct RoomView {
    pub id: String,
    pub name: String,
    pub lit: bool,
    pub occupant_ids: Vec<String>,
}

/// TS `DamageView` — `source` is always `None` at the one call site.
#[derive(Clone, Debug, PartialEq)]
pub struct DamageView {
    pub amount: f64,
    pub target: CharacterId,
    pub stat: StatType,
    pub source: Option<CharacterId>,
}

impl World {
    /// Build the owned party projection (TS `#campaignView` + `#characterView`).
    /// `party_ids` order is preserved. `rooms` is intentionally empty (v1).
    pub fn build_campaign_view(&self, cat: &Catalog) -> CampaignView {
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
        }
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
        })
    }

    /// The `behaviorKey` an item matches on (TS `item.behaviorKey`). Only catalog-backed
    /// `Item`s carry one; keys resolve `None`.
    fn behavior_key_of(&self, iid: &crate::world::ids::ItemId) -> Option<String> {
        match self.items.get(iid) {
            Some(ItemSnapshot::Item { behavior_key, .. }) => Some(behavior_key.clone()),
            _ => None,
        }
    }
}

// Local copy to avoid a cross-module const import cycle in this file.
const ALL_STATUSES_LOCAL: [Status; 4] =
    [Status::Confused, Status::Fear, Status::Ko, Status::Panic];

#[cfg(test)]
mod tests {
    use crate::world::descriptor::Catalog;
    use crate::world::ids::CharacterId;
    use crate::world::test_support::world_with_party;

    fn cid(s: &str) -> CharacterId { CharacterId(s.into()) }

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
}
