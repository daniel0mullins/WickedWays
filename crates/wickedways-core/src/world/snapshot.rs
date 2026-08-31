//! Serde wire structs — the leaf snapshots that compose a full
//! `CampaignSnapshot`. Field names and omission rules are pinned by the golden
//! gates and saved campaigns; treat any change here as a behavior change.
use super::ids::*;
use alloc::{collections::BTreeMap, string::String, vec::Vec};
use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---- item / loot / scene / exit snapshots ----

/// `ItemSnapshot` — a discriminated union on `kind`.
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

impl ItemSnapshot {
    /// The item's id, regardless of variant.
    pub const fn id(&self) -> &ItemId {
        match self {
            ItemSnapshot::Item { id, .. } | ItemSnapshot::Key { id, .. } => id,
        }
    }
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
    pub phase: String, // "enter" | "exit"
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

// ---- character snapshots ----

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub energy: f64,
    pub sanity: f64,
    pub health: f64,
}

impl Stats {
    /// The value of one stat, selected by `StatType`.
    pub const fn get(&self, stat: crate::stats::StatType) -> f64 {
        match stat {
            crate::stats::StatType::Energy => self.energy,
            crate::stats::StatType::Sanity => self.sanity,
            crate::stats::StatType::Health => self.health,
        }
    }

    /// Mutable access to one stat, selected by `StatType`. Returns a mutable
    /// reference *into* the struct — callers assign through it
    /// (`*stats.get_mut(s) += 1.0`), handing out an assignable "place" the way
    /// no JS function can.
    pub const fn get_mut(&mut self, stat: crate::stats::StatType) -> &mut f64 {
        match stat {
            crate::stats::StatType::Energy => &mut self.energy,
            crate::stats::StatType::Sanity => &mut self.sanity,
            crate::stats::StatType::Health => &mut self.health,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomSnapshot {
    pub id: RoomId,
    pub name: String,
    pub description: String,
    /// Direction -> exitId, keyed by the direction's wire name.
    pub exits: BTreeMap<String, ExitId>,
    pub dark: bool,
    pub spawn_modifier: i64,
    pub occupant_ids: Vec<CharacterId>,
    pub loot_ids: Vec<LootId>,
    pub material_cache_ids: Vec<MaterialCacheId>,
    pub light_source_ids: Vec<ItemId>,
    pub scenes: Vec<SceneSnapshot>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CharacterKind {
    Player,
    Mob,
    Npc,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventorySnapshot {
    pub slots: i64,
    pub item_ids: Vec<ItemId>,
    pub key_ids: Vec<ItemId>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterSnapshot {
    pub kind: CharacterKind,
    pub id: CharacterId,
    pub name: String,
    pub stats: Stats,
    pub actions_per_round: i64,
    pub actions_this_round: i64,
    /// `string | null` in TS — always present in JSON, serialises as `null` when None.
    pub current_room_id: Option<RoomId>,
    pub inventory: InventorySnapshot,
    /// EquipmentSlot -> itemId.
    pub equipment: BTreeMap<String, ItemId>,
    pub history: Vec<crate::world::history::ActionHistoryEntry>,
    pub archetype_immunities: Vec<crate::world::afflictions::Status>,
    pub afflictions: crate::world::afflictions::Afflictions,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archetype_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<Value>,
    /// `baseEscapeChance?: number` — integer-valued in practice (e.g. 50); typed i64 for
    /// byte-faithful round-trip. Serde will error loudly on a fractional value rather than
    /// silently normalising it (unlike f64, which re-serialises 50 as 50.0).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_escape_chance: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material_drops: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub light_averse: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub natural_attack: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub npc_behavior_key: Option<String>,
    /// Per-NPC-instance dialogue script state — the `once`-latch store the NPC
    /// matcher reads/writes under `state["onceFired"][key]` (see `ScriptedNpc::
    /// run_talk`). Shaped like `MechanicSnapshot.state` (an opaque JSON object),
    /// but churn-free like `visible`: `null`/absent is the empty state, and the
    /// key is OMITTED on serialize when null (`Value::is_null`) so pre-existing
    /// goldens stay byte-stable — only an NPC that has fired a `once` dialogue
    /// effect emits `npcState`. Two NPCs sharing an `npcBehaviorKey` keep
    /// INDEPENDENT latches because the state lives on the per-instance snapshot,
    /// not on the shared behavior.
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub npc_state: Value,
    /// Whether this character is present in the room's view/scope. Default `true`;
    /// an NPC that "disappears" flips this to `false` (reversibly). Snapshots
    /// written before this field existed lack the key and parse back to `true`
    /// (`default_true`); the `true` case is omitted on serialize (`is_true`) so
    /// pre-existing goldens stay byte-stable — only a hidden character emits the key.
    #[serde(default = "default_true", skip_serializing_if = "is_true")]
    pub visible: bool,
}

/// Serde value-default for `CharacterSnapshot::visible`: a character with no
/// `visible` key in its JSON parses back as visible. (The other optional-tail
/// fields default via `Option::is_none`; this one needs a value-default fn.)
fn default_true() -> bool {
    true
}

/// Serde `skip_serializing_if` for `CharacterSnapshot::visible`: omit the key
/// when the character is visible (the default), so only a hidden character
/// serialises a `visible: false`.
#[allow(clippy::trivially_copy_pass_by_ref)]
fn is_true(b: &bool) -> bool {
    *b
}

/// Serde `skip_serializing_if` for `VillainSnapshot::card_action_taken`: omit
/// the key while the latch is clear (the default between turns).
#[allow(clippy::trivially_copy_pass_by_ref)]
fn is_false(b: &bool) -> bool {
    !*b
}

/// Serde `skip_serializing_if` for `CampaignCoreSnapshot::lights_out_rounds`:
/// omit the key while no supernatural darkness is active, so pre-villain
/// goldens stay byte-stable.
#[allow(clippy::trivially_copy_pass_by_ref)]
fn is_zero(n: &i64) -> bool {
    *n == 0
}

// ---- campaign snapshots ----

pub const SCHEMA_VERSION: i64 = 6;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MechanicSnapshot {
    pub key: String,
    pub state: Value,
}

/// The Villain designation plus the Wicked Ways card economy: which character
/// plays against the heroes, and the deck (draw pile) / hand / discard of
/// one-time card keys. Cards are pure keys — behavior resolves through the
/// card registry / catalog at play time, mirroring `MechanicSnapshot.key`.
/// The whole struct rides `CampaignCoreSnapshot.villain` as an optional-tail
/// field, so a villain-less campaign serialises no trace of it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VillainSnapshot {
    /// The character playing the Villain. In multiplayer this is the GM's own
    /// pre-seated party character; in single-player it is a non-party,
    /// computer-driven character.
    pub character_id: CharacterId,
    /// The draw pile, bottom-to-top (draws pop from the END). Authored order
    /// at genesis; shuffled through `World.rng` at `begin_campaign`.
    pub deck: Vec<String>,
    /// The cards currently playable. Filled to `VILLAIN_HAND_SIZE` at
    /// `begin_campaign`.
    pub hand: Vec<String>,
    /// Spent/discarded cards; reshuffled into `deck` (via `World.rng`) when a
    /// draw finds the deck empty.
    pub discard: Vec<String>,
    /// The per-turn exclusivity latch: `true` once the villain has taken its
    /// one card action this turn (play-and-draw OR mulligan), reset on the
    /// villain's turn start. Omitted while `false` so goldens stay byte-stable.
    #[serde(default, skip_serializing_if = "is_false")]
    pub card_action_taken: bool,
}

/// A required (pinned) passage for procedural map generation: the two rooms are
/// guaranteed adjacent in every generated layout, and the exit carries the
/// authored door behavior/name/state (a keyed mausoleum door survives the
/// shuffle). Compass directions are still assigned by the generator.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequiredExitSnapshot {
    pub from: RoomId,
    pub to: RoomId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub behavior_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub state: Value,
}

/// Procedural map-generation config (the `[mapGen]` authoring table). When a
/// campaign carries one, its rooms are authored WITHOUT `[[exits]]` and the
/// engine wires them at `begin_campaign` via a randomized spanning tree drawn
/// from `World.rng` — every room reachable, bidirectional exits, no
/// self-connections, at most `max_exits_per_room` exits per room. Absent (and
/// omitted on serialize) for hand-wired campaigns, so pre-existing goldens
/// stay byte-stable.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapGenSnapshot {
    /// Loop edges beyond the spanning tree: an absolute count (`>= 1`), or a
    /// fraction of `n - 1` when strictly between 0 and 1. Default 0.
    #[serde(default, skip_serializing_if = "is_zero_f64")]
    pub extra_connections: f64,
    /// Room pairs pinned as neighbors before the tree is laid down (keyed
    /// doors and other authored passages that must exist in every layout).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub required: Vec<RequiredExitSnapshot>,
    /// Per-room exit cap, clamped to `2..=8` at build time. Default 8 (the
    /// eight compass directions).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_exits_per_room: Option<i64>,
    /// Rooms the generator may reach ONLY through `required` passages: they
    /// never host tree or loop edges, so a locked crypt's keyed door stays its
    /// sole entrance in every layout. Each sealed room must appear in a
    /// `required` pair or the build fails (a stranded room is an error).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sealed: Vec<RoomId>,
}

/// Serde `skip_serializing_if` for `MapGenSnapshot::extra_connections`.
#[allow(clippy::trivially_copy_pass_by_ref)]
fn is_zero_f64(n: &f64) -> bool {
    *n == 0.0
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VictoryConditionSnapshot {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub narration: Option<crate::presentation::OutcomeNarration>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CampaignCoreSnapshot {
    pub id: String,
    pub title: String,
    pub max_rounds: i64,
    pub round: i64,
    pub started: bool,
    pub outcome: crate::presentation::CampaignOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome_reason: Option<String>,
    pub win_conditions: Vec<VictoryConditionSnapshot>,
    pub lose_conditions: Vec<VictoryConditionSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_narration: Option<crate::presentation::OutcomeNarration>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_narration: Option<crate::presentation::OutcomeNarration>,
    pub active_character_index: i64,
    pub party_ids: Vec<CharacterId>,
    pub acted_this_round: Vec<CharacterId>,
    pub gm_id: Option<CharacterId>, // present but nullable -> keep null
    pub materials: Value,           // MaterialMap, inert
    pub claims: Vec<String>,
    pub encountered: Vec<String>,
    pub known_recipes: Vec<String>,
    pub archetypes: Value, // Archetype[], inert
    pub action_sounds: Value,
    pub encounter_table: Value,
    pub chat_policy: Value,
    pub av_policy: Value,
    pub mechanics: Vec<MechanicSnapshot>,
    /// The Villain designation + card state. Absent (and omitted on serialize)
    /// for a campaign with no villain, so pre-villain goldens stay byte-stable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub villain: Option<VillainSnapshot>,
    /// Rounds of supernatural darkness remaining (the `wicked:lights-out`
    /// card). While `> 0`, every room is unlit regardless of light sources.
    /// Ticks down at round end; omitted while `0` so goldens stay byte-stable.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub lights_out_rounds: i64,
    /// Campaign-wide, world-scoped script state: a JSON object readable from
    /// EVERY DSL context via `worldGet(...)` and written through the
    /// `setWorld(...)` effect. Unlike per-behavior `state`, this is the one
    /// sanctioned cross-behavior channel — a night clock a victory test can
    /// read, a ward a card can break. `null`/absent is the empty state and the
    /// key is omitted on serialize, so pre-existing goldens stay byte-stable.
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub world_state: Value,
    /// Procedural map-generation config. When present, `begin_campaign` wires
    /// the room graph from `World.rng` (see `MapGenSnapshot`); absent (and
    /// omitted on serialize) for hand-wired campaigns.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub map_gen: Option<MapGenSnapshot>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CampaignSnapshot {
    pub schema_version: i64,
    pub campaign: CampaignCoreSnapshot,
    pub rooms: Vec<RoomSnapshot>,
    pub exits: Vec<ExitSnapshot>,
    pub characters: Vec<CharacterSnapshot>,
    pub items: Vec<ItemSnapshot>,
    pub loot: Vec<LootSnapshot>,
    pub material_caches: Vec<MaterialCacheSnapshot>,
    pub codex: Value, // CodexEntry[], inert
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip<T: Serialize + for<'de> Deserialize<'de> + PartialEq + std::fmt::Debug>(
        json: &str,
    ) {
        let v: T = serde_json::from_str(json).unwrap();
        let out = serde_json::to_value(&v).unwrap();
        let expected: Value = serde_json::from_str(json).unwrap();
        assert_eq!(out, expected, "round-trip changed the JSON");
    }

    #[test]
    fn item_variant_roundtrips() {
        roundtrip::<ItemSnapshot>(
            r#"{"kind":"item","id":"i1","behaviorKey":"lantern","modifier":0}"#,
        );
        roundtrip::<ItemSnapshot>(
            r#"{"kind":"item","id":"i2","behaviorKey":"sword","durability":3,"modifier":2}"#,
        );
    }

    #[test]
    fn key_variant_roundtrips() {
        roundtrip::<ItemSnapshot>(
            r#"{"kind":"key","id":"k1","name":"Brass Key","keyCode":"crypt","consumeOnUse":true}"#,
        );
    }

    #[test]
    fn exit_roundtrips_with_and_without_optionals() {
        roundtrip::<ExitSnapshot>(r#"{"id":"e1","endpointIds":["r1","r2"],"state":{}}"#);
        roundtrip::<ExitSnapshot>(
            r#"{"id":"e2","endpointIds":["r1","r3"],"behaviorKey":"locked","name":"oak door","state":{"locked":true}}"#,
        );
    }

    #[test]
    fn player_character_roundtrips() {
        roundtrip::<CharacterSnapshot>(
            r#"{
            "kind":"player","id":"c1","name":"Heir",
            "stats":{"energy":5.0,"sanity":7.0,"health":10.0},
            "actionsPerRound":2,"actionsThisRound":0,"currentRoomId":"r1",
            "inventory":{"slots":6,"itemIds":["i1"],"keyIds":[]},
            "equipment":{"hand":"i1"},
            "history":[],"archetypeImmunities":[],
            "afflictions":{"active":{},"turnsActive":{},"shakenOff":[],"immunity":{}},
            "archetypeId":"survivor"
        }"#,
        );
    }

    #[test]
    fn mob_character_roundtrips_with_null_room_and_omitted_player_fields() {
        roundtrip::<CharacterSnapshot>(
            r#"{
            "kind":"mob","id":"m1","name":"Wraith",
            "stats":{"energy":3.0,"sanity":0.0,"health":4.0},
            "actionsPerRound":1,"actionsThisRound":0,"currentRoomId":null,
            "inventory":{"slots":0,"itemIds":[],"keyIds":[]},
            "equipment":{},
            "history":[],"archetypeImmunities":[],
            "afflictions":{"active":{},"turnsActive":{},"shakenOff":[],"immunity":{}},
            "origin":{"some":"data"},"lightAverse":true,"naturalAttack":{"stat":"sanity","power":2}
        }"#,
        );
    }

    #[test]
    fn stats_roundtrip_fractional_value() {
        // Post-mitigation damage lands fractional bases (e.g. 7.5, 2.4). f64 must
        // preserve them across serialize/deserialize.
        let s = Stats {
            energy: 2.4,
            sanity: 0.5,
            health: 7.5,
        };
        let json = serde_json::to_string(&s).unwrap();
        let back: Stats = serde_json::from_str(&json).unwrap();
        assert_eq!(back, s);
        // Integer-valued stats still (de)serialize; serde emits `10.0`, which the
        // conformance comparator parses back to the JS number 10 (transparent).
        let whole: Stats = serde_json::from_str(r#"{"energy":5,"sanity":7,"health":10}"#).unwrap();
        assert_eq!(
            whole,
            Stats {
                energy: 5.0,
                sanity: 7.0,
                health: 10.0
            }
        );
    }

    #[test]
    fn mob_with_base_escape_chance_roundtrips_as_integer() {
        // baseEscapeChance is integer-valued (e.g. 50 from the Hollow House genesis fixture).
        // With Option<f64>, serde would re-serialise 50 as 50.0, causing a byte-diff.
        // With Option<i64>, the value round-trips as exactly 50 — no JSON.parse normalisation needed.
        let json = r#"{
            "kind":"mob","id":"m2","name":"Shade",
            "stats":{"energy":2.0,"sanity":0.0,"health":3.0},
            "actionsPerRound":1,"actionsThisRound":0,"currentRoomId":null,
            "inventory":{"slots":0,"itemIds":[],"keyIds":[]},
            "equipment":{},
            "history":[],"archetypeImmunities":[],
            "afflictions":{"active":{},"turnsActive":{},"shakenOff":[],"immunity":{}},
            "baseEscapeChance":50
        }"#;
        let snap: CharacterSnapshot = serde_json::from_str(json).unwrap();
        assert_eq!(snap.base_escape_chance, Some(50i64));
        let out = serde_json::to_value(&snap).unwrap();
        let expected: Value = serde_json::from_str(json).unwrap();
        assert_eq!(
            out, expected,
            "baseEscapeChance 50 must round-trip as integer 50, not 50.0"
        );
    }

    #[test]
    fn character_without_visible_key_parses_to_true() {
        // Backward-compat: a snapshot written before `visible` existed has no
        // `visible` key and must hydrate as visible (default_true).
        let json = r#"{
            "kind":"player","id":"c1","name":"Heir",
            "stats":{"energy":5.0,"sanity":7.0,"health":10.0},
            "actionsPerRound":2,"actionsThisRound":0,"currentRoomId":"r1",
            "inventory":{"slots":6,"itemIds":[],"keyIds":[]},
            "equipment":{},
            "history":[],"archetypeImmunities":[],
            "afflictions":{"active":{},"turnsActive":{},"shakenOff":[],"immunity":{}}
        }"#;
        let snap: CharacterSnapshot = serde_json::from_str(json).unwrap();
        assert!(snap.visible, "absent `visible` must parse to true");
    }

    #[test]
    fn visible_true_is_omitted_from_serialization() {
        // A visible character omits the `visible` key (skip_serializing_if = is_true)
        // so pre-existing goldens (which never carried the key) stay byte-stable.
        let json = r#"{
            "kind":"player","id":"c1","name":"Heir",
            "stats":{"energy":5.0,"sanity":7.0,"health":10.0},
            "actionsPerRound":2,"actionsThisRound":0,"currentRoomId":"r1",
            "inventory":{"slots":6,"itemIds":[],"keyIds":[]},
            "equipment":{},
            "history":[],"archetypeImmunities":[],
            "afflictions":{"active":{},"turnsActive":{},"shakenOff":[],"immunity":{}}
        }"#;
        let snap: CharacterSnapshot = serde_json::from_str(json).unwrap();
        let out = serde_json::to_value(&snap).unwrap();
        assert!(
            out.get("visible").is_none(),
            "visible:true must not serialise (goldens stay byte-stable)"
        );
    }

    #[test]
    fn hidden_character_roundtrips_visible_false() {
        // A hidden character serialises `visible: false` and round-trips.
        let json = r#"{
            "kind":"npc","id":"n1","name":"Ghost",
            "stats":{"energy":1.0,"sanity":1.0,"health":1.0},
            "actionsPerRound":1,"actionsThisRound":0,"currentRoomId":"r1",
            "inventory":{"slots":0,"itemIds":[],"keyIds":[]},
            "equipment":{},
            "history":[],"archetypeImmunities":[],
            "afflictions":{"active":{},"turnsActive":{},"shakenOff":[],"immunity":{}},
            "visible":false
        }"#;
        let snap: CharacterSnapshot = serde_json::from_str(json).unwrap();
        assert!(!snap.visible);
        roundtrip::<CharacterSnapshot>(json);
    }

    #[test]
    fn room_roundtrips() {
        roundtrip::<RoomSnapshot>(
            r#"{
            "id":"r1","name":"Foyer","description":"Dusty.",
            "exits":{"north":"e1"},"dark":false,"spawnModifier":0,
            "occupantIds":["c1"],"lootIds":[],"materialCacheIds":[],"lightSourceIds":[],"scenes":[]
        }"#,
        );
    }

    #[test]
    fn victory_condition_snapshot_roundtrips() {
        roundtrip::<VictoryConditionSnapshot>(
            r#"{"key":"conformance:round-reached","narration":{"text":"You win."}}"#,
        );
        // narration omitted when absent (skip_serializing_if)
        roundtrip::<VictoryConditionSnapshot>(r#"{"key":"party-wiped"}"#);
    }

    #[test]
    fn full_campaign_snapshot_roundtrips() {
        let json = r#"{
          "schemaVersion":6,
          "campaign":{
            "id":"camp1","title":"Hollow House","maxRounds":20,"round":0,"started":false,
            "outcome":"ongoing","winConditions":[],"loseConditions":[],
            "activeCharacterIndex":0,"partyIds":["c1"],"actedThisRound":[],"gmId":null,
            "materials":{},"claims":[],"encountered":[],"knownRecipes":[],"archetypes":[],
            "actionSounds":{},"encounterTable":{"baseChance":0,"visited":[],"formations":[]},
            "chatPolicy":{},"avPolicy":{},"mechanics":[{"key":"dread","state":{}}]
          },
          "rooms":[{"id":"r1","name":"Foyer","description":"Dusty.","exits":{},"dark":false,
            "spawnModifier":0,"occupantIds":["c1"],"lootIds":[],"materialCacheIds":[],
            "lightSourceIds":[],"scenes":[]}],
          "exits":[],
          "characters":[{"kind":"player","id":"c1","name":"Heir",
            "stats":{"energy":5.0,"sanity":7.0,"health":10.0},"actionsPerRound":2,"actionsThisRound":0,
            "currentRoomId":"r1","inventory":{"slots":6,"itemIds":[],"keyIds":[]},"equipment":{},
            "history":[],"archetypeImmunities":[],
            "afflictions":{"active":{},"turnsActive":{},"shakenOff":[],"immunity":{}}}],
          "items":[],"loot":[],"materialCaches":[],"codex":[]
        }"#;
        roundtrip::<CampaignSnapshot>(json);
    }

    #[test]
    fn campaign_without_villain_keys_parses_and_omits_them() {
        // Backward-compat: a pre-villain snapshot has neither `villain` nor
        // `lightsOutRounds` and must hydrate to None/0 — and serialise neither
        // key back out, so pre-existing goldens stay byte-stable.
        let json = r#"{
            "id":"camp1","title":"T","maxRounds":20,"round":0,"started":false,
            "outcome":"ongoing","winConditions":[],"loseConditions":[],
            "activeCharacterIndex":0,"partyIds":[],"actedThisRound":[],"gmId":null,
            "materials":{},"claims":[],"encountered":[],"knownRecipes":[],"archetypes":[],
            "actionSounds":{},"encounterTable":{},"chatPolicy":{},"avPolicy":{},"mechanics":[]
        }"#;
        let core: CampaignCoreSnapshot = serde_json::from_str(json).unwrap();
        assert!(core.villain.is_none());
        assert_eq!(core.lights_out_rounds, 0);
        let out = serde_json::to_value(&core).unwrap();
        assert!(
            out.get("villain").is_none(),
            "absent villain must not serialise"
        );
        assert!(
            out.get("lightsOutRounds").is_none(),
            "zero lightsOutRounds must not serialise"
        );
    }

    #[test]
    fn villain_snapshot_roundtrips_and_omits_clear_latch() {
        roundtrip::<VillainSnapshot>(
            r#"{"characterId":"mob:Warden","deck":["a","b"],"hand":["c"],"discard":[],"cardActionTaken":true}"#,
        );
        // The clear latch is omitted on serialize.
        let v: VillainSnapshot = serde_json::from_str(
            r#"{"characterId":"mob:Warden","deck":[],"hand":[],"discard":[]}"#,
        )
        .unwrap();
        assert!(!v.card_action_taken, "absent latch must parse to false");
        let out = serde_json::to_value(&v).unwrap();
        assert!(
            out.get("cardActionTaken").is_none(),
            "clear latch must not serialise"
        );
    }
}
