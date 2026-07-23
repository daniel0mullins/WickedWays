//! The single-player transport (Phase 2c, sub-project D — slice 4).
//!
//! "Single-player is multiplayer with one seat and an in-process authority" (the master-design
//! carry): both modes drive a [`SyncCoordinator`], and only the transport differs. Multiplayer
//! injects [`WsTransport`](crate::transport::WsTransport) (a WebSocket to the room server);
//! single-player injects this [`SinglePlayerTransport`], which wraps a local [`SyncAuthority`]
//! directly — no socket, no server, fully offline.
//!
//! It exposes the **same seam the surfaces already use**: the synchronous [`SyncTransport`] reads the
//! coordinator drains (`head`/`entries_since`/`load_snapshot`) plus an async
//! [`submit_async`](SinglePlayerTransport::submit_async) matching [`WsTransport`]'s signature, so the
//! driver loop is transport-agnostic. The authority resolves in-process, so `submit_async` completes
//! immediately (no real await) — the async signature exists only to unify the two transports.
//!
//! Interior mutability ([`RefCell`]) mirrors [`WsTransport`]'s `Rc<RefCell<_>>`: the coordinator's
//! synchronous reads borrow the authority while the app holds the transport by shared reference.
//!
//! [`SyncTransport`]: wickedways_core::sync::SyncTransport
//! [`WsTransport`]: crate::transport::WsTransport

use std::cell::RefCell;

use wickedways_core::sync::{
    AuthorityOpts, Command, LogEntry, SubmitResult, SyncAuthority, SyncTransport,
};
use wickedways_core::world::descriptor::Catalog;
use wickedways_core::{CampaignSnapshot, World};

/// An in-process [`SyncTransport`] over a local [`SyncAuthority`] — the offline single-player host.
pub struct SinglePlayerTransport {
    authority: RefCell<SyncAuthority>,
}

impl SinglePlayerTransport {
    /// Seed a fresh authority from a genesis world + catalog (the same construction the room server
    /// does per campaign: `World::from_snapshot(genesis)` → `SyncAuthority::new`).
    pub fn new(genesis: World, catalog: Catalog) -> Self {
        // Solo mode: the offline host runs the full single-player turn loop (start_turn → action →
        // mob reactions → next_player) around each time-advancing command, so dread ticks, mobs
        // strike back, and rounds advance without a GM — the multiplayer server leaves this off.
        let authority =
            SyncAuthority::new(genesis, catalog, AuthorityOpts { solo: true, ..AuthorityOpts::default() });
        Self { authority: RefCell::new(authority) }
    }

    /// Submit a command to the local authority and return its verdict. Async only to match
    /// [`WsTransport::submit_async`](crate::transport::WsTransport::submit_async) — the authority is
    /// in-process, so this resolves without ever yielding.
    pub async fn submit_async(&self, command: Command) -> SubmitResult {
        self.authority.borrow_mut().submit(command)
    }

    /// The live authoritative snapshot (for tests / convergence assertions).
    pub fn current_snapshot(&self) -> CampaignSnapshot {
        self.authority.borrow().snapshot()
    }

    /// Teardown symmetry with [`WsTransport::close`](crate::transport::WsTransport::close) — nothing
    /// to release for an in-process authority.
    pub fn close(&self) {}
}

impl SyncTransport for SinglePlayerTransport {
    fn head(&self) -> u64 {
        self.authority.borrow().head()
    }

    fn submit(&mut self, command: Command) -> SubmitResult {
        self.authority.borrow_mut().submit(command)
    }

    fn entries_since(&self, from_seq: u64) -> Vec<LogEntry> {
        self.authority.borrow().entries_since(from_seq)
    }

    fn load_snapshot(&self) -> (u64, CampaignSnapshot) {
        let auth = self.authority.borrow();
        let (seq, snap) = auth.load_snapshot();
        (*seq, snap.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wickedways_core::sync::SyncCoordinator;
    use wickedways_core::world::ids::{CharacterId, RoomId};

    /// A committed `started` genesis snapshot (the same `demo` fixture the browser e2e serves). Seeds
    /// a real two-character campaign so submits are authorized without a server.
    const GENESIS: &str = include_str!("../../../conformance/fixtures/sync-move.genesis.json");

    fn genesis_world() -> World {
        World::from_snapshot(serde_json::from_str(GENESIS).expect("genesis fixture parses"))
    }

    #[test]
    fn join_seeds_the_replica_from_the_local_authority() {
        let t = SinglePlayerTransport::new(genesis_world(), Catalog::default());
        let coord = SyncCoordinator::join(&t);
        assert_eq!(coord.snapshot(), t.current_snapshot(), "replica must equal the authority at join");
    }

    #[test]
    fn submit_commits_offline_and_the_replica_applies_the_delta() {
        let mut t = SinglePlayerTransport::new(genesis_world(), Catalog::default());
        let mut coord = SyncCoordinator::join(&t);
        let head_before = t.head();
        // `nextPlayer` is a GM/lifecycle op needing no ids — the same command the surfaces' GM
        // control submits — so it commits against the fixture without a catalog.
        let res = coord.submit(&mut t, Command::NextPlayer);
        assert!(matches!(res, SubmitResult::Committed { .. }), "offline submit should commit");
        assert_eq!(t.head(), head_before + 1, "the authority advanced its log");
        assert_eq!(coord.snapshot(), t.current_snapshot(), "the replica converged to the authority");
    }

    #[test]
    fn a_second_coordinator_converges_after_sync() {
        let mut t = SinglePlayerTransport::new(genesis_world(), Catalog::default());
        let mut a = SyncCoordinator::join(&t);
        let b = SyncCoordinator::join(&t);
        a.submit(&mut t, Command::NextPlayer);
        assert_ne!(b.snapshot(), a.snapshot(), "b has not synced yet");
        let mut b = b;
        b.sync(&t);
        assert_eq!(b.snapshot(), a.snapshot(), "b converges to a");
        assert_eq!(b.snapshot(), t.current_snapshot(), "…and to the authority");
    }

    #[test]
    fn a_denied_command_leaves_the_replica_untouched() {
        let mut t = SinglePlayerTransport::new(genesis_world(), Catalog::default());
        let mut coord = SyncCoordinator::join(&t);
        let before = coord.snapshot();
        // A nonexistent actor is not the active character → the authority denies; nothing to apply.
        let res = coord.submit(
            &mut t,
            Command::Move { actor_id: CharacterId("ghost".into()), room_id: RoomId("nowhere".into()) },
        );
        assert!(matches!(res, SubmitResult::Denied { .. }), "an unauthorized command is denied");
        assert_eq!(coord.snapshot(), before, "a denial does not mutate the replica");
    }
}
