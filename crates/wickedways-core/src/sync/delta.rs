//! The replication `Delta` and its producer, [`DeltaComputer`].
//!
//! The wire types are `EntitySnapshot` / `Delta` / `CampaignCoreDelta`. A delta is
//! computed structurally, the same way the goldens pin it:
//! **serialize before, apply the command, serialize after, and structurally diff the two
//! snapshots** — no hand-maintained per-action delta code. Because the Rust
//! [`CampaignSnapshot`](crate::world::snapshot::CampaignSnapshot) is already gated to TS
//! `serializeCampaign` parity, a snapshot-diff `Delta` inherits that parity.
//!
//! **Byte-parity note.** The TS diff classifies "changed" via `JSON.stringify(b) !== stringify(a)`
//! and pushes entities in `after`-array order. Rust reaches the *same* classification with
//! structural [`PartialEq`] on the snapshot types — provided (1) we iterate `after` in array
//! order and (2) the snapshot serialization is canonical, which it already is. We therefore do
//! not replicate JS `JSON.stringify` semantics; we rely on the existing snapshot-parity
//! guarantee plus after-order iteration.
//!
//! Note the delta covers **rooms/characters/items/loot/materialCaches + campaignCore** — the
//! same five collections the `EntitySnapshot` union tags. Exits are not replicated by delta
//! (there is no exit `EntitySnapshot` variant), matching the oracle.

use alloc::boxed::Box;
use alloc::collections::{BTreeMap, BTreeSet};
use alloc::string::{String, ToString};
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::presentation::PresentationCue;
use crate::world::snapshot::{
    CampaignCoreSnapshot, CampaignSnapshot, CharacterSnapshot, ItemSnapshot, LootSnapshot,
    MaterialCacheSnapshot, RoomSnapshot,
};

/// A per-entity snapshot tagged so a replica applier can dispatch by entity type.
/// Serializes as `{ "type": <tag>, "data": <snapshot> }` (adjacently tagged), mirroring
/// the `EntitySnapshot` union. Payloads are boxed so the enum (which is carried in bulk
/// inside a [`Delta`]'s `Vec`s) stays pointer-sized rather than the largest variant's ~536
/// bytes; serde treats `Box<T>` transparently, so the wire shape is unchanged.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "camelCase")]
pub enum EntitySnapshot {
    Room(Box<RoomSnapshot>),
    Character(Box<CharacterSnapshot>),
    Item(Box<ItemSnapshot>),
    Loot(Box<LootSnapshot>),
    MaterialCache(Box<MaterialCacheSnapshot>),
}

/// Campaign-level change payload: the core fields plus the codex (both campaign-scoped).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CampaignCoreDelta {
    pub core: CampaignCoreSnapshot,
    pub codex: Value, // CodexEntry[], inert (mirrors the Rust snapshot's codex)
}

/// The state change produced by an accepted command — created/changed entities, removed ids,
/// and an optional campaign-core payload. Mirrors the `Delta`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Delta {
    pub changed: Vec<EntitySnapshot>,
    pub created: Vec<EntitySnapshot>,
    pub removed: Vec<String>,
    // Boxed: a `CampaignCoreDelta` embeds a full `CampaignCoreSnapshot` (~500 bytes), which would
    // otherwise make every `Delta` (and `LogEntry`/`SubmitResult` carrying one) that large even
    // when the core is unchanged. serde treats `Option<Box<T>>` transparently.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub campaign_core: Option<Box<CampaignCoreDelta>>,
    /// Presentation cues produced alongside this state change (e.g. a campaign `Status` readout from
    /// a turn hook). Not state — the delta model otherwise discards cues and re-derives presentation
    /// client-side, but campaign-authored cues like `Status` fields can't be re-derived, so they ride
    /// here (inside the opaque wire `delta`). Empty for most deltas; skipped when empty so the wire
    /// envelope and existing goldens are unchanged.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cues: Vec<PresentationCue>,
}

/// Diffs two full campaign snapshots into a minimal entity-delta. Mirrors the TS
/// `DeltaComputer.diff`.
pub fn diff(before: &CampaignSnapshot, after: &CampaignSnapshot) -> Delta {
    let mut changed = Vec::new();
    let mut created = Vec::new();
    let mut removed = Vec::new();

    diff_collection(
        &before.rooms,
        &after.rooms,
        room_id,
        |r| EntitySnapshot::Room(Box::new(r)),
        &mut changed,
        &mut created,
        &mut removed,
    );
    diff_collection(
        &before.characters,
        &after.characters,
        character_id,
        |c| EntitySnapshot::Character(Box::new(c)),
        &mut changed,
        &mut created,
        &mut removed,
    );
    diff_collection(
        &before.items,
        &after.items,
        item_id,
        |i| EntitySnapshot::Item(Box::new(i)),
        &mut changed,
        &mut created,
        &mut removed,
    );
    diff_collection(
        &before.loot,
        &after.loot,
        loot_id,
        |l| EntitySnapshot::Loot(Box::new(l)),
        &mut changed,
        &mut created,
        &mut removed,
    );
    diff_collection(
        &before.material_caches,
        &after.material_caches,
        cache_id,
        |m| EntitySnapshot::MaterialCache(Box::new(m)),
        &mut changed,
        &mut created,
        &mut removed,
    );

    let core_changed = before.campaign != after.campaign || before.codex != after.codex;
    let campaign_core = core_changed.then(|| {
        Box::new(CampaignCoreDelta {
            core: after.campaign.clone(),
            codex: after.codex.clone(),
        })
    });

    Delta {
        changed,
        created,
        removed,
        campaign_core,
        cues: Vec::new(),
    }
}

/// Compares one entity collection between `before` and `after`, classifying each `after`
/// entity (in array order) as created (absent in before) or changed (present but not
/// structurally equal), then each `before` id absent from `after` as removed. Mirrors
/// `DeltaComputer.diffArray`.
#[allow(clippy::too_many_arguments)]
fn diff_collection<T, F, G>(
    before: &[T],
    after: &[T],
    id_of: F,
    wrap: G,
    changed: &mut Vec<EntitySnapshot>,
    created: &mut Vec<EntitySnapshot>,
    removed: &mut Vec<String>,
) where
    T: PartialEq + Clone,
    F: Fn(&T) -> &str,
    G: Fn(T) -> EntitySnapshot,
{
    let before_by_id: BTreeMap<&str, &T> = before.iter().map(|e| (id_of(e), e)).collect();
    for a in after {
        match before_by_id.get(id_of(a)) {
            None => created.push(wrap(a.clone())),
            Some(b) if *b != a => changed.push(wrap(a.clone())),
            Some(_) => {}
        }
    }
    let after_ids: BTreeSet<&str> = after.iter().map(&id_of).collect();
    for b in before {
        if !after_ids.contains(id_of(b)) {
            removed.push(id_of(b).to_string());
        }
    }
}

fn room_id(r: &RoomSnapshot) -> &str {
    &r.id.0
}
fn character_id(c: &CharacterSnapshot) -> &str {
    &c.id.0
}
fn loot_id(l: &LootSnapshot) -> &str {
    &l.id.0
}
fn cache_id(m: &MaterialCacheSnapshot) -> &str {
    &m.id.0
}
fn item_id(i: &ItemSnapshot) -> &str {
    match i {
        ItemSnapshot::Item { id, .. } | ItemSnapshot::Key { id, .. } => &id.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::ids::ItemId;
    use crate::world::snapshot::ItemSnapshot;
    use crate::world::test_support::world_with_party;
    use serde_json::json;

    fn base() -> CampaignSnapshot {
        world_with_party(&["a", "b"], 10).to_snapshot()
    }

    #[test]
    fn empty_delta_when_nothing_changed() {
        let snap = base();
        let d = diff(&snap, &snap);
        assert!(d.changed.is_empty() && d.created.is_empty() && d.removed.is_empty());
        assert!(d.campaign_core.is_none());
    }

    #[test]
    fn captures_a_created_entity() {
        let before = base();
        let mut after = before.clone();
        let new_item = ItemSnapshot::Item {
            id: ItemId("new-1".into()),
            behavior_key: "k".into(),
            durability: None,
            modifier: 0,
        };
        after.items.push(new_item.clone());
        let d = diff(&before, &after);
        assert_eq!(
            d.created,
            alloc::vec![EntitySnapshot::Item(Box::new(new_item))]
        );
        assert!(d.changed.is_empty() && d.removed.is_empty());
    }

    #[test]
    fn captures_a_removed_id() {
        let mut before = base();
        before.items.push(ItemSnapshot::Item {
            id: ItemId("gone-1".into()),
            behavior_key: "k".into(),
            durability: None,
            modifier: 0,
        });
        let after = base();
        let d = diff(&before, &after);
        assert_eq!(d.removed, alloc::vec!["gone-1".to_string()]);
        assert!(d.created.is_empty() && d.changed.is_empty());
    }

    #[test]
    fn captures_a_changed_entity_in_after_order() {
        let before = base();
        let mut after = before.clone();
        // Mutate the first character's stats so its snapshot differs.
        after.characters[0].stats.health = 1.0;
        let d = diff(&before, &after);
        assert_eq!(d.changed.len(), 1);
        assert!(matches!(d.changed[0], EntitySnapshot::Character(_)));
        // A character-only mutation leaves campaign core untouched.
        assert!(d.campaign_core.is_none());
    }

    #[test]
    fn campaign_core_change_when_core_differs() {
        let before = base();
        let mut after = before.clone();
        after.campaign.round = 2;
        let d = diff(&before, &after);
        let cc = d.campaign_core.expect("core changed");
        assert_eq!(cc.core.round, 2);
    }

    #[test]
    fn campaign_core_change_when_only_codex_differs() {
        let before = base();
        let mut after = before.clone();
        after.codex = json!([{ "kind": "material", "key": "iron" }]);
        let d = diff(&before, &after);
        let cc = d.campaign_core.expect("codex changed");
        assert_eq!(cc.codex, json!([{ "kind": "material", "key": "iron" }]));
    }

    #[test]
    fn entity_snapshot_serializes_adjacently_tagged() {
        let e = EntitySnapshot::Item(Box::new(ItemSnapshot::Item {
            id: ItemId("i1".into()),
            behavior_key: "lantern".into(),
            durability: None,
            modifier: 0,
        }));
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["type"], json!("item"));
        assert_eq!(v["data"]["id"], json!("i1"));
    }

    #[test]
    fn delta_omits_campaign_core_when_absent() {
        let snap = base();
        let v = serde_json::to_value(diff(&snap, &snap)).unwrap();
        assert_eq!(v["changed"], json!([]));
        assert_eq!(v["created"], json!([]));
        assert_eq!(v["removed"], json!([]));
        assert!(
            v.get("campaignCore").is_none(),
            "absent core must be omitted, not null"
        );
    }

    #[test]
    fn created_and_changed_and_removed_together() {
        let mut before = base();
        before.items.push(ItemSnapshot::Item {
            id: ItemId("gone".into()),
            behavior_key: "k".into(),
            durability: None,
            modifier: 0,
        });
        let mut after = before.clone();
        after.items.retain(|i| item_id(i) != "gone"); // remove
        after.items.push(ItemSnapshot::Item {
            // create
            id: ItemId("fresh".into()),
            behavior_key: "k".into(),
            durability: None,
            modifier: 0,
        });
        after.characters[0].stats.sanity = 2.0; // change
        let d = diff(&before, &after);
        assert_eq!(d.removed, alloc::vec!["gone".to_string()]);
        assert_eq!(d.created.len(), 1);
        assert_eq!(d.changed.len(), 1);
    }
}
