//! The id-keyed runtime world model (Phase 1).
pub mod afflictions;
pub mod command;
pub mod descriptor;
pub mod direction;
pub mod equipment;
pub mod exits;
pub mod formations;
pub mod gate;
pub mod history;
pub mod ids;
pub mod intent;
pub mod mechanics;
pub mod resolve;
pub mod rng;
pub mod scenes;
pub mod snapshot;
pub mod submit;
mod combat;
mod items_actions;
mod movement;
mod turn;
pub mod view;
pub mod victory;

#[cfg(test)]
pub mod test_support;

pub use direction::Direction;
pub use ids::{CharacterId, ExitId, ItemId, LootId, MaterialCacheId, RoomId};
pub use snapshot::{ExitSnapshot, ItemSnapshot, LootSnapshot, MaterialCacheSnapshot, SceneSnapshot};

use alloc::collections::BTreeMap;
use rng::Rng;
use serde_json::Value;
use snapshot::{
    CampaignCoreSnapshot, CampaignSnapshot, CharacterSnapshot, RoomSnapshot, SCHEMA_VERSION,
};

#[derive(Clone, Debug, PartialEq)]
pub struct World {
    pub characters: BTreeMap<CharacterId, CharacterSnapshot>,
    pub rooms: BTreeMap<RoomId, RoomSnapshot>,
    pub items: BTreeMap<ItemId, ItemSnapshot>,
    pub loot: BTreeMap<LootId, LootSnapshot>,
    pub material_caches: BTreeMap<MaterialCacheId, MaterialCacheSnapshot>,
    pub exits: BTreeMap<ExitId, ExitSnapshot>,
    pub campaign: CampaignCoreSnapshot,
    pub codex: Value,
    pub rng: Rng,
}

fn item_id(i: &ItemSnapshot) -> ItemId {
    match i {
        ItemSnapshot::Item { id, .. } | ItemSnapshot::Key { id, .. } => id.clone(),
    }
}

impl World {
    /// Single pass: fold each entity array into its id-keyed store. No two-pass
    /// hydration — references are ids, so there is nothing to re-wire.
    pub fn from_snapshot(s: CampaignSnapshot) -> World {
        World {
            characters: s.characters.into_iter().map(|c| (c.id.clone(), c)).collect(),
            rooms: s.rooms.into_iter().map(|r| (r.id.clone(), r)).collect(),
            items: s.items.into_iter().map(|i| (item_id(&i), i)).collect(),
            loot: s.loot.into_iter().map(|l| (l.id.clone(), l)).collect(),
            material_caches: s
                .material_caches
                .into_iter()
                .map(|m| (m.id.clone(), m))
                .collect(),
            exits: s.exits.into_iter().map(|e| (e.id.clone(), e)).collect(),
            campaign: s.campaign,
            codex: s.codex,
            rng: Rng::seeded(0),
        }
    }

    /// Re-seed the transient rng (conformance harness only; called after `from_snapshot`).
    pub fn seed_rng(&mut self, seed: u32) {
        self.rng = Rng::seeded(seed);
    }

    /// Emit each store as an array in id-sorted order (BTreeMap iterates sorted).
    /// The conformance gate canonicalizes the TS side to the same ordering.
    ///
    /// `items` is **reachability-derived**, mirroring the TS serializer
    /// (`serialization/serializer.ts:54-112` `addItem`): only items referenced
    /// by a loot container's `content_ids`, a room's `light_source_ids`, or a
    /// character's inventory `item_ids`/`key_ids`/`equipment` are emitted.
    /// An item that has been dropped or consumed (removed from every inventory
    /// and not placed anywhere) is no longer reachable and drops out of the
    /// snapshot — matching the TS oracle, whose `items` array is built by
    /// walking the reachable graph rather than a persistent item registry.
    pub fn to_snapshot(&self) -> CampaignSnapshot {
        let mut reachable: alloc::collections::BTreeSet<ItemId> =
            alloc::collections::BTreeSet::new();
        for loot in self.loot.values() {
            for id in &loot.content_ids {
                reachable.insert(id.clone());
            }
        }
        for room in self.rooms.values() {
            for id in &room.light_source_ids {
                reachable.insert(id.clone());
            }
        }
        for ch in self.characters.values() {
            for id in &ch.inventory.item_ids {
                reachable.insert(id.clone());
            }
            for id in &ch.inventory.key_ids {
                reachable.insert(id.clone());
            }
            for id in ch.equipment.values() {
                reachable.insert(id.clone());
            }
        }

        CampaignSnapshot {
            schema_version: SCHEMA_VERSION,
            campaign: self.campaign.clone(),
            rooms: self.rooms.values().cloned().collect(),
            exits: self.exits.values().cloned().collect(),
            characters: self.characters.values().cloned().collect(),
            items: self
                .items
                .iter()
                .filter(|(id, _)| reachable.contains(*id))
                .map(|(_, snap)| snap.clone())
                .collect(),
            loot: self.loot.values().cloned().collect(),
            material_caches: self.material_caches.values().cloned().collect(),
            codex: self.codex.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_json() -> &'static str {
        // reuse the Task 4 minimal full snapshot
        r#"{ "schemaVersion":6, "campaign":{ "id":"camp1","title":"HH","maxRounds":20,"round":0,
        "started":false,"outcome":"ongoing","winConditions":[],"loseConditions":[],
        "activeCharacterIndex":0,"partyIds":["c1"],"actedThisRound":[],"gmId":null,"materials":{},
        "claims":[],"encountered":[],"knownRecipes":[],"archetypes":[],"actionSounds":{},
        "encounterTable":{"baseChance":0,"visited":[],"formations":[]},"chatPolicy":{},"avPolicy":{},
        "mechanics":[]}, "rooms":[{"id":"r1","name":"F","description":"d","exits":{},"dark":false,
        "spawnModifier":0,"occupantIds":["c1"],"lootIds":[],"materialCacheIds":[],"lightSourceIds":[],
        "scenes":[]}], "exits":[], "characters":[{"kind":"player","id":"c1","name":"H",
        "stats":{"energy":5,"sanity":7,"health":10},"actionsPerRound":2,"actionsThisRound":0,
        "currentRoomId":"r1","inventory":{"slots":6,"itemIds":[],"keyIds":[]},"equipment":{},
        "history":[],"archetypeImmunities":[],"afflictions":{"active":{},"turnsActive":{},
        "shakenOff":[],"immunity":{}}}], "items":[],"loot":[],"materialCaches":[],"codex":[] }"#
    }

    #[test]
    fn world_roundtrip_is_value_identical() {
        let snap: CampaignSnapshot = serde_json::from_str(sample_json()).unwrap();
        let back = World::from_snapshot(snap.clone()).to_snapshot();
        // Compare as serde_json::Value (object-key-order-insensitive); arrays already single-element.
        assert_eq!(
            serde_json::to_value(&back).unwrap(),
            serde_json::to_value(&snap).unwrap()
        );
    }

    #[test]
    fn from_then_to_preserves_entity_counts() {
        let snap: CampaignSnapshot = serde_json::from_str(sample_json()).unwrap();
        let w = World::from_snapshot(snap);
        assert_eq!(w.characters.len(), 1);
        assert_eq!(w.rooms.len(), 1);
        assert_eq!(w.to_snapshot().characters.len(), 1);
    }
}
