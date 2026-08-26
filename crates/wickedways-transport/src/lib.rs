//! The multiplayer wire protocol — shared by the room server and the web client.
//!
//! The `t`-tagged [`ClientMsg`]/[`ServerMsg`] unions, [`WireLogEntry`], [`Actor`], and the
//! presence/roster structs. `command`, `delta`, and `snapshot` are **opaque**
//! ([`serde_json::Value`]) — the server relays and orders them without understanding the engine.
//! The one exception is `submit.command`, which the server deserializes into a `sync::Command`
//! *only* to derive the acting seat.
//!
//! The tag key is `t` and every field is camelCase; the shape tests below pin the exact wire
//! shapes. To a TypeScript eye a `#[serde(tag = "t")]` enum *is* a discriminated union — the
//! variant name lands in the `t` field, `{ t: "join", … } | { t: "submit", … }` — and `match`
//! over it is the switch the compiler forces to be exhaustive.
//! Chat and A/V arms (`chatSend`/`callJoin`/`signal`/…) are deliberately absent and land
//! as new variants when that feature ships (additive — a `#[serde(tag = "t")]` enum simply
//! rejects an unknown tag until then).
//!
//! This crate is engine-free (serde only): both `wickedways-server` and `wickedways-web` depend on
//! it so client and server can never drift on the wire shape.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A log entry as carried on the wire: the server's ordered log shape with opaque payloads.
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

/// The actor a command is authorized as — a **server-internal** type consumed by the server's
/// membership check (`Membership::may_act` in `wickedways-server`). The server derives it from
/// the command itself (`actor_of`), never from the wire envelope. `character` = an owned seat;
/// `gm` = GM/lifecycle/NPC; `join` = self-claim a NEW seat. Tagged by `kind`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Actor {
    #[serde(rename_all = "camelCase")]
    Character {
        actor_id: String,
    },
    Gm,
    #[serde(rename_all = "camelCase")]
    Join {
        character_id: String,
    },
}

/// Messages a client sends to the room server. Multiplayer arms only; chat/AV land later.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum ClientMsg {
    #[serde(rename_all = "camelCase")]
    Join {
        campaign_id: String,
        token: String,
        from_seq: u64,
    },
    #[serde(rename_all = "camelCase")]
    Submit { campaign_id: String, command: Value },
    #[serde(rename_all = "camelCase")]
    GetSnapshot { campaign_id: String },
    #[serde(rename_all = "camelCase")]
    AssignSeat {
        campaign_id: String,
        character_id: String,
        identity: String,
    },
    #[serde(rename_all = "camelCase")]
    UnassignSeat {
        campaign_id: String,
        character_id: String,
    },
    // `transferGM` keeps its trailing capitals on the wire (camelCase would give `transferGm`),
    // so the tag is pinned explicitly — same treatment as the `Command` variant.
    #[serde(rename = "transferGM", rename_all = "camelCase")]
    TransferGm {
        campaign_id: String,
        identity: String,
    },
}

/// Messages the room server sends to a client. Multiplayer arms only; chat/AV land later.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum ServerMsg {
    Joined {
        head: u64,
    },
    Entry {
        entry: WireLogEntry,
    },
    Committed {
        seq: u64,
        delta: Value,
    },
    Snapshot {
        seq: u64,
        snapshot: Value,
    },
    Denied {
        reason: String,
    },
    Error {
        message: String,
    },
    #[serde(rename_all = "camelCase")]
    Presence {
        campaign_id: String,
        seats: Vec<PresenceEntry>,
        gm: GmPresence,
    },
    #[serde(rename_all = "camelCase")]
    Players {
        campaign_id: String,
        players: Vec<PlayerEntry>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Every `ClientMsg` arm round-trips through its exact JSON shape (tag `t`,
    /// camelCase fields). This is the wire contract.
    #[test]
    fn client_msg_wire_shapes_are_stable() {
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
            assert_eq!(
                serde_json::to_value(&parsed).unwrap(),
                case,
                "round-trip {case}"
            );
        }
    }

    /// Every `ServerMsg` arm round-trips through its exact JSON shape.
    #[test]
    fn server_msg_wire_shapes_are_stable() {
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
            assert_eq!(
                serde_json::to_value(&parsed).unwrap(),
                case,
                "round-trip {case}"
            );
        }
    }

    /// `transferGM` keeps its trailing capitals as the `t` tag (never `transferGm`).
    #[test]
    fn transfer_gm_tag_keeps_trailing_capitals() {
        let m = ClientMsg::TransferGm {
            campaign_id: "camp".into(),
            identity: "ada".into(),
        };
        assert_eq!(serde_json::to_value(&m).unwrap()["t"], json!("transferGM"));
    }

    /// An unclaimed seat serializes its owner as JSON `null`, never omits the field.
    #[test]
    fn unclaimed_seat_owner_is_null() {
        let e = PresenceEntry {
            character_id: "c1".into(),
            owner: None,
            online: false,
        };
        assert_eq!(
            serde_json::to_value(&e).unwrap(),
            json!({ "characterId": "c1", "owner": null, "online": false })
        );
    }

    /// The `Actor` union keeps its `kind`-tagged shape (server-internal, but must round-trip).
    #[test]
    fn actor_wire_shapes_are_stable() {
        let cases = [
            json!({ "kind": "character", "actorId": "c1" }),
            json!({ "kind": "gm" }),
            json!({ "kind": "join", "characterId": "c2" }),
        ];
        for case in cases {
            let parsed: Actor = serde_json::from_value(case.clone())
                .unwrap_or_else(|e| panic!("deserialize {case}: {e}"));
            assert_eq!(
                serde_json::to_value(&parsed).unwrap(),
                case,
                "round-trip {case}"
            );
        }
    }
}
