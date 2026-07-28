//! The session `execute` orchestration: `run_mob_reactions` (the solo-GM turn
//! driver), `ExecuteResult`, and `World::submit`. Behavior is pinned byte-exact
//! by the conformance goldens.
use alloc::collections::BTreeSet;
use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};

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
/// `amount` is an effective-stat delta (f64, per the stat model).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobAttack {
    pub name: String,
    pub stat: StatType,
    pub amount: f64,
}

impl MobAttack {
    /// One line of combat prose naming the stat lost, so the player sees what kind of harm landed.
    /// The single prose source shared by the solo turn loop (which emits it as a mechanic cue) and
    /// the surfaces' narrator.
    pub fn narration(&self) -> alloc::string::String {
        match self.stat {
            StatType::Sanity => alloc::format!(
                "The {} claws at your mind — you lose {} Sanity.",
                self.name,
                self.amount
            ),
            StatType::Energy => alloc::format!(
                "The {} saps your strength — you lose {} Energy.",
                self.name,
                self.amount
            ),
            StatType::Health => alloc::format!(
                "The {} tears into you — you lose {} Health.",
                self.name,
                self.amount
            ),
        }
    }
}

impl World {
    /// Each live (non-KO) mob in the active player's current room attacks the
    /// player (the "aggro while sharing its room" rule). Returns the typed damage
    /// each dealt, derived from the player's effective-stat deltas. A mob that
    /// can't act (afflicted → `ProceduralViolation` from `attack`) simply doesn't
    /// strike; a downed player is not piled on.
    ///
    /// Behavior is pinned byte-exact by the conformance goldens:
    /// - no current room or active player KO → empty
    /// - snapshot of the occupant id list taken up front, in room order
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
                .is_some_and(|c| c.kind == CharacterKind::Mob);
            if !is_mob || self.is_ko(&occ) {
                continue;
            }

            let before: [f64; 3] = STATS.map(|s| self.effective_stat(active, s, cat));
            // A blocked (afflicted) mob's ProceduralViolation is swallowed —
            // the mob simply doesn't strike. All core
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

/// The submit result. `mobAttacks` is present (possibly `[]`) on success and
/// ABSENT on the error path; `error` carries the `ProceduralViolation` message
/// verbatim. This shape is pinned by the conformance goldens.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteResult {
    pub cues: Vec<PresentationCue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mob_attacks: Option<Vec<MobAttack>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl World {
    /// The session execute flow, minus the host-side undo snapshot (undo stays
    /// host-side via `Authority::snapshot`):
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
        let is_move = matches!(intent, Intent::Move { .. });
        let outcome: Result<Option<Vec<MobAttack>>, ProceduralViolation> = (|| {
            let actor = self.active_character_id()?;
            if advances {
                self.start_turn(&actor, cat, &mut cues)?;
            }
            self.dispatch_intent(&actor, intent, cat, opened, &mut cues)?;
            // Light-tied initiative (v1): a time-advancing MOVE into a LIT room does
            // not provoke mob reactions — a player who can see gets the drop on
            // entry.
            // Entering a dark room still provokes (a light-averse mob ambushes; a
            // normal mob can't see you either). All other advancing actions are
            // unchanged.
            let entered_lit = is_move
                && self
                    .characters
                    .get(&actor)
                    .and_then(|c| c.current_room_id.clone())
                    .is_some_and(|rid| self.is_lit(&rid, cat));
            // Solo GM: after a time-advancing action, live mobs sharing the
            // player's room strike back. Runs before next_player so a fatal blow
            // is caught by the round's outcome check.
            let mob_attacks = if advances && !entered_lit {
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
            Ok(mob_attacks) => ExecuteResult {
                cues,
                mob_attacks,
                error: None,
            },
            Err(ProceduralViolation(msg)) => ExecuteResult {
                cues,
                mob_attacks: None, // error path returns { cues, error } — no mobAttacks key
                error: Some(msg),
            },
        }
    }

    /// The intent → engine-op mapping, including the intent-level legality
    /// guards that belong to session dispatch, NOT to the engine's `Command`
    /// handlers. Guard strings are pinned verbatim by the conformance goldens.
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
                    .is_some_and(|r| r.loot_ids.iter().any(|l| l.0 == target_id));
                if !in_room {
                    return Err(ProceduralViolation(
                        "There's nothing like that to open here.".into(),
                    ));
                }
                // The original open path also did a co-location assert +
                // contents peek with no mutation/cue; co-location holds by
                // construction here, so only the reveal remains.
                opened.insert(target_id);
                Ok(())
            }
            Intent::Take { target_id } => {
                // Loot containers are searched BEFORE the engine gate/dark
                // checks, throwing "You don't see that here.".
                let room_id = self.current_room_id_of(actor)?;
                let target = ItemId(target_id);
                let containing = self.rooms.get(&room_id).and_then(|r| {
                    r.loot_ids
                        .iter()
                        .find(|lid| {
                            self.loot
                                .get(lid)
                                .is_some_and(|l| l.content_ids.contains(&target))
                        })
                        .cloned()
                });
                let Some(loot_id) = containing else {
                    return Err(ProceduralViolation("You don't see that here.".into()));
                };
                // Dispatch marks the container opened BEFORE the take runs —
                // NOT after, the way apply_command's take
                // returns it. So a take that opens a fresh container then FAILS
                // (e.g. requireVisibleTarget in a dark room) still leaves the
                // container revealed. Insert before the take attempt.
                opened.insert(loot_id.0.clone());
                self.take(actor, &target, cat, cues)?;
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
                // Required quest items (droppable === false) can't be set down.
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
                    .is_some_and(|c| c.equipment.values().any(|i| i == &item_id));
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
                    .is_some_and(|r| r.occupant_ids.contains(&target));
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
            Intent::Talk { npc_id, prompt } => {
                // Resolve the target against the actor's current room: it must be a
                // co-located, VISIBLE NPC. Anything else (missing id, a Mob/player,
                // or a hidden NPC) is "no one to talk to". A resolved NPC then runs
                // its data-driven dialogue (Sub-plan 2) via `talk`.
                let room_id = self.current_room_id_of(actor)?;
                let target = CharacterId(npc_id);
                let in_room = self
                    .rooms
                    .get(&room_id)
                    .is_some_and(|r| r.occupant_ids.contains(&target));
                let is_visible_npc = self
                    .characters
                    .get(&target)
                    .is_some_and(|c| c.kind == CharacterKind::Npc && c.visible);
                if !in_room || !is_visible_npc {
                    return Err(ProceduralViolation(
                        "There's no one here to talk to.".into(),
                    ));
                }
                self.talk(actor, &target, prompt.as_deref(), cat, cues)
            }
            // Materials & crafting — free, turn-gated verbs (see `crafting.rs`).
            Intent::Harvest { target_id } => self.harvest(
                actor,
                &crate::world::ids::MaterialCacheId(target_id),
                cat,
                cues,
            ),
            Intent::Craft { recipe_id } => self.craft(actor, &recipe_id, cat, cues).map(|_| ()),
            Intent::Repair { target_id } => self.repair(actor, &ItemId(target_id), cat, cues),
            Intent::Destroy { target_id } => self.destroy(actor, &ItemId(target_id), cat, cues),
        }
    }

    /// Reads a held item, emitting its lore as a `mechanic` cue. Free, ungated,
    /// non-consuming. A non-held item is a quiet no-op — the session facade
    /// returns `[]` instead of surfacing the engine throw.
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
            .is_some_and(|c| c.inventory.item_ids.contains(item));
        if !held {
            return Ok(());
        }
        // Capture behavior_key (for on_read) + resolve lore first, dropping the
        // immutable snapshot borrow before we mutate self to apply effects.
        let behavior_key = match self.items.get(item) {
            Some(crate::world::snapshot::ItemSnapshot::Item { behavior_key, .. }) => {
                Some(behavior_key.clone())
            }
            _ => None,
        };
        let snap = self
            .items
            .get(item)
            .ok_or_else(|| ProceduralViolation("Item snapshot not found.".into()))?;
        let resolved = resolve_item(snap, cat)?;
        let lore = resolved.lore.clone();

        // Item read-behaviour (`ItemBehavior::on_read`): runs BEFORE the lore
        // cue — run the hook, THEN emit lore. An unresolved key = no-op. Effects
        // flow through the collect-then-apply pipeline, capped at
        // MAX_EFFECTS_PER_EVENT (same as use_item).
        if let Some(key) = &behavior_key {
            if let Some(resolved) = crate::world::item_behavior::resolve_item_behavior(key, cat) {
                let view = self.build_campaign_view(cat);
                // The held-check above guarantees the actor exists, so a missing view
                // is a real inconsistency — surface it (matching use_mechanic_action's
                // fail-loud stance) rather than silently dropping the behavior's effects.
                let actor_view = self.character_view(actor, cat).ok_or_else(|| {
                    ProceduralViolation(alloc::format!("Actor '{}' not found.", actor.0))
                })?;
                let effects = {
                    let rng = &mut self.rng;
                    let mut state = serde_json::Value::Null; // no per-item script state
                    let mut base = crate::world::mechanics::HookCtx {
                        state: &mut state,
                        view: &view,
                        rng,
                    };
                    resolved.as_behavior().on_read(&mut base, &actor_view)
                };
                if effects.len() > crate::world::mechanics::MAX_EFFECTS_PER_EVENT {
                    return Err(ProceduralViolation(alloc::format!(
                        "Item '{}' emitted too many effects.",
                        key
                    )));
                }
                self.apply_all(effects, cat, cues)?;
            }
        }

        if let Some(lore) = lore {
            cues.push(PresentationCue::Mechanic {
                cue: MechanicCue {
                    text: Some(lore),
                    sound: None,
                },
            });
        }
        Ok(())
    }

    /// Run an NPC's data-driven dialogue. Resolves the NPC's
    /// `npc_behavior_key` to an `NpcScript` (catalog-only, via `resolve_npc`);
    /// if it resolves, matches `prompt` to one dialogue entry, ALWAYS emits the
    /// selected entry's response as a `mechanic` cue, and applies its effects
    /// (honoring `once`, capped at `MAX_EFFECTS_PER_EVENT`). The `once` latch
    /// lives in the NPC's per-instance `npc_state` (round-trips through the
    /// snapshot), so two NPCs sharing a behavior key hold INDEPENDENT latches.
    /// Free + non-advancing (the "no one here" gate lives in `dispatch_intent`).
    /// An NPC with no key — or a key that doesn't bind an `Npc` behavior — is a
    /// quiet no-op (validation guarantees a seated NPC's key resolves; this
    /// fallback keeps `talk` total, mirroring `read_item`'s not-held no-op).
    pub fn talk(
        &mut self,
        actor: &CharacterId,
        npc: &CharacterId,
        prompt: Option<&str>,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
        // Behavior key off the NPC instance; clone it out before borrowing self mut.
        let Some(key) = self
            .characters
            .get(npc)
            .and_then(|c| c.npc_behavior_key.clone())
        else {
            return Ok(()); // no dialogue behavior — quiet no-op
        };
        // `resolve_npc` borrows only `cat` (a separate parameter of this fn), so the
        // returned `&NpcScript` can be held across the mutable `self` borrows below.
        let Some(script) = crate::world::resolve::resolve_npc(&key, cat) else {
            return Ok(()); // key doesn't bind an NPC behavior — quiet no-op
        };

        // Build the (owned) views while `self` is borrowed only immutably.
        let view = self.build_campaign_view(cat);
        let actor_view = self
            .character_view(actor, cat)
            .ok_or_else(|| ProceduralViolation(alloc::format!("Actor '{}' not found.", actor.0)))?;

        // Take `&mut` on the NPC's per-instance state AND on the rng — disjoint
        // fields of `World`, which the borrow checker allows simultaneously (same
        // shape as `use_mechanic_action`). The latch write lands in `npc.npc_state`,
        // persisting into that NPC's snapshot → per-instance `once`.
        let (mut cue_batch, effects) = {
            let rng = &mut self.rng;
            let npc_ref = self
                .characters
                .get_mut(npc)
                .ok_or_else(|| ProceduralViolation(alloc::format!("NPC '{}' not found.", npc.0)))?;
            let mut base = crate::world::mechanics::HookCtx {
                state: &mut npc_ref.npc_state,
                view: &view,
                rng,
            };
            crate::script::ops::ScriptedNpc { script }.run_talk(prompt, &mut base, &actor_view)
        };
        if effects.len() > crate::world::mechanics::MAX_EFFECTS_PER_EVENT {
            return Err(ProceduralViolation(alloc::format!(
                "NPC '{}' emitted too many effects.",
                key
            )));
        }
        // Response cue first (the NPC "speaks"), then the scripted effects (which
        // may push their own cues via `apply_all`).
        for cue in cue_batch.drain(..) {
            cues.push(PresentationCue::Mechanic { cue });
        }
        self.apply_all(effects, cat, cues)?;
        Ok(())
    }

    /// Emit an NPC's `examine` blurb. Free + non-advancing. When
    /// `target` is a co-located, VISIBLE NPC whose `npc_behavior_key` resolves to
    /// an `NpcScript`, pushes the script's `description` as a `mechanic` cue (the
    /// SAME cue shape as `read_item`'s lore). Any other target (non-NPC, hidden,
    /// missing, no/unresolved key, or not in the actor's room) is a quiet no-op.
    /// Examining a non-NPC or the room, and CRT routing, are not handled here.
    pub fn examine(
        &self,
        actor: &CharacterId,
        target: &CharacterId,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
        let is_visible_npc = self
            .characters
            .get(target)
            .is_some_and(|c| c.kind == CharacterKind::Npc && c.visible);
        let co_located = self
            .characters
            .get(actor)
            .and_then(|a| a.current_room_id.clone())
            .and_then(|rid| {
                self.rooms
                    .get(&rid)
                    .map(|r| r.occupant_ids.contains(target))
            })
            .unwrap_or(false);
        if !is_visible_npc || !co_located {
            return Ok(());
        }
        let Some(key) = self
            .characters
            .get(target)
            .and_then(|c| c.npc_behavior_key.clone())
        else {
            return Ok(());
        };
        let Some(script) = crate::world::resolve::resolve_npc(&key, cat) else {
            return Ok(());
        };
        cues.push(PresentationCue::Mechanic {
            cue: MechanicCue {
                text: Some(
                    crate::script::ops::ScriptedNpc { script }
                        .description()
                        .into(),
                ),
                sound: None,
            },
        });
        Ok(())
    }

    fn current_room_id_of(
        &self,
        actor: &CharacterId,
    ) -> Result<crate::world::ids::RoomId, ProceduralViolation> {
        // A missing room is unreachable in normal play; we surface it as a
        // violation rather than a panic.
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
        // Only inventory items are checked (NOT keys).
        let held = self
            .characters
            .get(actor)
            .is_some_and(|c| c.inventory.item_ids.contains(item));
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
    use crate::stats::StatType;
    use crate::world::afflictions::Status;
    use crate::world::descriptor::Catalog;
    use crate::world::formations::conformance::seat_test_mob;
    use crate::world::ids::RoomId;
    use crate::world::snapshot::RoomSnapshot;
    use crate::world::test_support::cid;
    use crate::world::test_support::world_with_party;
    use crate::world::test_support::{item_desc, props};
    use crate::world::World;
    use alloc::collections::BTreeMap;
    use alloc::string::String;

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
        assert!(
            (attacks[0].amount - 0.6).abs() < 1e-9,
            "amount = {}",
            attacks[0].amount
        );
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
        w.characters
            .get_mut(&cid("wraith"))
            .unwrap()
            .afflictions
            .set_active(Status::Ko, true);
        let attacks = w.run_mob_reactions(&cid("pc"), &Catalog::default(), &mut Vec::new());
        assert!(attacks.is_empty());
    }

    #[test]
    fn ko_active_player_is_not_piled_on_at_entry() {
        let mut w = world_with_pc_in_room();
        seat_test_mob(&mut w, "wraith", "room1");
        w.characters
            .get_mut(&cid("pc"))
            .unwrap()
            .afflictions
            .set_active(Status::Ko, true);
        let attacks = w.run_mob_reactions(&cid("pc"), &Catalog::default(), &mut Vec::new());
        assert!(attacks.is_empty());
    }

    #[test]
    fn blocked_mob_violation_is_swallowed() {
        // Panic blocks non-move actions (see gate.rs) — the mob's attack throws,
        // run_mob_reactions catches ProceduralViolation and skips the striker.
        let mut w = world_with_pc_in_room();
        seat_test_mob(&mut w, "wraith", "room1");
        w.characters
            .get_mut(&cid("wraith"))
            .unwrap()
            .afflictions
            .set_active(Status::Panic, true);
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

    use crate::world::descriptor::{ItemDescriptor, ItemProperties, ItemType, SlotKind};
    use crate::world::ids::{ItemId, LootId};
    use crate::world::intent::Intent;
    use crate::world::snapshot::{ItemSnapshot, LootSnapshot};
    use alloc::collections::BTreeSet;

    fn iid(s: &str) -> ItemId {
        ItemId(s.into())
    }
    fn lid(s: &str) -> LootId {
        LootId(s.into())
    }

    /// Catalog with one weapon "items/sword" (equippable) and one consumable
    /// "items/herb" (usable, lore) — the same descriptor shapes as command.rs tests.
    fn cat_with_items() -> Catalog {
        let mut items = BTreeMap::new();
        items.insert(
            "items/sword".to_string(),
            ItemDescriptor {
                properties: props(true, true, false),
                slot: Some(SlotKind::Hand),
                max_durability: Some(5),
                ..item_desc("Sword", ItemType::Weapon, StatType::Health, 3)
            },
        );
        items.insert(
            "items/herb".to_string(),
            ItemDescriptor {
                properties: props(false, false, true),
                lore: Some("Bitter leaves.".into()),
                consume_on_use: Some(true),
                ..item_desc("Herb", ItemType::Consumable, StatType::Health, 2)
            },
        );
        // A required quest item (droppable: false) for the drop guard.
        items.insert(
            "items/locket".to_string(),
            ItemDescriptor {
                properties: ItemProperties {
                    equippable: false,
                    equipped: false,
                    destroyable: false,
                    usable: false,
                    droppable: Some(false),
                },
                ..item_desc("Locket", ItemType::Accessory, StatType::Sanity, 0)
            },
        );
        Catalog {
            items,
            aliases: BTreeMap::new(),
            behaviors: BTreeMap::new(),
            formations: BTreeMap::default(),
            recipes: BTreeMap::default(),
        }
    }

    /// PC in room1 holding a sword (item-sword) and a locket (item-locket);
    /// the room holds a chest (loot-1) containing an herb (item-herb).
    fn world_for_submit() -> World {
        let mut w = world_with_pc_in_room();
        let pc = cid("pc");
        for (id, key) in [
            ("item-sword", "items/sword"),
            ("item-locket", "items/locket"),
            ("item-herb", "items/herb"),
        ] {
            w.items.insert(
                iid(id),
                ItemSnapshot::Item {
                    id: iid(id),
                    behavior_key: key.into(),
                    durability: if key == "items/sword" { Some(5) } else { None },
                    modifier: 0,
                },
            );
        }
        let ch = w.characters.get_mut(&pc).unwrap();
        ch.inventory.item_ids.push(iid("item-sword"));
        ch.inventory.item_ids.push(iid("item-locket"));
        w.loot.insert(
            lid("loot-1"),
            LootSnapshot {
                id: lid("loot-1"),
                description: "A chest".into(),
                capacity: 5,
                content_ids: alloc::vec![iid("item-herb")],
            },
        );
        w.rooms
            .get_mut(&rid("room1"))
            .unwrap()
            .loot_ids
            .push(lid("loot-1"));
        w
    }

    fn submit_one(w: &mut World, intent: Intent) -> (ExecuteResult, BTreeSet<String>) {
        let mut opened = BTreeSet::new();
        let r = w.submit(intent, &cat_with_items(), &mut opened);
        (r, opened)
    }

    /// Seat an NPC `name` (id == name) into `room` with the given visibility, and
    /// push its id into that room's `occupant_ids`. Mirrors `seat_test_mob` but
    /// with `kind = Npc`.
    fn seat_npc(w: &mut World, name: &str, room: &str, visible: bool) {
        use crate::world::afflictions::Afflictions;
        use crate::world::snapshot::{CharacterKind, InventorySnapshot, Stats};
        let id = cid(name);
        let room_id = rid(room);
        let snap = crate::world::snapshot::CharacterSnapshot {
            kind: CharacterKind::Npc,
            id: id.clone(),
            name: name.into(),
            stats: Stats {
                health: 3.0,
                sanity: 3.0,
                energy: 3.0,
            },
            actions_per_round: 1,
            actions_this_round: 0,
            current_room_id: Some(room_id.clone()),
            inventory: InventorySnapshot {
                slots: 0,
                item_ids: alloc::vec![],
                key_ids: alloc::vec![],
            },
            equipment: BTreeMap::new(),
            history: alloc::vec![],
            archetype_immunities: alloc::vec![],
            afflictions: Afflictions::default(),
            archetype_id: None,
            origin: None,
            base_escape_chance: None,
            material_drops: None,
            light_averse: None,
            natural_attack: None,
            npc_behavior_key: Some("npc/keeper".into()),
            npc_state: serde_json::Value::Null,
            visible,
        };
        w.characters.insert(id.clone(), snap);
        if let Some(r) = w.rooms.get_mut(&room_id) {
            if !r.occupant_ids.contains(&id) {
                r.occupant_ids.push(id);
            }
        }
    }

    #[test]
    fn wait_advances_the_turn_and_returns_empty_mob_attacks() {
        let mut w = world_for_submit();
        let (r, _) = submit_one(&mut w, Intent::Wait);
        assert_eq!(r.error, None);
        assert_eq!(r.mob_attacks, Some(Vec::new())); // mobAttacks present ([]) on success
                                                     // single-member party: next_player wraps → round 0 → 1
        assert_eq!(w.campaign.round, 1);
    }

    #[test]
    fn equip_is_free_no_turn_wrap() {
        let mut w = world_for_submit();
        let (r, _) = submit_one(
            &mut w,
            Intent::Equip {
                target_id: "item-sword".into(),
            },
        );
        assert_eq!(r.error, None);
        assert_eq!(
            w.campaign.round, 0,
            "free action must not advance the round"
        );
        assert!(w.characters[&cid("pc")]
            .equipment
            .values()
            .any(|i| i == &iid("item-sword")));
    }

    #[test]
    fn open_marks_loot_revealed_without_advancing() {
        let mut w = world_for_submit();
        let (r, opened) = submit_one(
            &mut w,
            Intent::Open {
                target_id: "loot-1".into(),
            },
        );
        assert_eq!(r.error, None);
        assert!(opened.contains("loot-1"));
        assert_eq!(w.campaign.round, 0);
        assert_eq!(
            w.loot[&lid("loot-1")].content_ids.len(),
            1,
            "open mutates nothing"
        );
    }

    #[test]
    fn take_auto_opens_moves_item_and_advances() {
        let mut w = world_for_submit();
        let (r, opened) = submit_one(
            &mut w,
            Intent::Take {
                target_id: "item-herb".into(),
            },
        );
        assert_eq!(r.error, None);
        assert!(opened.contains("loot-1"), "take auto-opens the container");
        assert!(w.characters[&cid("pc")]
            .inventory
            .item_ids
            .contains(&iid("item-herb")));
        assert_eq!(w.campaign.round, 1);
    }

    #[test]
    fn failed_after_open_take_still_marks_container_opened() {
        // Dispatch marks `opened` BEFORE the take runs.
        // A dark room makes the take fail AFTER the open,
        // so the container must remain revealed even though nothing was taken.
        let mut w = world_for_submit();
        w.rooms.get_mut(&rid("room1")).unwrap().dark = true;
        let (r, opened) = submit_one(
            &mut w,
            Intent::Take {
                target_id: "item-herb".into(),
            },
        );
        assert_eq!(r.error.as_deref(), Some("Cannot loot in the dark"));
        assert!(
            opened.contains("loot-1"),
            "a failed-after-open take still reveals the container"
        );
        // The item never left the chest.
        assert!(w.loot[&lid("loot-1")]
            .content_ids
            .contains(&iid("item-herb")));
    }

    #[test]
    fn move_into_lit_room_with_mob_does_not_provoke_ambush() {
        // Light-tied initiative: entering a LIT room with a live mob gives the
        // player the drop — no entry swing. "start"→North→"next", both lit.
        use crate::world::Direction;
        let mut w = crate::world::test_support::world_two_rooms(/*next_dark=*/ false);
        seat_test_mob(&mut w, "wraith", "next"); // mob waits in the destination
        let (r, _) = submit_one(
            &mut w,
            Intent::Move {
                dir: Direction::North,
            },
        );
        assert_eq!(r.error, None);
        assert_eq!(
            r.mob_attacks,
            Some(Vec::new()),
            "entering a lit room must not provoke a mob swing"
        );
        // The PC actually moved in and took no damage.
        assert_eq!(w.characters[&cid("pc")].current_room_id, Some(rid("next")));
        assert_eq!(w.characters[&cid("pc")].stats.health, 5.0);
    }

    #[test]
    fn move_into_dark_room_with_light_averse_mob_still_ambushes() {
        // Scope control: the skip is LIT-only. A light-averse mob in a dark room
        // still gets its entry swing.
        use crate::world::Direction;
        let mut w = crate::world::test_support::world_two_rooms(/*next_dark=*/ true);
        seat_test_mob(&mut w, "lurker", "next");
        // Make the lurker see in the dark so it can actually strike.
        w.characters.get_mut(&cid("lurker")).unwrap().light_averse = Some(true);
        let (r, _) = submit_one(
            &mut w,
            Intent::Move {
                dir: Direction::North,
            },
        );
        assert_eq!(r.error, None);
        assert_eq!(
            r.mob_attacks.as_ref().map(std::vec::Vec::len),
            Some(1),
            "a light-averse mob still ambushes on a dark-room entry"
        );
    }

    #[test]
    fn wait_in_lit_room_with_mob_still_provokes() {
        // Control: a NON-move advancing action still triggers reactions.
        let mut w = crate::world::test_support::world_two_rooms(/*next_dark=*/ false);
        seat_test_mob(&mut w, "wraith", "start"); // co-located with the PC
        let (r, _) = submit_one(&mut w, Intent::Wait);
        assert_eq!(r.mob_attacks.as_ref().map(std::vec::Vec::len), Some(1));
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

    // ── legality guards: exact pinned strings, no state change ──────────────

    #[test]
    fn error_results_use_exact_ts_strings_and_omit_mob_attacks() {
        let cases: alloc::vec::Vec<(Intent, &str)> = alloc::vec![
            (
                Intent::Open {
                    target_id: "nope".into()
                },
                "There's nothing like that to open here."
            ),
            (
                Intent::Take {
                    target_id: "nope".into()
                },
                "You don't see that here."
            ),
            (
                Intent::Drop {
                    target_id: "nope".into()
                },
                "You aren't carrying that."
            ),
            (
                Intent::Drop {
                    target_id: "item-locket".into()
                },
                "You can't bring yourself to part with the Locket."
            ),
            (
                Intent::Equip {
                    target_id: "nope".into()
                },
                "You aren't carrying that."
            ),
            (
                Intent::Use {
                    target_id: "nope".into()
                },
                "You aren't carrying that."
            ),
            (
                Intent::Unequip {
                    target_id: "item-sword".into()
                },
                "That isn't equipped."
            ),
            (
                Intent::Attack {
                    target_id: "nope".into()
                },
                "There's nothing like that to attack here."
            ),
            (
                Intent::Talk {
                    npc_id: "n1".into(),
                    prompt: None
                },
                "There's no one here to talk to."
            ),
        ];
        for (intent, want) in cases {
            let mut w = world_for_submit();
            let (r, _) = submit_one(&mut w, intent.clone());
            assert_eq!(r.error.as_deref(), Some(want), "intent {intent:?}");
            assert_eq!(
                r.mob_attacks, None,
                "TS error path omits mobAttacks ({intent:?})"
            );
        }
    }

    // ── talk: resolves a co-located visible NPC; free (non-advancing) ────────

    #[test]
    fn talk_to_visible_npc_resolves_as_free_no_op() {
        // A co-located VISIBLE NPC resolves: no error, no cues, and — talk being
        // non-advancing — the round does NOT tick and mobAttacks is empty ([]).
        let mut w = world_for_submit();
        seat_npc(&mut w, "keeper", "room1", /*visible=*/ true);
        let (r, _) = submit_one(
            &mut w,
            Intent::Talk {
                npc_id: "keeper".into(),
                prompt: None,
            },
        );
        assert_eq!(r.error, None, "a visible co-located NPC must resolve");
        assert_eq!(
            r.cues,
            Vec::new(),
            "Sub-plan 2 owns dialogue; this is a placeholder no-op"
        );
        assert_eq!(
            r.mob_attacks,
            Some(Vec::new()),
            "free action returns mobAttacks: []"
        );
        assert_eq!(w.campaign.round, 0, "talk is free — no round advance");
    }

    #[test]
    fn talk_with_prompt_to_visible_npc_resolves() {
        let mut w = world_for_submit();
        seat_npc(&mut w, "keeper", "room1", /*visible=*/ true);
        let (r, _) = submit_one(
            &mut w,
            Intent::Talk {
                npc_id: "keeper".into(),
                prompt: Some("how do i get out".into()),
            },
        );
        assert_eq!(r.error, None);
        assert_eq!(w.campaign.round, 0);
    }

    #[test]
    fn talk_to_invisible_npc_is_rejected() {
        // A hidden NPC is not "here" for conversation.
        let mut w = world_for_submit();
        seat_npc(&mut w, "keeper", "room1", /*visible=*/ false);
        let (r, _) = submit_one(
            &mut w,
            Intent::Talk {
                npc_id: "keeper".into(),
                prompt: None,
            },
        );
        assert_eq!(r.error.as_deref(), Some("There's no one here to talk to."));
        assert_eq!(r.mob_attacks, None, "error path omits mobAttacks");
    }

    #[test]
    fn talk_to_a_mob_is_rejected() {
        // A co-located Mob is not an NPC — you can't converse with it.
        let mut w = world_for_submit();
        seat_test_mob(&mut w, "wraith", "room1");
        let (r, _) = submit_one(
            &mut w,
            Intent::Talk {
                npc_id: "wraith".into(),
                prompt: None,
            },
        );
        assert_eq!(r.error.as_deref(), Some("There's no one here to talk to."));
    }

    #[test]
    fn talk_to_missing_npc_is_rejected() {
        let mut w = world_for_submit();
        let (r, _) = submit_one(
            &mut w,
            Intent::Talk {
                npc_id: "nobody".into(),
                prompt: None,
            },
        );
        assert_eq!(r.error.as_deref(), Some("There's no one here to talk to."));
    }

    #[test]
    fn attack_on_ko_target_reports_already_dead() {
        let mut w = world_for_submit();
        seat_test_mob(&mut w, "wraith", "room1");
        w.characters
            .get_mut(&cid("wraith"))
            .unwrap()
            .afflictions
            .set_active(Status::Ko, true);
        let (r, _) = submit_one(
            &mut w,
            Intent::Attack {
                target_id: "wraith".into(),
            },
        );
        assert_eq!(r.error.as_deref(), Some("The wraith is already dead."));
    }

    #[test]
    fn error_path_still_returns_cues_emitted_before_the_throw() {
        // Advancing intent: start_turn runs (mutating), then the guard throws.
        // Submit returns { cues-so-far, error } and does NOT roll back.
        let mut w = world_for_submit();
        let (r, _) = submit_one(
            &mut w,
            Intent::Take {
                target_id: "nope".into(),
            },
        );
        assert_eq!(r.error.as_deref(), Some("You don't see that here."));
        assert_eq!(
            w.campaign.round, 0,
            "next_player must NOT run after a throw"
        );
    }

    // ── read_item ────────────────────────────────────────────────────────────

    #[test]
    fn read_item_emits_lore_as_mechanic_cue() {
        use crate::presentation::MechanicCue;
        let mut w = world_for_submit();
        // move the herb (has lore) into inventory first
        let mut opened = BTreeSet::new();
        w.submit(
            Intent::Take {
                target_id: "item-herb".into(),
            },
            &cat_with_items(),
            &mut opened,
        );
        let mut cues = Vec::new();
        w.read_item(&cid("pc"), &iid("item-herb"), &cat_with_items(), &mut cues)
            .unwrap();
        assert_eq!(
            cues,
            alloc::vec![PresentationCue::Mechanic {
                cue: MechanicCue {
                    text: Some("Bitter leaves.".into()),
                    sound: None
                },
            }]
        );
        // free + non-consuming: still held, round unchanged by read itself
        assert!(w.characters[&cid("pc")]
            .inventory
            .item_ids
            .contains(&iid("item-herb")));
    }

    #[test]
    fn read_item_runs_scripted_on_read_before_lore_cue() {
        use crate::script::ast::{BehaviorScript, EffectTemplate, Expr, ItemScript, Stmt};
        use crate::script::value::Value;
        let mut w = world_for_submit();
        let pc = cid("pc");
        w.characters.get_mut(&pc).unwrap().stats.sanity = 7.0;

        // Build a catalog: the herb (has lore "Bitter leaves.") + an on_read script.
        let mut cat = cat_with_items();
        cat.behaviors.insert(
            "items/herb".to_string(),
            BehaviorScript::Item {
                script: ItemScript {
                    on_use: None,
                    on_read: Some(alloc::vec![Stmt::Emit {
                        effect: EffectTemplate::AdjustStat {
                            target: Expr::Actor,
                            stat: StatType::Sanity,
                            delta: Expr::Lit {
                                value: Value::Number(-2.0)
                            },
                        }
                    }]),
                },
            },
        );

        // Move the herb into inventory, then read it.
        let mut opened = BTreeSet::new();
        w.submit(
            Intent::Take {
                target_id: "item-herb".into(),
            },
            &cat,
            &mut opened,
        );
        let mut cues = Vec::new();
        w.read_item(&pc, &iid("item-herb"), &cat, &mut cues)
            .unwrap();

        assert_eq!(
            w.characters[&pc].stats.sanity, 5.0,
            "onRead drained 2 sanity"
        );
        // The lore cue is still emitted (and after the stat change).
        assert!(cues.iter().any(|c| matches!(c,
            PresentationCue::Mechanic { cue } if cue.text.as_deref() == Some("Bitter leaves."))));
    }

    #[test]
    fn read_item_not_held_is_a_quiet_no_op() {
        // read_item returns [] rather than surfacing the engine's
        // not-held throw.
        let mut w = world_for_submit();
        let mut cues = Vec::new();
        w.read_item(&cid("pc"), &iid("item-herb"), &cat_with_items(), &mut cues)
            .unwrap();
        assert!(cues.is_empty());
    }

    #[test]
    fn read_item_without_lore_is_silent() {
        let mut w = world_for_submit();
        let mut cues = Vec::new();
        w.read_item(&cid("pc"), &iid("item-sword"), &cat_with_items(), &mut cues)
            .unwrap();
        assert!(cues.is_empty());
    }

    // ── talk → dialogue + examine → description ───────────────────────────────

    use crate::script::ast::{
        BehaviorScript, DialogueEntry, DialogueMatch, EffectTemplate, Expr, NpcScript,
    };
    use crate::script::value::Value as ScriptValue;

    /// An NPC script for "npc/keeper": a `default` entry (bare talk) whose single
    /// AdjustStat(+3 sanity) effect is gated by `once`, plus one fuzzy "cellar"
    /// entry with no effect. `once` toggles the default entry's latch.
    fn keeper_script(default_once: bool) -> NpcScript {
        let lit = |s: &str| Expr::Lit {
            value: ScriptValue::Str(s.into()),
        };
        NpcScript {
            description: "A hunched keeper.".into(),
            default: DialogueEntry {
                match_: DialogueMatch::Exact { text: "".into() },
                response: lit("The keeper nods."),
                effects: alloc::vec![EffectTemplate::AdjustStat {
                    target: Expr::Actor,
                    stat: StatType::Sanity,
                    delta: Expr::Lit {
                        value: ScriptValue::Number(3.0)
                    },
                }],
                once: default_once,
            },
            dialogue: alloc::vec![DialogueEntry {
                match_: DialogueMatch::Fuzzy {
                    tokens: alloc::vec!["cellar".into()]
                },
                response: lit("The cellar is locked."),
                effects: alloc::vec![],
                once: false,
            }],
        }
    }

    /// `cat_with_items` plus the "npc/keeper" NPC behavior registered.
    fn cat_with_keeper(default_once: bool) -> Catalog {
        let mut cat = cat_with_items();
        cat.behaviors.insert(
            "npc/keeper".into(),
            BehaviorScript::Npc {
                script: keeper_script(default_once),
            },
        );
        cat
    }

    fn has_cue(r: &ExecuteResult, text: &str) -> bool {
        r.cues.iter().any(|c| {
            matches!(c,
            PresentationCue::Mechanic { cue } if cue.text.as_deref() == Some(text))
        })
    }

    #[test]
    fn bare_talk_emits_default_response_and_fires_once_effects_then_latches_across_snapshot() {
        let mut w = world_for_submit();
        seat_npc(&mut w, "keeper", "room1", /*visible=*/ true);
        let cat = cat_with_keeper(/*default_once=*/ true);

        // First bare talk: DEFAULT response cue + the once effect fires (sanity 7→10).
        let mut opened = BTreeSet::new();
        let r1 = w.submit(
            Intent::Talk {
                npc_id: "keeper".into(),
                prompt: None,
            },
            &cat,
            &mut opened,
        );
        assert_eq!(r1.error, None);
        assert!(
            has_cue(&r1, "The keeper nods."),
            "default response cue always emitted"
        );
        assert_eq!(
            w.characters[&cid("pc")].stats.sanity,
            10.0,
            "once effect fired"
        );
        assert_eq!(w.campaign.round, 0, "talk is free — no round advance");

        // The latch lives on THIS npc's per-instance state under onceFired.default.
        assert_eq!(
            w.characters[&cid("keeper")].npc_state["onceFired"]["default"],
            serde_json::json!(true)
        );

        // Round-trip the whole world through JSON, proving npcState persists in bytes.
        let json = serde_json::to_string(&w.to_snapshot()).unwrap();
        assert!(
            json.contains("\"npcState\""),
            "fired latch must serialize: {json}"
        );
        assert!(json.contains("\"onceFired\""));
        let mut w2 = crate::world::World::from_snapshot(serde_json::from_str(&json).unwrap());

        // Second talk after the round-trip: response re-emits, effect is SUPPRESSED.
        let mut opened2 = BTreeSet::new();
        let r2 = w2.submit(
            Intent::Talk {
                npc_id: "keeper".into(),
                prompt: None,
            },
            &cat,
            &mut opened2,
        );
        assert_eq!(r2.error, None);
        assert!(has_cue(&r2, "The keeper nods."), "response re-emitted");
        assert_eq!(
            w2.characters[&cid("pc")].stats.sanity,
            10.0,
            "once latch survived the snapshot"
        );
    }

    #[test]
    fn talk_with_prompt_selects_matching_dialogue_entry() {
        let mut w = world_for_submit();
        seat_npc(&mut w, "keeper", "room1", true);
        let cat = cat_with_keeper(false);
        let mut opened = BTreeSet::new();
        let r = w.submit(
            Intent::Talk {
                npc_id: "keeper".into(),
                prompt: Some("about the cellar?".into()),
            },
            &cat,
            &mut opened,
        );
        assert_eq!(r.error, None);
        assert!(
            has_cue(&r, "The cellar is locked."),
            "fuzzy 'cellar' entry selected"
        );
    }

    #[test]
    fn talk_to_npc_without_registered_behavior_is_a_quiet_no_op() {
        // seat_npc uses key "npc/keeper"; cat_with_items has no such behavior, so
        // resolve_npc → None and talk emits nothing (mirrors read_item not-held).
        let mut w = world_for_submit();
        seat_npc(&mut w, "keeper", "room1", true);
        let (r, _) = submit_one(
            &mut w,
            Intent::Talk {
                npc_id: "keeper".into(),
                prompt: None,
            },
        );
        assert_eq!(r.error, None);
        assert_eq!(r.cues, Vec::new());
    }

    #[test]
    fn two_npcs_sharing_a_behavior_key_have_independent_once_latches() {
        let mut w = world_for_submit();
        seat_npc(&mut w, "keeper-a", "room1", true);
        seat_npc(&mut w, "keeper-b", "room1", true);
        let cat = cat_with_keeper(/*default_once=*/ true);
        let mut opened = BTreeSet::new();

        // keeper-a fires (7→10); keeper-b fires INDEPENDENTLY (10→13).
        w.submit(
            Intent::Talk {
                npc_id: "keeper-a".into(),
                prompt: None,
            },
            &cat,
            &mut opened,
        );
        assert_eq!(w.characters[&cid("pc")].stats.sanity, 10.0);
        w.submit(
            Intent::Talk {
                npc_id: "keeper-b".into(),
                prompt: None,
            },
            &cat,
            &mut opened,
        );
        assert_eq!(
            w.characters[&cid("pc")].stats.sanity,
            13.0,
            "keeper-b's latch is separate"
        );

        // keeper-a is latched — talking to it again fires no effect.
        w.submit(
            Intent::Talk {
                npc_id: "keeper-a".into(),
                prompt: None,
            },
            &cat,
            &mut opened,
        );
        assert_eq!(w.characters[&cid("pc")].stats.sanity, 13.0);

        // Each NPC carries its OWN latch on its OWN snapshot state.
        assert_eq!(
            w.characters[&cid("keeper-a")].npc_state["onceFired"]["default"],
            serde_json::json!(true)
        );
        assert_eq!(
            w.characters[&cid("keeper-b")].npc_state["onceFired"]["default"],
            serde_json::json!(true)
        );
    }

    #[test]
    fn examine_visible_npc_emits_description_cue() {
        use crate::presentation::MechanicCue;
        let mut w = world_for_submit();
        seat_npc(&mut w, "keeper", "room1", true);
        let cat = cat_with_keeper(false);
        let mut cues = Vec::new();
        w.examine(&cid("pc"), &cid("keeper"), &cat, &mut cues)
            .unwrap();
        assert_eq!(
            cues,
            alloc::vec![PresentationCue::Mechanic {
                cue: MechanicCue {
                    text: Some("A hunched keeper.".into()),
                    sound: None
                },
            }]
        );
    }

    #[test]
    fn examine_hidden_or_non_npc_target_is_a_quiet_no_op() {
        let cat = cat_with_keeper(false);
        // hidden NPC
        let mut w = world_for_submit();
        seat_npc(&mut w, "keeper", "room1", /*visible=*/ false);
        let mut cues = Vec::new();
        w.examine(&cid("pc"), &cid("keeper"), &cat, &mut cues)
            .unwrap();
        assert!(cues.is_empty(), "a hidden NPC yields no description");
        // a co-located Mob is not an NPC
        let mut cues2 = Vec::new();
        seat_test_mob(&mut w, "wraith", "room1");
        w.examine(&cid("pc"), &cid("wraith"), &cat, &mut cues2)
            .unwrap();
        assert!(cues2.is_empty(), "examining a mob is a no-op");
    }

    #[test]
    fn validate_mechanics_rejects_npc_with_unresolved_behavior_key() {
        let mut w = world_for_submit();
        seat_npc(&mut w, "keeper", "room1", true); // npc_behavior_key = "npc/keeper"
                                                   // No "npc/keeper" behavior registered → validation fails fast.
        let err = w.validate_mechanics(&cat_with_items()).unwrap_err();
        assert!(err.0.contains("npc/keeper"), "got: {}", err.0);
        // Registered → validation passes.
        assert!(w.validate_mechanics(&cat_with_keeper(false)).is_ok());
    }
}
