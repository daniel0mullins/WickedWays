//! The actor-tagged multiplayer command union (Phase 2c, sub-project A).
//!
//! Mirrors `src/lib/sync/types.ts` `Command` 1:1 — the serializable player/GM/NPC
//! intent where every entity reference is an id and every *turn-action* carries the
//! acting character's `actorId`. This is the networked wire vocabulary the sync
//! `Authority` (sub-project B) resolves and the room server (C) gates — distinct from
//! the single-seat internal [`Command`](crate::world::command::Command), which carries
//! no actor id and only exists for the conformance replay harness.
//!
//! Serde parity with the TS union is asserted byte-for-byte in the tests (this is the
//! wire contract). ts-rs export is intentionally deferred to sub-project B, where the
//! type first has to cross the JSON seam to a generated TS binding.

use alloc::boxed::Box;
use alloc::string::String;
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};

use crate::world::ids::{CharacterId, ItemId, LootId, MaterialCacheId, RoomId};
use crate::world::snapshot::CharacterSnapshot;

/// A named equipment slot — the optional `slot` of an `equip` command. Mirrors
/// `src/lib/equipment.ts` `EquipmentSlot` (the *named* slot, e.g. `leftHand`), which
/// is finer-grained than the engine's [`SlotKind`](crate::world::descriptor::SlotKind)
/// (the slot *kind*, e.g. `hand`). Serialized as its camelCase string.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EquipmentSlot {
    Head,
    Torso,
    Legs,
    Feet,
    LeftWrist,
    RightWrist,
    LeftHand,
    RightHand,
    LeftIndexFinger,
    LeftRingFinger,
    RightIndexFinger,
    RightRingFinger,
}

/// A serializable player/GM/NPC command. Every entity reference is an id; the tag is
/// `kind` (camelCase). Mirrors the TS `Command` union field-for-field.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Command {
    // ── turn-actions: a PlayerCharacter, only legal on its own turn ──
    #[serde(rename_all = "camelCase")]
    Move { actor_id: CharacterId, room_id: RoomId },
    #[serde(rename_all = "camelCase")]
    Attack { actor_id: CharacterId, target_id: CharacterId },
    #[serde(rename_all = "camelCase")]
    Equip {
        actor_id: CharacterId,
        item_id: ItemId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        slot: Option<EquipmentSlot>,
    },
    #[serde(rename_all = "camelCase")]
    Unequip { actor_id: CharacterId, item_id: ItemId },
    #[serde(rename_all = "camelCase")]
    Craft { actor_id: CharacterId, recipe_id: String },
    #[serde(rename_all = "camelCase")]
    Repair { actor_id: CharacterId, item_id: ItemId },
    // Scrap a held item back into the shared material pool. A Rust-side extension beyond the TS
    // `types.ts` union (the TS engine ran `destroy` through the item-action/session layer), like
    // `talk`/`wait`: the Rust surfaces route every action through sync, so it needs a wire command.
    // Free — turn-gated, no budget tick.
    #[serde(rename_all = "camelCase")]
    Destroy { actor_id: CharacterId, item_id: ItemId },
    #[serde(rename_all = "camelCase")]
    PickUp { actor_id: CharacterId, item_ids: Vec<ItemId> },
    #[serde(rename_all = "camelCase")]
    Drop { actor_id: CharacterId, item_ids: Vec<ItemId> },
    #[serde(rename_all = "camelCase")]
    TakeFromLootBox { actor_id: CharacterId, loot_id: LootId, item_ids: Vec<ItemId> },
    #[serde(rename_all = "camelCase")]
    PutInLootBox { actor_id: CharacterId, loot_id: LootId, item_ids: Vec<ItemId> },
    #[serde(rename_all = "camelCase")]
    TransferKey { actor_id: CharacterId, item_id: ItemId, recipient_id: CharacterId },
    #[serde(rename_all = "camelCase")]
    ConsumeKey { actor_id: CharacterId, item_id: ItemId },
    #[serde(rename_all = "camelCase")]
    Use { actor_id: CharacterId, item_id: ItemId },
    #[serde(rename_all = "camelCase")]
    PlaceLight { actor_id: CharacterId, item_id: ItemId },
    #[serde(rename_all = "camelCase")]
    TakeLight { actor_id: CharacterId, item_id: ItemId },
    #[serde(rename_all = "camelCase")]
    Harvest { actor_id: CharacterId, cache_id: MaterialCacheId },
    // ── free NPC interaction: dialogue (non-advancing; runs on your own turn) ──
    // A Rust-side extension beyond the TS `types.ts` union: the original engine ran NPC
    // dialogue through the single-seat session layer, but the Rust surfaces route every
    // action through sync, so `talk` needs a wire command to reach the authority. Free
    // (it spends no round/budget), but classified apart from the turn-actions above so it
    // is NOT part of the TS-mirrored `TURN_ACTION_KINDS`.
    #[serde(rename_all = "camelCase")]
    Talk {
        actor_id: CharacterId,
        npc_id: CharacterId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prompt: Option<String>,
    },
    // ── pass the turn: a time-advancing no-op (the `wait` verb) ──
    // Another Rust-side extension: the TS union expressed "wait" only as an `Intent`, never a wire
    // `Command` (the solo session ran it locally). The offline single-player authority resolves it
    // through the solo turn loop (start_turn → mob reactions → next_player); in multiplayer it is a
    // no-op the GM's `nextPlayer` supersedes.
    #[serde(rename_all = "camelCase")]
    Wait { actor_id: CharacterId },
    // ── end-of-turn: a player ends their OWN turn ──
    // A Rust-side extension: carries the acting player's id so the room server routes it to that
    // player's seat (a player may only end their own turn), whereas the GM's `nextPlayer` (no actor)
    // can end anyone's. Both advance the active seat; managed-turn mode `start_turn`s the next player.
    #[serde(rename_all = "camelCase")]
    EndTurn { actor_id: CharacterId },
    // ── setup: pre-start, on your own character ──
    #[serde(rename_all = "camelCase")]
    SelectArchetype { actor_id: CharacterId, archetype_id: String },
    // ── join: self-service; carries the new character's bare snapshot ──
    // Boxed: a `CharacterSnapshot` dwarfs every id-only variant, so keeping it inline
    // would bloat every `Command` value (and every `LogEntry` that carries one). serde
    // treats `Box<T>` transparently, so the wire shape is unchanged.
    JoinCampaign { character: Box<CharacterSnapshot> },
    // ── GM / lifecycle / NPC: issued by the GM ──
    BeginCampaign,
    EndCampaign,
    NextPlayer,
    #[serde(rename_all = "camelCase")]
    LeaveCampaign { character_id: CharacterId },
    // `transferGM` keeps its trailing capitals on the wire (camelCase would give
    // `transferGm`), so the tag is pinned explicitly.
    #[serde(rename = "transferGM", rename_all = "camelCase")]
    TransferGm { character_id: CharacterId },
    #[serde(rename_all = "camelCase")]
    MobEscape { mob_id: CharacterId },
    #[serde(rename_all = "camelCase")]
    MobAttack { mob_id: CharacterId, target_id: CharacterId },
}

impl Command {
    /// `true` for player turn-actions (move, attack, equip, …) — the ones gated to
    /// the active character's turn. Mirrors `types.ts` `TURN_ACTION_KINDS`.
    pub fn is_turn_action(&self) -> bool {
        matches!(
            self,
            Command::Move { .. }
                | Command::Attack { .. }
                | Command::Equip { .. }
                | Command::Unequip { .. }
                | Command::Craft { .. }
                | Command::Repair { .. }
                | Command::Destroy { .. }
                | Command::PickUp { .. }
                | Command::Drop { .. }
                | Command::TakeFromLootBox { .. }
                | Command::PutInLootBox { .. }
                | Command::TransferKey { .. }
                | Command::ConsumeKey { .. }
                | Command::Use { .. }
                | Command::PlaceLight { .. }
                | Command::TakeLight { .. }
                | Command::Harvest { .. }
        )
    }

    /// `true` for turn-actions that actually **spend** the per-round action budget, i.e.
    /// `is_turn_action` minus the deliberately **free** verbs (`equip`/`unequip`/`craft`/`repair`/
    /// `harvest`), which require the actor's turn but never tick `actionsThisRound` (mirroring the
    /// engine's `recordAction(fn, budgeted=false)` for those methods). The managed-turns budget gate
    /// keys off this — a spent budget bars a *budgeted* action but must still allow the free ones.
    pub fn is_budgeted_action(&self) -> bool {
        self.is_turn_action()
            && !matches!(
                self,
                Command::Equip { .. }
                    | Command::Unequip { .. }
                    | Command::Craft { .. }
                    | Command::Repair { .. }
                    | Command::Destroy { .. }
                    | Command::Harvest { .. }
            )
    }

    /// `true` for pre-start setup commands (`selectArchetype`).
    pub fn is_setup_command(&self) -> bool {
        matches!(self, Command::SelectArchetype { .. })
    }

    /// `true` for GM / lifecycle / NPC commands (beginCampaign, mobAttack, …).
    pub fn is_gm_command(&self) -> bool {
        matches!(
            self,
            Command::BeginCampaign
                | Command::EndCampaign
                | Command::NextPlayer
                | Command::LeaveCampaign { .. }
                | Command::TransferGm { .. }
                | Command::MobEscape { .. }
                | Command::MobAttack { .. }
        )
    }

    /// `true` for the self-service join command.
    pub fn is_join_command(&self) -> bool {
        matches!(self, Command::JoinCampaign { .. })
    }

    /// `true` for free NPC interactions (`talk`) — non-advancing, permitted on your own turn.
    pub fn is_npc_interaction(&self) -> bool {
        matches!(self, Command::Talk { .. })
    }

    /// `true` for a player ending their own turn (`endTurn`) — permitted on your own turn, advances
    /// the active seat (like the GM's `nextPlayer`, but self-service).
    pub fn is_end_turn(&self) -> bool {
        matches!(self, Command::EndTurn { .. })
    }

    /// `true` for time-advancing player actions — the ones the solo turn loop wraps with
    /// `start_turn` → action → mob reactions → `next_player`. Mirrors `intent.rs`
    /// `is_time_advancing` (move/take/drop/use/attack/wait); equip/unequip/talk are free.
    pub fn is_time_advancing(&self) -> bool {
        matches!(
            self,
            Command::Move { .. }
                | Command::PickUp { .. }
                | Command::Drop { .. }
                | Command::Use { .. }
                | Command::Attack { .. }
                | Command::Wait { .. }
        )
    }

    /// The acting player's id for turn/setup commands; `None` for GM/lifecycle/NPC/join
    /// commands. Mirrors `types.ts` `commandActorId`.
    pub fn actor_id(&self) -> Option<&CharacterId> {
        match self {
            Command::Move { actor_id, .. }
            | Command::Attack { actor_id, .. }
            | Command::Equip { actor_id, .. }
            | Command::Unequip { actor_id, .. }
            | Command::Craft { actor_id, .. }
            | Command::Repair { actor_id, .. }
            | Command::Destroy { actor_id, .. }
            | Command::PickUp { actor_id, .. }
            | Command::Drop { actor_id, .. }
            | Command::TakeFromLootBox { actor_id, .. }
            | Command::PutInLootBox { actor_id, .. }
            | Command::TransferKey { actor_id, .. }
            | Command::ConsumeKey { actor_id, .. }
            | Command::Use { actor_id, .. }
            | Command::PlaceLight { actor_id, .. }
            | Command::TakeLight { actor_id, .. }
            | Command::Harvest { actor_id, .. }
            | Command::Talk { actor_id, .. }
            | Command::Wait { actor_id }
            | Command::EndTurn { actor_id }
            | Command::SelectArchetype { actor_id, .. } => Some(actor_id),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;
    use serde_json::json;

    /// Every non-join variant round-trips through the exact `src/lib/sync/types.ts`
    /// JSON shape (byte-for-byte field names + tag). This is the wire contract.
    #[test]
    fn command_json_shapes_mirror_ts_union() {
        let cases = [
            json!({ "kind": "move", "actorId": "c1", "roomId": "r1" }),
            json!({ "kind": "attack", "actorId": "c1", "targetId": "m1" }),
            json!({ "kind": "equip", "actorId": "c1", "itemId": "i1", "slot": "leftHand" }),
            json!({ "kind": "equip", "actorId": "c1", "itemId": "i1" }),
            json!({ "kind": "unequip", "actorId": "c1", "itemId": "i1" }),
            json!({ "kind": "craft", "actorId": "c1", "recipeId": "torch" }),
            json!({ "kind": "repair", "actorId": "c1", "itemId": "i1" }),
            json!({ "kind": "destroy", "actorId": "c1", "itemId": "i1" }),
            json!({ "kind": "pickUp", "actorId": "c1", "itemIds": ["i1", "i2"] }),
            json!({ "kind": "drop", "actorId": "c1", "itemIds": ["i1"] }),
            json!({ "kind": "takeFromLootBox", "actorId": "c1", "lootId": "l1", "itemIds": ["i1"] }),
            json!({ "kind": "putInLootBox", "actorId": "c1", "lootId": "l1", "itemIds": ["i1"] }),
            json!({ "kind": "transferKey", "actorId": "c1", "itemId": "k1", "recipientId": "c2" }),
            json!({ "kind": "consumeKey", "actorId": "c1", "itemId": "k1" }),
            json!({ "kind": "use", "actorId": "c1", "itemId": "i1" }),
            json!({ "kind": "placeLight", "actorId": "c1", "itemId": "i1" }),
            json!({ "kind": "takeLight", "actorId": "c1", "itemId": "i1" }),
            json!({ "kind": "harvest", "actorId": "c1", "cacheId": "cache1" }),
            json!({ "kind": "selectArchetype", "actorId": "c1", "archetypeId": "a1" }),
            json!({ "kind": "beginCampaign" }),
            json!({ "kind": "endCampaign" }),
            json!({ "kind": "nextPlayer" }),
            json!({ "kind": "leaveCampaign", "characterId": "c1" }),
            json!({ "kind": "transferGM", "characterId": "c2" }),
            json!({ "kind": "mobEscape", "mobId": "m1" }),
            json!({ "kind": "mobAttack", "mobId": "m1", "targetId": "c1" }),
        ];
        for case in cases {
            let parsed: Command = serde_json::from_value(case.clone())
                .unwrap_or_else(|e| panic!("deserialize {case}: {e}"));
            assert_eq!(serde_json::to_value(&parsed).unwrap(), case, "round-trip {case}");
        }
    }

    #[test]
    fn transfer_gm_tag_keeps_trailing_capitals() {
        let c: Command =
            serde_json::from_value(json!({ "kind": "transferGM", "characterId": "c1" })).unwrap();
        assert!(matches!(c, Command::TransferGm { .. }));
        assert_eq!(
            serde_json::to_value(&c).unwrap()["kind"],
            json!("transferGM"),
            "the tag must stay `transferGM`, not `transferGm`"
        );
    }

    #[test]
    fn classifiers_partition_the_union() {
        let turn = Command::Move { actor_id: CharacterId("c1".into()), room_id: RoomId("r1".into()) };
        let setup = Command::SelectArchetype { actor_id: CharacterId("c1".into()), archetype_id: "a".into() };
        let gm = Command::NextPlayer;
        assert!(turn.is_turn_action() && !turn.is_setup_command() && !turn.is_gm_command());
        assert!(setup.is_setup_command() && !setup.is_turn_action() && !setup.is_gm_command());
        assert!(gm.is_gm_command() && !gm.is_turn_action() && !gm.is_setup_command());
    }

    #[test]
    fn budgeted_action_excludes_the_free_verbs() {
        // Budgeted turn-actions spend the per-round budget…
        let mv = Command::Move { actor_id: CharacterId("c1".into()), room_id: RoomId("r1".into()) };
        let attack = Command::Attack {
            actor_id: CharacterId("c1".into()),
            target_id: CharacterId("m1".into()),
        };
        assert!(mv.is_budgeted_action() && mv.is_turn_action());
        assert!(attack.is_budgeted_action());
        // …while equip/unequip/craft/repair/harvest are turn-actions but FREE (no budget tick), so a
        // spent budget must not bar them.
        for free in [
            Command::Equip {
                actor_id: CharacterId("c1".into()),
                item_id: ItemId("i1".into()),
                slot: None,
            },
            Command::Unequip { actor_id: CharacterId("c1".into()), item_id: ItemId("i1".into()) },
            Command::Craft { actor_id: CharacterId("c1".into()), recipe_id: "r".into() },
            Command::Repair { actor_id: CharacterId("c1".into()), item_id: ItemId("i1".into()) },
            Command::Destroy { actor_id: CharacterId("c1".into()), item_id: ItemId("i1".into()) },
            Command::Harvest {
                actor_id: CharacterId("c1".into()),
                cache_id: MaterialCacheId("cache1".into()),
            },
        ] {
            assert!(free.is_turn_action(), "{free:?} still requires the actor's turn");
            assert!(!free.is_budgeted_action(), "{free:?} is a free action, not budgeted");
        }
    }

    #[test]
    fn actor_id_is_present_for_turn_and_setup_only() {
        let turn = Command::Attack {
            actor_id: CharacterId("c1".into()),
            target_id: CharacterId("m1".into()),
        };
        let setup = Command::SelectArchetype {
            actor_id: CharacterId("c2".into()),
            archetype_id: "a".into(),
        };
        assert_eq!(turn.actor_id(), Some(&CharacterId("c1".into())));
        assert_eq!(setup.actor_id(), Some(&CharacterId("c2".into())));
        assert_eq!(Command::NextPlayer.actor_id(), None);
        assert_eq!(Command::MobEscape { mob_id: CharacterId("m1".into()) }.actor_id(), None);
    }

    #[test]
    fn join_carries_a_character_snapshot_and_has_no_actor() {
        // A join wraps a full CharacterSnapshot; borrow one from a built world.
        let world = crate::world::test_support::world_with_party(&["c1"], 10);
        let character = world.characters[&CharacterId("c1".into())].clone();
        let join = Command::JoinCampaign { character: Box::new(character) };
        assert!(join.is_join_command());
        assert_eq!(join.actor_id(), None);
        // The tag is `joinCampaign` and the character rides under `character`.
        let v = serde_json::to_value(&join).unwrap();
        assert_eq!(v["kind"], json!("joinCampaign"));
        assert_eq!(v["character"]["id"], json!("c1"));
        // …and it round-trips.
        let back: Command = serde_json::from_value(v).unwrap();
        assert_eq!(back, join);
    }

    #[test]
    fn talk_round_trips_and_classifies_as_a_free_npc_interaction() {
        let bare = Command::Talk {
            actor_id: CharacterId("c1".into()),
            npc_id: CharacterId("npc:Caretaker".into()),
            prompt: None,
        };
        // Prompt is omitted when absent (wire shape).
        assert_eq!(
            serde_json::to_value(&bare).unwrap(),
            json!({ "kind": "talk", "actorId": "c1", "npcId": "npc:Caretaker" })
        );
        // A free interaction: carries an actor, but is NOT a turn/gm/setup/join command.
        assert!(bare.is_npc_interaction());
        assert_eq!(bare.actor_id(), Some(&CharacterId("c1".into())));
        assert!(!bare.is_turn_action() && !bare.is_gm_command() && !bare.is_setup_command() && !bare.is_join_command());
        // A prompt round-trips.
        let with: Command = serde_json::from_value(
            json!({ "kind": "talk", "actorId": "c1", "npcId": "n1", "prompt": "the cellar" }),
        )
        .unwrap();
        assert!(matches!(with, Command::Talk { prompt: Some(p), .. } if p == "the cellar"));
    }

    #[test]
    fn end_turn_round_trips_and_carries_the_acting_player() {
        let et = Command::EndTurn { actor_id: CharacterId("c1".into()) };
        assert_eq!(serde_json::to_value(&et).unwrap(), json!({ "kind": "endTurn", "actorId": "c1" }));
        // Carries an actor (so the room server routes it to that player's seat), but is not a
        // turn-action / gm / setup command.
        assert!(et.is_end_turn());
        assert_eq!(et.actor_id(), Some(&CharacterId("c1".into())));
        assert!(!et.is_turn_action() && !et.is_gm_command() && !et.is_time_advancing());
    }

    #[test]
    fn wait_round_trips_and_is_time_advancing() {
        let wait = Command::Wait { actor_id: CharacterId("c1".into()) };
        assert_eq!(
            serde_json::to_value(&wait).unwrap(),
            json!({ "kind": "wait", "actorId": "c1" })
        );
        // A time-advancing pass: carries an actor, but is not a turn/gm/setup/join command.
        assert!(wait.is_time_advancing());
        assert_eq!(wait.actor_id(), Some(&CharacterId("c1".into())));
        assert!(!wait.is_turn_action() && !wait.is_gm_command() && !wait.is_npc_interaction());
        // Move/pickUp/drop/use/attack are time-advancing; equip/unequip/talk are not.
        let m = Command::Move { actor_id: CharacterId("c1".into()), room_id: RoomId("r".into()) };
        assert!(m.is_time_advancing());
        let e = Command::Equip { actor_id: CharacterId("c1".into()), item_id: ItemId("i".into()), slot: None };
        assert!(!e.is_time_advancing());
        let t = Command::Talk { actor_id: CharacterId("c1".into()), npc_id: CharacterId("n".into()), prompt: None };
        assert!(!t.is_time_advancing());
    }

    #[test]
    fn equip_slot_is_optional_and_omitted_when_absent() {
        let no_slot = Command::Equip {
            actor_id: CharacterId("c1".into()),
            item_id: ItemId("i1".into()),
            slot: None,
        };
        assert_eq!(
            serde_json::to_value(&no_slot).unwrap(),
            json!({ "kind": "equip", "actorId": "c1", "itemId": "i1" })
        );
        let with_slot: Command =
            serde_json::from_value(json!({ "kind": "equip", "actorId": "c1", "itemId": "i1", "slot": "rightIndexFinger" }))
                .unwrap();
        assert!(matches!(
            with_slot,
            Command::Equip { slot: Some(EquipmentSlot::RightIndexFinger), .. }
        ));
    }

    #[test]
    fn item_ids_are_batched_lists() {
        let c: Command = serde_json::from_value(
            json!({ "kind": "pickUp", "actorId": "c1", "itemIds": ["a", "b", "c"] }),
        )
        .unwrap();
        assert_eq!(
            c,
            Command::PickUp {
                actor_id: CharacterId("c1".into()),
                item_ids: vec![ItemId("a".into()), ItemId("b".into()), ItemId("c".into())],
            }
        );
    }
}
