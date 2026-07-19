//! Seat ownership (Phase 2c, sub-project C — slice 1).
//!
//! Ports `packages/server/src/membership.ts` (the seat/GM map) plus `server.ts`'s `actorOf` helper.
//! This is **server-side protocol state** — not part of the campaign snapshot — so the server can
//! gate appends by seat ownership without reading opaque engine payloads. Seeded with the GM at room
//! creation; mutated by self-service join (self-claim) and GM control messages.

use wickedways_core::sync::Command;

use crate::store::MembershipState;
use crate::transport::Actor;

/// One campaign's seat-ownership map: which identity owns each character seat, plus the GM identity.
///
/// Seats are held in an **insertion-ordered** `Vec` rather than a sorted map so
/// [`seats`](Membership::seats)/[`to_state`](Membership::to_state) preserve claim order, matching
/// the TS `Map` the oracle serializes (assigning an already-owned seat updates it in place, keeping
/// its position — exactly `Map.set` semantics). Party sizes are tiny, so the linear scans are free.
pub struct Membership {
    gm_identity: String,
    seats: Vec<(String, String)>,
}

impl Membership {
    /// A fresh membership with `gm_identity` as GM and no seats claimed.
    pub fn new(gm_identity: impl Into<String>) -> Self {
        Self { gm_identity: gm_identity.into(), seats: Vec::new() }
    }

    /// The campaign's current GM identity.
    pub fn gm_identity(&self) -> &str {
        &self.gm_identity
    }

    /// The owner of a character seat, or `None` if unowned.
    pub fn owner_of(&self, character_id: &str) -> Option<&str> {
        self.seats.iter().find(|(c, _)| c == character_id).map(|(_, i)| i.as_str())
    }

    /// All seats as `[characterId, owner]` pairs, in claim order.
    pub fn seats(&self) -> &[(String, String)] {
        &self.seats
    }

    /// Whether `identity` may act as `actor`.
    pub fn may_act(&self, identity: &str, actor: &Actor) -> bool {
        match actor {
            Actor::Character { actor_id } => self.owner_of(actor_id) == Some(identity),
            Actor::Gm => identity == self.gm_identity,
            // self-claim: allowed only for an unowned seat (no hijack).
            Actor::Join { character_id } => self.owner_of(character_id).is_none(),
        }
    }

    // `claim` and `assign` are intentionally distinct despite identical bodies: `claim` =
    // self-service join (a player binds their own seat); `assign` = GM override (host reassigns any
    // seat). Keep them separate so semantic callers stay explicit — mirrors the TS note.

    /// Binds a newly-joined character to its claiming identity (self-service join).
    pub fn claim(&mut self, character_id: &str, identity: impl Into<String>) {
        self.set_seat(character_id, identity.into());
    }

    /// GM override: (re)assign a seat to an identity.
    pub fn assign(&mut self, character_id: &str, identity: impl Into<String>) {
        self.set_seat(character_id, identity.into());
    }

    /// GM override: free a seat.
    pub fn unassign(&mut self, character_id: &str) {
        self.seats.retain(|(c, _)| c != character_id);
    }

    /// GM override: hand the GM role to another identity.
    pub fn transfer_gm(&mut self, identity: impl Into<String>) {
        self.gm_identity = identity.into();
    }

    /// Serializes the GM identity + seat map for durable storage.
    pub fn to_state(&self) -> MembershipState {
        MembershipState { gm_identity: self.gm_identity.clone(), seats: self.seats.clone() }
    }

    /// Rebuilds a `Membership` from persisted state.
    pub fn from_state(state: MembershipState) -> Self {
        let mut m = Membership::new(state.gm_identity);
        for (character_id, identity) in state.seats {
            m.assign(&character_id, identity);
        }
        m
    }

    /// `Map.set` semantics: update an existing seat in place (keeping its position), else append.
    fn set_seat(&mut self, character_id: &str, identity: String) {
        if let Some(entry) = self.seats.iter_mut().find(|(c, _)| c == character_id) {
            entry.1 = identity;
        } else {
            self.seats.push((character_id.to_string(), identity));
        }
    }
}

/// Derives the seat an append acts as, read straight from the command (no client-supplied envelope
/// exists to forge). `join` self-claims the joining character's seat; a turn/setup command acts as
/// its `actorId` seat; everything else (GM / lifecycle / NPC) acts as the GM. Ports `server.ts`'s
/// `actorOf`.
pub fn actor_of(command: &Command) -> Actor {
    if let Command::JoinCampaign { character } = command {
        return Actor::Join { character_id: character.id.0.clone() };
    }
    match command.actor_id() {
        Some(id) => Actor::Character { actor_id: id.0.clone() },
        None => Actor::Gm,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn starts_with_only_the_gm_identity_and_no_seats() {
        let m = Membership::new("gm");
        assert_eq!(m.gm_identity(), "gm");
        assert!(m.seats().is_empty());
        assert_eq!(m.owner_of("c1"), None);
    }

    #[test]
    fn may_act_character_requires_owning_the_seat() {
        let mut m = Membership::new("gm");
        m.claim("c1", "ada");
        assert!(m.may_act("ada", &Actor::Character { actor_id: "c1".into() }));
        assert!(!m.may_act("ben", &Actor::Character { actor_id: "c1".into() }));
        // unowned seat
        assert!(!m.may_act("ada", &Actor::Character { actor_id: "cX".into() }));
    }

    #[test]
    fn may_act_gm_requires_being_the_gm_identity() {
        let m = Membership::new("gm");
        assert!(m.may_act("gm", &Actor::Gm));
        assert!(!m.may_act("ada", &Actor::Gm));
    }

    #[test]
    fn may_act_join_is_allowed_only_for_an_unowned_seat() {
        let mut m = Membership::new("gm");
        assert!(m.may_act("ada", &Actor::Join { character_id: "c1".into() })); // unowned -> may claim
        m.claim("c1", "ada");
        assert!(!m.may_act("ben", &Actor::Join { character_id: "c1".into() })); // owned -> no hijack
    }

    #[test]
    fn claim_assign_unassign_transfer_gm_mutate_ownership() {
        let mut m = Membership::new("gm");
        m.claim("c1", "ada");
        assert_eq!(m.owner_of("c1"), Some("ada"));
        m.assign("c1", "ben"); // GM override reassigns (in place)
        assert_eq!(m.owner_of("c1"), Some("ben"));
        m.unassign("c1");
        assert_eq!(m.owner_of("c1"), None);
        m.transfer_gm("ada");
        assert_eq!(m.gm_identity(), "ada");
    }

    #[test]
    fn seats_list_current_ownerships_in_claim_order() {
        let mut m = Membership::new("gm");
        m.claim("c1", "ada");
        m.claim("c2", "ben");
        assert_eq!(
            m.seats(),
            &[("c1".to_string(), "ada".to_string()), ("c2".to_string(), "ben".to_string())]
        );
    }

    #[test]
    fn reassigning_an_owned_seat_keeps_its_position() {
        let mut m = Membership::new("gm");
        m.claim("c1", "ada");
        m.claim("c2", "ben");
        m.assign("c1", "cleo"); // update in place, not moved to the end
        assert_eq!(
            m.seats(),
            &[("c1".to_string(), "cleo".to_string()), ("c2".to_string(), "ben".to_string())]
        );
    }

    #[test]
    fn round_trips_through_to_state_from_state() {
        let mut m = Membership::new("gm-1");
        m.claim("ada", "ident-ada");
        m.assign("ben", "ident-ben");
        let state = m.to_state();
        assert_eq!(
            state,
            MembershipState {
                gm_identity: "gm-1".into(),
                seats: vec![("ada".into(), "ident-ada".into()), ("ben".into(), "ident-ben".into())],
            }
        );
        let restored = Membership::from_state(state.clone());
        assert_eq!(restored.gm_identity(), "gm-1");
        assert_eq!(restored.owner_of("ada"), Some("ident-ada"));
        assert_eq!(restored.owner_of("ben"), Some("ident-ben"));
        assert_eq!(restored.to_state(), state);
    }

    #[test]
    fn actor_of_turn_command_is_its_seat() {
        let cmd: Command =
            serde_json::from_value(json!({ "kind": "move", "actorId": "c1", "roomId": "r1" })).unwrap();
        assert_eq!(actor_of(&cmd), Actor::Character { actor_id: "c1".into() });
    }

    #[test]
    fn actor_of_setup_command_is_its_seat() {
        let cmd: Command = serde_json::from_value(
            json!({ "kind": "selectArchetype", "actorId": "c2", "archetypeId": "fighter" }),
        )
        .unwrap();
        assert_eq!(actor_of(&cmd), Actor::Character { actor_id: "c2".into() });
    }

    #[test]
    fn actor_of_gm_and_lifecycle_commands_is_gm() {
        let next: Command = serde_json::from_value(json!({ "kind": "nextPlayer" })).unwrap();
        let mob: Command =
            serde_json::from_value(json!({ "kind": "mobEscape", "mobId": "m1" })).unwrap();
        assert_eq!(actor_of(&next), Actor::Gm);
        assert_eq!(actor_of(&mob), Actor::Gm);
    }
    // `actor_of` for a `joinCampaign` command (needs a full CharacterSnapshot) is covered in
    // `tests/membership.rs`, which borrows a character from the committed genesis fixture.
}
