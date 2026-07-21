//! The [`apply`] delta applier — the replica half of the sync core (Phase 2c, sub-project B).
//!
//! Mirrors `src/lib/sync/delta-applier.ts`, but the Rust port is dramatically simpler. The TS
//! applier needs a two-pass hydrate (construct created entities in id-resolvable order, then wire
//! cross-references) because the TS campaign is a graph of **live objects holding object
//! references**. The Rust [`World`] is a flat, id-keyed store of snapshots — entities reference
//! each other by id, never by pointer — so applying a [`Delta`] is just: insert every
//! created/changed entity into its map, remove every `removed` id, and replace the campaign core +
//! codex. No ordering constraint, no hydration, no rng. A replica converges structurally because
//! the same one crate produces and applies the delta.

use crate::world::ids::{CharacterId, ItemId, LootId, MaterialCacheId, RoomId};
use crate::world::snapshot::ItemSnapshot;
use crate::world::World;

use super::delta::{Delta, EntitySnapshot};

/// Patches `replica` in place to reflect `delta`. Never runs game logic and never draws rng — a
/// replica trusts the ordered log and converges by mirroring the authority's entity snapshots.
pub fn apply(replica: &mut World, delta: &Delta) {
    // created ∪ changed — a flat `insert` handles both (it replaces on an existing key).
    for entity in delta.created.iter().chain(delta.changed.iter()) {
        match entity {
            EntitySnapshot::Room(r) => {
                replica.rooms.insert(r.id.clone(), (**r).clone());
            }
            EntitySnapshot::Character(c) => {
                replica.characters.insert(c.id.clone(), (**c).clone());
            }
            EntitySnapshot::Item(i) => {
                replica.items.insert(item_id(i), (**i).clone());
            }
            EntitySnapshot::Loot(l) => {
                replica.loot.insert(l.id.clone(), (**l).clone());
            }
            EntitySnapshot::MaterialCache(m) => {
                replica.material_caches.insert(m.id.clone(), (**m).clone());
            }
        }
    }

    // removed — a bare id whose entity type is not tagged, so try each collection (only the owner
    // removes). Mirrors the TS applier, where removal is a near-no-op on the replica's maps.
    for id in &delta.removed {
        replica.rooms.remove(&RoomId(id.clone()));
        replica.characters.remove(&CharacterId(id.clone()));
        replica.items.remove(&ItemId(id.clone()));
        replica.loot.remove(&LootId(id.clone()));
        replica.material_caches.remove(&MaterialCacheId(id.clone()));
    }

    // campaign core + codex.
    if let Some(cc) = &delta.campaign_core {
        replica.campaign = cc.core.clone();
        replica.codex = cc.codex.clone();
    }
}

fn item_id(i: &ItemSnapshot) -> ItemId {
    match i {
        ItemSnapshot::Item { id, .. } | ItemSnapshot::Key { id, .. } => id.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::authority::{AuthorityOpts, SubmitResult, SyncAuthority};
    use crate::sync::command::Command;
    use crate::sync::delta::{Delta, EntitySnapshot};
    use crate::world::descriptor::Catalog;
    use crate::world::ids::{CharacterId, ItemId, RoomId};
    use crate::world::snapshot::ItemSnapshot;
    use crate::world::test_support::{world_two_rooms, world_with_party};
    use alloc::boxed::Box;
    use alloc::vec;

    fn commit_delta(auth: &mut SyncAuthority, cmd: Command) -> super::Delta {
        match auth.submit(cmd) {
            SubmitResult::Committed { delta, .. } => delta,
            SubmitResult::Denied { reason } => panic!("expected commit, denied: {reason}"),
        }
    }

    #[test]
    fn apply_inserts_created_and_replaces_changed() {
        // Exercise apply's map writes directly on a hand-built delta (a snapshot-diff only ever
        // carries reachable entities; this checks the mechanism, not reachability).
        let mut replica = world_with_party(&["a", "b"], 10);
        let new_item = ItemSnapshot::Item {
            id: ItemId("new".into()),
            behavior_key: "k".into(),
            durability: None,
            modifier: 0,
        };
        let mut changed = replica.characters[&CharacterId("a".into())].clone();
        changed.stats.health = 1.0;
        let delta = Delta {
            created: vec![EntitySnapshot::Item(Box::new(new_item.clone()))],
            changed: vec![EntitySnapshot::Character(Box::new(changed))],
            removed: vec![],
            campaign_core: None,
            cues: vec![],
        };
        apply(&mut replica, &delta);
        assert_eq!(replica.items[&ItemId("new".into())], new_item, "created item inserted");
        assert_eq!(
            replica.characters[&CharacterId("a".into())].stats.health,
            1.0,
            "changed character replaced"
        );
    }

    #[test]
    fn apply_removes_a_deleted_id() {
        let mut replica = world_with_party(&["a"], 10);
        replica.items.insert(
            ItemId("gone".into()),
            ItemSnapshot::Item { id: ItemId("gone".into()), behavior_key: "k".into(), durability: None, modifier: 0 },
        );
        let delta = Delta { created: vec![], changed: vec![], removed: vec!["gone".into()], campaign_core: None, cues: vec![] };
        apply(&mut replica, &delta);
        assert!(!replica.items.contains_key(&ItemId("gone".into())), "removed id is gone");
    }

    #[test]
    fn replica_converges_across_a_command_sequence() {
        // The structural-convergence guarantee: replaying the authority's own deltas into a fresh
        // replica reproduces the authoritative snapshot exactly, after every step.
        let genesis = world_two_rooms(false);
        let mut auth = SyncAuthority::new(genesis.clone(), Catalog::default(), AuthorityOpts::default());
        let mut replica = genesis.clone();

        let pc = crate::world::ids::CharacterId("pc".into());
        let sequence = [
            Command::Move { actor_id: pc.clone(), room_id: RoomId("next".into()) },
            Command::Move { actor_id: pc.clone(), room_id: RoomId("start".into()) },
            Command::Move { actor_id: pc.clone(), room_id: RoomId("next".into()) },
        ];
        for cmd in sequence {
            let delta = commit_delta(&mut auth, cmd);
            apply(&mut replica, &delta);
            assert_eq!(replica.to_snapshot(), auth.snapshot(), "replica diverged from authority");
        }
    }

    #[test]
    fn campaign_core_delta_is_applied() {
        // A GM nextPlayer mutates only the campaign core (active index / acted); the replica must
        // pick that up through campaignCore.
        let mut world = world_with_party(&["a", "b"], 10);
        world.campaign.gm_id = Some(crate::world::ids::CharacterId("a".into()));
        let mut auth = SyncAuthority::new(world.clone(), Catalog::default(), AuthorityOpts::default());
        let mut replica = world.clone();
        let delta = commit_delta(&mut auth, Command::NextPlayer);
        assert!(delta.campaign_core.is_some());
        apply(&mut replica, &delta);
        assert_eq!(replica.to_snapshot(), auth.snapshot());
    }
}
