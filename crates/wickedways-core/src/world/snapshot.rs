//! Serde wire structs mirroring `src/lib/serialization/types.ts` —
//! the leaf snapshots that compose a full `CampaignSnapshot`.
use alloc::{string::String, vec::Vec};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use super::ids::*;

/// TS `ItemSnapshot` — a discriminated union on `kind`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ItemSnapshot {
    #[serde(rename_all = "camelCase")]
    Item {
        id: ItemId,
        behavior_key: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        durability: Option<i64>,
        modifier: i64,
    },
    #[serde(rename_all = "camelCase")]
    Key {
        id: ItemId,
        name: String,
        key_code: String,
        consume_on_use: bool,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LootSnapshot {
    pub id: LootId,
    pub description: String,
    pub capacity: i64,
    pub content_ids: Vec<ItemId>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialCacheSnapshot {
    pub id: MaterialCacheId,
    /// Inert here (MaterialMap) — faithful passthrough.
    pub contents: Value,
    pub depleted: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneSnapshot {
    pub id: String,
    pub behavior_key: String,
    pub phase: String, // "enter" | "exit" — string this sub-plan
    pub state: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitSnapshot {
    pub id: ExitId,
    pub endpoint_ids: [RoomId; 2],
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub behavior_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub state: Value,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip<T: Serialize + for<'de> Deserialize<'de> + PartialEq + std::fmt::Debug>(json: &str) {
        let v: T = serde_json::from_str(json).unwrap();
        let out = serde_json::to_value(&v).unwrap();
        let expected: Value = serde_json::from_str(json).unwrap();
        assert_eq!(out, expected, "round-trip changed the JSON");
    }

    #[test]
    fn item_variant_roundtrips() {
        roundtrip::<ItemSnapshot>(r#"{"kind":"item","id":"i1","behaviorKey":"lantern","modifier":0}"#);
        roundtrip::<ItemSnapshot>(r#"{"kind":"item","id":"i2","behaviorKey":"sword","durability":3,"modifier":2}"#);
    }

    #[test]
    fn key_variant_roundtrips() {
        roundtrip::<ItemSnapshot>(r#"{"kind":"key","id":"k1","name":"Brass Key","keyCode":"crypt","consumeOnUse":true}"#);
    }

    #[test]
    fn exit_roundtrips_with_and_without_optionals() {
        roundtrip::<ExitSnapshot>(r#"{"id":"e1","endpointIds":["r1","r2"],"state":{}}"#);
        roundtrip::<ExitSnapshot>(r#"{"id":"e2","endpointIds":["r1","r3"],"behaviorKey":"locked","name":"oak door","state":{"locked":true}}"#);
    }
}
