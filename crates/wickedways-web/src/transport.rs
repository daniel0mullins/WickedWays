//! The `web-sys` WebSocket transport.
//!
//! Wraps the warm [`Mirror`](crate::mirror::Mirror) with a browser [`WebSocket`]. This is how the
//! **synchronous**
//! [`SyncTransport`] trait reconciles with an async socket: every synchronous
//! read (`head`/`entries_since`/`load_snapshot`) is served from the mirror, so only submit is truly
//! async — [`submit_async`](WsTransport::submit_async) sends the frame and awaits the server's
//! `committed`/`denied`. The [`SyncTransport::submit`] method is therefore a no-op on this transport;
//! the app drives the coordinator with `submit_async` + [`SyncCoordinator::sync`], never
//! `SyncCoordinator::submit`.
//!
//! Everything runs on the browser's single thread, so shared state between the app and the socket's
//! message callback lives in `Rc<RefCell<_>>`; waiters (handshake, submit, head) are
//! `futures_channel::oneshot`s the message handler resolves. Reconnect is intentionally minimal here
//! (a dropped socket resolves an in-flight submit as "connection lost; resubmit"); full
//! reopen-and-rejoin is a follow-up.
//!
//! [`SyncTransport`]: wickedways_core::sync::SyncTransport
//! [`SyncCoordinator::sync`]: wickedways_core::sync::SyncCoordinator::sync
//! [`SyncCoordinator::submit`]: wickedways_core::sync::SyncCoordinator::submit

use std::cell::RefCell;
use std::rc::Rc;

use futures_channel::mpsc;
use futures_channel::oneshot;
use serde_json::Value;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use web_sys::{MessageEvent, WebSocket};

use wickedways_core::sync::{Command, Delta, LogEntry, SubmitResult, SyncTransport};
use wickedways_core::CampaignSnapshot;
use wickedways_transport::{
    ClientMsg, GmPresence, PlayerEntry, PresenceEntry, ServerMsg, WireLogEntry,
};

use crate::mirror::Mirror;

/// The live lobby roster the transport absorbs from the server's `presence`/`players` pushes: each
/// seat's owner + online state, the GM's identity, and the connected players. Read via
/// [`WsTransport::roster`] and refreshed as the server rebroadcasts — no polling.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Roster {
    pub seats: Vec<PresenceEntry>,
    pub gm: Option<GmPresence>,
    pub players: Vec<PlayerEntry>,
}

/// Shared mutable state between the app and the socket's message callback.
struct Inner {
    mirror: Mirror,
    snapshot_waiter: Option<oneshot::Sender<(u64, Option<CampaignSnapshot>)>>,
    joined_waiter: Option<oneshot::Sender<u64>>,
    pending_submit: Option<(oneshot::Sender<SubmitResult>, Command)>,
    head_waiters: Vec<(u64, oneshot::Sender<()>)>,
    auth_error: Option<String>,
    /// Latest `presence`/`players` roster, kept fresh as the server rebroadcasts.
    roster: Roster,
    /// A UI wake-up channel: every applied push (a log `entry` or a `presence`/`players` update) sends
    /// a tick so a subscriber can re-read state, so the lobby/surface reacts to server pushes without
    /// polling. `None` until a consumer registers via [`WsTransport::push_notifications`].
    push_tx: Option<mpsc::UnboundedSender<()>>,
}

impl Inner {
    fn new() -> Self {
        Inner {
            mirror: Mirror::new(),
            snapshot_waiter: None,
            joined_waiter: None,
            pending_submit: None,
            head_waiters: Vec::new(),
            auth_error: None,
            roster: Roster::default(),
            push_tx: None,
        }
    }

    /// Wake any registered push subscriber (best-effort; a closed receiver is dropped).
    fn notify_push(&self) {
        if let Some(tx) = &self.push_tx {
            let _ = tx.unbounded_send(());
        }
    }

    /// Resolve any head-waiter whose target the mirror has now reached.
    fn check_head_waiters(&mut self) {
        let head = self.mirror.head();
        let mut i = 0;
        while i < self.head_waiters.len() {
            if head >= self.head_waiters[i].0 {
                let (_, w) = self.head_waiters.remove(i);
                let _ = w.send(());
            } else {
                i += 1;
            }
        }
    }
}

/// Handles one inbound server frame, updating the mirror + resolving waiters.
fn handle_message(inner: &Rc<RefCell<Inner>>, text: &str) {
    let Ok(msg) = serde_json::from_str::<ServerMsg>(text) else {
        return;
    };
    let mut b = inner.borrow_mut();
    match msg {
        ServerMsg::Snapshot { seq, snapshot } => {
            if let Some(w) = b.snapshot_waiter.take() {
                let snap = if snapshot.is_null() {
                    None
                } else {
                    serde_json::from_value(snapshot).ok()
                };
                let _ = w.send((seq, snap));
            }
        }
        ServerMsg::Joined { head } => {
            if let Some(w) = b.joined_waiter.take() {
                let _ = w.send(head);
            }
        }
        ServerMsg::Entry { entry } => {
            let _ = b.mirror.apply_wire_entry(&entry);
            b.check_head_waiters();
            // A pushed entry (another client's action, or a join) changed the world — wake the UI.
            b.notify_push();
        }
        ServerMsg::Committed { seq, delta } => {
            if let Some((w, command)) = b.pending_submit.take() {
                // Apply our own committed delta to the mirror, then resolve the awaiting submit.
                let wire = WireLogEntry {
                    seq,
                    base_seq: seq.saturating_sub(1),
                    command: serde_json::to_value(&command).unwrap_or(Value::Null),
                    delta: delta.clone(),
                };
                let _ = b.mirror.apply_wire_entry(&wire);
                match serde_json::from_value::<Delta>(delta) {
                    Ok(d) => {
                        let _ = w.send(SubmitResult::Committed { seq, delta: d });
                    }
                    Err(e) => {
                        let _ = w.send(SubmitResult::Denied {
                            reason: format!("bad delta: {e}"),
                        });
                    }
                }
                b.check_head_waiters();
                // Our own committed action changed the world too — wake the UI (the lobby refreshes
                // its roster / started state off the same push signal as external entries).
                b.notify_push();
            }
        }
        ServerMsg::Denied { reason } => {
            if let Some((w, _)) = b.pending_submit.take() {
                // A denied SUBMIT is terminal.
                let _ = w.send(SubmitResult::Denied { reason });
            } else {
                // A denied HANDSHAKE (join): record the error and unblock the pending waiters so the
                // handshake await returns and can surface it.
                b.auth_error = Some(format!("auth denied: {reason}"));
                if let Some(w) = b.snapshot_waiter.take() {
                    let _ = w.send((0, None));
                }
                if let Some(w) = b.joined_waiter.take() {
                    let _ = w.send(0);
                }
            }
        }
        ServerMsg::Presence { seats, gm, .. } => {
            b.roster.seats = seats;
            b.roster.gm = Some(gm);
            b.notify_push();
        }
        ServerMsg::Players { players, .. } => {
            b.roster.players = players;
            b.notify_push();
        }
        // Other frames (chat/AV) are ignored by this transport.
        _ => {}
    }
}

fn send(ws: &WebSocket, msg: &ClientMsg) {
    if let Ok(text) = serde_json::to_string(msg) {
        let _ = ws.send_with_str(&text);
    }
}

/// A [`SyncTransport`] over a WebSocket room server: a warm mirror fed by the subscription, with an
/// async [`submit_async`](WsTransport::submit_async).
pub struct WsTransport {
    inner: Rc<RefCell<Inner>>,
    ws: WebSocket,
    campaign_id: String,
    // Closures kept alive for the socket's lifetime.
    _on_message: Closure<dyn FnMut(MessageEvent)>,
    _on_close: Closure<dyn FnMut()>,
}

impl WsTransport {
    /// Opens a transport and resolves once its mirror has caught up to the server head. Errors on an
    /// auth denial during the handshake.
    pub async fn connect(url: &str, campaign_id: &str, token: &str) -> Result<WsTransport, String> {
        let ws = WebSocket::new(url).map_err(|e| format!("open socket: {e:?}"))?;
        let inner = Rc::new(RefCell::new(Inner::new()));

        let inner_msg = inner.clone();
        let on_message = Closure::<dyn FnMut(MessageEvent)>::new(move |ev: MessageEvent| {
            if let Some(text) = ev.data().as_string() {
                handle_message(&inner_msg, &text);
            }
        });
        ws.set_onmessage(Some(on_message.as_ref().unchecked_ref()));

        // On close, resolve an in-flight submit as a resubmit-able loss (minimal reconnect).
        let inner_close = inner.clone();
        let on_close = Closure::<dyn FnMut()>::new(move || {
            if let Some((w, _)) = inner_close.borrow_mut().pending_submit.take() {
                let _ = w.send(SubmitResult::Denied {
                    reason: "connection lost; resubmit".into(),
                });
            }
        });
        ws.set_onclose(Some(on_close.as_ref().unchecked_ref()));

        // Await open.
        let (open_tx, open_rx) = oneshot::channel::<()>();
        let open_cell = Rc::new(RefCell::new(Some(open_tx)));
        let on_open = Closure::<dyn FnMut()>::new(move || {
            if let Some(tx) = open_cell.borrow_mut().take() {
                let _ = tx.send(());
            }
        });
        ws.set_onopen(Some(on_open.as_ref().unchecked_ref()));
        open_rx
            .await
            .map_err(|_| "socket closed before open".to_string())?;
        ws.set_onopen(None);
        drop(on_open);

        // getSnapshot → seed the mirror.
        let snap_rx = {
            let (tx, rx) = oneshot::channel();
            inner.borrow_mut().snapshot_waiter = Some(tx);
            rx
        };
        send(
            &ws,
            &ClientMsg::GetSnapshot {
                campaign_id: campaign_id.into(),
            },
        );
        let (seq, snapshot) = snap_rx
            .await
            .map_err(|_| "closed during getSnapshot".to_string())?;
        inner.borrow_mut().mirror.seed(seq, snapshot);

        // join(fromSeq) → head.
        let joined_rx = {
            let (tx, rx) = oneshot::channel();
            inner.borrow_mut().joined_waiter = Some(tx);
            rx
        };
        send(
            &ws,
            &ClientMsg::Join {
                campaign_id: campaign_id.into(),
                token: token.into(),
                from_seq: seq,
            },
        );
        let head = joined_rx
            .await
            .map_err(|_| "closed during join".to_string())?;
        if let Some(err) = inner.borrow().auth_error.clone() {
            return Err(err);
        }

        // Catch the mirror up to the head the server reported at join.
        await_head(&inner, head).await;

        Ok(WsTransport {
            inner,
            ws,
            campaign_id: campaign_id.into(),
            _on_message: on_message,
            _on_close: on_close,
        })
    }

    /// Submits a command and awaits the server's authoritative verdict. On `committed`, our own
    /// delta has been applied to the mirror by the time this resolves.
    pub async fn submit_async(&self, command: Command) -> SubmitResult {
        // `ClientMsg::Submit.command` is opaque (`Value`); serialize before we move `command` into
        // the pending-submit slot (it is echoed into the mirror entry when `committed` returns).
        let command_value = serde_json::to_value(&command).unwrap_or(Value::Null);
        let rx = {
            let mut b = self.inner.borrow_mut();
            let (tx, rx) = oneshot::channel();
            b.pending_submit = Some((tx, command));
            rx
        };
        send(
            &self.ws,
            &ClientMsg::Submit {
                campaign_id: self.campaign_id.clone(),
                command: command_value,
            },
        );
        rx.await.unwrap_or(SubmitResult::Denied {
            reason: "connection lost".into(),
        })
    }

    /// The latest lobby roster (seat ownership + online + GM + connected players), as pushed by the
    /// server. Snapshot-in-time; combine with [`push_notifications`](Self::push_notifications) to
    /// refresh on change.
    pub fn roster(&self) -> Roster {
        self.inner.borrow().roster.clone()
    }

    /// A stream that ticks whenever the server pushes a change (a committed log `entry` from another
    /// client, or a `presence`/`players` update). Lets the lobby/surface re-read state reactively
    /// instead of polling. Registering replaces any previous subscriber.
    pub fn push_notifications(&self) -> mpsc::UnboundedReceiver<()> {
        let (tx, rx) = mpsc::unbounded();
        self.inner.borrow_mut().push_tx = Some(tx);
        rx
    }

    /// Closes the socket (teardown).
    pub fn close(&self) {
        let _ = self.ws.close();
    }
}

impl Drop for WsTransport {
    /// Unregister the JS event handlers before the backing `Closure`s are freed, then close the
    /// socket. Without this, a socket callback that fires during teardown (e.g. `onclose` as the lobby
    /// hands off to the surface) invokes an already-dropped closure — a `wasm-bindgen` panic.
    fn drop(&mut self) {
        self.ws.set_onmessage(None);
        self.ws.set_onclose(None);
        let _ = self.ws.close();
    }
}

/// Resolves once the mirror's head reaches `target` (immediately if already there).
async fn await_head(inner: &Rc<RefCell<Inner>>, target: u64) {
    let rx = {
        let mut b = inner.borrow_mut();
        if b.mirror.head() >= target {
            return;
        }
        let (tx, rx) = oneshot::channel();
        b.head_waiters.push((target, tx));
        rx
    };
    let _ = rx.await;
}

impl SyncTransport for WsTransport {
    fn head(&self) -> u64 {
        self.inner.borrow().mirror.head()
    }

    /// Unsupported on the WebSocket transport — submits are async; use
    /// [`submit_async`](WsTransport::submit_async). Present only to satisfy the trait the coordinator
    /// uses for its synchronous reads; the app never routes a submit through here.
    fn submit(&mut self, _command: Command) -> SubmitResult {
        SubmitResult::Denied {
            reason: "WebSocket transport: use submit_async".into(),
        }
    }

    fn entries_since(&self, from_seq: u64) -> Vec<LogEntry> {
        self.inner.borrow().mirror.entries_since(from_seq)
    }

    fn load_snapshot(&self) -> (u64, CampaignSnapshot) {
        // A successfully-connected transport always has a seeded snapshot (a known campaign returns a
        // non-null getSnapshot; an unknown one is denied at join and `connect` errors).
        self.inner
            .borrow()
            .mirror
            .load_snapshot()
            .expect("a connected WsTransport has a seeded snapshot")
    }
}
