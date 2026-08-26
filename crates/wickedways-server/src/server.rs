//! The room server: connection lifecycle + axum WebSocket handler.
//!
//! The **multiplayer** message loop: a host-configured [`RoomServer`] holds a
//! [`Table`](crate::table::Table) actor per campaign (built lazily from `genesis_for`), gates every
//! append by seat ownership, and drives presence/roster. Each connection authenticates on `join`;
//! writes (`submit`) require an authenticated connection and a seat the caller owns. The only
//! server-owned gate is seat ownership, checked against the actor the server reads from the command
//! itself — no client-supplied actor envelope exists to forge.
//!
//! Chat and A/V (`chatSend`/`callJoin`/`signal`/…) are **not implemented yet**: an inbound chat/AV
//! frame is simply an unknown `ClientMsg` variant here (rejected as malformed) until those arms are
//! added.
//!
//! The axum `/ws` handler is a thin adapter: it bridges the synchronous [`Subscriber`] callback the
//! `Table` expects to the async WebSocket sink via an unbounded channel, then feeds parsed frames to
//! [`Connection::handle`]. The connection lifecycle logic lives on [`Connection`] so it is unit-tested
//! directly against a recording sink; the two-client over-a-real-socket proof lives in `tests/e2e.rs`.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use axum::routing::{any, get};
use axum::Router;
use serde_json::Value;
use wickedways_core::sync::{AuthorityOpts, Command, SyncAuthority};
use wickedways_core::world::descriptor::Catalog;
use wickedways_core::world::rng::Rng;
use wickedways_core::world::snapshot::SCHEMA_VERSION;
use wickedways_core::{CampaignSnapshot, World};

use crate::membership::{actor_of, Membership};
use crate::store::{CampaignStore, MembershipState};
use crate::table::{
    spawn_table, ConnId, GmOp, OnCommit, SubmitOutcome, Subscriber, Table, TableHandle,
};
use crate::transport::{Actor, ClientMsg, GmPresence, PlayerEntry, PresenceEntry, ServerMsg};

/// Host-supplied verifier: maps a connection token to its authenticated identity, or `None` to deny.
pub type VerifyToken = Box<dyn Fn(&str) -> Option<String> + Send + Sync>;
/// Host-supplied: the designated GM identity for a campaign (seeds its membership).
pub type GmIdentityFor = Box<dyn Fn(&str) -> String + Send + Sync>;
/// Host-supplied genesis for a campaign, or `None` to reject it as unknown.
pub type GenesisFor = Box<dyn Fn(&str) -> Option<CampaignSnapshot> + Send + Sync>;
/// Optional host-supplied per-campaign catalog resolver. `Some(catalog)` overrides the shared
/// [`ServerOptions::catalog`] for that campaign; `None` falls back to it. Lets one server host
/// several authored campaigns whose behaviors (victory scripts, item/exit/mechanic bodies) live in
/// their own catalogs, instead of forcing every campaign through a single global catalog.
pub type CatalogFor = Box<dyn Fn(&str) -> Option<Catalog> + Send + Sync>;
/// Optional display-name resolver for the `players` roster; defaults to the identity string.
pub type DisplayNameFor = Box<dyn Fn(&str) -> String + Send + Sync>;

/// Construction options for a [`RoomServer`] (multiplayer fields only; the chat/AV options —
/// `chat_store`, `ice_servers`, … — do not exist yet).
pub struct ServerOptions {
    pub verify_token: VerifyToken,
    pub gm_identity_for: GmIdentityFor,
    pub genesis_for: GenesisFor,
    pub display_name_for: Option<DisplayNameFor>,
    /// The catalog a campaign's authority resolves commands against when [`catalog_for`] returns
    /// `None` for it (or is unset) — the shared default.
    ///
    /// [`catalog_for`]: ServerOptions::catalog_for
    pub catalog: Catalog,
    /// Optional per-campaign catalog override; falls back to [`catalog`](ServerOptions::catalog).
    pub catalog_for: Option<CatalogFor>,
    /// Optional durable store; `None` = ephemeral (in-memory only).
    pub store: Option<Arc<dyn CampaignStore>>,
    /// Optional fixed rng seed for every campaign's authority (determinism in tests / replay).
    pub rng_seed: Option<u32>,
}

/// A running room server's shared state: the per-campaign table actors, per-campaign online counts,
/// and the host options. Cloneable via `Arc`; a `/ws` connection borrows it for its lifetime.
pub struct RoomServer {
    opts: ServerOptions,
    /// Loaded campaigns. A `std::sync::Mutex` held only for the brief get/insert — never across an
    /// `.await`. (Rust has two mutex flavors: this synchronous one blocks its whole worker thread,
    /// so it must be locked and released between await points; contrast `load_lock` below.)
    tables: Mutex<HashMap<String, TableHandle>>,
    /// campaign → identity → live-connection count (an identity is online while any connection lives).
    online: Mutex<HashMap<String, HashMap<String, u32>>>,
    /// Serializes campaign loads so two concurrent `join`s for the same campaign don't build two
    /// authorities (inflight dedup). Global rather than per-campaign because loads are rare; a
    /// future optimization is per-campaign inflight tracking.
    ///
    /// This one is tokio's **async** mutex — the flavor that MAY be held across an `.await`
    /// (waiters park their task, not their thread), which the slow store load underneath requires.
    load_lock: tokio::sync::Mutex<()>,
    /// Connection-id counter. An atomic is the thread-safe `next_conn += 1` with no lock at all.
    next_conn: AtomicU64,
}

impl RoomServer {
    /// Builds a room server over `opts`.
    pub fn new(opts: ServerOptions) -> Arc<Self> {
        Arc::new(Self {
            opts,
            tables: Mutex::new(HashMap::new()),
            online: Mutex::new(HashMap::new()),
            load_lock: tokio::sync::Mutex::new(()),
            next_conn: AtomicU64::new(0),
        })
    }

    fn next_conn_id(&self) -> ConnId {
        self.next_conn.fetch_add(1, Ordering::Relaxed)
    }

    /// The catalog a campaign's authority resolves against: the per-campaign override if
    /// [`ServerOptions::catalog_for`] provides one, else the shared [`ServerOptions::catalog`].
    fn catalog_for(&self, campaign_id: &str) -> Catalog {
        self.opts
            .catalog_for
            .as_ref()
            .and_then(|f| f(campaign_id))
            .unwrap_or_else(|| self.opts.catalog.clone())
    }

    /// A loaded campaign's handle, or `None` if not yet loaded. Brief lock, never held across await.
    fn get_table(&self, campaign_id: &str) -> Option<TableHandle> {
        self.tables.lock().unwrap().get(campaign_id).cloned()
    }

    /// Returns the campaign's table, loading it from the store (or `genesis_for`) on first use.
    /// `None` = unknown campaign, a store-load failure, or a schema mismatch (fail-closed). A store
    /// load runs on the blocking pool; the load lock dedups concurrent first-loads.
    async fn ensure_loaded(&self, campaign_id: &str) -> Option<TableHandle> {
        if let Some(h) = self.get_table(campaign_id) {
            return Some(h);
        }
        let _guard = self.load_lock.lock().await;
        // Another loader may have finished while we waited for the lock.
        if let Some(h) = self.get_table(campaign_id) {
            return Some(h);
        }

        let rec = match &self.opts.store {
            Some(store) => {
                let store = store.clone();
                let id = campaign_id.to_string();
                match tokio::task::spawn_blocking(move || store.load(&id)).await {
                    Ok(Ok(rec)) => rec,
                    // Load failure (or the blocking task dying) is treated as "campaign not found"
                    // — the campaign is not wedged, a later ensure_loaded retries.
                    _ => return None,
                }
            }
            None => None,
        };

        let (genesis, seq, membership) = match rec {
            Some(rec) => {
                if rec.snapshot.schema_version != SCHEMA_VERSION {
                    eprintln!(
                        "[persistence] campaign {campaign_id}: snapshot schemaVersion {} != {SCHEMA_VERSION}; refusing to resume (migration required)",
                        rec.snapshot.schema_version
                    );
                    return None; // fail closed — do NOT build a genesis table (that would overwrite the record)
                }
                (
                    rec.snapshot,
                    rec.seq,
                    Membership::from_state(rec.membership),
                )
            }
            None => {
                let genesis = (self.opts.genesis_for)(campaign_id)?;
                let gm_identity = (self.opts.gm_identity_for)(campaign_id);
                let mut membership = Membership::new(gm_identity.clone());
                // The GM plays its own pre-seated character (the genesis `gmId`), not just narrates:
                // give the GM identity that seat so it can take turns, while other players self-join
                // theirs. Without this the GM could issue GM commands but never move.
                if let Some(gm_char) = genesis.campaign.gm_id.as_ref() {
                    membership.assign(&gm_char.0, gm_identity);
                }
                (genesis, 0, membership)
            }
        };

        // With a store, checkpoint on every commit so a resumed authority's snapshot is always fresh.
        let snapshot_every = if self.opts.store.is_some() { 1 } else { 20 };
        let mut world = World::from_snapshot(genesis);
        if let Some(seed) = self.opts.rng_seed {
            world.rng = Rng::seeded(seed);
        }
        let catalog = self.catalog_for(campaign_id);
        let authority = SyncAuthority::new(
            world,
            catalog.clone(),
            AuthorityOpts {
                snapshot_every,
                start_seq: seq,
                solo: false,
                manage_turns: true,
            },
        );
        let mut table = Table::new(authority, membership, campaign_id, catalog, snapshot_every);
        if let Some(store) = &self.opts.store {
            table.set_store(store.clone());
        }
        let handle = spawn_table(table);
        self.tables
            .lock()
            .unwrap()
            .insert(campaign_id.to_string(), handle.clone());
        Some(handle)
    }

    /// Adjusts an identity's online-connection count for a campaign (removing the entry at zero).
    fn bump(&self, campaign_id: &str, identity: &str, delta: i64) {
        let mut online = self.online.lock().unwrap();
        let inner = online.entry(campaign_id.to_string()).or_default();
        let n = (i64::from(*inner.get(identity).unwrap_or(&0)) + delta).max(0);
        if n == 0 {
            inner.remove(identity);
        } else {
            inner.insert(identity.to_string(), n as u32);
        }
    }

    fn is_online(&self, campaign_id: &str, identity: &str) -> bool {
        self.online
            .lock()
            .unwrap()
            .get(campaign_id)
            .and_then(|m| m.get(identity))
            .is_some_and(|&n| n > 0)
    }

    fn online_ids(&self, campaign_id: &str) -> Vec<String> {
        self.online
            .lock()
            .unwrap()
            .get(campaign_id)
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default()
    }

    fn display_name(&self, identity: &str) -> String {
        self.opts
            .display_name_for
            .as_ref()
            .map_or_else(|| identity.to_string(), |f| f(identity))
    }

    /// Builds the current presence message (seat owners + GM, each with its online flag).
    async fn presence_of(&self, campaign_id: &str) -> Option<ServerMsg> {
        let view = self.get_table(campaign_id)?.membership_view().await?;
        let seats = view
            .seats
            .iter()
            .map(|(character_id, owner)| PresenceEntry {
                character_id: character_id.clone(),
                owner: Some(owner.clone()),
                online: self.is_online(campaign_id, owner),
            })
            .collect();
        Some(ServerMsg::Presence {
            campaign_id: campaign_id.to_string(),
            seats,
            gm: GmPresence {
                online: self.is_online(campaign_id, &view.gm_identity),
                identity: view.gm_identity,
            },
        })
    }

    async fn broadcast_presence(&self, campaign_id: &str) {
        if let Some(msg) = self.presence_of(campaign_id).await {
            if let Some(t) = self.get_table(campaign_id) {
                t.broadcast(msg).await;
            }
        }
    }

    /// Builds the roster (GM + seat owners + any online identity), each with its display name.
    async fn roster_of(&self, campaign_id: &str) -> Option<ServerMsg> {
        let view = self.get_table(campaign_id)?.membership_view().await?;
        let mut ids = Vec::new();
        let mut seen = HashSet::new();
        for id in std::iter::once(view.gm_identity.clone())
            .chain(view.seats.iter().map(|(_, owner)| owner.clone()))
            .chain(self.online_ids(campaign_id))
        {
            if seen.insert(id.clone()) {
                ids.push(id);
            }
        }
        let players = ids
            .into_iter()
            .map(|identity| PlayerEntry {
                display_name: self.display_name(&identity),
                online: self.is_online(campaign_id, &identity),
                identity,
            })
            .collect();
        Some(ServerMsg::Players {
            campaign_id: campaign_id.to_string(),
            players,
        })
    }

    async fn broadcast_roster(&self, campaign_id: &str) {
        if let Some(msg) = self.roster_of(campaign_id).await {
            if let Some(t) = self.get_table(campaign_id) {
                t.broadcast(msg).await;
            }
        }
    }
}

// ── the connection lifecycle ──────────────────────────────────────────────────────────────────

/// One WebSocket connection's server-side state + message handling. Holds the connection's outbound
/// [`Subscriber`], its authenticated identity (set on the first successful `join`), and the set of
/// campaigns it has joined.
pub struct Connection {
    server: Arc<RoomServer>,
    send: Subscriber,
    conn_id: ConnId,
    identity: Option<String>,
    joined: HashSet<String>,
}

impl Connection {
    /// A fresh, unauthenticated connection.
    pub fn new(server: Arc<RoomServer>, send: Subscriber, conn_id: ConnId) -> Self {
        Self {
            server,
            send,
            conn_id,
            identity: None,
            joined: HashSet::new(),
        }
    }

    fn reply(&self, msg: ServerMsg) {
        (self.send)(msg);
    }

    fn denied(&self, reason: &str) {
        self.reply(ServerMsg::Denied {
            reason: reason.to_string(),
        });
    }

    /// Handles one parsed client message. Multiplayer arms only.
    pub async fn handle(&mut self, msg: ClientMsg) {
        match msg {
            ClientMsg::Join {
                campaign_id,
                token,
                from_seq,
            } => self.on_join(campaign_id, token, from_seq).await,
            ClientMsg::Submit {
                campaign_id,
                command,
            } => self.on_submit(campaign_id, command).await,
            ClientMsg::GetSnapshot { campaign_id } => self.on_get_snapshot(campaign_id).await,
            ClientMsg::AssignSeat {
                campaign_id,
                character_id,
                identity,
            } => {
                self.on_gm_control(
                    &campaign_id,
                    GmOp::Assign {
                        character_id,
                        identity,
                    },
                )
                .await;
            }
            ClientMsg::UnassignSeat {
                campaign_id,
                character_id,
            } => {
                self.on_gm_control(&campaign_id, GmOp::Unassign { character_id })
                    .await;
            }
            ClientMsg::TransferGm {
                campaign_id,
                identity,
            } => {
                self.on_gm_control(&campaign_id, GmOp::TransferGm { identity })
                    .await;
            }
        }
    }

    async fn on_join(&mut self, campaign_id: String, token: String, from_seq: u64) {
        let Some(id) = (self.server.opts.verify_token)(&token) else {
            self.denied("authentication failed");
            return;
        };
        if let Some(current) = &self.identity {
            if *current != id {
                self.denied("different identity on one connection");
                return;
            }
        }
        if self.joined.contains(&campaign_id) {
            self.denied("already joined this campaign");
            return;
        }
        // Set identity before the async load so messages arriving while we await see this
        // connection as authenticated; revert if the campaign turns out to be unknown.
        let prev = self.identity.take();
        self.identity = Some(id.clone());
        let Some(table) = self.server.ensure_loaded(&campaign_id).await else {
            self.identity = prev;
            self.denied("unknown campaign");
            return;
        };
        table.join(self.conn_id, self.send.clone(), from_seq).await;
        self.joined.insert(campaign_id.clone());
        self.server.bump(&campaign_id, &id, 1);
        self.server.broadcast_presence(&campaign_id).await;
        self.server.broadcast_roster(&campaign_id).await;
    }

    async fn on_submit(&mut self, campaign_id: String, command: Value) {
        let Some(identity) = self.identity.clone() else {
            self.denied("not authenticated");
            return;
        };
        let Some(table) = self.server.get_table(&campaign_id) else {
            self.denied("unknown campaign");
            return;
        };
        let Ok(command) = serde_json::from_value::<Command>(command) else {
            self.denied("malformed command");
            return;
        };
        let actor = actor_of(&command);
        let Some(view) = table.membership_view().await else {
            self.denied("unknown campaign");
            return;
        };
        let may = Membership::from_state(MembershipState {
            gm_identity: view.gm_identity,
            seats: view.seats,
        })
        .may_act(&identity, &actor);
        if !may {
            self.denied("not authorized for this seat");
            return;
        }
        // For a join, claim the seat in `on_commit` so it lands in the SAME atomic persist as the
        // commit (closes the orphaned-character window).
        let on_commit: Option<OnCommit> = match &actor {
            Actor::Join { character_id } => {
                let character_id = character_id.clone();
                let claimer = identity.clone();
                Some(Box::new(move |m: &mut Membership| {
                    m.claim(&character_id, claimer);
                }))
            }
            _ => None,
        };
        let out = table.submit(command, self.send.clone(), on_commit).await;
        if matches!(actor, Actor::Join { .. }) && matches!(out, SubmitOutcome::Committed { .. }) {
            self.server.broadcast_presence(&campaign_id).await;
        }
    }

    async fn on_get_snapshot(&self, campaign_id: String) {
        // Read-only; pre-auth allowed.
        match self.server.ensure_loaded(&campaign_id).await {
            Some(table) => table.get_snapshot(self.send.clone()).await,
            None => self.reply(ServerMsg::Snapshot {
                seq: 0,
                snapshot: Value::Null,
            }),
        }
    }

    async fn on_gm_control(&self, campaign_id: &str, op: GmOp) {
        let Some(caller) = self.identity.clone() else {
            self.denied("not authenticated");
            return;
        };
        let Some(table) = self.server.ensure_loaded(campaign_id).await else {
            self.denied("unknown campaign");
            return;
        };
        let Some(view) = table.membership_view().await else {
            self.denied("unknown campaign");
            return;
        };
        if caller != view.gm_identity {
            self.denied("GM only");
            return;
        }
        match table.gm_mutate(op).await {
            Ok(()) => self.server.broadcast_presence(campaign_id).await,
            Err(()) => self.denied("could not persist; retry"),
        }
    }

    /// Handles disconnect: leave every joined table and refresh presence/roster.
    pub async fn on_close(&mut self) {
        let joined: Vec<String> = self.joined.drain().collect();
        for campaign_id in joined {
            if let Some(t) = self.server.get_table(&campaign_id) {
                t.leave(self.conn_id).await;
            }
            if let Some(identity) = &self.identity {
                self.server.bump(&campaign_id, identity, -1);
            }
            self.server.broadcast_presence(&campaign_id).await;
            self.server.broadcast_roster(&campaign_id).await;
        }
    }
}

// ── the axum WebSocket adapter ────────────────────────────────────────────────────────────────

/// An axum router serving the room server at `/ws`, plus a `/healthz` liveness probe.
pub fn router(server: Arc<RoomServer>) -> Router {
    Router::new()
        .route("/ws", any(ws_handler))
        // Lightweight liveness/readiness probe (200 "ok") for container orchestrators — the whole
        // app is one binary, so a live socket means the client + `/ws` are both up. Kept ahead of
        // the `WEB_DIR` fallback so it never resolves to `index.html`.
        .route("/healthz", get(healthz))
        .with_state(server)
}

/// Health probe: returns `200 OK` with a tiny body while the server is accepting connections.
async fn healthz() -> &'static str {
    "ok"
}

async fn ws_handler(ws: WebSocketUpgrade, State(server): State<Arc<RoomServer>>) -> Response {
    ws.on_upgrade(move |socket| serve_socket(socket, server))
}

/// Drives one WebSocket: bridges the synchronous [`Subscriber`] (fed by the `Table`) to the async
/// socket via an unbounded channel, and pumps inbound frames into [`Connection::handle`]. A single
/// task multiplexes read + write with `select!`, so no split/extra dependency is needed.
///
/// The channel exists because the `Subscriber` callback is synchronous while the socket send is
/// async: the callback just enqueues (like emitting onto an event queue) and this loop drains.
/// `select!` itself is `Promise.race` run in a loop — whichever side has something ready wins that
/// iteration, all on one task.
async fn serve_socket(mut socket: WebSocket, server: Arc<RoomServer>) {
    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<ServerMsg>();
    let send: Subscriber = Arc::new(move |msg| {
        let _ = out_tx.send(msg);
    });
    let conn_id = server.next_conn_id();
    let mut conn = Connection::new(server, send, conn_id);

    loop {
        tokio::select! {
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => match serde_json::from_str::<Value>(&text) {
                        Err(_) => conn.reply(ServerMsg::Error { message: "Invalid JSON".into() }),
                        Ok(v) => match serde_json::from_value::<ClientMsg>(v) {
                            Ok(msg) => conn.handle(msg).await,
                            Err(_) => conn.reply(ServerMsg::Error { message: "Malformed message".into() }),
                        },
                    },
                    // Clean close, stream end, and socket error all end the session.
                    Some(Ok(Message::Close(_)) | Err(_)) | None => break,
                    Some(Ok(_)) => {} // ignore binary/ping/pong
                }
            }
            outgoing = out_rx.recv() => {
                if let Some(msg) = outgoing {
                    let text = serde_json::to_string(&msg).unwrap_or_default();
                    if socket.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                }
            }
        }
    }
    conn.on_close().await;
}
