//! The sync [`SyncAuthority`] — server + single-player resolution (Phase 2c, sub-project B).
//!
//! Mirrors `src/lib/sync/authority.ts`: `submit` runs **authorize → apply (restoring from the
//! pre-image on a [`ProceduralViolation`]) → diff → commit**, re-deriving the [`Delta`] from the
//! command itself and appending an ordered [`LogEntry`]. The authoritative state is never left
//! half-mutated. Named `SyncAuthority` to disambiguate from the single-player engine handle
//! (`wickedways-wasm`'s `Authority`).
//!
//! **Scope (MVP).** [`apply_command`] dispatches the command subset the engine already supports
//! (move/attack/equip/unequip/use/pickUp/drop + begin/end/nextPlayer). Every other command kind
//! is a clean [`SubmitResult::Denied`] (never a panic), pending sub-project A1/A2's engine-action
//! ports and C's seat/GM handling.
//!
//! **Denial parity (deferred).** The TS `resolver.apply` resolves every argument id through an
//! entity index that throws on a miss, so a command naming a nonexistent id is *denied*. The Rust
//! engine methods validate ids themselves, but not always identically (e.g. `move_to` to an
//! unknown room is a quiet no-op rather than a violation). Exact invalid-id denial parity with the
//! oracle is aligned when B's differential gate replays TS-emitted goldens — the machinery here
//! (authorize → apply → restore-on-violation → diff → commit → log) is what this slice proves.

use alloc::string::String;
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};

use crate::error::ProceduralViolation;
use crate::presentation::PresentationCue;
use crate::world::descriptor::Catalog;
use crate::world::snapshot::CampaignSnapshot;
use crate::world::World;

use super::authorize::{authorize, AuthResult};
use super::command::Command;
use super::delta::{diff, Delta};

/// An ordered, broadcast entry: the command and the delta it produced. Serializes as the wire
/// `WireLogEntry` (camelCase). Mirrors the TS `LogEntry`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub seq: u64,
    pub base_seq: u64,
    pub command: Command,
    pub delta: Delta,
}

/// The outcome of [`SyncAuthority::submit`]: committed with its delta, or a terminal denial.
/// A plain Rust enum — the wire framing (the TS `committed{seq,delta}` / `denied{reason}`
/// server messages) is sub-project C's concern.
#[derive(Clone, Debug, PartialEq)]
pub enum SubmitResult {
    Committed { seq: u64, delta: Delta },
    Denied { reason: String },
}

/// Construction options for a [`SyncAuthority`].
#[derive(Clone, Debug)]
pub struct AuthorityOpts {
    /// Checkpoint every N commits (the `load_snapshot` freshness cadence). Default 20.
    pub snapshot_every: u64,
    /// The seq the log starts above (for resuming a persisted campaign). Default 0.
    pub start_seq: u64,
}

impl Default for AuthorityOpts {
    fn default() -> Self {
        AuthorityOpts { snapshot_every: 20, start_seq: 0 }
    }
}

/// The single authority over a campaign's state: the live [`World`], the committed ordered log,
/// and the latest checkpoint.
pub struct SyncAuthority {
    world: World,
    catalog: Catalog,
    log: Vec<LogEntry>,
    checkpoint: (u64, CampaignSnapshot),
    snapshot_every: u64,
    start_seq: u64,
}

impl SyncAuthority {
    /// Builds an authority over `world` (the genesis) resolving commands against `catalog`.
    pub fn new(world: World, catalog: Catalog, opts: AuthorityOpts) -> Self {
        let checkpoint = (opts.start_seq, world.to_snapshot());
        SyncAuthority {
            world,
            catalog,
            log: Vec::new(),
            checkpoint,
            snapshot_every: opts.snapshot_every.max(1),
            start_seq: opts.start_seq,
        }
    }

    /// Highest committed seq (`start_seq` when the log is empty).
    pub fn head(&self) -> u64 {
        self.log.last().map_or(self.start_seq, |e| e.seq)
    }

    /// The latest checkpoint (the genesis until the first `snapshot_every` commit).
    pub fn load_snapshot(&self) -> &(u64, CampaignSnapshot) {
        &self.checkpoint
    }

    /// Committed entries with `seq >= from_seq`, in order.
    pub fn entries_since(&self, from_seq: u64) -> Vec<LogEntry> {
        self.log.iter().filter(|e| e.seq >= from_seq).cloned().collect()
    }

    /// Authorize → apply (restoring the pre-image on a [`ProceduralViolation`]) → diff → commit.
    /// Returns the committed `{ seq, delta }` or a terminal denial; state is never left
    /// half-mutated.
    pub fn submit(&mut self, command: Command) -> SubmitResult {
        if let AuthResult::Denied(reason) = authorize(&self.world, &command) {
            return SubmitResult::Denied { reason };
        }

        // Keep an exact pre-apply copy of the world (rng included) to roll back to on a
        // violation — a partially-applied-then-rejected command must leave nothing behind. A
        // direct clone is guaranteed faithful, where a snapshot round-trip need not be.
        let backup = self.world.clone();
        let before = self.world.to_snapshot();
        if let Err(v) = apply_command(&mut self.world, &command, &self.catalog) {
            self.world = backup;
            return SubmitResult::Denied { reason: v.0 };
        }

        let after = self.world.to_snapshot();
        let delta = diff(&before, &after);
        let seq = self.head() + 1;
        self.log.push(LogEntry { seq, base_seq: seq - 1, command, delta: delta.clone() });
        if seq.is_multiple_of(self.snapshot_every) {
            self.checkpoint = (seq, after);
        }
        SubmitResult::Committed { seq, delta }
    }
}

/// Dispatches an authorized command to the engine. Mirrors `resolver.ts` `apply` for the supported
/// subset; the engine resolves ids internally, so no separate entity index is needed. Cues are
/// collected into a throwaway buffer — they are not part of the state delta. Unsupported command
/// kinds return a [`ProceduralViolation`] (the caller turns it into a clean denial).
fn apply_command(
    world: &mut World,
    command: &Command,
    cat: &Catalog,
) -> Result<(), ProceduralViolation> {
    let mut cues: Vec<PresentationCue> = Vec::new();
    match command {
        Command::Move { actor_id, room_id } => world.move_to(actor_id, room_id.clone(), cat, &mut cues),
        Command::Attack { actor_id, target_id } => world.attack(actor_id, target_id, cat, &mut cues),
        Command::Equip { actor_id, item_id, .. } => world.equip(actor_id, item_id, cat, &mut cues),
        Command::Unequip { actor_id, item_id } => world.unequip(actor_id, item_id, cat, &mut cues),
        Command::Use { actor_id, item_id } => world.use_item(actor_id, item_id, cat, &mut cues),
        Command::PickUp { actor_id, item_ids } => {
            for id in item_ids {
                world.take(actor_id, id, cat, &mut cues)?;
            }
            Ok(())
        }
        Command::Drop { actor_id, item_ids } => {
            for id in item_ids {
                world.drop_item(actor_id, id, cat, &mut cues)?;
            }
            Ok(())
        }
        Command::BeginCampaign => world.begin_campaign(cat, &mut cues),
        Command::EndCampaign => world.end_campaign(&mut cues),
        Command::NextPlayer => world.next_player(cat, &mut cues),
        // A1/A2 engine-action ports, join/seat handling (C), and the mob commands are not yet
        // wired — a clean denial, never a panic (the modding trust boundary).
        _ => Err(ProceduralViolation(
            "command kind not yet supported by the Rust sync port".into(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::ids::{CharacterId, RoomId};
    use crate::world::test_support::{world_two_rooms, world_with_party};

    fn authority(world: World) -> SyncAuthority {
        SyncAuthority::new(world, Catalog::default(), AuthorityOpts::default())
    }

    #[test]
    fn commits_a_move_and_produces_a_delta() {
        let mut auth = authority(world_two_rooms(false));
        let res = auth.submit(Command::Move {
            actor_id: CharacterId("pc".into()),
            room_id: RoomId("next".into()),
        });
        match res {
            SubmitResult::Committed { seq, delta } => {
                assert_eq!(seq, 1);
                // Moving the pc changes its character snapshot and the two rooms' occupants.
                assert!(delta.changed.iter().any(|e| matches!(e, super::super::delta::EntitySnapshot::Character(_))));
                assert!(!delta.changed.is_empty());
            }
            SubmitResult::Denied { reason } => panic!("expected commit, denied: {reason}"),
        }
        assert_eq!(auth.head(), 1);
        assert_eq!(auth.entries_since(1).len(), 1);
    }

    #[test]
    fn authorize_denial_does_not_advance_the_log() {
        let mut auth = authority(world_two_rooms(false));
        // "other" is not the active character → authorize rejects.
        let res = auth.submit(Command::Move {
            actor_id: CharacterId("other".into()),
            room_id: RoomId("next".into()),
        });
        assert!(matches!(res, SubmitResult::Denied { .. }));
        assert_eq!(auth.head(), 0);
        assert!(auth.entries_since(1).is_empty());
    }

    #[test]
    fn violation_restores_the_pre_image_and_denies() {
        let mut auth = authority(world_two_rooms(false));
        let before = auth.world.to_snapshot();
        // Authorized (active pc, started, ongoing) but illegal: using an item the pc does not
        // hold throws a ProceduralViolation inside apply.
        let res = auth.submit(Command::Use {
            actor_id: CharacterId("pc".into()),
            item_id: crate::world::ids::ItemId("ghost-item".into()),
        });
        assert!(matches!(res, SubmitResult::Denied { .. }));
        assert_eq!(auth.head(), 0, "a denied command commits nothing");
        assert_eq!(auth.world.to_snapshot(), before, "state must be fully restored");
    }

    #[test]
    fn unsupported_command_is_denied_not_panicked() {
        // craft is authorized as a turn-action but not yet wired → clean denial.
        let mut auth = authority(world_two_rooms(false));
        let res = auth.submit(Command::Craft {
            actor_id: CharacterId("pc".into()),
            recipe_id: "torch".into(),
        });
        assert!(matches!(res, SubmitResult::Denied { .. }));
        assert_eq!(auth.head(), 0);
    }

    #[test]
    fn sequencing_increments_and_entries_since_filters() {
        // A GM `nextPlayer` twice over a 2-player party: index 0 -> 1 -> 0 (end_round).
        let mut world = world_with_party(&["a", "b"], 10);
        world.campaign.gm_id = Some(CharacterId("a".into()));
        let mut auth = authority(world);
        assert!(matches!(auth.submit(Command::NextPlayer), SubmitResult::Committed { seq: 1, .. }));
        assert!(matches!(auth.submit(Command::NextPlayer), SubmitResult::Committed { seq: 2, .. }));
        assert_eq!(auth.head(), 2);
        assert_eq!(auth.entries_since(2).len(), 1, "entries_since(2) is just the second commit");
        assert_eq!(auth.entries_since(1).len(), 2);
    }

    #[test]
    fn checkpoint_advances_on_the_snapshot_cadence() {
        let mut world = world_with_party(&["a", "b"], 100);
        world.campaign.gm_id = Some(CharacterId("a".into()));
        let mut auth = SyncAuthority::new(
            world,
            Catalog::default(),
            AuthorityOpts { snapshot_every: 2, start_seq: 0 },
        );
        assert_eq!(auth.load_snapshot().0, 0, "genesis checkpoint until the cadence");
        auth.submit(Command::NextPlayer); // seq 1
        assert_eq!(auth.load_snapshot().0, 0);
        auth.submit(Command::NextPlayer); // seq 2 -> checkpoint
        assert_eq!(auth.load_snapshot().0, 2);
    }
}
