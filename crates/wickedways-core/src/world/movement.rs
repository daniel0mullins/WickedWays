//! Movement primitives: `go` (direction-based) and `move_to` (room-id-based).
//! Mirrors `src/lib/character/character.ts` `go` (:1047-1063) and `move`/`#enterRoom`
//! (:1018-1032) plus `src/lib/room.ts` `isLit` (:113-211).
//!
//! Scenes fire on room enter/exit via the `SceneBehavior` registry
//! (`crate::world::scenes::scene_behavior`, sub-plan 6c-2): exit-phase scenes of
//! the departed room fire before the occupant is removed, enter-phase scenes of
//! the entered room fire after the occupant is added and before the visibility
//! cue. An unregistered scene `behavior_key` surfaces as `Err(ProceduralViolation)`.
use alloc::collections::BTreeSet;
use alloc::format;
use alloc::string::ToString;
use alloc::vec::Vec;
use crate::error::ProceduralViolation;
use crate::presentation::{ActionKind, EntityRef, MechanicCue, PresentationCue};
use crate::world::descriptor::Catalog;
use crate::world::direction::Direction;
use crate::world::history::{ActionHistoryEntry, RoomRef};
use crate::world::ids::{CharacterId, RoomId};
use crate::world::World;

impl World {
    /// Whether `room` is currently lit. Mirrors `src/lib/room.ts` `get isLit`
    /// (:206-212): a non-dark room is always lit; a dark room is lit iff it holds
    /// a non-broken placed light source, OR an occupant carries an equipped,
    /// non-broken light. Needs `&Catalog` to read each item's `emits_light` and
    /// `max_durability` (broken-state).
    pub fn is_lit(&self, room: &RoomId, cat: &Catalog) -> bool {
        let Some(r) = self.rooms.get(room) else { return true };
        if !r.dark { return true; }
        // Placed light sources: any non-broken source lights the room
        // (TS `for (const light of #lightSources.values()) if (!light.isBroken)`).
        for id in &r.light_source_ids {
            if let Some(snap) = self.items.get(id) {
                if !self.item_is_broken(snap, cat) {
                    return true;
                }
            }
        }
        // Occupant-carried light (TS `occupants.some((o) => o.hasLight)`).
        r.occupant_ids.iter().any(|occ| self.character_has_light(occ, cat))
    }

    /// True when `char_id` has an equipped, non-broken, light-emitting item in a
    /// hand slot. Mirrors `character.ts` `get hasLight` (:275-281): iterate the
    /// left/right hand slots; an item counts iff its descriptor `emitsLight` is
    /// `true` and the instance is not broken.
    pub fn character_has_light(&self, char_id: &CharacterId, cat: &Catalog) -> bool {
        let Some(ch) = self.characters.get(char_id) else { return false };
        for slot in ["leftHand", "rightHand"] {
            let Some(item_id) = ch.equipment.get(slot) else { continue };
            let Some(snap) = self.items.get(item_id) else { continue };
            if let crate::world::snapshot::ItemSnapshot::Item { behavior_key, .. } = snap {
                let emits = cat
                    .items
                    .get(behavior_key)
                    .and_then(|d| d.emits_light)
                    .unwrap_or(false);
                if emits && !self.item_is_broken(snap, cat) {
                    return true;
                }
            }
        }
        false
    }

    /// Mirror of `Item.isBroken` (`inventory.ts:403-405`):
    /// `maxDurability !== undefined && durability === 0`. `max_durability` lives on
    /// the catalog descriptor; `durability` is the per-instance snapshot value.
    fn item_is_broken(&self, snap: &crate::world::snapshot::ItemSnapshot, cat: &Catalog) -> bool {
        match snap {
            crate::world::snapshot::ItemSnapshot::Item { behavior_key, durability, .. } => {
                cat.items.get(behavior_key).and_then(|d| d.max_durability).is_some()
                    && *durability == Some(0)
            }
            crate::world::snapshot::ItemSnapshot::Key { .. } => false,
        }
    }

    /// Build an `EntityRef` for a character — safe to call even if the character
    /// has already been mutated (uses current snapshot state).
    pub(crate) fn entity_ref_char(&self, id: &CharacterId) -> EntityRef {
        let name = self.characters.get(id).map(|c| c.name.clone()).unwrap_or_default();
        EntityRef { id: id.0.clone(), name }
    }

    /// Evaluate the exit in `dir` from the actor's current room, then call
    /// `move_to`. Mirrors TS `Character.go` (:1047-1063).
    ///
    /// - No exit in that direction → emits "You can't go that way." mechanic cue,
    ///   returns `Ok(())`, does NOT tick the budget.
    /// - Behavior-keyed exit → resolves `exit_behavior(key)` (unregistered key →
    ///   `Err(ProceduralViolation)`), evaluates `can_pass`; on failure emits the
    ///   behavior's `fail_message` (if any) as a `Mechanic` cue and returns without
    ///   moving; on success runs `run_script` (falling back to `pass_message`),
    ///   emits that line as a `Mechanic` cue (if any), then delegates to `move_to`.
    /// - Behavior-free exit → delegates to `move_to`.
    pub fn go(
        &mut self,
        actor: &CharacterId,
        dir: Direction,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
        // Affliction gate (is_move = true, budgeted). Mirrors attemptAction(this.go, true).
        match self.gate(actor, true) {
            crate::world::gate::GateVerdict::Block(r) => return Err(ProceduralViolation(r)),
            crate::world::gate::GateVerdict::Fizzle => {
                self.record_fumble(actor, "go", true, cat, cues)?;
                return Ok(());
            }
            crate::world::gate::GateVerdict::Allow => {}
        }

        let here = self
            .characters
            .get(actor)
            .and_then(|c| c.current_room_id.clone())
            .ok_or_else(|| ProceduralViolation("Cannot move: not in any room.".into()))?;

        let room = self
            .rooms
            .get(&here)
            .ok_or_else(|| ProceduralViolation("current room missing".into()))?;

        let Some(exit_id) = room.exits.get(dir.as_key()).cloned() else {
            cues.push(PresentationCue::Mechanic {
                cue: MechanicCue { text: Some("You can't go that way.".into()), sound: None },
            });
            return Ok(());
        };

        let exit = self
            .exits
            .get(&exit_id)
            .ok_or_else(|| ProceduralViolation("exit missing".into()))?;

        // Far endpoint (shared by the keyed and behavior-free paths). Computed
        // from the immutable `exit` read and owned (cloned `RoomId`s), so it
        // stays valid once that borrow ends below (e.g. at the keyed branch's
        // `self.exits.get_mut(&exit_id)`). `endpoint_ids` is [RoomId; 2] — use
        // index syntax, not tuple syntax.
        let a = exit.endpoint_ids[0].clone();
        let b = exit.endpoint_ids[1].clone();
        let dest = if a == here { b } else { a };

        // A behavior-keyed exit: resolve the registry (sub-plan 6) and evaluate
        // canPass / runScript-or-passMessage before moving. Mirrors TS `go` (:4-6).
        if let Some(key) = exit.behavior_key.clone() {
            let resolved = crate::world::exits::resolve_exit_behavior(&key, cat).ok_or_else(|| {
                ProceduralViolation(format!("Exit behavior '{key}' is not registered."))
            })?;
            let behavior = resolved.as_behavior();
            let actor_view = self
                .character_view(actor, cat)
                .ok_or_else(|| ProceduralViolation("actor not found".into()))?;

            // canPass
            if !behavior.can_pass(&actor_view, &exit.state) {
                if let Some(fail) = behavior.fail_message() {
                    cues.push(PresentationCue::Mechanic {
                        cue: MechanicCue { text: Some(fail.into()), sound: None },
                    });
                }
                return Ok(()); // blocked — no move
            }
            // runScript(state) ?? passMessage
            let line = {
                let ex = self.exits.get_mut(&exit_id).expect("exit present");
                behavior.run_script(&actor_view, &mut ex.state)
            }
            .or_else(|| behavior.pass_message().map(|s| s.to_string()));
            if let Some(l) = line {
                cues.push(PresentationCue::Mechanic {
                    cue: MechanicCue { text: Some(l), sound: None },
                });
            }
            return self.move_to(actor, dest, cat, cues);
        }

        // Behavior-free exit: always passable.
        self.move_to(actor, dest, cat, cues)
    }

    /// Fire every scene of the given `phase` registered on `room_id`, in snapshot
    /// order. Each firing may mutate its own `state` and returns mechanic cues,
    /// pushed onto `cues` as `PresentationCue::Mechanic`. Mirrors TS
    /// `Room.enterRoom`/`exitRoom` → `scene.playScene(phase, room)`.
    ///
    /// An unregistered `behavior_key` on a matching-phase scene →
    /// `Err(ProceduralViolation)` (mirrors TS `registry.scene()`'s `#require`).
    ///
    /// `pub(crate)` (rather than private) so `World::maybe_spawn`
    /// (`world/formations.rs`, sub-plan 6c-3) can fire enter-scenes silently for
    /// freshly-placed mobs.
    pub(crate) fn fire_scenes(
        &mut self,
        room_id: &RoomId,
        phase: &str,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
        // Skip the view build for the common scene-less / no-matching-phase case.
        let has_match = self
            .rooms
            .get(room_id)
            .map(|r| r.scenes.iter().any(|s| s.phase == phase))
            .unwrap_or(false);
        if !has_match {
            return Ok(());
        }
        let view = self
            .room_view(room_id, cat)
            .ok_or_else(|| ProceduralViolation("scene room missing".into()))?;
        let room = self
            .rooms
            .get_mut(room_id)
            .ok_or_else(|| ProceduralViolation("scene room missing".into()))?;
        // Collect cues into a local buffer and push after the loop. Intentional:
        // on the unregistered-key `Err` path this drops earlier scenes' cues, but
        // the whole move aborts (`?`) so the cue stream is discarded anyway — a
        // direct-push would be a behavior change, not a cleanup. (Unreachable via
        // the gate: TS resolves a scene behaviorKey at hydrate, not at fire.)
        let mut emitted: Vec<MechanicCue> = Vec::new();
        for scene in room.scenes.iter_mut() {
            if scene.phase != phase {
                continue;
            }
            let behavior = crate::world::scenes::scene_behavior(&scene.behavior_key).ok_or_else(
                || {
                    ProceduralViolation(format!(
                        "Scene behavior '{}' is not registered.",
                        scene.behavior_key
                    ))
                },
            )?;
            if behavior.can_play(&view, &scene.state) {
                emitted.extend(behavior.run_script(&view, &mut scene.state));
            }
        }
        for cue in emitted {
            cues.push(PresentationCue::Mechanic { cue });
        }
        Ok(())
    }

    /// Move `actor` to `room`, updating occupancy in both rooms, emitting a
    /// visibility cue if the destination is dark, then recording the action
    /// (budget tick + history + action cue). Mirrors TS `Character.move` (:1018-1032)
    /// and `Character.#enterRoom`.
    ///
    /// Occupancy is a `Vec`: exit via `retain`, enter via `push` (guards against
    /// duplicates). Insertion order matches TS.
    pub fn move_to(
        &mut self,
        actor: &CharacterId,
        room: RoomId,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
        // Exit old room — fire exit-phase scenes first (mover still an occupant),
        // then retain all occupants that are not the actor. Mirrors TS
        // `Room.exitRoom` (play "exit" scenes → delete occupant).
        if let Some(prev) =
            self.characters.get(actor).and_then(|c| c.current_room_id.clone())
        {
            self.fire_scenes(&prev, "exit", cat, cues)?;
            if let Some(r) = self.rooms.get_mut(&prev) {
                r.occupant_ids.retain(|id| id != actor);
            }
        }

        // Enter new room.
        if let Some(c) = self.characters.get_mut(actor) {
            c.current_room_id = Some(room.clone());
        }
        if let Some(r) = self.rooms.get_mut(&room) {
            if !r.occupant_ids.contains(actor) {
                r.occupant_ids.push(actor.clone());
            }
        }

        // Fire enter-phase scenes now that the actor is an occupant of `room`,
        // BEFORE the visibility cue. Mirrors TS `Room.enterRoom` (add occupant →
        // play "enter" scenes) inside `#enterRoom`, which runs before `move`'s
        // visibility cue.
        self.fire_scenes(&room, "enter", cat, cues)?;

        // Visibility cue when the destination is dark (mirrors TS `move` :1021-1027).
        if !self.is_lit(&room, cat) {
            let name = self
                .rooms
                .get(&room)
                .map(|r| r.name.clone())
                .unwrap_or_default();
            cues.push(PresentationCue::Visibility {
                room: EntityRef { id: room.0.clone(), name },
                lit: false,
            });
        }

        // After a successful move, replicate PlayerCharacter.move side-effects
        // (player-character.ts :169-178): maybeSpawn (encounter table visited) and
        // RECORD_ENCOUNTER for the room (codex).  Both apply only to player characters.
        let is_player = self
            .characters
            .get(actor)
            .map(|c| matches!(c.kind, crate::world::snapshot::CharacterKind::Player))
            .unwrap_or(false);

        // record_action(move): tick budget, append history, emit action cue.
        // Budget tick mirrors TS `recordAction` (:530-532): `actions_this_round += 1`.
        // The `record_action` call below also conditionally ends the turn (reconcile)
        // once the budget is exhausted, mirroring TS `recordAction` → `endTurn()`.
        let round = self.campaign.round;
        let room_name = self
            .rooms
            .get(&room)
            .map(|r| r.name.clone())
            .unwrap_or_default();
        if let Some(c) = self.characters.get_mut(actor) {
            c.history.push(ActionHistoryEntry::Move {
                round,
                room: RoomRef { id: room.clone(), name: room_name.clone() },
            });
        }
        // Action cue — emitted after the history push, matching TS order.
        cues.push(PresentationCue::Action {
            action: ActionKind::Move,
            actor: self.entity_ref_char(actor),
            sound: None,
        });
        // record_action (budget tick + cap-triggered endTurn/reconcile) runs BEFORE
        // the encounter cues: TS `PlayerCharacter.move` (player-character.ts:169-173)
        // calls `super.move(room)` — which runs `recordAction` to completion, including
        // any `endTurn`/reconcile — THEN emits NOTE_ENCOUNTERS.
        self.record_action(actor, true, crate::world::mechanics::ActionView {
            kind: "move".into(),
            room: Some(RoomRef { id: room.clone(), name: room_name.clone() }),
        }, cat, cues)?;

        // PlayerCharacter.move tail (player-character.ts:169-176), AFTER super.move's
        // recordAction: maybeSpawn → NOTE_ENCOUNTERS → room codex. Spawned mobs land
        // before the occupant scan; spawn rng falls after any turn-end rng.
        if is_player {
            // maybeSpawn: roll/select/build/place (marks visited; fires enter-scenes silently).
            self.maybe_spawn(&room, cat)?;

            // NOTE_ENCOUNTERS: scan occupants (now incl. spawned), skip party/KO, dedup on
            // "{actor}:{occ}" in campaign.encountered; record mob codex; stage encounter cues.
            let party: BTreeSet<CharacterId> = self.campaign.party_ids.iter().cloned().collect();
            let occupants: Vec<CharacterId> =
                self.rooms.get(&room).map(|r| r.occupant_ids.clone()).unwrap_or_default();
            let mut encounter_refs: Vec<EntityRef> = Vec::new();
            for occ in occupants {
                if party.contains(&occ) { continue; }
                if self.is_ko(&occ) { continue; }
                let key = format!("{}:{}", actor.0, occ.0);
                if self.campaign.encountered.iter().any(|k| k == &key) { continue; }
                self.campaign.encountered.push(key);
                let (name, stats) = self.characters.get(&occ)
                    .map(|c| (c.name.clone(), (c.stats.health, c.stats.sanity, c.stats.energy)))
                    .unwrap_or_default();
                self.record_codex(
                    "mob", &name,
                    serde_json::json!({ "name": name, "stats": { "health": stats.0, "sanity": stats.1, "energy": stats.2 } }),
                    Some(&actor.0), Some(&room.0),
                );
                encounter_refs.push(self.entity_ref_char(&occ));
            }

            // RECORD_ENCOUNTER({kind:"room"}): first-write-wins room codex entry.
            let room_id_str = room.0.clone();
            let already_in_codex = self.codex.as_array()
                .map(|arr| arr.iter().any(|e|
                    e.get("kind").and_then(|v| v.as_str()) == Some("room")
                    && e.get("key").and_then(|v| v.as_str()) == Some(&room_id_str)))
                .unwrap_or(false);
            if !already_in_codex {
                let (room_name_str, room_desc) = self.rooms.get(&room)
                    .map(|r| (r.name.clone(), r.description.clone())).unwrap_or_default();
                let entry = serde_json::json!({
                    "kind": "room", "key": room_id_str,
                    "snapshot": { "name": room_name_str, "description": room_desc },
                    "firstSeen": { "round": self.campaign.round, "characterId": actor.0.clone(), "roomId": room_id_str }
                });
                if let Some(arr) = self.codex.as_array_mut() { arr.push(entry); }
            }

            // Encounter cues last (after the move action cue AND any turn-end cues).
            for r in encounter_refs {
                cues.push(PresentationCue::Encounter {
                    mob: r,
                    room: EntityRef { id: room.0.clone(), name: room_name.clone() },
                    sound: None,
                });
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::presentation::{ActionKind, EntityRef, PresentationCue};
    use crate::world::history::ActionHistoryEntry;
    use crate::world::ids::{CharacterId, RoomId};
    use crate::world::test_support::world_two_rooms;

    fn cid(s: &str) -> CharacterId { CharacterId(s.into()) }
    fn rid(s: &str) -> RoomId { RoomId(s.into()) }

    /// Insert a minimal live Mob character `name` (id == name) into `room`, and push
    /// its id into that room's `occupant_ids`. Mirrors the CharacterSnapshot pattern
    /// used in `test_support.rs` for player characters.
    fn seat_mob(w: &mut crate::world::World, name: &str, room: &str) {
        use alloc::collections::BTreeMap;
        use crate::world::afflictions::Afflictions;
        use crate::world::snapshot::{CharacterKind, CharacterSnapshot, InventorySnapshot, Stats};
        let id = CharacterId(name.into());
        let room_id = RoomId(room.into());
        let snap = CharacterSnapshot {
            kind: CharacterKind::Mob,
            id: id.clone(),
            name: name.into(),
            stats: Stats { health: 4.0, sanity: 0.0, energy: 3.0 },
            actions_per_round: 1,
            actions_this_round: 0,
            current_room_id: Some(room_id.clone()),
            inventory: InventorySnapshot { slots: 0, item_ids: alloc::vec![], key_ids: alloc::vec![] },
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
            npc_behavior_key: None,
            visible: true,
        };
        w.characters.insert(id.clone(), snap);
        if let Some(r) = w.rooms.get_mut(&room_id) {
            if !r.occupant_ids.contains(&id) {
                r.occupant_ids.push(id);
            }
        }
    }

    #[test]
    fn go_over_behavior_free_exit_moves_updates_occupancy_and_emits_action_cue() {
        let mut w = world_two_rooms(/*next_dark=*/false);
        let mut cues = Vec::new();
        w.go(&cid("pc"), Direction::North, &Catalog::default(), &mut cues).unwrap();
        assert_eq!(w.characters[&cid("pc")].current_room_id, Some(rid("next")));
        assert!(!w.rooms[&rid("start")].occupant_ids.contains(&cid("pc")));
        assert!(w.rooms[&rid("next")].occupant_ids.contains(&cid("pc")));
        assert_eq!(w.characters[&cid("pc")].actions_this_round, 1);
        assert_eq!(cues, vec![PresentationCue::Action {
            action: ActionKind::Move,
            actor: EntityRef { id: "pc".into(), name: "Heir".into() },
            sound: None }]);
        // history append — pin exact round and room
        assert_eq!(
            w.characters[&cid("pc")].history.last(),
            Some(&ActionHistoryEntry::Move {
                round: 0,
                room: RoomRef { id: rid("next"), name: "Next".into() },
            })
        );
    }

    #[test]
    fn entering_a_dark_room_emits_visibility_lit_false() {
        let mut w = world_two_rooms(/*next_dark=*/true);
        let mut cues = Vec::new();
        w.go(&cid("pc"), Direction::North, &Catalog::default(), &mut cues).unwrap();
        assert_eq!(cues, vec![
            PresentationCue::Visibility {
                room: EntityRef { id: "next".into(), name: "Next".into() },
                lit: false,
            },
            PresentationCue::Action {
                action: ActionKind::Move,
                actor: EntityRef { id: "pc".into(), name: "Heir".into() },
                sound: None,
            },
        ]);
    }

    #[test]
    fn go_at_a_wall_emits_cant_go_that_way_and_does_not_move_or_tick_budget() {
        let mut w = world_two_rooms(false);
        let mut cues = Vec::new();
        w.go(&cid("pc"), Direction::East, &Catalog::default(), &mut cues).unwrap();
        assert_eq!(w.characters[&cid("pc")].current_room_id, Some(rid("start")));
        assert_eq!(w.characters[&cid("pc")].actions_this_round, 0);
        assert_eq!(cues, vec![PresentationCue::Mechanic {
            cue: crate::presentation::MechanicCue {
                text: Some("You can't go that way.".into()), sound: None } }]);
    }

    #[test]
    fn is_lit_truth_table() {
        let w = world_two_rooms(true);
        let cat = Catalog::default();
        assert!(w.is_lit(&rid("start"), &cat));   // not dark
        assert!(!w.is_lit(&rid("next"), &cat));   // dark, no light sources
    }

    /// Build an Accessory descriptor that (maybe) emits light and (maybe) has a
    /// max durability — enough to drive `character_has_light` / `is_lit`.
    fn lantern_desc(emits: Option<bool>, max_dur: Option<i64>) -> crate::world::descriptor::ItemDescriptor {
        use crate::world::descriptor::{ItemDescriptor, ItemProperties, ItemType, SlotKind};
        ItemDescriptor {
            name: "Brass Lantern".into(),
            r#type: ItemType::Accessory,
            stat: crate::stats::StatType::Sanity,
            modifier: 0,
            properties: ItemProperties {
                equippable: true, equipped: true, destroyable: false, usable: false, droppable: None,
            },
            slot: Some(SlotKind::Hand),
            two_handed: None,
            emits_light: emits,
            max_durability: max_dur,
            lore: None,
            presentation: None,
            key_code: None,
            consume_on_use: None,
            recipe: serde_json::Value::Null,
            teaches: serde_json::Value::Null,
            immunities: serde_json::Value::Null,
            grants_immunity: serde_json::Value::Null,
        }
    }

    /// A dark room is lit by an occupant's equipped, non-broken, light-emitting
    /// hand item — and NOT lit if that item is broken or does not emit light.
    /// Mirrors `room.ts` `isLit` → `character.ts` `hasLight` (occupant path).
    #[test]
    fn dark_room_lit_by_occupant_equipped_lantern() {
        use crate::world::descriptor::Catalog;
        use crate::world::ids::ItemId;
        use crate::world::snapshot::ItemSnapshot;

        let mut w = world_two_rooms(/*next_dark=*/true);
        // Seat the pc as an occupant of the dark "next" room.
        if let Some(r) = w.rooms.get_mut(&rid("next")) {
            r.occupant_ids.push(cid("pc"));
        }
        let mut cat = Catalog::default();
        cat.items.insert("lantern".into(), lantern_desc(Some(true), None));

        // No equipped light yet → dark room stays unlit.
        assert!(!w.character_has_light(&cid("pc"), &cat));
        assert!(!w.is_lit(&rid("next"), &cat));

        // Equip a non-broken lantern in the left hand → room is now lit.
        let item_id = ItemId("lantern-1".into());
        w.items.insert(item_id.clone(), ItemSnapshot::Item {
            id: item_id.clone(), behavior_key: "lantern".into(), durability: None, modifier: 0,
        });
        w.characters.get_mut(&cid("pc")).unwrap().equipment.insert("leftHand".into(), item_id.clone());
        assert!(w.character_has_light(&cid("pc"), &cat));
        assert!(w.is_lit(&rid("next"), &cat));

        // Broken lantern (maxDurability set + durability 0) → not a light.
        cat.items.insert("lantern".into(), lantern_desc(Some(true), Some(3)));
        if let Some(ItemSnapshot::Item { durability, .. }) = w.items.get_mut(&item_id) {
            *durability = Some(0);
        }
        assert!(!w.character_has_light(&cid("pc"), &cat));
        assert!(!w.is_lit(&rid("next"), &cat));

        // Non-broken again but descriptor does not emit light → not a light.
        cat.items.insert("lantern".into(), lantern_desc(None, None));
        if let Some(ItemSnapshot::Item { durability, .. }) = w.items.get_mut(&item_id) {
            *durability = None;
        }
        assert!(!w.character_has_light(&cid("pc"), &cat));
        assert!(!w.is_lit(&rid("next"), &cat));
    }

    /// A dark room with a placed BROKEN light source is NOT lit (mirrors TS
    /// `for (const light of #lightSources) if (!light.isBroken)`); a non-broken
    /// placed source lights it.
    #[test]
    fn dark_room_placed_light_source_respects_broken_state() {
        use crate::world::descriptor::Catalog;
        use crate::world::ids::ItemId;
        use crate::world::snapshot::ItemSnapshot;

        let mut w = world_two_rooms(/*next_dark=*/true);
        let mut cat = Catalog::default();
        cat.items.insert("torch".into(), lantern_desc(Some(true), Some(2)));

        let item_id = ItemId("torch-1".into());
        w.items.insert(item_id.clone(), ItemSnapshot::Item {
            id: item_id.clone(), behavior_key: "torch".into(), durability: Some(0), modifier: 0,
        });
        if let Some(r) = w.rooms.get_mut(&rid("next")) {
            r.light_source_ids.push(item_id.clone());
        }
        // Placed but broken → still dark.
        assert!(!w.is_lit(&rid("next"), &cat));

        // Repair it (durability > 0) → lit.
        if let Some(ItemSnapshot::Item { durability, .. }) = w.items.get_mut(&item_id) {
            *durability = Some(2);
        }
        assert!(w.is_lit(&rid("next"), &cat));
    }

    #[test]
    fn entering_a_room_with_a_live_mob_emits_encounter_cue_and_codex() {
        let mut w = world_two_rooms(/*next_dark=*/false);
        // Seat a live mob "grue" in the destination room "next".
        seat_mob(&mut w, "grue", "next");
        let mut cues = Vec::new();
        w.go(&cid("pc"), Direction::North, &Catalog::default(), &mut cues).unwrap();
        // encounter cue present, after the move action cue
        let move_idx = cues.iter().position(|c| matches!(c, PresentationCue::Action { action: ActionKind::Move, .. })).unwrap();
        let enc_idx = cues.iter().position(|c| matches!(c, PresentationCue::Encounter { .. })).unwrap();
        assert!(enc_idx > move_idx, "encounter cue comes after the move action cue");
        match &cues[enc_idx] {
            PresentationCue::Encounter { mob, room, sound: None } => {
                assert_eq!(mob.id, "grue"); assert_eq!(room.id, "next");
            }
            other => panic!("expected Encounter cue, got {:?}", other),
        }
        // codex: mob record for grue exists AND precedes the room record for "next"
        let codex = w.codex.as_array().unwrap();
        let mob_idx = codex.iter().position(|e| e["kind"] == serde_json::json!("mob") && e["key"] == serde_json::json!("grue")).unwrap();
        let room_idx = codex.iter().position(|e| e["kind"] == serde_json::json!("room") && e["key"] == serde_json::json!("next")).unwrap();
        assert!(mob_idx < room_idx, "mob codex record precedes the room codex record");
        // dedup: the composite key `${mover}:${occupant}` is recorded
        assert!(w.campaign.encountered.iter().any(|k| k == "pc:grue"), "encountered key recorded for dedup");
    }

    #[test]
    fn player_move_into_fresh_room_spawns_and_encounters() {
        use crate::world::ids::CharacterId;
        let mut w = world_two_rooms(false);
        // arm the encounter table with a guaranteed spawn
        w.campaign.encounter_table = serde_json::json!({
            "baseChance": 100, "visited": [],
            "formations": [ { "behaviorKey": "conformance:wraith", "weight": 1 } ]
        });
        if let Some(r) = w.rooms.get_mut(&rid("next")) { r.spawn_modifier = 1; }
        let mut cues = Vec::new();
        w.go(&cid("pc"), Direction::North, &Catalog::default(), &mut cues).unwrap();

        // wraith spawned into "next"
        let wid = CharacterId("campaign-mob:wraith".into());
        assert_eq!(w.characters[&wid].current_room_id, Some(rid("next")));
        assert!(w.rooms[&rid("next")].occupant_ids.contains(&wid));

        // encounter cue for the wraith comes AFTER the move action cue
        let mv = cues.iter().position(|c| matches!(c, PresentationCue::Action { action: ActionKind::Move, .. })).unwrap();
        let enc = cues.iter().position(|c| matches!(c, PresentationCue::Encounter { mob, .. } if mob.id == "campaign-mob:wraith")).unwrap();
        assert!(enc > mv, "spawned-mob encounter cue comes after the move action cue");
    }

    #[test]
    fn budgeted_go_at_cap_triggers_turn_end_reconcile() {
        use crate::world::afflictions::Status;
        use crate::world::descriptor::Catalog;
        let mut w = world_two_rooms(false);
        let mut cues = Vec::new();
        if let Some(c) = w.characters.get_mut(&cid("pc")) {
            c.actions_per_round = 1; // next action exhausts the budget
            c.stats.health = -3.0;   // reconcile floors this iff turn-end runs
        }
        w.go(&cid("pc"), Direction::North, &Catalog::default(), &mut cues).unwrap();
        let ch = w.characters.get(&cid("pc")).unwrap();
        assert_eq!(ch.actions_this_round, 1);
        assert_eq!(ch.stats.health, 0.0, "cap-reaching move auto-ends turn -> reconcile floored base");
        assert!(ch.afflictions.is_active(Status::Ko));
    }

    /// Insert an `ItemSnapshot::Item` with the given `behavior_key` into `world.items`
    /// and push its id onto `char_id`'s `inventory.item_ids`. Mirrors how the real game
    /// seeds a held item; used to satisfy `CharacterView::has_item` for keyed-exit tests.
    fn seed_held_item(w: &mut crate::world::World, char_id: &str, behavior_key: &str) {
        use crate::world::ids::ItemId;
        use crate::world::snapshot::ItemSnapshot;
        let item_id = ItemId(alloc::format!("{char_id}-{behavior_key}-item"));
        w.items.insert(
            item_id.clone(),
            ItemSnapshot::Item {
                id: item_id.clone(),
                behavior_key: behavior_key.into(),
                durability: None,
                modifier: 0,
            },
        );
        if let Some(c) = w.characters.get_mut(&cid(char_id)) {
            c.inventory.item_ids.push(item_id);
        }
    }

    #[test]
    fn keyed_exit_blocked_without_key_emits_fail_and_does_not_move() {
        use crate::world::descriptor::Catalog;
        let mut w = world_two_rooms(false);
        w.make_north_exit_keyed("conformance:keyed-door"); // marks the north exit keyed
        // set locked initial state on that exit
        for ex in w.exits.values_mut() { if ex.behavior_key.is_some() { ex.state = serde_json::json!({ "unlocked": false }); } }
        let start_room = w.characters[&cid("pc")].current_room_id.clone();
        let mut cues = Vec::new();
        w.go(&cid("pc"), Direction::North, &Catalog::default(), &mut cues).unwrap();
        // did not move
        assert_eq!(w.characters[&cid("pc")].current_room_id, start_room);
        // fail message emitted
        assert!(cues.iter().any(|c| matches!(c,
            PresentationCue::Mechanic { cue } if cue.text.as_deref() == Some("The door is locked."))));
    }

    #[test]
    fn keyed_exit_with_key_unlocks_moves_and_persists_state() {
        use crate::world::descriptor::Catalog;
        let mut w = world_two_rooms(false);
        w.make_north_exit_keyed("conformance:keyed-door");
        for ex in w.exits.values_mut() { if ex.behavior_key.is_some() { ex.state = serde_json::json!({ "unlocked": false }); } }
        seed_held_item(&mut w, "pc", "brass-key"); // helper: item with behavior_key "brass-key" in pc inventory
        let start_room = w.characters[&cid("pc")].current_room_id.clone();
        let mut cues = Vec::new();
        w.go(&cid("pc"), Direction::North, &Catalog::default(), &mut cues).unwrap();
        // moved to the far room
        assert_ne!(w.characters[&cid("pc")].current_room_id, start_room);
        // unlock narration emitted
        assert!(cues.iter().any(|c| matches!(c,
            PresentationCue::Mechanic { cue } if cue.text.as_deref() == Some("The door unlocks."))));
        // state persisted
        assert!(w.exits.values().any(|ex| ex.state.get("unlocked") == Some(&serde_json::json!(true))));
    }

    #[test]
    fn keyed_exit_unregistered_key_errors() {
        use crate::world::descriptor::Catalog;
        let mut w = world_two_rooms(false);
        w.make_north_exit_keyed("nope:not-registered");
        let mut cues = Vec::new();
        assert!(w.go(&cid("pc"), Direction::North, &Catalog::default(), &mut cues).is_err());
    }

    /// Put a true Key (kind:"key") with `key_code` into `char_id`'s keyring.
    fn seed_held_key(w: &mut crate::world::World, char_id: &str, key_code: &str) {
        use crate::world::snapshot::ItemSnapshot;
        let item_id = crate::world::ids::ItemId(alloc::format!("key-{key_code}"));
        w.items.insert(item_id.clone(), ItemSnapshot::Key {
            id: item_id.clone(), name: alloc::format!("{key_code} key"),
            key_code: key_code.into(), consume_on_use: false,
        });
        if let Some(c) = w.characters.get_mut(&cid(char_id)) {
            c.inventory.key_ids.push(item_id);
        }
    }

    #[test]
    fn go_resolves_a_scripted_exit_from_the_catalog() {
        // Same two-room world as the conformance:keyed-door tests, but the
        // north exit resolves through Catalog.behaviors ("study-door").
        let cat = crate::world::exits::tests_catalog_with_door("study-door");
        let mut w = world_two_rooms(false);
        w.make_north_exit_keyed("study-door");
        for ex in w.exits.values_mut() {
            if ex.behavior_key.is_some() { ex.state = serde_json::json!({ "unlocked": false }); }
        }
        let start_room = w.characters[&cid("pc")].current_room_id.clone();
        let mut cues = Vec::new();

        // 1. keyless: blocked, fail cue, no move
        w.go(&cid("pc"), Direction::North, &cat, &mut cues).unwrap();
        assert_eq!(w.characters[&cid("pc")].current_room_id, start_room);
        assert!(cues.iter().any(|c| matches!(c, PresentationCue::Mechanic { cue }
            if cue.text.as_deref() == Some("The study door won't budge — it's locked."))));

        // 2. with the brass key: unlock narration + move + persisted state
        seed_held_key(&mut w, "pc", "brass");
        let mut cues = Vec::new();
        w.go(&cid("pc"), Direction::North, &cat, &mut cues).unwrap();
        assert_ne!(w.characters[&cid("pc")].current_room_id, start_room);
        assert!(cues.iter().any(|c| matches!(c, PresentationCue::Mechanic { cue }
            if cue.text.as_deref() == Some("The door unlocks."))));
        assert!(w.exits.values().any(|ex| ex.state.get("unlocked") == Some(&serde_json::json!(true))));

        // 3. re-pass back through the unlocked door: silent (no mechanic cue)
        let mut cues = Vec::new();
        w.go(&cid("pc"), Direction::South, &cat, &mut cues).unwrap();
        assert!(!cues.iter().any(|c| matches!(c, PresentationCue::Mechanic { .. })),
            "unlocked re-pass must be silent");
    }

    /// Attach a `conformance:visit-counter` scene to `room` with the given phase and
    /// starting count. Mirrors how RoomSnapshot carries scenes.
    fn attach_scene(w: &mut crate::world::World, room: &str, phase: &str, count: i64) {
        use crate::world::snapshot::SceneSnapshot;
        if let Some(r) = w.rooms.get_mut(&rid(room)) {
            r.scenes.push(SceneSnapshot {
                id: alloc::format!("{room}-{phase}-scene"),
                behavior_key: "conformance:visit-counter".into(),
                phase: phase.into(),
                state: serde_json::json!({ "count": count }),
            });
        }
    }

    #[test]
    fn enter_scene_fires_after_occupant_add_and_emits_cue_before_visibility() {
        let mut w = world_two_rooms(/*next_dark=*/true); // dark → a visibility cue follows
        attach_scene(&mut w, "next", "enter", 0);
        let mut cues = Vec::new();
        w.go(&cid("pc"), Direction::North, &Catalog::default(), &mut cues).unwrap();

        // scene mutated its own state (count 0 → 1), mover was an occupant when it fired
        let scene = &w.rooms[&rid("next")].scenes[0];
        assert_eq!(scene.state["count"], serde_json::json!(1));

        // cue order: scene mechanic cue BEFORE the visibility cue BEFORE the move action cue
        let mech = cues.iter().position(|c| matches!(c,
            PresentationCue::Mechanic { cue } if cue.text.as_deref() == Some("The Next stirs (visit 1)."))).unwrap();
        let vis = cues.iter().position(|c| matches!(c, PresentationCue::Visibility { .. })).unwrap();
        let mv = cues.iter().position(|c| matches!(c, PresentationCue::Action { action: ActionKind::Move, .. })).unwrap();
        assert!(mech < vis && vis < mv, "scene cue precedes visibility precedes move; got {cues:?}");
    }

    #[test]
    fn exit_scene_fires_before_occupant_removal() {
        let mut w = world_two_rooms(false);
        attach_scene(&mut w, "start", "exit", 0);
        let mut cues = Vec::new();
        w.go(&cid("pc"), Direction::North, &Catalog::default(), &mut cues).unwrap();
        // exit scene on the departed room fired (count 0 → 1)
        assert_eq!(w.rooms[&rid("start")].scenes[0].state["count"], serde_json::json!(1));
        // its cue is the FIRST cue (before any enter/visibility/move cue for the new room)
        assert!(matches!(&cues[0],
            PresentationCue::Mechanic { cue } if cue.text.as_deref() == Some("The Start stirs (visit 1).")));
    }

    #[test]
    fn exit_scene_then_enter_scene_ordering_in_one_move() {
        let mut w = world_two_rooms(false);
        attach_scene(&mut w, "start", "exit", 0);
        attach_scene(&mut w, "next", "enter", 0);
        let mut cues = Vec::new();
        w.go(&cid("pc"), Direction::North, &Catalog::default(), &mut cues).unwrap();
        let exit_idx = cues.iter().position(|c| matches!(c,
            PresentationCue::Mechanic { cue } if cue.text.as_deref() == Some("The Start stirs (visit 1)."))).unwrap();
        let enter_idx = cues.iter().position(|c| matches!(c,
            PresentationCue::Mechanic { cue } if cue.text.as_deref() == Some("The Next stirs (visit 1)."))).unwrap();
        assert!(exit_idx < enter_idx, "old-room exit-scene cue precedes new-room enter-scene cue");
    }

    #[test]
    fn scene_precondition_cap_stops_firing() {
        let mut w = world_two_rooms(false);
        attach_scene(&mut w, "next", "enter", 3); // already at the cap
        let mut cues = Vec::new();
        w.go(&cid("pc"), Direction::North, &Catalog::default(), &mut cues).unwrap();
        // no mutation, no scene cue
        assert_eq!(w.rooms[&rid("next")].scenes[0].state["count"], serde_json::json!(3));
        assert!(!cues.iter().any(|c| matches!(c,
            PresentationCue::Mechanic { cue } if cue.text.as_deref().map(|t| t.contains("stirs")).unwrap_or(false))));
    }

    #[test]
    fn unregistered_scene_behavior_key_errors() {
        let mut w = world_two_rooms(false);
        if let Some(r) = w.rooms.get_mut(&rid("next")) {
            r.scenes.push(crate::world::snapshot::SceneSnapshot {
                id: "bad".into(), behavior_key: "nope:unregistered".into(),
                phase: "enter".into(), state: serde_json::json!({}),
            });
        }
        let mut cues = Vec::new();
        assert!(w.go(&cid("pc"), Direction::North, &Catalog::default(), &mut cues).is_err());
    }
}
