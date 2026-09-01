//! Movement primitives: `go` (direction-based) and `move_to` (room-id-based),
//! plus room lighting (`is_lit`). Behavior is pinned byte-exact by the
//! conformance goldens.
//!
//! Scenes fire on room enter/exit via the `SceneBehavior` registry
//! (`crate::world::scenes::scene_behavior`): exit-phase scenes of
//! the departed room fire before the occupant is removed, enter-phase scenes of
//! the entered room fire after the occupant is added and before the visibility
//! cue. An unregistered scene `behavior_key` surfaces as `Err(ProceduralViolation)`.
use crate::error::ProceduralViolation;
use crate::presentation::{ActionKind, EntityRef, MechanicCue, PresentationCue};
use crate::world::descriptor::Catalog;
use crate::world::direction::Direction;
use crate::world::history::{ActionHistoryEntry, RoomRef};
use crate::world::ids::{CharacterId, RoomId};
use crate::world::World;
use alloc::collections::BTreeSet;
use alloc::format;
use alloc::vec::Vec;

impl World {
    // ---- room lighting ----

    /// Whether `room` is currently lit:
    /// a non-dark room is always lit; a dark room is lit iff it holds
    /// a non-broken placed light source, OR an occupant carries an equipped,
    /// non-broken light. Needs `&Catalog` to read each item's `emits_light` and
    /// `max_durability` (broken-state).
    ///
    /// Supernatural darkness (the Villain's `wicked:lights-out` card) overrides
    /// everything: while `campaign.lights_out_rounds > 0`, EVERY room is unlit
    /// regardless of `dark` flags or light sources. The check is first so it
    /// propagates to every consumer (targeting gate, light-averse multiplier,
    /// entry-swing initiative, visibility cues, view projections) at once.
    pub fn is_lit(&self, room: &RoomId, cat: &Catalog) -> bool {
        if self.campaign.lights_out_rounds > 0 {
            return false;
        }
        let Some(r) = self.rooms.get(room) else {
            return true;
        };
        if !r.dark {
            return true;
        }
        // Placed light sources: any non-broken source lights the room.
        for id in &r.light_source_ids {
            if let Some(snap) = self.items.get(id) {
                if !self.item_is_broken(snap, cat) {
                    return true;
                }
            }
        }
        // Occupant-carried light: any occupant with an equipped light counts.
        r.occupant_ids
            .iter()
            .any(|occ| self.character_has_light(occ, cat))
    }

    /// True when `char_id` has an equipped, non-broken, light-emitting item in a
    /// hand slot: iterate the
    /// left/right hand slots; an item counts iff its descriptor `emitsLight` is
    /// `true` and the instance is not broken.
    pub fn character_has_light(&self, char_id: &CharacterId, cat: &Catalog) -> bool {
        let Some(ch) = self.characters.get(char_id) else {
            return false;
        };
        for slot in ["leftHand", "rightHand"] {
            let Some(item_id) = ch.equipment.get(slot) else {
                continue;
            };
            let Some(snap) = self.items.get(item_id) else {
                continue;
            };
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

    /// Broken test:
    /// `maxDurability !== undefined && durability === 0`. `max_durability` lives on
    /// the catalog descriptor; `durability` is the per-instance snapshot value.
    fn item_is_broken(&self, snap: &crate::world::snapshot::ItemSnapshot, cat: &Catalog) -> bool {
        match snap {
            crate::world::snapshot::ItemSnapshot::Item {
                behavior_key,
                durability,
                ..
            } => {
                cat.items
                    .get(behavior_key)
                    .and_then(|d| d.max_durability)
                    .is_some()
                    && *durability == Some(0)
            }
            crate::world::snapshot::ItemSnapshot::Key { .. } => false,
        }
    }

    /// Build an `EntityRef` for a character — safe to call even if the character
    /// has already been mutated (uses current snapshot state).
    pub(crate) fn entity_ref_char(&self, id: &CharacterId) -> EntityRef {
        let name = self
            .characters
            .get(id)
            .map(|c| c.name.clone())
            .unwrap_or_default();
        EntityRef {
            id: id.0.clone(),
            name,
        }
    }

    // ---- exits: the `go` action ----

    /// Evaluate the exit in `dir` from the actor's current room, then call
    /// `move_to`. Behavior is pinned byte-exact by the conformance goldens.
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
                cue: MechanicCue {
                    text: Some("You can't go that way.".into()),
                    sound: None,
                },
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

        // A behavior-keyed exit: resolve the registry and evaluate
        // canPass / runScript-or-passMessage before moving.
        if let Some(key) = exit.behavior_key.clone() {
            let resolved =
                crate::world::exits::resolve_exit_behavior(&key, cat).ok_or_else(|| {
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
                        cue: MechanicCue {
                            text: Some(fail.into()),
                            sound: None,
                        },
                    });
                }
                return Ok(()); // blocked — no move
            }
            // runScript(state) ?? passMessage
            let line = {
                let ex = self.exits.get_mut(&exit_id).expect("exit present");
                behavior.run_script(&actor_view, &mut ex.state)
            }
            .or_else(|| {
                behavior
                    .pass_message()
                    .map(alloc::string::ToString::to_string)
            });
            if let Some(l) = line {
                cues.push(PresentationCue::Mechanic {
                    cue: MechanicCue {
                        text: Some(l),
                        sound: None,
                    },
                });
            }
            return self.move_to(actor, &dest, cat, cues);
        }

        // Behavior-free exit: always passable.
        self.move_to(actor, &dest, cat, cues)
    }

    /// Whether a keyed-exit behavior blocks `actor` from moving through the exit in `dir`. Returns
    /// the behavior's `fail_message` (or a default) when `can_pass` is false, else `None` (no exit
    /// there, a behavior-free exit, or a passable keyed exit).
    ///
    /// A **pure** query — it does NOT run the exit's `run_script` or mutate door state. The
    /// surfaces call this to gate a room-id `move` client-side before issuing it, the way the
    /// single-seat [`go`](Self::go) does — narrating the fail message without a round-trip;
    /// [`move_block_reason`](Self::move_block_reason) is the authority-side twin that backs it up.
    pub fn exit_block_reason(
        &self,
        actor: &CharacterId,
        dir: Direction,
        cat: &Catalog,
    ) -> Option<alloc::string::String> {
        let here = self
            .characters
            .get(actor)
            .and_then(|c| c.current_room_id.clone())?;
        let exit_id = self.rooms.get(&here)?.exits.get(dir.as_key())?.clone();
        let exit = self.exits.get(&exit_id)?;
        exit.behavior_key.as_ref()?; // behavior-free: passable, skip the view build
        let actor_view = self.character_view(actor, cat)?;
        keyed_exit_blocks(exit, &actor_view, cat)
    }

    /// Whether the room-id `move` from `actor`'s current room to `dest` is barred by keyed
    /// exits: `Some(fail message)` when at least one exit connects the two rooms and **every**
    /// connecting exit refuses passage; `None` when any connecting exit is passable
    /// (behavior-free, or a keyed exit whose `can_pass` holds), or when no exit connects them
    /// at all — adjacency is not this check's concern, mirroring [`move_to`](Self::move_to)'s
    /// existing posture toward unconnected rooms.
    ///
    /// The sync authority calls this to deny a blocked `move` command server-side (a pure
    /// `can_pass` query like [`exit_block_reason`](Self::exit_block_reason) — no `run_script`,
    /// no state mutation), so a locked or sealed door holds even against a replica whose exit
    /// state is stale.
    pub fn move_block_reason(
        &self,
        actor: &CharacterId,
        dest: &RoomId,
        cat: &Catalog,
    ) -> Option<alloc::string::String> {
        let here = self
            .characters
            .get(actor)
            .and_then(|c| c.current_room_id.clone())?;
        if &here == dest {
            return None;
        }
        let room = self.rooms.get(&here)?;
        let actor_view = self.character_view(actor, cat)?;
        // First blocking exit's message, kept only if NO connecting exit lets the actor
        // through. `room.exits` is a BTreeMap (direction-keyed), so iteration — and thus
        // which fail message wins — is deterministic.
        let mut block: Option<alloc::string::String> = None;
        for exit_id in room.exits.values() {
            let Some(exit) = self.exits.get(exit_id) else {
                continue;
            };
            let connects = (exit.endpoint_ids[0] == here && exit.endpoint_ids[1] == *dest)
                || (exit.endpoint_ids[1] == here && exit.endpoint_ids[0] == *dest);
            if !connects {
                continue;
            }
            match keyed_exit_blocks(exit, &actor_view, cat) {
                None => return None, // a passable route exists
                Some(reason) => block = block.or(Some(reason)),
            }
        }
        block
    }

    // ---- scenes ----

    /// Fire every scene of the given `phase` registered on `room_id`, in snapshot
    /// order. Each firing may mutate its own `state` and returns mechanic cues,
    /// pushed onto `cues` as `PresentationCue::Mechanic`. Mirrors
    /// `Room.enterRoom`/`exitRoom` → `scene.playScene(phase, room)`.
    ///
    /// An unregistered `behavior_key` on a matching-phase scene →
    /// `Err(ProceduralViolation)` (mirrors `registry.scene()`'s `#require`).
    ///
    /// `pub(crate)` (rather than private) so `World::maybe_spawn`
    /// (`world/formations.rs`) can fire enter-scenes silently for
    /// freshly-placed mobs.
    pub(crate) fn fire_scenes(
        &mut self,
        room_id: &RoomId,
        phase: &str,
        actor: &CharacterId,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
        // Skip the view build for the common scene-less / no-matching-phase case.
        let has_match = self
            .rooms
            .get(room_id)
            .is_some_and(|r| r.scenes.iter().any(|s| s.phase == phase));
        if !has_match {
            return Ok(());
        }
        let view = self
            .room_view(room_id, cat)
            .ok_or_else(|| ProceduralViolation("scene room missing".into()))?;

        // Native-scene cues are collected here and pushed AFTER the loop — byte-identical
        // to the pre-scripted path. Intentional: on the unregistered-key `Err` path this
        // drops earlier native scenes' cues, but the whole move aborts (`?`) so the cue
        // stream is discarded anyway. Scripted scenes read the LIVE world
        // (RoomSource::World), so they resolve by index and re-borrow `self` fresh each
        // iteration — their effects flow through the shared collect-then-apply pipeline
        // (`apply_all`), whose cues surface inline.
        let scene_count = self.rooms.get(room_id).map_or(0, |r| r.scenes.len());
        let mut emitted: Vec<MechanicCue> = Vec::new();
        // FOOTGUN (mixed families in one room+phase): `view` above is built ONCE,
        // pre-loop, so a Native scene always reads PRE-loop world state. A Scripted
        // scene ordered earlier in this same loop mutates the LIVE world (e.g.
        // SetVisible via `apply_all`), so a later Native scene would observe the
        // stale snapshot in Rust but the mutated state in the TS oracle -> divergence.
        // Cue ordering diverges too: scripted cues surface INLINE (via `apply_all`),
        // native cues are BUFFERED and pushed AFTER the loop, so ordering only matches
        // between engines for single-family (all-native OR all-scripted) rooms.
        // Rule for authors: do NOT register a native scene alongside a state-mutating
        // scripted scene in the same room+phase. Safe today -- native scenes are
        // compiled-in and only `conformance:visit-counter` exists (real campaigns are
        // all-scripted), so this case is unreachable; this note guards future authors.
        // An index loop instead of `for scene in r.scenes`: iterating the room
        // directly would hold a borrow of `self` for the whole loop, and the scene
        // bodies below need `&mut self`. Indexing re-borrows fresh each iteration.
        for i in 0..scene_count {
            let (scene_phase, behavior_key) =
                match self.rooms.get(room_id).and_then(|r| r.scenes.get(i)) {
                    Some(s) => (s.phase.clone(), s.behavior_key.clone()),
                    None => continue,
                };
            if scene_phase != phase {
                continue;
            }
            match crate::world::scenes::resolve_scene(&behavior_key, cat) {
                None => {
                    return Err(ProceduralViolation(format!(
                        "Scene behavior '{behavior_key}' is not registered."
                    )));
                }
                // Native: unchanged cue-only path (byte-identical to the old resolver).
                Some(crate::world::scenes::ResolvedScene::Native(behavior)) => {
                    if let Some(scene) = self
                        .rooms
                        .get_mut(room_id)
                        .and_then(|r| r.scenes.get_mut(i))
                    {
                        if behavior.can_play(&view, &scene.state) {
                            emitted.extend(behavior.run_script(&view, &mut scene.state));
                        }
                    }
                }
                // Scripted: gate on `can_play`, evaluate the phase body into effects, then
                // apply them (SetVisible/GiveItem/SetState + cues) through `apply_all`.
                Some(crate::world::scenes::ResolvedScene::Scripted(script)) => {
                    // Take the scene's own JSON state out so its Write borrow does not
                    // collide with the RoomSource::World `&self` borrow used for room reads.
                    let mut state = match self
                        .rooms
                        .get_mut(room_id)
                        .and_then(|r| r.scenes.get_mut(i))
                    {
                        Some(s) => core::mem::take(&mut s.state),
                        None => continue,
                    };
                    let campaign_view = self.build_campaign_view(cat);
                    let actor_view = self.character_view(actor, cat);
                    let scene_op = crate::script::ops::ScriptedScene { script };
                    let effects = if scene_op.can_play(
                        &state,
                        &campaign_view,
                        actor_view.as_ref(),
                        self,
                        cat,
                    ) {
                        let body = match phase {
                            "enter" => script.on_enter.as_ref(),
                            "exit" => script.on_exit.as_ref(),
                            _ => None,
                        };
                        scene_op.run(
                            body,
                            &mut state,
                            &campaign_view,
                            actor_view.as_ref(),
                            self,
                            cat,
                        )
                    } else {
                        Vec::new()
                    };
                    // Write the (possibly mutated) state back before applying effects.
                    if let Some(s) = self
                        .rooms
                        .get_mut(room_id)
                        .and_then(|r| r.scenes.get_mut(i))
                    {
                        s.state = state;
                    }
                    // Runaway backstop, then the shared collect-then-apply pipeline.
                    if effects.len() > crate::world::mechanics::MAX_EFFECTS_PER_EVENT {
                        return Err(ProceduralViolation(format!(
                            "Scene behavior '{behavior_key}' emitted too many effects."
                        )));
                    }
                    self.apply_all(effects, cat, cues)?;
                }
            }
        }
        for cue in emitted {
            cues.push(PresentationCue::Mechanic { cue });
        }
        Ok(())
    }

    // ---- relocation & the move action ----

    /// The bare relocation shared by `move_to` and the Villain's `Teleport` card
    /// effect: exit-phase scenes of the departed room (mover still an occupant) →
    /// occupancy swap → enter-phase scenes of the destination → visibility cue
    /// when the destination is dark. No budget tick, no history, no spawn/codex
    /// tail — callers layer those on.
    pub(crate) fn relocate(
        &mut self,
        actor: &CharacterId,
        room: &RoomId,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
        // Exit old room — fire exit-phase scenes first (mover still an occupant),
        // then retain all occupants that are not the actor. Mirrors
        // `Room.exitRoom` (play "exit" scenes → delete occupant).
        if let Some(prev) = self
            .characters
            .get(actor)
            .and_then(|c| c.current_room_id.clone())
        {
            self.fire_scenes(&prev, "exit", actor, cat, cues)?;
            if let Some(r) = self.rooms.get_mut(&prev) {
                r.occupant_ids.retain(|id| id != actor);
            }
        }

        // Enter new room.
        if let Some(c) = self.characters.get_mut(actor) {
            c.current_room_id = Some(room.clone());
        }
        if let Some(r) = self.rooms.get_mut(room) {
            if !r.occupant_ids.contains(actor) {
                r.occupant_ids.push(actor.clone());
            }
        }

        // Fire enter-phase scenes now that the actor is an occupant of `room`,
        // BEFORE the visibility cue. Mirrors `Room.enterRoom` (add occupant →
        // play "enter" scenes) inside `#enterRoom`, which runs before `move`'s
        // visibility cue.
        self.fire_scenes(room, "enter", actor, cat, cues)?;

        // Visibility cue when the destination is dark (mirrors `move`:1021-1027).
        if !self.is_lit(room, cat) {
            let name = self
                .rooms
                .get(room)
                .map(|r| r.name.clone())
                .unwrap_or_default();
            cues.push(PresentationCue::Visibility {
                room: EntityRef {
                    id: room.0.clone(),
                    name,
                },
                lit: false,
            });
        }
        Ok(())
    }

    /// Move `actor` to `room`, updating occupancy in both rooms, emitting a
    /// visibility cue if the destination is dark, then recording the action
    /// (budget tick + history + action cue). Mirrors `Character.move`
    /// and `Character.#enterRoom`.
    ///
    /// Occupancy is a `Vec`: exit via `retain`, enter via `push` (guards against
    /// duplicates). Insertion order matches TS.
    pub fn move_to(
        &mut self,
        actor: &CharacterId,
        room: &RoomId,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
        self.relocate(actor, room, cat, cues)?;

        // After a successful move: maybe_spawn (encounter table visited) and the
        // room codex record. Both apply only to player characters.
        let is_player = self
            .characters
            .get(actor)
            .is_some_and(|c| matches!(c.kind, crate::world::snapshot::CharacterKind::Player));

        // record_action(move): tick budget, append history, emit action cue.
        // Budget tick mirrors `recordAction`: `actions_this_round += 1`.
        // The `record_action` call below also conditionally ends the turn (reconcile)
        // once the budget is exhausted, mirroring `recordAction` → `endTurn()`.
        let round = self.campaign.round;
        let room_name = self
            .rooms
            .get(room)
            .map(|r| r.name.clone())
            .unwrap_or_default();
        if let Some(c) = self.characters.get_mut(actor) {
            c.history.push(ActionHistoryEntry::Move {
                round,
                room: RoomRef {
                    id: room.clone(),
                    name: room_name.clone(),
                },
            });
        }
        // Action cue — emitted after the history push, matching TS order.
        cues.push(PresentationCue::Action {
            action: ActionKind::Move,
            actor: self.entity_ref_char(actor),
            sound: None,
        });
        // record_action (budget tick + cap-triggered endTurn/reconcile) runs BEFORE
        // the encounter cues: `PlayerCharacter.move`
        // calls `super.move(room)` — which runs `recordAction` to completion, including
        // any `endTurn`/reconcile — THEN emits NOTE_ENCOUNTERS.
        self.record_action(
            actor,
            true,
            &crate::world::mechanics::ActionView {
                kind: "move".into(),
                room: Some(RoomRef {
                    id: room.clone(),
                    name: room_name.clone(),
                }),
            },
            cat,
            cues,
        )?;

        // PlayerCharacter.move tail, AFTER super.move's
        // recordAction: maybeSpawn → NOTE_ENCOUNTERS → room codex. Spawned mobs land
        // before the occupant scan; spawn rng falls after any turn-end rng.
        if is_player {
            // maybeSpawn: roll/select/build/place (marks visited; fires enter-scenes silently).
            self.maybe_spawn(room, cat)?;

            // NOTE_ENCOUNTERS: scan occupants (now incl. spawned), skip party/KO, dedup on
            // "{actor}:{occ}" in campaign.encountered; record mob codex; stage encounter cues.
            let party: BTreeSet<CharacterId> = self.campaign.party_ids.iter().cloned().collect();
            let occupants: Vec<CharacterId> = self
                .rooms
                .get(room)
                .map(|r| r.occupant_ids.clone())
                .unwrap_or_default();
            let mut encounter_refs: Vec<EntityRef> = Vec::new();
            for occ in occupants {
                if party.contains(&occ) {
                    continue;
                }
                if self.is_ko(&occ) {
                    continue;
                }
                let key = format!("{}:{}", actor.0, occ.0);
                if self.campaign.encountered.iter().any(|k| k == &key) {
                    continue;
                }
                self.campaign.encountered.push(key);
                let (name, stats) = self
                    .characters
                    .get(&occ)
                    .map(|c| {
                        (
                            c.name.clone(),
                            (c.stats.health, c.stats.sanity, c.stats.energy),
                        )
                    })
                    .unwrap_or_default();
                self.record_codex(
                    "mob", &name,
                    &serde_json::json!({ "name": name, "stats": { "health": stats.0, "sanity": stats.1, "energy": stats.2 } }),
                    Some(&actor.0), Some(&room.0),
                );
                encounter_refs.push(self.entity_ref_char(&occ));
            }

            // RECORD_ENCOUNTER({kind:"room"}): first-write-wins room codex entry.
            let room_id_str = room.0.clone();
            let already_in_codex = self.codex.as_array().is_some_and(|arr| {
                arr.iter().any(|e| {
                    e.get("kind").and_then(|v| v.as_str()) == Some("room")
                        && e.get("key").and_then(|v| v.as_str()) == Some(&room_id_str)
                })
            });
            if !already_in_codex {
                let (room_name_str, room_desc) = self
                    .rooms
                    .get(room)
                    .map(|r| (r.name.clone(), r.description.clone()))
                    .unwrap_or_default();
                let entry = serde_json::json!({
                    "kind": "room", "key": room_id_str,
                    "snapshot": { "name": room_name_str, "description": room_desc },
                    "firstSeen": { "round": self.campaign.round, "characterId": actor.0.clone(), "roomId": room_id_str }
                });
                if let Some(arr) = self.codex.as_array_mut() {
                    arr.push(entry);
                }
            }

            // Encounter cues last (after the move action cue AND any turn-end cues).
            for r in encounter_refs {
                cues.push(PresentationCue::Encounter {
                    mob: r,
                    room: EntityRef {
                        id: room.0.clone(),
                        name: room_name.clone(),
                    },
                    sound: None,
                });
            }
        }
        Ok(())
    }
}

/// Whether `exit`'s keyed behavior blocks `actor_view`: `None` for a behavior-free exit, an
/// unresolvable key (load-time `validate_mechanics` guards against those), or a passable keyed
/// exit; the behavior's `fail_message` (or a default) otherwise. Pure — never runs
/// `run_script` or mutates door state. The shared core of
/// [`World::exit_block_reason`] and [`World::move_block_reason`].
fn keyed_exit_blocks(
    exit: &crate::world::snapshot::ExitSnapshot,
    actor_view: &crate::world::mechanics::view::CharacterView,
    cat: &Catalog,
) -> Option<alloc::string::String> {
    let key = exit.behavior_key.as_deref()?;
    let resolved = crate::world::exits::resolve_exit_behavior(key, cat)?;
    let behavior = resolved.as_behavior();
    if behavior.can_pass(actor_view, &exit.state) {
        None
    } else {
        Some(
            behavior
                .fail_message()
                .unwrap_or("The way is blocked.")
                .into(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::presentation::{ActionKind, EntityRef, PresentationCue};
    use crate::world::history::ActionHistoryEntry;
    use crate::world::ids::{CharacterId, RoomId};
    use crate::world::test_support::item_desc;
    use crate::world::test_support::world_two_rooms;
    use crate::world::test_support::{cid, rid};

    /// Insert a minimal live Mob character `name` (id == name) into `room`, and push
    /// its id into that room's `occupant_ids`. Mirrors the CharacterSnapshot pattern
    /// used in `test_support.rs` for player characters.
    fn seat_mob(w: &mut crate::world::World, name: &str, room: &str) {
        use crate::world::afflictions::Afflictions;
        use crate::world::snapshot::{CharacterKind, CharacterSnapshot, InventorySnapshot, Stats};
        use alloc::collections::BTreeMap;
        let id = CharacterId(name.into());
        let room_id = RoomId(room.into());
        let snap = CharacterSnapshot {
            kind: CharacterKind::Mob,
            id: id.clone(),
            name: name.into(),
            stats: Stats {
                health: 4.0,
                sanity: 0.0,
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
            npc_behavior_key: None,
            npc_state: serde_json::Value::Null,
            visible: true,
        };
        w.characters.insert(id.clone(), snap);
        if let Some(r) = w.rooms.get_mut(&room_id) {
            if !r.occupant_ids.contains(&id) {
                r.occupant_ids.push(id);
            }
        }
    }

    /// Attach a scene to `room` under `key`/`phase` with the given initial state.
    fn attach_named_scene(
        w: &mut crate::world::World,
        room: &str,
        key: &str,
        phase: &str,
        state: serde_json::Value,
    ) {
        w.rooms
            .get_mut(&rid(room))
            .unwrap()
            .scenes
            .push(crate::world::snapshot::SceneSnapshot {
                id: "scene".into(),
                behavior_key: key.into(),
                phase: phase.into(),
                state,
            });
    }

    fn mcue(text: &str) -> PresentationCue {
        PresentationCue::Mechanic {
            cue: crate::presentation::MechanicCue {
                text: Some(text.into()),
                sound: None,
            },
        }
    }

    #[test]
    fn scripted_scene_enter_emits_cue_and_hides_target() {
        let mut w = world_two_rooms(/*next_dark=*/ false);
        seat_mob(&mut w, "ghost", "start"); // a target to hide
        attach_named_scene(
            &mut w,
            "start",
            "scenes/ambush",
            "enter",
            serde_json::json!({}),
        );
        let cat: Catalog = serde_json::from_value(serde_json::json!({
            "items": {}, "aliases": {},
            "behaviors": { "scenes/ambush": {
                "family": "scene",
                "script": { "onEnter": [
                    { "kind": "emit", "effect": { "kind": "cue",
                        "text": { "kind": "lit", "value": "A cold wind stirs." } } },
                    { "kind": "emit", "effect": { "kind": "setVisible",
                        "target": { "kind": "lit", "value": "ghost" },
                        "visible": { "kind": "lit", "value": false } } }
                ] }
            } }
        }))
        .unwrap();
        let mut cues = Vec::new();
        w.fire_scenes(&rid("start"), "enter", &cid("pc"), &cat, &mut cues)
            .unwrap();
        // cue surfaced AND target hidden — both effects applied in order.
        assert_eq!(cues, alloc::vec![mcue("A cold wind stirs.")]);
        assert!(!w.characters[&cid("ghost")].visible);
    }

    #[test]
    fn scripted_scene_can_play_false_is_skipped() {
        let mut w = world_two_rooms(false);
        attach_named_scene(
            &mut w,
            "start",
            "scenes/quiet",
            "enter",
            serde_json::json!({}),
        );
        let cat: Catalog = serde_json::from_value(serde_json::json!({
            "items": {}, "aliases": {},
            "behaviors": { "scenes/quiet": {
                "family": "scene",
                "script": {
                    "canPlay": { "kind": "lit", "value": false },
                    "onEnter": [
                        { "kind": "emit", "effect": { "kind": "cue",
                            "text": { "kind": "lit", "value": "nope" } } },
                        { "kind": "setState", "field": "fired",
                            "value": { "kind": "lit", "value": true } }
                    ]
                }
            } }
        }))
        .unwrap();
        let mut cues = Vec::new();
        w.fire_scenes(&rid("start"), "enter", &cid("pc"), &cat, &mut cues)
            .unwrap();
        // Skipped: no cue emitted and the body's setState never ran.
        assert!(cues.is_empty());
        assert_eq!(
            w.rooms[&rid("start")].scenes[0].state,
            serde_json::json!({})
        );
    }

    #[test]
    fn scripted_scene_setstate_persists_across_fires() {
        let mut w = world_two_rooms(false);
        attach_named_scene(
            &mut w,
            "start",
            "scenes/counter",
            "enter",
            serde_json::json!({}),
        );
        let cat: Catalog = serde_json::from_value(serde_json::json!({
            "items": {}, "aliases": {},
            "behaviors": { "scenes/counter": {
                "family": "scene",
                "script": { "onEnter": [ { "kind": "setState", "field": "count",
                    "value": { "kind": "bin", "op": "add",
                        "left": { "kind": "stateGet", "field": "count", "default": 0 },
                        "right": { "kind": "lit", "value": 1 } } } ] }
            } }
        }))
        .unwrap();
        let mut cues = Vec::new();
        w.fire_scenes(&rid("start"), "enter", &cid("pc"), &cat, &mut cues)
            .unwrap();
        assert_eq!(
            w.rooms[&rid("start")].scenes[0].state["count"],
            serde_json::json!(1.0)
        );
        w.fire_scenes(&rid("start"), "enter", &cid("pc"), &cat, &mut cues)
            .unwrap();
        assert_eq!(
            w.rooms[&rid("start")].scenes[0].state["count"],
            serde_json::json!(2.0)
        );
    }

    #[test]
    fn native_visit_counter_scene_still_fires_unchanged() {
        let mut w = world_two_rooms(false);
        attach_named_scene(
            &mut w,
            "start",
            "conformance:visit-counter",
            "enter",
            serde_json::json!({ "count": 0 }),
        );
        let cat = Catalog::default();
        let mut cues = Vec::new();
        w.fire_scenes(&rid("start"), "enter", &cid("pc"), &cat, &mut cues)
            .unwrap();
        assert_eq!(cues, alloc::vec![mcue("The Start stirs (visit 1).")]);
        assert_eq!(
            w.rooms[&rid("start")].scenes[0].state["count"],
            serde_json::json!(1)
        );
        // Firing again advances the native counter — byte-identical to the old path.
        let mut cues2 = Vec::new();
        w.fire_scenes(&rid("start"), "enter", &cid("pc"), &cat, &mut cues2)
            .unwrap();
        assert_eq!(cues2, alloc::vec![mcue("The Start stirs (visit 2).")]);
    }

    #[test]
    fn go_over_behavior_free_exit_moves_updates_occupancy_and_emits_action_cue() {
        let mut w = world_two_rooms(/*next_dark=*/ false);
        let mut cues = Vec::new();
        w.go(&cid("pc"), Direction::North, &Catalog::default(), &mut cues)
            .unwrap();
        assert_eq!(w.characters[&cid("pc")].current_room_id, Some(rid("next")));
        assert!(!w.rooms[&rid("start")].occupant_ids.contains(&cid("pc")));
        assert!(w.rooms[&rid("next")].occupant_ids.contains(&cid("pc")));
        assert_eq!(w.characters[&cid("pc")].actions_this_round, 1);
        assert_eq!(
            cues,
            vec![PresentationCue::Action {
                action: ActionKind::Move,
                actor: EntityRef {
                    id: "pc".into(),
                    name: "Heir".into()
                },
                sound: None
            }]
        );
        // history append — pin exact round and room
        assert_eq!(
            w.characters[&cid("pc")].history.last(),
            Some(&ActionHistoryEntry::Move {
                round: 0,
                room: RoomRef {
                    id: rid("next"),
                    name: "Next".into()
                },
            })
        );
    }

    #[test]
    fn entering_a_dark_room_emits_visibility_lit_false() {
        let mut w = world_two_rooms(/*next_dark=*/ true);
        let mut cues = Vec::new();
        w.go(&cid("pc"), Direction::North, &Catalog::default(), &mut cues)
            .unwrap();
        assert_eq!(
            cues,
            vec![
                PresentationCue::Visibility {
                    room: EntityRef {
                        id: "next".into(),
                        name: "Next".into()
                    },
                    lit: false,
                },
                PresentationCue::Action {
                    action: ActionKind::Move,
                    actor: EntityRef {
                        id: "pc".into(),
                        name: "Heir".into()
                    },
                    sound: None,
                },
            ]
        );
    }

    #[test]
    fn go_at_a_wall_emits_cant_go_that_way_and_does_not_move_or_tick_budget() {
        let mut w = world_two_rooms(false);
        let mut cues = Vec::new();
        w.go(&cid("pc"), Direction::East, &Catalog::default(), &mut cues)
            .unwrap();
        assert_eq!(w.characters[&cid("pc")].current_room_id, Some(rid("start")));
        assert_eq!(w.characters[&cid("pc")].actions_this_round, 0);
        assert_eq!(
            cues,
            vec![PresentationCue::Mechanic {
                cue: crate::presentation::MechanicCue {
                    text: Some("You can't go that way.".into()),
                    sound: None
                }
            }]
        );
    }

    #[test]
    fn is_lit_truth_table() {
        let w = world_two_rooms(true);
        let cat = Catalog::default();
        assert!(w.is_lit(&rid("start"), &cat)); // not dark
        assert!(!w.is_lit(&rid("next"), &cat)); // dark, no light sources
    }

    /// Build an Accessory descriptor that (maybe) emits light and (maybe) has a
    /// max durability — enough to drive `character_has_light` / `is_lit`.
    fn lantern_desc(
        emits: Option<bool>,
        max_dur: Option<i64>,
    ) -> crate::world::descriptor::ItemDescriptor {
        use crate::world::descriptor::{ItemDescriptor, ItemProperties, ItemType, SlotKind};
        ItemDescriptor {
            properties: ItemProperties {
                equippable: true,
                equipped: true,
                destroyable: false,
                usable: false,
                droppable: None,
            },
            slot: Some(SlotKind::Hand),
            emits_light: emits,
            max_durability: max_dur,
            recipe: serde_json::Value::Null,
            teaches: serde_json::Value::Null,
            immunities: serde_json::Value::Null,
            grants_immunity: serde_json::Value::Null,
            ..item_desc(
                "Brass Lantern",
                ItemType::Accessory,
                crate::stats::StatType::Sanity,
                0,
            )
        }
    }

    /// A dark room is lit by an occupant's equipped, non-broken, light-emitting
    /// hand item — and NOT lit if that item is broken or does not emit light.
    /// Mirrors `isLit` → `hasLight` (occupant path).
    #[test]
    fn dark_room_lit_by_occupant_equipped_lantern() {
        use crate::world::descriptor::Catalog;
        use crate::world::ids::ItemId;
        use crate::world::snapshot::ItemSnapshot;

        let mut w = world_two_rooms(/*next_dark=*/ true);
        // Seat the pc as an occupant of the dark "next" room.
        if let Some(r) = w.rooms.get_mut(&rid("next")) {
            r.occupant_ids.push(cid("pc"));
        }
        let mut cat = Catalog::default();
        cat.items
            .insert("lantern".into(), lantern_desc(Some(true), None));

        // No equipped light yet → dark room stays unlit.
        assert!(!w.character_has_light(&cid("pc"), &cat));
        assert!(!w.is_lit(&rid("next"), &cat));

        // Equip a non-broken lantern in the left hand → room is now lit.
        let item_id = ItemId("lantern-1".into());
        w.items.insert(
            item_id.clone(),
            ItemSnapshot::Item {
                id: item_id.clone(),
                behavior_key: "lantern".into(),
                durability: None,
                modifier: 0,
            },
        );
        w.characters
            .get_mut(&cid("pc"))
            .unwrap()
            .equipment
            .insert("leftHand".into(), item_id.clone());
        assert!(w.character_has_light(&cid("pc"), &cat));
        assert!(w.is_lit(&rid("next"), &cat));

        // Broken lantern (maxDurability set + durability 0) → not a light.
        cat.items
            .insert("lantern".into(), lantern_desc(Some(true), Some(3)));
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

        let mut w = world_two_rooms(/*next_dark=*/ true);
        let mut cat = Catalog::default();
        cat.items
            .insert("torch".into(), lantern_desc(Some(true), Some(2)));

        let item_id = ItemId("torch-1".into());
        w.items.insert(
            item_id.clone(),
            ItemSnapshot::Item {
                id: item_id.clone(),
                behavior_key: "torch".into(),
                durability: Some(0),
                modifier: 0,
            },
        );
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
        let mut w = world_two_rooms(/*next_dark=*/ false);
        // Seat a live mob "grue" in the destination room "next".
        seat_mob(&mut w, "grue", "next");
        let mut cues = Vec::new();
        w.go(&cid("pc"), Direction::North, &Catalog::default(), &mut cues)
            .unwrap();
        // encounter cue present, after the move action cue
        let move_idx = cues
            .iter()
            .position(|c| {
                matches!(
                    c,
                    PresentationCue::Action {
                        action: ActionKind::Move,
                        ..
                    }
                )
            })
            .unwrap();
        let enc_idx = cues
            .iter()
            .position(|c| matches!(c, PresentationCue::Encounter { .. }))
            .unwrap();
        assert!(
            enc_idx > move_idx,
            "encounter cue comes after the move action cue"
        );
        match &cues[enc_idx] {
            PresentationCue::Encounter {
                mob,
                room,
                sound: None,
            } => {
                assert_eq!(mob.id, "grue");
                assert_eq!(room.id, "next");
            }
            other => panic!("expected Encounter cue, got {:?}", other),
        }
        // codex: mob record for grue exists AND precedes the room record for "next"
        let codex = w.codex.as_array().unwrap();
        let mob_idx = codex
            .iter()
            .position(|e| {
                e["kind"] == serde_json::json!("mob") && e["key"] == serde_json::json!("grue")
            })
            .unwrap();
        let room_idx = codex
            .iter()
            .position(|e| {
                e["kind"] == serde_json::json!("room") && e["key"] == serde_json::json!("next")
            })
            .unwrap();
        assert!(
            mob_idx < room_idx,
            "mob codex record precedes the room codex record"
        );
        // dedup: the composite key `${mover}:${occupant}` is recorded
        assert!(
            w.campaign.encountered.iter().any(|k| k == "pc:grue"),
            "encountered key recorded for dedup"
        );
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
        if let Some(r) = w.rooms.get_mut(&rid("next")) {
            r.spawn_modifier = 1;
        }
        let mut cues = Vec::new();
        w.go(&cid("pc"), Direction::North, &Catalog::default(), &mut cues)
            .unwrap();

        // wraith spawned into "next"
        let wid = CharacterId("campaign-mob:wraith".into());
        assert_eq!(w.characters[&wid].current_room_id, Some(rid("next")));
        assert!(w.rooms[&rid("next")].occupant_ids.contains(&wid));

        // encounter cue for the wraith comes AFTER the move action cue
        let mv = cues
            .iter()
            .position(|c| {
                matches!(
                    c,
                    PresentationCue::Action {
                        action: ActionKind::Move,
                        ..
                    }
                )
            })
            .unwrap();
        let enc = cues.iter().position(|c| matches!(c, PresentationCue::Encounter { mob, .. } if mob.id == "campaign-mob:wraith")).unwrap();
        assert!(
            enc > mv,
            "spawned-mob encounter cue comes after the move action cue"
        );
    }

    #[test]
    fn budgeted_go_at_cap_triggers_turn_end_reconcile() {
        use crate::world::afflictions::Status;
        use crate::world::descriptor::Catalog;
        let mut w = world_two_rooms(false);
        let mut cues = Vec::new();
        if let Some(c) = w.characters.get_mut(&cid("pc")) {
            c.actions_per_round = 1; // next action exhausts the budget
            c.stats.health = -3.0; // reconcile floors this iff turn-end runs
        }
        w.go(&cid("pc"), Direction::North, &Catalog::default(), &mut cues)
            .unwrap();
        let ch = w.characters.get(&cid("pc")).unwrap();
        assert_eq!(ch.actions_this_round, 1);
        assert_eq!(
            ch.stats.health, 0.0,
            "cap-reaching move auto-ends turn -> reconcile floored base"
        );
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
        for ex in w.exits.values_mut() {
            if ex.behavior_key.is_some() {
                ex.state = serde_json::json!({ "unlocked": false });
            }
        }
        let start_room = w.characters[&cid("pc")].current_room_id.clone();
        let mut cues = Vec::new();
        w.go(&cid("pc"), Direction::North, &Catalog::default(), &mut cues)
            .unwrap();
        // did not move
        assert_eq!(w.characters[&cid("pc")].current_room_id, start_room);
        // fail message emitted
        assert!(cues.iter().any(|c| matches!(c,
            PresentationCue::Mechanic { cue } if cue.text.as_deref() == Some("The door is locked."))));
    }

    #[test]
    fn exit_block_reason_reports_locked_doors_and_clears_with_the_key() {
        use crate::world::descriptor::Catalog;
        let mut w = world_two_rooms(false);
        w.make_north_exit_keyed("conformance:keyed-door");
        for ex in w.exits.values_mut() {
            if ex.behavior_key.is_some() {
                ex.state = serde_json::json!({ "unlocked": false });
            }
        }
        // Locked without the key → the behavior's fail message.
        assert_eq!(
            w.exit_block_reason(&cid("pc"), Direction::North, &Catalog::default())
                .as_deref(),
            Some("The door is locked.")
        );
        // With the key, `can_pass` is true → no block.
        seed_held_item(&mut w, "pc", "brass-key");
        assert_eq!(
            w.exit_block_reason(&cid("pc"), Direction::North, &Catalog::default()),
            None
        );
        // A pure query: the door state was never mutated (still locked; no run_script ran).
        assert!(
            w.exits
                .values()
                .all(|ex| ex.state.get("unlocked") == Some(&serde_json::json!(false))),
            "exit_block_reason must not mutate door state"
        );
    }

    #[test]
    fn move_block_reason_bars_a_locked_door_and_clears_with_the_key() {
        use crate::world::descriptor::Catalog;
        let mut w = world_two_rooms(false);
        w.make_north_exit_keyed("conformance:keyed-door");
        for ex in w.exits.values_mut() {
            if ex.behavior_key.is_some() {
                ex.state = serde_json::json!({ "unlocked": false });
            }
        }
        // Locked without the key → the behavior's fail message, resolved by room id alone.
        assert_eq!(
            w.move_block_reason(&cid("pc"), &rid("next"), &Catalog::default())
                .as_deref(),
            Some("The door is locked.")
        );
        // With the key, `can_pass` holds → no block.
        seed_held_item(&mut w, "pc", "brass-key");
        assert_eq!(
            w.move_block_reason(&cid("pc"), &rid("next"), &Catalog::default()),
            None
        );
        // A pure query: door state never mutated (still locked; no run_script ran).
        assert!(
            w.exits
                .values()
                .all(|ex| ex.state.get("unlocked") == Some(&serde_json::json!(false))),
            "move_block_reason must not mutate door state"
        );
    }

    #[test]
    fn move_block_reason_passes_behavior_free_unconnected_and_same_room_moves() {
        let w = world_two_rooms(false);
        let cat = Catalog::default();
        // A behavior-free connecting exit → passable.
        assert_eq!(w.move_block_reason(&cid("pc"), &rid("next"), &cat), None);
        // No exit connects the rooms → not this check's concern (move_to's posture).
        assert_eq!(w.move_block_reason(&cid("pc"), &rid("nowhere"), &cat), None);
        // A same-room "move" → no check.
        assert_eq!(w.move_block_reason(&cid("pc"), &rid("start"), &cat), None);
    }

    #[test]
    fn keyed_exit_with_key_unlocks_moves_and_persists_state() {
        use crate::world::descriptor::Catalog;
        let mut w = world_two_rooms(false);
        w.make_north_exit_keyed("conformance:keyed-door");
        for ex in w.exits.values_mut() {
            if ex.behavior_key.is_some() {
                ex.state = serde_json::json!({ "unlocked": false });
            }
        }
        seed_held_item(&mut w, "pc", "brass-key"); // helper: item with behavior_key "brass-key" in pc inventory
        let start_room = w.characters[&cid("pc")].current_room_id.clone();
        let mut cues = Vec::new();
        w.go(&cid("pc"), Direction::North, &Catalog::default(), &mut cues)
            .unwrap();
        // moved to the far room
        assert_ne!(w.characters[&cid("pc")].current_room_id, start_room);
        // unlock narration emitted
        assert!(
            cues.iter().any(|c| matches!(c,
            PresentationCue::Mechanic { cue } if cue.text.as_deref() == Some("The door unlocks.")))
        );
        // state persisted
        assert!(w
            .exits
            .values()
            .any(|ex| ex.state.get("unlocked") == Some(&serde_json::json!(true))));
    }

    #[test]
    fn keyed_exit_unregistered_key_errors() {
        use crate::world::descriptor::Catalog;
        let mut w = world_two_rooms(false);
        w.make_north_exit_keyed("nope:not-registered");
        let mut cues = Vec::new();
        assert!(w
            .go(&cid("pc"), Direction::North, &Catalog::default(), &mut cues)
            .is_err());
    }

    /// Put a true Key (kind:"key") with `key_code` into `char_id`'s keyring.
    fn seed_held_key(w: &mut crate::world::World, char_id: &str, key_code: &str) {
        use crate::world::snapshot::ItemSnapshot;
        let item_id = crate::world::ids::ItemId(alloc::format!("key-{key_code}"));
        w.items.insert(
            item_id.clone(),
            ItemSnapshot::Key {
                id: item_id.clone(),
                name: alloc::format!("{key_code} key"),
                key_code: key_code.into(),
                consume_on_use: false,
            },
        );
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
            if ex.behavior_key.is_some() {
                ex.state = serde_json::json!({ "unlocked": false });
            }
        }
        let start_room = w.characters[&cid("pc")].current_room_id.clone();
        let mut cues = Vec::new();

        // 1. keyless: blocked, fail cue, no move
        w.go(&cid("pc"), Direction::North, &cat, &mut cues).unwrap();
        assert_eq!(w.characters[&cid("pc")].current_room_id, start_room);
        assert!(cues
            .iter()
            .any(|c| matches!(c, PresentationCue::Mechanic { cue }
            if cue.text.as_deref() == Some("The study door won't budge — it's locked."))));

        // 2. with the brass key: unlock narration + move + persisted state
        seed_held_key(&mut w, "pc", "brass");
        let mut cues = Vec::new();
        w.go(&cid("pc"), Direction::North, &cat, &mut cues).unwrap();
        assert_ne!(w.characters[&cid("pc")].current_room_id, start_room);
        assert!(cues
            .iter()
            .any(|c| matches!(c, PresentationCue::Mechanic { cue }
            if cue.text.as_deref() == Some("The door unlocks."))));
        assert!(w
            .exits
            .values()
            .any(|ex| ex.state.get("unlocked") == Some(&serde_json::json!(true))));

        // 3. re-pass back through the unlocked door: silent (no mechanic cue)
        let mut cues = Vec::new();
        w.go(&cid("pc"), Direction::South, &cat, &mut cues).unwrap();
        assert!(
            !cues
                .iter()
                .any(|c| matches!(c, PresentationCue::Mechanic { .. })),
            "unlocked re-pass must be silent"
        );
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
        let mut w = world_two_rooms(/*next_dark=*/ true); // dark → a visibility cue follows
        attach_scene(&mut w, "next", "enter", 0);
        let mut cues = Vec::new();
        w.go(&cid("pc"), Direction::North, &Catalog::default(), &mut cues)
            .unwrap();

        // scene mutated its own state (count 0 → 1), mover was an occupant when it fired
        let scene = &w.rooms[&rid("next")].scenes[0];
        assert_eq!(scene.state["count"], serde_json::json!(1));

        // cue order: scene mechanic cue BEFORE the visibility cue BEFORE the move action cue
        let mech = cues.iter().position(|c| matches!(c,
            PresentationCue::Mechanic { cue } if cue.text.as_deref() == Some("The Next stirs (visit 1)."))).unwrap();
        let vis = cues
            .iter()
            .position(|c| matches!(c, PresentationCue::Visibility { .. }))
            .unwrap();
        let mv = cues
            .iter()
            .position(|c| {
                matches!(
                    c,
                    PresentationCue::Action {
                        action: ActionKind::Move,
                        ..
                    }
                )
            })
            .unwrap();
        assert!(
            mech < vis && vis < mv,
            "scene cue precedes visibility precedes move; got {cues:?}"
        );
    }

    #[test]
    fn exit_scene_fires_before_occupant_removal() {
        let mut w = world_two_rooms(false);
        attach_scene(&mut w, "start", "exit", 0);
        let mut cues = Vec::new();
        w.go(&cid("pc"), Direction::North, &Catalog::default(), &mut cues)
            .unwrap();
        // exit scene on the departed room fired (count 0 → 1)
        assert_eq!(
            w.rooms[&rid("start")].scenes[0].state["count"],
            serde_json::json!(1)
        );
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
        w.go(&cid("pc"), Direction::North, &Catalog::default(), &mut cues)
            .unwrap();
        let exit_idx = cues.iter().position(|c| matches!(c,
            PresentationCue::Mechanic { cue } if cue.text.as_deref() == Some("The Start stirs (visit 1)."))).unwrap();
        let enter_idx = cues.iter().position(|c| matches!(c,
            PresentationCue::Mechanic { cue } if cue.text.as_deref() == Some("The Next stirs (visit 1)."))).unwrap();
        assert!(
            exit_idx < enter_idx,
            "old-room exit-scene cue precedes new-room enter-scene cue"
        );
    }

    #[test]
    fn scene_precondition_cap_stops_firing() {
        let mut w = world_two_rooms(false);
        attach_scene(&mut w, "next", "enter", 3); // already at the cap
        let mut cues = Vec::new();
        w.go(&cid("pc"), Direction::North, &Catalog::default(), &mut cues)
            .unwrap();
        // no mutation, no scene cue
        assert_eq!(
            w.rooms[&rid("next")].scenes[0].state["count"],
            serde_json::json!(3)
        );
        assert!(!cues.iter().any(|c| matches!(c,
            PresentationCue::Mechanic { cue } if cue.text.as_deref().is_some_and(|t| t.contains("stirs")))));
    }

    #[test]
    fn unregistered_scene_behavior_key_errors() {
        let mut w = world_two_rooms(false);
        if let Some(r) = w.rooms.get_mut(&rid("next")) {
            r.scenes.push(crate::world::snapshot::SceneSnapshot {
                id: "bad".into(),
                behavior_key: "nope:unregistered".into(),
                phase: "enter".into(),
                state: serde_json::json!({}),
            });
        }
        let mut cues = Vec::new();
        assert!(w
            .go(&cid("pc"), Direction::North, &Catalog::default(), &mut cues)
            .is_err());
    }
}
