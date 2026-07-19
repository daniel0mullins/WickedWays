//! The per-campaign coordinator + actor (Phase 2c, sub-project C — slice 2).
//!
//! Ports `packages/server/src/table.ts`. A [`Table`] wraps the engine [`SyncAuthority`] (the single
//! source of truth) and the participant set, emitting ordered [`ServerMsg`]s through subscriber
//! callbacks: the submitter gets `committed{seq,delta}`, every other participant gets
//! `entry{seq,delta}`. With a store installed, a commit is persisted **before** it is acked/broadcast
//! (flush-before-ack); a persist failure rolls the campaign back via [`reload`](Table::reload) and
//! denies the submitter. Named `Table` (not `Room`) to avoid colliding with the engine's `Room`.
//!
//! On top of the core, [`spawn_table`] runs a `Table` as a **per-campaign tokio actor**: a single
//! task drains an mpsc queue, so every submit → persist → ack is processed strictly in order with no
//! shared mutable state across `.await`. That is the concurrency decision the TS code flags but
//! cannot make (its `persist` thunk "would need per-campaign submit serialization" under a genuinely
//! async store, `table.ts`/`server.ts`); different campaigns still run concurrently, each on its own
//! task. Store I/O runs on the blocking pool via `spawn_blocking` (rusqlite is synchronous).

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
use wickedways_core::sync::{AuthorityOpts, Command, SubmitResult, SyncAuthority};
use wickedways_core::world::descriptor::Catalog;
use wickedways_core::{CampaignSnapshot, World};

use crate::membership::Membership;
use crate::store::{CampaignRecord, CampaignStore, StoreError};
use crate::transport::{ServerMsg, WireLogEntry};

/// A per-connection identity for the participant map (Rust closures are not comparable, so seats in
/// the participant set are keyed by this rather than by callback identity).
pub type ConnId = u64;

/// A connected participant: receives ordered server messages for one [`Table`]. The real transport
/// (slice 3) feeds a WebSocket sink; tests feed a closure over a shared buffer.
pub type Subscriber = Arc<dyn Fn(ServerMsg) + Send + Sync>;

/// Runs after the in-memory commit and before persistence, so a seat-claim it performs on the
/// membership is written in the SAME atomic `save` as the commit (closes the orphaned-character
/// window on join). Ported from `table.ts`'s `onCommit`.
pub type OnCommit = Box<dyn FnOnce(&mut Membership) + Send>;

/// The outcome of [`Table::submit`]: committed with its seq, or not committed (denied or
/// persist-failed). The wire messages are emitted to subscribers as a side effect; this is the
/// caller-facing summary (mirrors `table.ts`'s return object).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SubmitOutcome {
    Committed { seq: u64 },
    NotCommitted,
}

/// The server-side coordinator for one campaign's session — the virtual tabletop.
pub struct Table {
    authority: SyncAuthority,
    membership: Membership,
    participants: HashMap<ConnId, Subscriber>,
    /// Durable store; `None` = ephemeral (persist/reload are no-ops), matching the TS default hooks.
    store: Option<Arc<dyn CampaignStore>>,
    campaign_id: String,
    /// Kept so [`reload`](Table::reload) can rebuild the authority identically to how it was built.
    catalog: Catalog,
    snapshot_every: u64,
    /// The state to fall back to on `reload` when the store holds no record yet (a never-persisted
    /// campaign): the snapshot/seq/GM the table was constructed with. Mirrors the TS
    /// `genesisFor(id)` + `new Membership(gmIdentityFor(id))` fallback.
    base_snapshot: CampaignSnapshot,
    base_seq: u64,
    base_gm_identity: String,
}

impl Table {
    /// Builds a table over `authority` with the given seat `membership`. `campaign_id`, `catalog`,
    /// and `snapshot_every` are retained so `reload` can rebuild the authority faithfully. Durability
    /// is off until [`set_store`](Table::set_store) installs a store.
    pub fn new(
        authority: SyncAuthority,
        membership: Membership,
        campaign_id: impl Into<String>,
        catalog: Catalog,
        snapshot_every: u64,
    ) -> Self {
        let base_snapshot = authority.snapshot();
        let base_seq = authority.head();
        let base_gm_identity = membership.gm_identity().to_string();
        Self {
            authority,
            membership,
            participants: HashMap::new(),
            store: None,
            campaign_id: campaign_id.into(),
            catalog,
            snapshot_every: snapshot_every.max(1),
            base_snapshot,
            base_seq,
            base_gm_identity,
        }
    }

    /// Installs the durable store (the ephemeral path never calls this).
    pub fn set_store(&mut self, store: Arc<dyn CampaignStore>) {
        self.store = Some(store);
    }

    /// Highest committed seq (`start_seq` when empty). Delegates to the authority.
    pub fn head(&self) -> u64 {
        self.authority.head()
    }

    /// The authority's current live state as a snapshot (what `persist` writes).
    pub fn current_snapshot(&self) -> CampaignSnapshot {
        self.authority.snapshot()
    }

    /// Read access to the seat map (presence/roster in slice 3).
    pub fn membership(&self) -> &Membership {
        &self.membership
    }

    /// Mutable access to the seat map (GM control messages in slice 3).
    pub fn membership_mut(&mut self) -> &mut Membership {
        &mut self.membership
    }

    /// Registers a participant, acks the current head, then backfills entries after `from_seq`.
    pub fn join(&mut self, conn: ConnId, sub: Subscriber, from_seq: u64) {
        sub(ServerMsg::Joined { head: self.head() });
        for e in self.authority.entries_since(from_seq + 1) {
            sub(ServerMsg::Entry { entry: wire_entry(&e.command, &e.delta, e.seq, e.base_seq) });
        }
        self.participants.insert(conn, sub);
    }

    /// Removes a participant (e.g. on disconnect).
    pub fn leave(&mut self, conn: ConnId) {
        self.participants.remove(&conn);
    }

    /// Sends the authority's latest checkpoint to `requester` (read-only; pre-auth in slice 3).
    pub fn send_snapshot(&self, requester: &Subscriber) {
        let (seq, snapshot) = self.authority.load_snapshot();
        requester(ServerMsg::Snapshot {
            seq: *seq,
            snapshot: serde_json::to_value(snapshot).unwrap_or(Value::Null),
        });
    }

    /// Sends a server message to every current participant (used for presence).
    pub fn broadcast(&self, msg: ServerMsg) {
        for p in self.participants.values() {
            p(msg.clone());
        }
    }

    /// Resolves a command through the authority. `on_commit` (if given) runs AFTER the in-memory
    /// commit and BEFORE persistence, so a seat-claim it performs is written in the SAME atomic
    /// `save` as the commit. On commit: persist (flush-before-ack), then ack `sender` with
    /// `committed` and broadcast `entry` to every OTHER participant. On a persist failure: `reload`
    /// (discarding the un-persisted commit + any `on_commit` mutation) and deny `sender` only. On an
    /// authority denial: deny `sender` only.
    pub async fn submit(
        &mut self,
        command: Command,
        sender: &Subscriber,
        on_commit: Option<OnCommit>,
    ) -> SubmitOutcome {
        let (seq, delta) = match self.authority.submit(command.clone()) {
            SubmitResult::Denied { reason } => {
                sender(ServerMsg::Denied { reason });
                return SubmitOutcome::NotCommitted;
            }
            SubmitResult::Committed { seq, delta } => (seq, delta),
        };

        if let Some(f) = on_commit {
            f(&mut self.membership);
        }

        if self.persist().await.is_err() {
            // Revert campaign + membership to the last durable record, then deny the submitter only.
            self.reload().await;
            sender(ServerMsg::Denied { reason: "could not persist; retry".into() });
            return SubmitOutcome::NotCommitted;
        }

        let delta = serde_json::to_value(&delta).unwrap_or(Value::Null);
        let command = serde_json::to_value(&command).unwrap_or(Value::Null);
        sender(ServerMsg::Committed { seq, delta: delta.clone() });
        let entry = WireLogEntry { seq, base_seq: seq - 1, command, delta };
        for p in self.participants.values() {
            // Exclude the submitter (who already got `committed`); a not-yet-joined submitter is
            // simply absent from the map, so nothing special is needed.
            if !Arc::ptr_eq(p, sender) {
                p(ServerMsg::Entry { entry: entry.clone() });
            }
        }
        SubmitOutcome::Committed { seq }
    }

    /// Writes the current durable record (no-op without a store). Snapshot + membership are written
    /// in one `save`, so they land atomically. Runs on the blocking pool (rusqlite is synchronous).
    pub async fn persist(&self) -> Result<(), StoreError> {
        let Some(store) = self.store.clone() else { return Ok(()) };
        let record = CampaignRecord {
            seq: self.authority.head(),
            snapshot: self.authority.snapshot(),
            membership: self.membership.to_state(),
        };
        let id = self.campaign_id.clone();
        run_blocking(move || store.save(&id, &record)).await
    }

    /// Rebuilds the authority + membership from the last durable record (no-op without a store),
    /// discarding any un-persisted commit. Falls back to the construction state when the store holds
    /// no record yet. Mirrors the TS `reload` hook.
    pub async fn reload(&mut self) {
        let Some(store) = self.store.clone() else { return };
        let id = self.campaign_id.clone();
        let loaded = run_blocking(move || store.load(&id)).await;
        let (snapshot, seq, membership) = match loaded {
            Ok(Some(rec)) => (rec.snapshot, rec.seq, Membership::from_state(rec.membership)),
            // Load failed or empty: fall back to the construction state (never-persisted campaign).
            _ => (
                self.base_snapshot.clone(),
                self.base_seq,
                Membership::new(self.base_gm_identity.clone()),
            ),
        };
        self.authority = SyncAuthority::new(
            World::from_snapshot(snapshot),
            self.catalog.clone(),
            AuthorityOpts { snapshot_every: self.snapshot_every, start_seq: seq },
        );
        self.membership = membership;
    }
}

/// Builds a `WireLogEntry` (opaque `command`/`delta`) from a typed authority log entry.
fn wire_entry(command: &Command, delta: &wickedways_core::sync::Delta, seq: u64, base_seq: u64) -> WireLogEntry {
    WireLogEntry {
        seq,
        base_seq,
        command: serde_json::to_value(command).unwrap_or(Value::Null),
        delta: serde_json::to_value(delta).unwrap_or(Value::Null),
    }
}

/// Runs a synchronous store call on the blocking pool, flattening the join error into a
/// [`StoreError`] so a task panic surfaces as a persist failure (the room stays alive).
async fn run_blocking<T, F>(f: F) -> Result<T, StoreError>
where
    F: FnOnce() -> Result<T, StoreError> + Send + 'static,
    T: Send + 'static,
{
    match tokio::task::spawn_blocking(f).await {
        Ok(r) => r,
        Err(_join) => Err(StoreError::Task("store task panicked".into())),
    }
}

// ── the actor ──────────────────────────────────────────────────────────────────────────────────

/// A message to a running [`Table`] actor. Processed strictly in arrival order by the single task,
/// so submit → persist → ack is atomic per campaign for free.
pub enum TableMsg {
    Join { conn: ConnId, sub: Subscriber, from_seq: u64 },
    Leave { conn: ConnId },
    Submit { command: Command, sender: Subscriber, on_commit: Option<OnCommit>, reply: oneshot::Sender<SubmitOutcome> },
    GetSnapshot { requester: Subscriber },
    Broadcast { msg: ServerMsg },
    Head { reply: oneshot::Sender<u64> },
    CurrentSnapshot { reply: oneshot::Sender<CampaignSnapshot> },
    /// Run a closure against the seat map (GM control messages, presence reads) under the actor's
    /// serialization, with an optional follow-up reply.
    WithMembership { f: Box<dyn FnOnce(&mut Membership) + Send>, reply: oneshot::Sender<()> },
}

/// A handle to a running [`Table`] actor: cloneable, cheap, and the only way to reach the campaign's
/// state once it is spawned.
#[derive(Clone)]
pub struct TableHandle {
    tx: mpsc::Sender<TableMsg>,
}

impl TableHandle {
    /// Registers a participant and backfills entries after `from_seq`.
    pub async fn join(&self, conn: ConnId, sub: Subscriber, from_seq: u64) {
        let _ = self.tx.send(TableMsg::Join { conn, sub, from_seq }).await;
    }

    /// Removes a participant.
    pub async fn leave(&self, conn: ConnId) {
        let _ = self.tx.send(TableMsg::Leave { conn }).await;
    }

    /// Submits a command; resolves once the actor has committed-or-denied (and persisted) it.
    pub async fn submit(
        &self,
        command: Command,
        sender: Subscriber,
        on_commit: Option<OnCommit>,
    ) -> SubmitOutcome {
        let (reply, rx) = oneshot::channel();
        if self.tx.send(TableMsg::Submit { command, sender, on_commit, reply }).await.is_err() {
            return SubmitOutcome::NotCommitted;
        }
        rx.await.unwrap_or(SubmitOutcome::NotCommitted)
    }

    /// Sends the latest checkpoint to `requester`.
    pub async fn get_snapshot(&self, requester: Subscriber) {
        let _ = self.tx.send(TableMsg::GetSnapshot { requester }).await;
    }

    /// Broadcasts a message to every participant.
    pub async fn broadcast(&self, msg: ServerMsg) {
        let _ = self.tx.send(TableMsg::Broadcast { msg }).await;
    }

    /// The current committed head.
    pub async fn head(&self) -> u64 {
        let (reply, rx) = oneshot::channel();
        if self.tx.send(TableMsg::Head { reply }).await.is_err() {
            return 0;
        }
        rx.await.unwrap_or(0)
    }

    /// The current live snapshot.
    pub async fn current_snapshot(&self) -> Option<CampaignSnapshot> {
        let (reply, rx) = oneshot::channel();
        if self.tx.send(TableMsg::CurrentSnapshot { reply }).await.is_err() {
            return None;
        }
        rx.await.ok()
    }

    /// Runs `f` against the seat map under the actor's serialization; resolves when done.
    pub async fn with_membership(&self, f: impl FnOnce(&mut Membership) + Send + 'static) {
        let (reply, rx) = oneshot::channel();
        if self.tx.send(TableMsg::WithMembership { f: Box::new(f), reply }).await.is_err() {
            return;
        }
        let _ = rx.await;
    }
}

/// Spawns `table` as a per-campaign actor and returns a handle to it. The task ends when every
/// handle is dropped (the mpsc closes).
pub fn spawn_table(table: Table) -> TableHandle {
    let (tx, mut rx) = mpsc::channel::<TableMsg>(64);
    tokio::spawn(async move {
        let mut table = table;
        while let Some(msg) = rx.recv().await {
            match msg {
                TableMsg::Join { conn, sub, from_seq } => table.join(conn, sub, from_seq),
                TableMsg::Leave { conn } => table.leave(conn),
                TableMsg::Submit { command, sender, on_commit, reply } => {
                    let out = table.submit(command, &sender, on_commit).await;
                    let _ = reply.send(out);
                }
                TableMsg::GetSnapshot { requester } => table.send_snapshot(&requester),
                TableMsg::Broadcast { msg } => table.broadcast(msg),
                TableMsg::Head { reply } => {
                    let _ = reply.send(table.head());
                }
                TableMsg::CurrentSnapshot { reply } => {
                    let _ = reply.send(table.current_snapshot());
                }
                TableMsg::WithMembership { f, reply } => {
                    f(table.membership_mut());
                    let _ = reply.send(());
                }
            }
        }
    });
    TableHandle { tx }
}
