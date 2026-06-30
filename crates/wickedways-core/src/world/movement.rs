//! Movement primitives: `go` (direction-based) and `move_to` (room-id-based).
//! Mirrors `src/lib/character/character.ts` `go` (:1047-1063) and `move`/`#enterRoom`
//! (:1018-1032) plus `src/lib/room.ts` `isLit` (:113-211).
//!
//! Scenes are NOT fired (deferred to sub-plan 6). Keyed exits are OUT OF SCOPE
//! and return `Err(ProceduralViolation)` until the registry lands in sub-plan 6.
use alloc::vec::Vec;
use crate::error::ProceduralViolation;
use crate::presentation::{ActionKind, EntityRef, MechanicCue, PresentationCue};
use crate::world::direction::Direction;
use crate::world::history::{ActionHistoryEntry, RoomRef};
use crate::world::ids::{CharacterId, RoomId};
use crate::world::World;

impl World {
    /// A room is lit if it is not dark, or if it has at least one placed light
    /// source. Broken-state and occupant-carried light fold in with item
    /// behavior in sub-plan 3 — the corpus has empty `light_source_ids` for dark
    /// rooms, so this predicate is sufficient for Phase 1.
    pub fn is_lit(&self, room: &RoomId) -> bool {
        let Some(r) = self.rooms.get(room) else { return true };
        if !r.dark { return true; }
        // TODO(sub-plan 3): also require !light.broken per source, plus occupant-carried light (occupant.has_light)
        !r.light_source_ids.is_empty()
    }

    /// Build an `EntityRef` for a character — safe to call even if the character
    /// has already been mutated (uses current snapshot state).
    fn entity_ref_char(&self, id: &CharacterId) -> EntityRef {
        let name = self.characters.get(id).map(|c| c.name.clone()).unwrap_or_default();
        EntityRef { id: id.0.clone(), name }
    }

    /// Evaluate the exit in `dir` from the actor's current room, then call
    /// `move_to`. Mirrors TS `Character.go` (:1047-1063).
    ///
    /// - No exit in that direction → emits "You can't go that way." mechanic cue,
    ///   returns `Ok(())`, does NOT tick the budget.
    /// - Behavior-keyed exit → `Err(ProceduralViolation)` (registry deferred to sub-plan 6).
    /// - Behavior-free exit → delegates to `move_to`.
    pub fn go(
        &mut self,
        actor: &CharacterId,
        dir: Direction,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
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

        // A behavior-keyed exit needs the registry (sub-plan 6) to evaluate canPass.
        if exit.behavior_key.is_some() {
            return Err(ProceduralViolation(
                "keyed-exit traversal is out of scope until sub-plan 6".into(),
            ));
        }

        // Behavior-free exit: always passable; determine the far endpoint.
        // `endpoint_ids` is [RoomId; 2] — use index syntax, not tuple syntax.
        let a = exit.endpoint_ids[0].clone();
        let b = exit.endpoint_ids[1].clone();
        let dest = if a == here { b } else { a };

        self.move_to(actor, dest, cues)
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
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
        // Exit old room — retain all occupants that are not the actor.
        // Scene exit firing is deferred to sub-plan 6.
        if let Some(prev) =
            self.characters.get(actor).and_then(|c| c.current_room_id.clone())
        {
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

        // Visibility cue when the destination is dark (mirrors TS `move` :1021-1027).
        if !self.is_lit(&room) {
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

        // record_action(move): tick budget, append history, emit action cue.
        // Budget tick mirrors TS `recordAction` (:530-532): `actions_this_round += 1`.
        // `endTurn` is not modelled in sub-plan 2 — the conformance stream stays
        // within budget, and turn-ending lands in sub-plan 5.
        let round = self.campaign.round;
        let room_name = self
            .rooms
            .get(&room)
            .map(|r| r.name.clone())
            .unwrap_or_default();
        if let Some(c) = self.characters.get_mut(actor) {
            c.actions_this_round += 1;
            c.history.push(ActionHistoryEntry::Move {
                round,
                room: RoomRef { id: room.clone(), name: room_name },
            });
        }
        // Action cue — emitted after the history push, matching TS order.
        cues.push(PresentationCue::Action {
            action: ActionKind::Move,
            actor: self.entity_ref_char(actor),
            sound: None,
        });
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

    #[test]
    fn go_over_behavior_free_exit_moves_updates_occupancy_and_emits_action_cue() {
        let mut w = world_two_rooms(/*next_dark=*/false);
        let mut cues = Vec::new();
        w.go(&cid("pc"), Direction::North, &mut cues).unwrap();
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
        w.go(&cid("pc"), Direction::North, &mut cues).unwrap();
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
        w.go(&cid("pc"), Direction::East, &mut cues).unwrap();
        assert_eq!(w.characters[&cid("pc")].current_room_id, Some(rid("start")));
        assert_eq!(w.characters[&cid("pc")].actions_this_round, 0);
        assert_eq!(cues, vec![PresentationCue::Mechanic {
            cue: crate::presentation::MechanicCue {
                text: Some("You can't go that way.".into()), sound: None } }]);
    }

    #[test]
    fn go_through_a_keyed_exit_is_out_of_scope_and_errors() {
        let mut w = world_two_rooms(false);
        w.make_north_exit_keyed("study-door");
        let mut cues = Vec::new();
        assert!(w.go(&cid("pc"), Direction::North, &mut cues).is_err());
    }

    #[test]
    fn is_lit_truth_table() {
        let w = world_two_rooms(true);
        assert!(w.is_lit(&rid("start")));   // not dark
        assert!(!w.is_lit(&rid("next")));   // dark, no light sources
    }
}
