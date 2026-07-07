//! Phase 2a: the ported `GameSession.execute` orchestration.
//!
//! `run_mob_reactions` — solo-GM turn driver, faithful port of
//! `packages/play-runtime/src/session.ts:148-177`.
//! (`ExecuteResult` + `World::submit` land in the next slice of this file.)
use alloc::collections::BTreeSet;
use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

use crate::error::ProceduralViolation;
use crate::presentation::{MechanicCue, PresentationCue};
use crate::stats::StatType;
use crate::world::descriptor::Catalog;
use crate::world::ids::{CharacterId, ItemId};
use crate::world::intent::{is_time_advancing, Intent};
use crate::world::resolve::resolve_item;
use crate::world::snapshot::CharacterKind;
use crate::world::World;

/// A single mob-on-player strike, surfaced for typed combat feedback.
/// Mirrors the TS `MobAttack` (`session.ts:22`); `amount` is an effective-stat
/// delta (f64 per sub-plan 4b's stat model).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct MobAttack {
    pub name: String,
    pub stat: StatType,
    pub amount: f64,
}

impl World {
    /// Each live (non-KO) mob in the active player's current room attacks the
    /// player (the "aggro while sharing its room" rule). Returns the typed damage
    /// each dealt, derived from the player's effective-stat deltas. A mob that
    /// can't act (afflicted → `ProceduralViolation` from `attack`) simply doesn't
    /// strike; a downed player is not piled on.
    ///
    /// Faithful port of `session.ts` `runMobReactions` (:148-177):
    /// - no current room or active player KO → empty
    /// - snapshot of the occupant id list, in room order (TS `[...room.occupants]`)
    /// - skip the active character, non-`Mob`s, KO'd mobs
    /// - per stat in [Health, Sanity, Energy] order: `before - after > 0` → push
    /// - break once the player is KO
    pub fn run_mob_reactions(
        &mut self,
        active: &CharacterId,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Vec<MobAttack> {
        const STATS: [StatType; 3] = [StatType::Health, StatType::Sanity, StatType::Energy];
        let mut attacks: Vec<MobAttack> = Vec::new();

        let Some(room_id) = self
            .characters
            .get(active)
            .and_then(|c| c.current_room_id.clone())
        else {
            return attacks;
        };
        if self.is_ko(active) {
            return attacks;
        }

        let occupant_ids: Vec<CharacterId> = self
            .rooms
            .get(&room_id)
            .map(|r| r.occupant_ids.clone())
            .unwrap_or_default();

        for occ in occupant_ids {
            if &occ == active {
                continue;
            }
            let is_mob = self
                .characters
                .get(&occ)
                .map(|c| c.kind == CharacterKind::Mob)
                .unwrap_or(false);
            if !is_mob || self.is_ko(&occ) {
                continue;
            }

            let before: [f64; 3] = STATS.map(|s| self.effective_stat(active, s, cat));
            // A blocked (afflicted) mob's ProceduralViolation is swallowed —
            // the mob simply doesn't strike (session.ts:165-168). All core
            // errors are ProceduralViolation, so every Err is the "skip" arm.
            if self.attack(&occ, active, cat, cues).is_err() {
                continue;
            }
            let after: [f64; 3] = STATS.map(|s| self.effective_stat(active, s, cat));

            let name = self
                .characters
                .get(&occ)
                .map(|c| c.name.clone())
                .unwrap_or_default();
            for (i, stat) in STATS.iter().enumerate() {
                let dealt = before[i] - after[i];
                if dealt > 0.0 {
                    attacks.push(MobAttack {
                        name: name.clone(),
                        stat: *stat,
                        amount: dealt,
                    });
                }
            }
            if self.is_ko(active) {
                break; // don't pile on a downed player
            }
        }
        attacks
    }
}

/// Mirrors the TS `ExecuteResult` (`session.ts:24`): `mobAttacks` is present
/// (possibly `[]`) on success and ABSENT on the error path; `error` carries the
/// `ProceduralViolation` message verbatim.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct ExecuteResult {
    pub cues: Vec<PresentationCue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub mob_attacks: Option<Vec<MobAttack>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub error: Option<String>,
}

impl World {
    /// The ported `GameSession.execute` flow (`session.ts:116-140`), minus the
    /// host-side undo snapshot (undo stays host-side via `Authority::snapshot`):
    /// classify → `start_turn` → dispatch → `run_mob_reactions` → `next_player`;
    /// free actions skip the wrap. A `ProceduralViolation` anywhere is caught
    /// and returned as `ExecuteResult.error` with the cues emitted so far.
    pub fn submit(
        &mut self,
        intent: Intent,
        cat: &Catalog,
        opened: &mut BTreeSet<String>,
    ) -> ExecuteResult {
        let mut cues: Vec<PresentationCue> = Vec::new();
        let advances = is_time_advancing(&intent);
        let outcome: Result<Option<Vec<MobAttack>>, ProceduralViolation> = (|| {
            let actor = self.active_character_id()?;
            if advances {
                self.start_turn(&actor, cat, &mut cues)?;
            }
            self.dispatch_intent(&actor, intent, cat, opened, &mut cues)?;
            // Solo GM: after a time-advancing action, live mobs sharing the
            // player's room strike back. Runs before next_player so a fatal blow
            // is caught by the round's outcome check (session.ts:127-131).
            let mob_attacks = if advances {
                self.run_mob_reactions(&actor, cat, &mut cues)
            } else {
                Vec::new()
            };
            if advances {
                self.next_player(cat, &mut cues)?;
            }
            Ok(Some(mob_attacks))
        })();
        match outcome {
            Ok(mob_attacks) => ExecuteResult { cues, mob_attacks, error: None },
            Err(ProceduralViolation(msg)) => ExecuteResult {
                cues,
                mob_attacks: None, // TS error path returns { cues, error } — no mobAttacks key
                error: Some(msg),
            },
        }
    }

    /// The intent → engine-op mapping, including the intent-level legality
    /// guards that live in TS `GameSession.dispatch` (`session.ts:179-256`) but
    /// NOT in the engine's `Command` handlers. Guard strings are verbatim TS.
    fn dispatch_intent(
        &mut self,
        actor: &CharacterId,
        intent: Intent,
        cat: &Catalog,
        opened: &mut BTreeSet<String>,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
        match intent {
            Intent::Move { dir } => self.go(actor, dir, cat, cues),
            Intent::Wait => Ok(()),
            Intent::Open { target_id } => {
                let room_id = self.current_room_id_of(actor)?;
                let in_room = self
                    .rooms
                    .get(&room_id)
                    .map(|r| r.loot_ids.iter().any(|l| l.0 == target_id))
                    .unwrap_or(false);
                if !in_room {
                    return Err(ProceduralViolation(
                        "There's nothing like that to open here.".into(),
                    ));
                }
                // TS also calls pc.openLootBox(loot) — a co-location assert +
                // contents peek with no mutation/cue (player-character.ts:201-204);
                // co-location holds by construction here, so only the reveal remains.
                opened.insert(target_id);
                Ok(())
            }
            Intent::Take { target_id } => {
                // TS findInLoot (session.ts:249-256): searched BEFORE the engine
                // gate/dark checks, throwing "You don't see that here.".
                let room_id = self.current_room_id_of(actor)?;
                let target = ItemId(target_id);
                let visible = self
                    .rooms
                    .get(&room_id)
                    .map(|r| {
                        r.loot_ids.iter().any(|lid| {
                            self.loot
                                .get(lid)
                                .map(|l| l.content_ids.contains(&target))
                                .unwrap_or(false)
                        })
                    })
                    .unwrap_or(false);
                if !visible {
                    return Err(ProceduralViolation("You don't see that here.".into()));
                }
                if let Some(loot_id) = self.take(actor, &target, cat, cues)? {
                    opened.insert(loot_id.0); // auto-open (session.ts:198-201)
                }
                Ok(())
            }
            Intent::Drop { target_id } => {
                let item_id = ItemId(target_id);
                self.guard_carrying(actor, &item_id)?;
                let snap = self
                    .items
                    .get(&item_id)
                    .ok_or_else(|| ProceduralViolation("You aren't carrying that.".into()))?;
                let resolved = resolve_item(snap, cat)?;
                // Required quest items (droppable === false) can't be set down
                // (session.ts:208-211).
                if resolved.properties.droppable == Some(false) {
                    return Err(ProceduralViolation(format!(
                        "You can't bring yourself to part with the {}.",
                        resolved.name
                    )));
                }
                self.drop_item(actor, &item_id, cat, cues)
            }
            Intent::Equip { target_id } => {
                let item_id = ItemId(target_id);
                self.guard_carrying(actor, &item_id)?;
                self.equip(actor, &item_id, cat, cues)
            }
            Intent::Unequip { target_id } => {
                let item_id = ItemId(target_id);
                let equipped = self
                    .characters
                    .get(actor)
                    .map(|c| c.equipment.values().any(|i| i == &item_id))
                    .unwrap_or(false);
                if !equipped {
                    return Err(ProceduralViolation("That isn't equipped.".into()));
                }
                self.unequip(actor, &item_id, cat, cues)
            }
            Intent::Use { target_id } => {
                let item_id = ItemId(target_id);
                self.guard_carrying(actor, &item_id)?;
                self.use_item(actor, &item_id, cat, cues)
            }
            Intent::Attack { target_id } => {
                let room_id = self.current_room_id_of(actor)?;
                let target = CharacterId(target_id);
                let in_room = self
                    .rooms
                    .get(&room_id)
                    .map(|r| r.occupant_ids.contains(&target))
                    .unwrap_or(false);
                if !in_room {
                    return Err(ProceduralViolation(
                        "There's nothing like that to attack here.".into(),
                    ));
                }
                if self.is_ko(&target) {
                    let name = self
                        .characters
                        .get(&target)
                        .map(|c| c.name.clone())
                        .unwrap_or_default();
                    return Err(ProceduralViolation(format!("The {name} is already dead.")));
                }
                self.attack(actor, &target, cat, cues)
            }
            Intent::Talk { .. } => {
                // No NPCs in this campaign; dialogue is reserved for future
                // content (session.ts:242-245).
                Err(ProceduralViolation("There's no one here to talk to.".into()))
            }
        }
    }

    /// Reads a held item, emitting its lore as a `mechanic` cue. Free, ungated,
    /// non-consuming. Mirrors `GameSession.read` (session.ts:104-111) over
    /// `Character.read` (character.ts:784-792): a non-held item is a quiet no-op
    /// (the facade returned `[]` instead of surfacing the engine throw).
    pub fn read_item(
        &mut self,
        actor: &CharacterId,
        item: &ItemId,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
        let held = self
            .characters
            .get(actor)
            .map(|c| c.inventory.item_ids.contains(item))
            .unwrap_or(false);
        if !held {
            return Ok(());
        }
        let snap = self
            .items
            .get(item)
            .ok_or_else(|| ProceduralViolation("Item snapshot not found.".into()))?;
        let resolved = resolve_item(snap, cat)?;
        if let Some(lore) = resolved.lore.clone() {
            cues.push(PresentationCue::Mechanic {
                cue: MechanicCue { text: Some(lore), sound: None },
            });
        }
        Ok(())
    }

    fn current_room_id_of(
        &self,
        actor: &CharacterId,
    ) -> Result<crate::world::ids::RoomId, ProceduralViolation> {
        // TS dispatch does `pc.currentRoom!` — a missing room is unreachable in
        // normal play; we surface it as a violation rather than a panic.
        self.characters
            .get(actor)
            .and_then(|c| c.current_room_id.clone())
            .ok_or_else(|| ProceduralViolation("active character has no current room".into()))
    }

    fn guard_carrying(
        &self,
        actor: &CharacterId,
        item: &ItemId,
    ) -> Result<(), ProceduralViolation> {
        // TS checks pc.inventory.items (NOT keys) — session.ts:206/216/228.
        let held = self
            .characters
            .get(actor)
            .map(|c| c.inventory.item_ids.contains(item))
            .unwrap_or(false);
        if held {
            Ok(())
        } else {
            Err(ProceduralViolation("You aren't carrying that.".into()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::collections::BTreeMap;
    use alloc::string::String;
    use crate::stats::StatType;
    use crate::world::afflictions::Status;
    use crate::world::descriptor::Catalog;
    use crate::world::formations::conformance::seat_test_mob;
    use crate::world::ids::{CharacterId, RoomId};
    use crate::world::snapshot::RoomSnapshot;
    use crate::world::test_support::world_with_party;
    use crate::world::World;

    fn cid(s: &str) -> CharacterId {
        CharacterId(s.into())
    }
    fn rid(s: &str) -> RoomId {
        RoomId(s.into())
    }

    /// A PC (energy 5 / sanity 7 / health 10, 2 actions/round) placed alone in
    /// "room1" (lit). Stats are set explicitly here — `world_with_party` seeds a
    /// flat 5/5/5, so the mitigation math below (mitigator = effective sanity 7)
    /// needs sanity 7 / health 10 established on the fixture.
    fn world_with_pc_in_room() -> World {
        let mut w = world_with_party(&["pc"], 10);
        let pc = cid("pc");
        {
            let c = w.characters.get_mut(&pc).unwrap();
            c.current_room_id = Some(rid("room1"));
            c.stats.energy = 5.0;
            c.stats.sanity = 7.0;
            c.stats.health = 10.0;
        }
        w.rooms.insert(
            rid("room1"),
            RoomSnapshot {
                id: rid("room1"),
                name: "Test Room".into(),
                description: String::new(),
                exits: BTreeMap::new(),
                dark: false,
                spawn_modifier: 0,
                occupant_ids: alloc::vec![pc],
                loot_ids: alloc::vec![],
                material_cache_ids: alloc::vec![],
                light_source_ids: alloc::vec![],
                scenes: alloc::vec![],
            },
        );
        w
    }

    #[test]
    fn live_mob_strikes_and_reports_typed_health_delta() {
        let mut w = world_with_pc_in_room();
        seat_test_mob(&mut w, "wraith", "room1"); // natural attack default {health, 1}
        let mut cues = Vec::new();
        let attacks = w.run_mob_reactions(&cid("pc"), &Catalog::default(), &mut cues);
        // strength 1, armor 0, mitigator = effective sanity 7 → (10-7)*0.2 = 0.6 dealt
        assert_eq!(attacks.len(), 1);
        assert_eq!(attacks[0].name, "wraith");
        assert_eq!(attacks[0].stat, StatType::Health);
        assert!((attacks[0].amount - 0.6).abs() < 1e-9, "amount = {}", attacks[0].amount);
        // The strike actually landed on the PC.
        let health = w.effective_stat(&cid("pc"), StatType::Health, &Catalog::default());
        assert!((health - 9.4).abs() < 1e-9);
        // Cues from the attack path were emitted (takeDamage + attack action cues).
        assert!(!cues.is_empty());
    }

    #[test]
    fn ko_mob_does_not_strike() {
        let mut w = world_with_pc_in_room();
        seat_test_mob(&mut w, "wraith", "room1");
        w.characters.get_mut(&cid("wraith")).unwrap().afflictions.set_active(Status::Ko, true);
        let attacks = w.run_mob_reactions(&cid("pc"), &Catalog::default(), &mut Vec::new());
        assert!(attacks.is_empty());
    }

    #[test]
    fn ko_active_player_is_not_piled_on_at_entry() {
        let mut w = world_with_pc_in_room();
        seat_test_mob(&mut w, "wraith", "room1");
        w.characters.get_mut(&cid("pc")).unwrap().afflictions.set_active(Status::Ko, true);
        let attacks = w.run_mob_reactions(&cid("pc"), &Catalog::default(), &mut Vec::new());
        assert!(attacks.is_empty());
    }

    #[test]
    fn blocked_mob_violation_is_swallowed() {
        // Panic blocks non-move actions (gate.rs:53) — the mob's attack throws,
        // runMobReactions catches ProceduralViolation and skips (session.ts:165-168).
        let mut w = world_with_pc_in_room();
        seat_test_mob(&mut w, "wraith", "room1");
        w.characters.get_mut(&cid("wraith")).unwrap().afflictions.set_active(Status::Panic, true);
        let attacks = w.run_mob_reactions(&cid("pc"), &Catalog::default(), &mut Vec::new());
        assert!(attacks.is_empty());
        // PC untouched.
        assert_eq!(w.characters[&cid("pc")].stats.health, 10.0);
    }

    #[test]
    fn player_ko_mid_loop_stops_further_strikes() {
        let mut w = world_with_pc_in_room();
        seat_test_mob(&mut w, "mob-a", "room1");
        seat_test_mob(&mut w, "mob-b", "room1");
        // sanity 0 → mitigation multiplier 2.0 → each strike deals 2.0 health.
        // health 1 → first strike floors to 0 and latches KO → mob-b must not act.
        if let Some(c) = w.characters.get_mut(&cid("pc")) {
            c.stats.health = 1.0;
            c.stats.sanity = 0.0;
        }
        let attacks = w.run_mob_reactions(&cid("pc"), &Catalog::default(), &mut Vec::new());
        assert_eq!(attacks.len(), 1, "second mob must not pile on");
        assert_eq!(attacks[0].name, "mob-a");
        assert!(w.is_ko(&cid("pc")));
    }

    #[test]
    fn non_mob_occupant_is_skipped() {
        let mut w = world_with_party(&["pc", "ally"], 10);
        let pc = cid("pc");
        for id in ["pc", "ally"] {
            w.characters.get_mut(&cid(id)).unwrap().current_room_id = Some(rid("room1"));
        }
        w.rooms.insert(
            rid("room1"),
            RoomSnapshot {
                id: rid("room1"),
                name: "Test Room".into(),
                description: String::new(),
                exits: BTreeMap::new(),
                dark: false,
                spawn_modifier: 0,
                occupant_ids: alloc::vec![pc.clone(), cid("ally")],
                loot_ids: alloc::vec![],
                material_cache_ids: alloc::vec![],
                light_source_ids: alloc::vec![],
                scenes: alloc::vec![],
            },
        );
        let attacks = w.run_mob_reactions(&pc, &Catalog::default(), &mut Vec::new());
        assert!(attacks.is_empty()); // ally is kind=player, not Mob
    }

    use alloc::collections::BTreeSet;
    use crate::world::intent::Intent;
    use crate::world::ids::{ItemId, LootId};
    use crate::world::snapshot::{ItemSnapshot, LootSnapshot};
    use crate::world::descriptor::{ItemDescriptor, ItemProperties, ItemType, SlotKind};
    use serde_json::json;

    fn iid(s: &str) -> ItemId { ItemId(s.into()) }
    fn lid(s: &str) -> LootId { LootId(s.into()) }

    /// Catalog with one weapon "items/sword" (equippable) and one consumable
    /// "items/herb" (usable, lore) — the same descriptor shapes as command.rs tests.
    fn cat_with_items() -> Catalog {
        let mut items = BTreeMap::new();
        items.insert("items/sword".to_string(), ItemDescriptor {
            name: "Sword".into(), r#type: ItemType::Weapon, stat: StatType::Health,
            modifier: 3,
            properties: ItemProperties {
                equippable: true, equipped: false, destroyable: true,
                usable: false, droppable: None,
            },
            slot: Some(SlotKind::Hand), two_handed: None, emits_light: None,
            max_durability: Some(5), lore: None, presentation: None, key_code: None,
            consume_on_use: None, recipe: json!({}), teaches: json!(null),
            immunities: json!([]), grants_immunity: json!(null),
        });
        items.insert("items/herb".to_string(), ItemDescriptor {
            name: "Herb".into(), r#type: ItemType::Consumable, stat: StatType::Health,
            modifier: 2,
            properties: ItemProperties {
                equippable: false, equipped: false, destroyable: false,
                usable: true, droppable: None,
            },
            slot: None, two_handed: None, emits_light: None, max_durability: None,
            lore: Some("Bitter leaves.".into()), presentation: None, key_code: None,
            consume_on_use: Some(true), recipe: json!({}), teaches: json!(null),
            immunities: json!([]), grants_immunity: json!(null),
        });
        // A required quest item (droppable: false) for the drop guard.
        items.insert("items/locket".to_string(), ItemDescriptor {
            name: "Locket".into(), r#type: ItemType::Accessory, stat: StatType::Sanity,
            modifier: 0,
            properties: ItemProperties {
                equippable: false, equipped: false, destroyable: false,
                usable: false, droppable: Some(false),
            },
            slot: None, two_handed: None, emits_light: None, max_durability: None,
            lore: None, presentation: None, key_code: None, consume_on_use: None,
            recipe: json!({}), teaches: json!(null),
            immunities: json!([]), grants_immunity: json!(null),
        });
        Catalog { items, aliases: BTreeMap::new(), behaviors: BTreeMap::new() }
    }

    /// PC in room1 holding a sword (item-sword) and a locket (item-locket);
    /// the room holds a chest (loot-1) containing an herb (item-herb).
    fn world_for_submit() -> World {
        let mut w = world_with_pc_in_room();
        let pc = cid("pc");
        for (id, key) in [("item-sword", "items/sword"), ("item-locket", "items/locket"), ("item-herb", "items/herb")] {
            w.items.insert(iid(id), ItemSnapshot::Item {
                id: iid(id), behavior_key: key.into(),
                durability: if key == "items/sword" { Some(5) } else { None },
                modifier: 0,
            });
        }
        let ch = w.characters.get_mut(&pc).unwrap();
        ch.inventory.item_ids.push(iid("item-sword"));
        ch.inventory.item_ids.push(iid("item-locket"));
        w.loot.insert(lid("loot-1"), LootSnapshot {
            id: lid("loot-1"), description: "A chest".into(), capacity: 5,
            content_ids: alloc::vec![iid("item-herb")],
        });
        w.rooms.get_mut(&rid("room1")).unwrap().loot_ids.push(lid("loot-1"));
        w
    }

    fn submit_one(w: &mut World, intent: Intent) -> (ExecuteResult, BTreeSet<String>) {
        let mut opened = BTreeSet::new();
        let r = w.submit(intent, &cat_with_items(), &mut opened);
        (r, opened)
    }

    #[test]
    fn wait_advances_the_turn_and_returns_empty_mob_attacks() {
        let mut w = world_for_submit();
        let (r, _) = submit_one(&mut w, Intent::Wait);
        assert_eq!(r.error, None);
        assert_eq!(r.mob_attacks, Some(Vec::new())); // TS: mobAttacks present ([]) on success
        // single-member party: next_player wraps → round 0 → 1
        assert_eq!(w.campaign.round, 1);
    }

    #[test]
    fn equip_is_free_no_turn_wrap() {
        let mut w = world_for_submit();
        let (r, _) = submit_one(&mut w, Intent::Equip { target_id: "item-sword".into() });
        assert_eq!(r.error, None);
        assert_eq!(w.campaign.round, 0, "free action must not advance the round");
        assert!(w.characters[&cid("pc")].equipment.values().any(|i| i == &iid("item-sword")));
    }

    #[test]
    fn open_marks_loot_revealed_without_advancing() {
        let mut w = world_for_submit();
        let (r, opened) = submit_one(&mut w, Intent::Open { target_id: "loot-1".into() });
        assert_eq!(r.error, None);
        assert!(opened.contains("loot-1"));
        assert_eq!(w.campaign.round, 0);
        assert_eq!(w.loot[&lid("loot-1")].content_ids.len(), 1, "open mutates nothing");
    }

    #[test]
    fn take_auto_opens_moves_item_and_advances() {
        let mut w = world_for_submit();
        let (r, opened) = submit_one(&mut w, Intent::Take { target_id: "item-herb".into() });
        assert_eq!(r.error, None);
        assert!(opened.contains("loot-1"), "take auto-opens the container");
        assert!(w.characters[&cid("pc")].inventory.item_ids.contains(&iid("item-herb")));
        assert_eq!(w.campaign.round, 1);
    }

    #[test]
    fn mob_reactions_run_inside_an_advancing_submit() {
        let mut w = world_for_submit();
        seat_test_mob(&mut w, "wraith", "room1");
        let (r, _) = submit_one(&mut w, Intent::Wait);
        assert_eq!(r.error, None);
        let attacks = r.mob_attacks.unwrap();
        assert_eq!(attacks.len(), 1);
        assert_eq!(attacks[0].name, "wraith");
    }

    // ── legality guards: exact TS strings, no state change ──────────────────

    #[test]
    fn error_results_use_exact_ts_strings_and_omit_mob_attacks() {
        let cases: alloc::vec::Vec<(Intent, &str)> = alloc::vec![
            (Intent::Open { target_id: "nope".into() }, "There's nothing like that to open here."),
            (Intent::Take { target_id: "nope".into() }, "You don't see that here."),
            (Intent::Drop { target_id: "nope".into() }, "You aren't carrying that."),
            (Intent::Drop { target_id: "item-locket".into() },
                "You can't bring yourself to part with the Locket."),
            (Intent::Equip { target_id: "nope".into() }, "You aren't carrying that."),
            (Intent::Use { target_id: "nope".into() }, "You aren't carrying that."),
            (Intent::Unequip { target_id: "item-sword".into() }, "That isn't equipped."),
            (Intent::Attack { target_id: "nope".into() }, "There's nothing like that to attack here."),
            (Intent::Talk { npc_id: "n1".into(), prompt: None }, "There's no one here to talk to."),
        ];
        for (intent, want) in cases {
            let mut w = world_for_submit();
            let (r, _) = submit_one(&mut w, intent.clone());
            assert_eq!(r.error.as_deref(), Some(want), "intent {intent:?}");
            assert_eq!(r.mob_attacks, None, "TS error path omits mobAttacks ({intent:?})");
        }
    }

    #[test]
    fn attack_on_ko_target_reports_already_dead() {
        let mut w = world_for_submit();
        seat_test_mob(&mut w, "wraith", "room1");
        w.characters.get_mut(&cid("wraith")).unwrap().afflictions.set_active(Status::Ko, true);
        let (r, _) = submit_one(&mut w, Intent::Attack { target_id: "wraith".into() });
        assert_eq!(r.error.as_deref(), Some("The wraith is already dead."));
    }

    #[test]
    fn error_path_still_returns_cues_emitted_before_the_throw() {
        // Advancing intent: start_turn runs (mutating), then the guard throws.
        // TS returns { cues-so-far, error } and does NOT roll back (session.ts:134-138).
        let mut w = world_for_submit();
        let (r, _) = submit_one(&mut w, Intent::Take { target_id: "nope".into() });
        assert_eq!(r.error.as_deref(), Some("You don't see that here."));
        assert_eq!(w.campaign.round, 0, "next_player must NOT run after a throw");
    }

    // ── read_item ────────────────────────────────────────────────────────────

    #[test]
    fn read_item_emits_lore_as_mechanic_cue() {
        use crate::presentation::MechanicCue;
        let mut w = world_for_submit();
        // move the herb (has lore) into inventory first
        let mut opened = BTreeSet::new();
        w.submit(Intent::Take { target_id: "item-herb".into() }, &cat_with_items(), &mut opened);
        let mut cues = Vec::new();
        w.read_item(&cid("pc"), &iid("item-herb"), &cat_with_items(), &mut cues).unwrap();
        assert_eq!(cues, alloc::vec![PresentationCue::Mechanic {
            cue: MechanicCue { text: Some("Bitter leaves.".into()), sound: None },
        }]);
        // free + non-consuming: still held, round unchanged by read itself
        assert!(w.characters[&cid("pc")].inventory.item_ids.contains(&iid("item-herb")));
    }

    #[test]
    fn read_item_not_held_is_a_quiet_no_op() {
        // Mirrors GameSession.read (session.ts:104-111): returns [] rather than
        // surfacing Character.read's throw.
        let mut w = world_for_submit();
        let mut cues = Vec::new();
        w.read_item(&cid("pc"), &iid("item-herb"), &cat_with_items(), &mut cues).unwrap();
        assert!(cues.is_empty());
    }

    #[test]
    fn read_item_without_lore_is_silent() {
        let mut w = world_for_submit();
        let mut cues = Vec::new();
        w.read_item(&cid("pc"), &iid("item-sword"), &cat_with_items(), &mut cues).unwrap();
        assert!(cues.is_empty());
    }
}
