//! Two-client convergence e2e over a real WebSocket (Phase 2c, sub-project C — slice 4).
//!
//! The end-to-end proof C exists for: two independent clients connect to the axum `/ws` server over
//! real sockets, seed a replica from `getSnapshot`, and — when one client submits a command — both
//! apply the server's authoritative delta (the submitter via `committed`, the other via `entry`) and
//! **converge to the identical snapshot**. Because the exchange is real `ClientMsg`/`ServerMsg` bytes
//! on the wire, this also exercises wire parity end-to-end (the `transport` module's serde shapes are
//! additionally unit-checked against the TS union in `src/transport.rs`).

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};
use wickedways_core::sync::{apply_delta, Delta};
use wickedways_core::{CampaignSnapshot, World};
use wickedways_server::server::{router, RoomServer, ServerOptions};
use wickedways_server::transport::{ClientMsg, ServerMsg};
use wickedways_core::world::descriptor::Catalog;

fn genesis() -> CampaignSnapshot {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../conformance/fixtures/sync-move.genesis.json");
    serde_json::from_str(&std::fs::read_to_string(&p).expect("read genesis")).expect("parse genesis")
}

/// Binds an ephemeral-store room server (campaign `demo`) on a free port and serves it in the
/// background. Returns the bound port.
async fn start_server() -> u16 {
    let g = genesis();
    let opts = ServerOptions {
        verify_token: Box::new(|t: &str| (!t.is_empty()).then(|| t.to_string())),
        gm_identity_for: Box::new(|_| "gm".to_string()),
        genesis_for: Box::new(move |id: &str| (id == "demo").then(|| g.clone())),
        display_name_for: None,
        catalog: Catalog::default(),
        store: None,
        rng_seed: None,
    };
    let app = router(RoomServer::new(opts));
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("serve");
    });
    port
}

/// A thin async WebSocket test client.
struct Client {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
}

impl Client {
    async fn connect(port: u16) -> Self {
        let (ws, _resp) = connect_async(format!("ws://127.0.0.1:{port}/ws"))
            .await
            .expect("connect");
        Self { ws }
    }

    async fn send(&mut self, msg: ClientMsg) {
        let text = serde_json::to_string(&msg).unwrap();
        self.ws.send(Message::Text(text.into())).await.expect("send");
    }

    /// Reads server frames until one satisfies `pred`, returning it (intermediate frames — presence,
    /// roster, etc. — are skipped). Bounded by a timeout so a stall fails loudly, labelled by `what`.
    async fn recv_until(&mut self, what: &str, pred: impl Fn(&ServerMsg) -> bool) -> ServerMsg {
        let read = async {
            loop {
                match self.ws.next().await {
                    Some(Ok(Message::Text(t))) => {
                        if let Ok(sm) = serde_json::from_str::<ServerMsg>(&t) {
                            if pred(&sm) {
                                return sm;
                            }
                        }
                    }
                    Some(Ok(_)) => {} // ignore ping/pong/binary
                    other => panic!("socket closed before `{what}`: {other:?}"),
                }
            }
        };
        tokio::time::timeout(std::time::Duration::from_secs(10), read)
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for `{what}`"))
    }

    /// Joins `campaign` as `token`, then seeds a replica `World` from a `getSnapshot`.
    async fn join_and_seed(&mut self, campaign: &str, token: &str) -> World {
        self.send(ClientMsg::Join { campaign_id: campaign.into(), token: token.into(), from_seq: 0 }).await;
        self.send(ClientMsg::GetSnapshot { campaign_id: campaign.into() }).await;
        let snap = self.recv_until("snapshot", |m| matches!(m, ServerMsg::Snapshot { .. })).await;
        let ServerMsg::Snapshot { snapshot, .. } = snap else { unreachable!() };
        World::from_snapshot(serde_json::from_value(snapshot).expect("snapshot"))
    }
}

fn delta_from(value: Value) -> Delta {
    serde_json::from_value(value).expect("delta")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_clients_converge_over_a_real_websocket() {
    let port = start_server().await;

    // A joins as the GM (so it may issue a seat-free GM command); B as a spectator. Both seed their
    // replica from the genesis checkpoint (seq 0). A plain `join` authenticates + subscribes but
    // claims no character seat, which is why the acting client here is the GM issuing `nextPlayer`.
    let mut a = Client::connect(port).await;
    let mut replica_a = a.join_and_seed("demo", "gm").await;

    let mut b = Client::connect(port).await;
    let mut replica_b = b.join_and_seed("demo", "ben").await;

    // Normalize `base` through the same World round-trip the replicas take, so entity arrays are in
    // the same id-sorted order (a raw snapshot is in reachable-walk order — a difference the sync
    // gate canonicalizes too; here both sides go through `World`, so they line up).
    let base = World::from_snapshot(genesis()).to_snapshot();
    assert_eq!(replica_a.to_snapshot(), base, "replica A seeds from the genesis checkpoint");
    assert_eq!(replica_b.to_snapshot(), base, "replica B seeds from the genesis checkpoint");

    // The GM submits `nextPlayer`. A is the submitter → `committed`; B, the other participant →
    // `entry`. Both carry the SAME authoritative delta (here a campaign-core advance).
    a.send(ClientMsg::Submit {
        campaign_id: "demo".into(),
        command: json!({ "kind": "nextPlayer" }),
    })
    .await;

    let committed = a.recv_until("committed", |m| matches!(m, ServerMsg::Committed { .. })).await;
    let ServerMsg::Committed { seq, delta } = committed else { unreachable!() };
    assert_eq!(seq, 1, "the first commit is seq 1");
    apply_delta(&mut replica_a, &delta_from(delta));

    let entry = b.recv_until("entry", |m| matches!(m, ServerMsg::Entry { .. })).await;
    let ServerMsg::Entry { entry } = entry else { unreachable!() };
    assert_eq!(entry.seq, 1, "B sees the same seq");
    apply_delta(&mut replica_b, &delta_from(entry.delta));

    // Convergence: both replicas reach the identical post-move snapshot, and it actually changed.
    let after_a = replica_a.to_snapshot();
    let after_b = replica_b.to_snapshot();
    assert_eq!(after_a, after_b, "the two clients converge to the identical snapshot");
    assert_ne!(after_a, base, "the move actually advanced the state (a non-trivial delta was applied)");
}
