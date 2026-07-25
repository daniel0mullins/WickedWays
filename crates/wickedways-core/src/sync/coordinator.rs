//! The [`SyncTransport`] seam + [`InProcessTransport`] + [`SyncCoordinator`] — the client-side
//! replica driver (Phase 2c, sub-project B, slice 4).
//!
//! Mirrors `src/lib/sync/transport.ts` + `coordinator.ts`. A [`SyncCoordinator`] owns a local
//! replica [`World`], submits commands to an authority through a [`SyncTransport`], and applies the
//! authoritative deltas the transport exposes — it never resolves commands itself and never
//! optimistically mutates, so there is no rollback and no CAS conflict.
//!
//! The TS coordinator uses a *push* subscription (the transport calls a handler per committed
//! entry). This in-process port is *pull*-based instead: after a submit — and on demand via
//! [`SyncCoordinator::sync`] — the coordinator drains `entries_since` in order and applies each
//! delta. Pull is sufficient (and far simpler in Rust) for the single-process and test paths; the
//! genuinely-async push transport is a WebSocket concern for sub-projects C/D.

use alloc::vec::Vec;

use crate::presentation::{PresentationCue, StatusField};
use crate::world::snapshot::CampaignSnapshot;
use crate::world::World;

use super::applier::apply;
use super::authority::{LogEntry, SubmitResult, SyncAuthority};
use super::command::Command;

/// The ordered, broadcast surface a [`SyncCoordinator`] submits commands to and reads entries
/// from. The in-process impl wraps a [`SyncAuthority`]; a WebSocket impl (C/D) forwards to the
/// room server. Only this trait and the coordinator need know the difference.
pub trait SyncTransport {
    /// Highest committed seq.
    fn head(&self) -> u64;
    /// Submit a command; returns the committed delta or a denial.
    fn submit(&mut self, command: Command) -> SubmitResult;
    /// Entries with `seq >= from_seq`, in order.
    fn entries_since(&self, from_seq: u64) -> Vec<LogEntry>;
    /// The latest checkpoint `(seq, snapshot)`.
    fn load_snapshot(&self) -> (u64, CampaignSnapshot);
}

/// In-process [`SyncTransport`]: wraps a [`SyncAuthority`] directly (the single-player / test host).
pub struct InProcessTransport {
    authority: SyncAuthority,
}

impl InProcessTransport {
    pub fn new(authority: SyncAuthority) -> Self {
        InProcessTransport { authority }
    }

    /// The live authoritative snapshot (for tests / convergence assertions).
    pub fn current_snapshot(&self) -> CampaignSnapshot {
        self.authority.snapshot()
    }
}

impl SyncTransport for InProcessTransport {
    fn head(&self) -> u64 {
        self.authority.head()
    }
    fn submit(&mut self, command: Command) -> SubmitResult {
        self.authority.submit(command)
    }
    fn entries_since(&self, from_seq: u64) -> Vec<LogEntry> {
        self.authority.entries_since(from_seq)
    }
    fn load_snapshot(&self) -> (u64, CampaignSnapshot) {
        let (seq, snap) = self.authority.load_snapshot();
        (*seq, snap.clone())
    }
}

/// A replica of a campaign synchronized against an authoritative transport.
pub struct SyncCoordinator {
    replica: World,
    last_applied: u64,
    /// The most recent campaign `Status` readout absorbed from an applied delta's cues, or empty
    /// until one arrives. Surfaces render it as the status bar (the delta model can't re-derive it).
    latest_status: Vec<StatusField>,
}

impl SyncCoordinator {
    /// Builds a replica from the transport's latest checkpoint, then catches it up to head.
    pub fn join<T: SyncTransport>(transport: &T) -> Self {
        let (seq, snap) = transport.load_snapshot();
        let mut coord = SyncCoordinator {
            replica: World::from_snapshot(snap),
            last_applied: seq,
            latest_status: Vec::new(),
        };
        coord.sync(transport);
        coord
    }

    /// The most recent campaign `Status` fields (empty until a `Status` cue has been applied). Kept
    /// live from every applied delta's cues, so it reflects the current turn's readout.
    pub fn status_fields(&self) -> &[StatusField] {
        &self.latest_status
    }

    /// The current replica state as a snapshot.
    pub fn snapshot(&self) -> CampaignSnapshot {
        self.replica.to_snapshot()
    }

    /// The live replica (read-only).
    pub fn replica(&self) -> &World {
        &self.replica
    }

    /// Submits a command to the authority; on success the authoritative delta has been applied to
    /// the local replica by the time this returns. A denial leaves the replica untouched.
    pub fn submit<T: SyncTransport>(
        &mut self,
        transport: &mut T,
        command: Command,
    ) -> SubmitResult {
        let res = transport.submit(command);
        self.sync(transport);
        res
    }

    /// Applies every not-yet-seen committed entry, in order, up to the transport's head. Out-of-order
    /// or already-seen entries are skipped (a gap heals on the next call once the run is contiguous).
    pub fn sync<T: SyncTransport>(&mut self, transport: &T) {
        let head = transport.head();
        for entry in transport.entries_since(self.last_applied + 1) {
            if entry.seq > head {
                break;
            }
            if entry.seq == self.last_applied + 1 {
                apply(&mut self.replica, &entry.delta);
                // Absorb the delta's presentation cues: keep the latest campaign `Status` readout so
                // surfaces can render the status bar (state alone can't reconstruct it).
                for cue in &entry.delta.cues {
                    if let PresentationCue::Status { fields } = cue {
                        self.latest_status = fields.clone();
                    }
                }
                self.last_applied = entry.seq;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::authority::AuthorityOpts;
    use crate::world::descriptor::Catalog;
    use crate::world::ids::{CharacterId, RoomId};
    use crate::world::test_support::world_two_rooms;

    fn transport(world: World) -> InProcessTransport {
        InProcessTransport::new(SyncAuthority::new(
            world,
            Catalog::default(),
            AuthorityOpts::default(),
        ))
    }

    #[test]
    fn a_fresh_replica_matches_the_authority_at_join() {
        // Also asserts to_snapshot(from_snapshot(genesis)) round-trips: the coordinator seeds its
        // replica via from_snapshot, so a join-time match proves snapshot idempotency here.
        let t = transport(world_two_rooms(false));
        let coord = SyncCoordinator::join(&t);
        assert_eq!(
            coord.snapshot(),
            t.current_snapshot(),
            "replica must equal the authority at join"
        );
    }

    #[test]
    fn submit_applies_the_authoritative_delta_locally() {
        let mut t = transport(world_two_rooms(false));
        let mut coord = SyncCoordinator::join(&t);
        let res = coord.submit(
            &mut t,
            Command::Move {
                actor_id: CharacterId("pc".into()),
                room_id: RoomId("next".into()),
            },
        );
        assert!(matches!(res, SubmitResult::Committed { .. }));
        assert_eq!(
            coord.snapshot(),
            t.current_snapshot(),
            "submitter's replica reflects its own commit"
        );
    }

    #[test]
    fn a_second_replica_converges_after_sync() {
        let mut t = transport(world_two_rooms(false));
        let mut a = SyncCoordinator::join(&t);
        let mut b = SyncCoordinator::join(&t);
        // `a` acts; `b` is unaware until it syncs.
        a.submit(
            &mut t,
            Command::Move {
                actor_id: CharacterId("pc".into()),
                room_id: RoomId("next".into()),
            },
        );
        assert_ne!(b.snapshot(), a.snapshot(), "b has not synced yet");
        b.sync(&t);
        assert_eq!(b.snapshot(), a.snapshot(), "b converges to a");
        assert_eq!(b.snapshot(), t.current_snapshot(), "…and to the authority");
    }

    #[test]
    fn a_denied_command_leaves_the_replica_untouched() {
        let mut t = transport(world_two_rooms(false));
        let mut coord = SyncCoordinator::join(&t);
        let before = coord.snapshot();
        // Not the active character → authority denies; nothing to apply.
        let res = coord.submit(
            &mut t,
            Command::Move {
                actor_id: CharacterId("ghost".into()),
                room_id: RoomId("next".into()),
            },
        );
        assert!(matches!(res, SubmitResult::Denied { .. }));
        assert_eq!(
            coord.snapshot(),
            before,
            "a denial does not mutate the replica"
        );
    }
}
