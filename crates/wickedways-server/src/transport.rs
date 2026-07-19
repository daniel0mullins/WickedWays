//! The room-server wire protocol (Phase 2c, sub-project C — slice 1).
//!
//! Ports the multiplayer arms of `packages/transport-shared/src/index.ts`: the `t`-tagged
//! [`ClientMsg`]/[`ServerMsg`] unions, [`WireLogEntry`], [`Actor`], and the presence/roster
//! structs. `command`, `delta`, and `snapshot` are **opaque** ([`serde_json::Value`]) — the server
//! relays and orders them without understanding the engine, exactly as the TS package does with
//! `unknown`. The one exception is `submit.command`, which a later slice deserializes into a
//! [`sync::Command`](wickedways_core::sync::Command) *only* to derive the acting seat.
//!
//! The tag key is `t` and every field is camelCase, so these serialize byte-identically to the TS
//! union (the wire contract — see the shape tests below). The chat and A/V arms
//! (`chatSend`/`callJoin`/`signal`/…) are **sub-project E**: they are deliberately omitted here and
//! added as new variants when E lands (additive — a Rust `#[serde(tag = "t")]` enum simply rejects
//! an unknown tag until then). Extracting this module to a shared `wickedways-transport` crate is
//! deferred to D, which will reuse it for the web client.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A log entry as carried on the wire (sub-project B's `LogEntry` with opaque payloads).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireLogEntry {
    pub seq: u64,
    pub base_seq: u64,
    pub command: Value,
    pub delta: Value,
}

/// One seat's presence: its owner (or `None` if unclaimed) and whether that owner is online.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceEntry {
    pub character_id: String,
    pub owner: Option<String>,
    pub online: bool,
}

/// The GM's presence half of a `presence` message: identity + online state.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GmPresence {
    pub identity: String,
    pub online: bool,
}

/// One player's roster entry: stable identity, host display name, and online state.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerEntry {
    pub identity: String,
    pub display_name: String,
    pub online: bool,
}

/// The actor a command is authorized as — a **server-internal** type consumed by
/// [`Membership::may_act`](crate::membership::Membership::may_act). The server derives it from the
/// command via [`actor_of`](crate::membership::actor_of), never from the wire envelope.
/// `character` = an owned seat; `gm` = GM/lifecycle/NPC; `join` = self-claim a NEW seat. Mirrors
/// the TS `Actor` union (tag `kind`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Actor {
    #[serde(rename_all = "camelCase")]
    Character { actor_id: String },
    Gm,
    #[serde(rename_all = "camelCase")]
    Join { character_id: String },
}

/// Messages a client sends to the room server. Multiplayer arms only; chat/AV are sub-project E.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum ClientMsg {
    #[serde(rename_all = "camelCase")]
    Join { campaign_id: String, token: String, from_seq: u64 },
    #[serde(rename_all = "camelCase")]
    Submit { campaign_id: String, command: Value },
    #[serde(rename_all = "camelCase")]
    GetSnapshot { campaign_id: String },
    #[serde(rename_all = "camelCase")]
    AssignSeat { campaign_id: String, character_id: String, identity: String },
    #[serde(rename_all = "camelCase")]
    UnassignSeat { campaign_id: String, character_id: String },
    // `transferGM` keeps its trailing capitals on the wire (camelCase would give `transferGm`),
    // so the tag is pinned explicitly — same treatment as the `Command` variant.
    #[serde(rename = "transferGM", rename_all = "camelCase")]
    TransferGm { campaign_id: String, identity: String },
}

/// Messages the room server sends to a client. Multiplayer arms only; chat/AV are sub-project E.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum ServerMsg {
    Joined { head: u64 },
    Entry { entry: WireLogEntry },
    Committed { seq: u64, delta: Value },
    Snapshot { seq: u64, snapshot: Value },
    Denied { reason: String },
    Error { message: String },
    #[serde(rename_all = "camelCase")]
    Presence { campaign_id: String, seats: Vec<PresenceEntry>, gm: GmPresence },
    #[serde(rename_all = "camelCase")]
    Players { campaign_id: String, players: Vec<PlayerEntry> },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Every ported `ClientMsg` arm round-trips through the exact `transport-shared` JSON shape
    /// (tag `t`, camelCase fields). This is the wire contract.
    #[test]
    fn client_msg_shapes_mirror_the_ts_union() {
        let cases = [
            json!({ "t": "join", "campaignId": "camp", "token": "tok", "fromSeq": 0 }),
            json!({ "t": "submit", "campaignId": "camp", "command": { "kind": "nextPlayer" } }),
            json!({ "t": "getSnapshot", "campaignId": "camp" }),
            json!({ "t": "assignSeat", "campaignId": "camp", "characterId": "c1", "identity": "ada" }),
            json!({ "t": "unassignSeat", "campaignId": "camp", "characterId": "c1" }),
            json!({ "t": "transferGM", "campaignId": "camp", "identity": "ben" }),
        ];
        for case in cases {
            let parsed: ClientMsg = serde_json::from_value(case.clone())
                .unwrap_or_else(|e| panic!("deserialize {case}: {e}"));
            assert_eq!(serde_json::to_value(&parsed).unwrap(), case, "round-trip {case}");
        }
    }

    /// Every ported `ServerMsg` arm round-trips through the exact `transport-shared` JSON shape.
    #[test]
    fn server_msg_shapes_mirror_the_ts_union() {
        let cases = [
            json!({ "t": "joined", "head": 3 }),
            json!({ "t": "entry", "entry": { "seq": 2, "baseSeq": 1, "command": { "kind": "nextPlayer" }, "delta": {} } }),
            json!({ "t": "committed", "seq": 2, "delta": { "changed": [] } }),
            json!({ "t": "snapshot", "seq": 5, "snapshot": { "schemaVersion": 1 } }),
            json!({ "t": "denied", "reason": "not your turn" }),
            json!({ "t": "error", "message": "boom" }),
            json!({
                "t": "presence", "campaignId": "camp",
                "seats": [{ "characterId": "c1", "owner": "ada", "online": true }],
                "gm": { "identity": "gm", "online": false }
            }),
            json!({
                "t": "players", "campaignId": "camp",
                "players": [{ "identity": "ada", "displayName": "Ada", "online": true }]
            }),
        ];
        for case in cases {
            let parsed: ServerMsg = serde_json::from_value(case.clone())
                .unwrap_or_else(|e| panic!("deserialize {case}: {e}"));
            assert_eq!(serde_json::to_value(&parsed).unwrap(), case, "round-trip {case}");
        }
    }

    /// `transferGM` keeps its trailing capitals as the `t` tag (never `transferGm`).
    #[test]
    fn transfer_gm_tag_keeps_trailing_capitals() {
        let m = ClientMsg::TransferGm { campaign_id: "camp".into(), identity: "ada".into() };
        assert_eq!(serde_json::to_value(&m).unwrap()["t"], json!("transferGM"));
    }

    /// An unclaimed seat serializes its owner as JSON `null` (TS `owner: string | null`).
    #[test]
    fn unclaimed_seat_owner_is_null() {
        let e = PresenceEntry { character_id: "c1".into(), owner: None, online: false };
        assert_eq!(
            serde_json::to_value(&e).unwrap(),
            json!({ "characterId": "c1", "owner": null, "online": false })
        );
    }

    /// The `Actor` union matches the TS `kind`-tagged shape (server-internal, but must round-trip).
    #[test]
    fn actor_shapes_mirror_the_ts_union() {
        let cases = [
            json!({ "kind": "character", "actorId": "c1" }),
            json!({ "kind": "gm" }),
            json!({ "kind": "join", "characterId": "c2" }),
        ];
        for case in cases {
            let parsed: Actor = serde_json::from_value(case.clone())
                .unwrap_or_else(|e| panic!("deserialize {case}: {e}"));
            assert_eq!(serde_json::to_value(&parsed).unwrap(), case, "round-trip {case}");
        }
    }
}
