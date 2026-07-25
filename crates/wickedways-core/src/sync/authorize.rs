//! The sync **authorize gate** (Phase 2c, sub-project A).
//!
//! A pure function of `(world, command)` — the game-rule gate that decides whether a
//! command is permitted given the campaign's lifecycle/turn/GM state. Mirrors
//! `src/lib/sync/resolver.ts` `Resolver.authorize` branch-for-branch. Deeper
//! validation (does the target exist, is the move legal) stays in the engine actions,
//! which throw [`ProceduralViolation`](crate::error::ProceduralViolation) — the sync
//! `Authority` (sub-project B) turns that into a `denied` result on its
//! restore-on-violation path. This gate never mutates and never allocates world state.

use alloc::string::{String, ToString};

use crate::presentation::CampaignOutcome;
use crate::world::snapshot::CharacterKind;
use crate::world::World;

use super::command::Command;

/// The verdict of [`authorize`]: permitted, or denied with a human-readable reason
/// (the reason is surfaced to the submitter verbatim, as in the TS oracle).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AuthResult {
    Ok,
    Denied(String),
}

impl AuthResult {
    /// `true` when the command is permitted.
    pub fn is_ok(&self) -> bool {
        matches!(self, AuthResult::Ok)
    }
}

/// The game-rule gate. Returns [`AuthResult::Ok`] if `command` is permitted given the
/// campaign's lifecycle/turn/GM state, else [`AuthResult::Denied`] with a reason.
pub fn authorize(world: &World, command: &Command) -> AuthResult {
    let started = world.campaign.started;
    let finished = world.campaign.outcome != CampaignOutcome::Ongoing;

    // Turn-actions, `wait`, and `endTurn` share the same gate: the campaign is running and it's your
    // turn. `wait` is a time-advancing pass; `endTurn` ends your own turn (a player may only end the
    // turn while it is theirs — the GM ends anyone's via `nextPlayer`).
    if command.is_turn_action() || matches!(command, Command::Wait { .. }) || command.is_end_turn()
    {
        if !started {
            return denied("Campaign has not begun.");
        }
        if finished {
            return denied("Campaign has finished.");
        }
        // The actor must be the active character. `active_character_id` is `Ok` once
        // the campaign has started; a missing active seat fails the turn-owner check.
        let active = world.active_character_id().ok();
        if active.as_ref() != command.actor_id() {
            return denied("Not the active character's turn.");
        }
        return AuthResult::Ok;
    }

    if command.is_npc_interaction() {
        // Dialogue is free (spends no round) but still a live-play action: the campaign must be
        // running and it's your own turn to speak (parity with the turn-action gate, minus the
        // budget tick). The engine's `talk` no-ops if the NPC isn't reachable.
        if !started {
            return denied("Campaign has not begun.");
        }
        if finished {
            return denied("Campaign has finished.");
        }
        let active = world.active_character_id().ok();
        if active.as_ref() != command.actor_id() {
            return denied("Not the active character's turn.");
        }
        return AuthResult::Ok;
    }

    if command.is_setup_command() {
        if started {
            return denied("Setup is only allowed before the campaign begins.");
        }
        // The actor's existence is resolved against the world at apply time.
        return AuthResult::Ok;
    }

    if command.is_join_command() {
        if finished {
            return denied("Campaign has finished.");
        }
        if let Command::JoinCampaign { character } = command {
            if character.kind != CharacterKind::Player {
                return denied("Only player characters can join a campaign.");
            }
        }
        return AuthResult::Ok;
    }

    if command.is_gm_command() {
        if world.campaign.gm_id.is_none() {
            return denied("No GM is set.");
        }
        if matches!(command, Command::BeginCampaign) {
            if started {
                return denied("Campaign already begun.");
            }
            return AuthResult::Ok;
        }
        if !started {
            return denied("Campaign has not begun.");
        }
        return AuthResult::Ok;
    }

    denied("Unrecognized command.")
}

fn denied(reason: &str) -> AuthResult {
    AuthResult::Denied(reason.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::ids::{CharacterId, RoomId};
    use crate::world::test_support::world_with_party;
    use alloc::boxed::Box;

    fn cid(s: &str) -> CharacterId {
        CharacterId(s.into())
    }

    fn move_cmd(actor: &str) -> Command {
        Command::Move {
            actor_id: cid(actor),
            room_id: RoomId("r1".into()),
        }
    }

    #[test]
    fn accepts_a_turn_action_from_the_active_character() {
        // world_with_party starts the campaign with active_character_index 0.
        let world = world_with_party(&["a", "b"], 10);
        assert_eq!(authorize(&world, &move_cmd("a")), AuthResult::Ok);
    }

    #[test]
    fn rejects_a_turn_action_from_a_non_active_character() {
        let world = world_with_party(&["a", "b"], 10);
        assert!(matches!(
            authorize(&world, &move_cmd("b")),
            AuthResult::Denied(_)
        ));
    }

    #[test]
    fn rejects_a_turn_action_before_the_campaign_begins() {
        let mut world = world_with_party(&["a"], 10);
        world.campaign.started = false;
        assert_eq!(
            authorize(&world, &move_cmd("a")),
            AuthResult::Denied("Campaign has not begun.".into())
        );
    }

    #[test]
    fn rejects_a_turn_action_after_the_campaign_finishes() {
        let mut world = world_with_party(&["a"], 10);
        world.campaign.outcome = CampaignOutcome::Won;
        assert_eq!(
            authorize(&world, &move_cmd("a")),
            AuthResult::Denied("Campaign has finished.".into())
        );
    }

    #[test]
    fn rejects_setup_after_the_campaign_has_started() {
        let world = world_with_party(&["a"], 10); // started == true
        let setup = Command::SelectArchetype {
            actor_id: cid("a"),
            archetype_id: "arch".into(),
        };
        assert!(matches!(authorize(&world, &setup), AuthResult::Denied(_)));
    }

    #[test]
    fn accepts_setup_before_start() {
        let mut world = world_with_party(&["a"], 10);
        world.campaign.started = false;
        let setup = Command::SelectArchetype {
            actor_id: cid("a"),
            archetype_id: "arch".into(),
        };
        assert_eq!(authorize(&world, &setup), AuthResult::Ok);
    }

    #[test]
    fn rejects_a_gm_command_when_there_is_no_gm() {
        let world = world_with_party(&["a"], 10); // gm_id == None
        assert_eq!(
            authorize(&world, &Command::NextPlayer),
            AuthResult::Denied("No GM is set.".into())
        );
    }

    #[test]
    fn accepts_a_gm_command_once_a_gm_is_set_and_started() {
        let mut world = world_with_party(&["a"], 10);
        world.campaign.gm_id = Some(cid("a"));
        assert_eq!(authorize(&world, &Command::NextPlayer), AuthResult::Ok);
    }

    #[test]
    fn begin_campaign_requires_a_gm_and_a_not_started_campaign() {
        let mut world = world_with_party(&["a"], 10);
        world.campaign.gm_id = Some(cid("a"));
        // started == true → already begun
        assert_eq!(
            authorize(&world, &Command::BeginCampaign),
            AuthResult::Denied("Campaign already begun.".into())
        );
        world.campaign.started = false;
        assert_eq!(authorize(&world, &Command::BeginCampaign), AuthResult::Ok);
    }

    #[test]
    fn non_begin_gm_command_requires_a_started_campaign() {
        let mut world = world_with_party(&["a"], 10);
        world.campaign.gm_id = Some(cid("a"));
        world.campaign.started = false;
        assert_eq!(
            authorize(&world, &Command::NextPlayer),
            AuthResult::Denied("Campaign has not begun.".into())
        );
    }

    #[test]
    fn join_accepts_a_player_and_rejects_after_finish() {
        let world = world_with_party(&["a"], 10);
        let character = world.characters[&cid("a")].clone(); // kind == Player
        let join = Command::JoinCampaign {
            character: Box::new(character),
        };
        assert_eq!(authorize(&world, &join), AuthResult::Ok);

        let mut finished = world_with_party(&["a"], 10);
        finished.campaign.outcome = CampaignOutcome::Ended;
        let character = finished.characters[&cid("a")].clone();
        assert!(matches!(
            authorize(
                &finished,
                &Command::JoinCampaign {
                    character: Box::new(character)
                }
            ),
            AuthResult::Denied(_)
        ));
    }

    fn talk_cmd(actor: &str) -> Command {
        Command::Talk {
            actor_id: cid(actor),
            npc_id: cid("npc:Caretaker"),
            prompt: None,
        }
    }

    #[test]
    fn accepts_talk_from_the_active_character_in_a_running_campaign() {
        let world = world_with_party(&["a", "b"], 10);
        assert_eq!(authorize(&world, &talk_cmd("a")), AuthResult::Ok);
    }

    #[test]
    fn rejects_talk_from_a_non_active_character() {
        let world = world_with_party(&["a", "b"], 10);
        assert!(matches!(
            authorize(&world, &talk_cmd("b")),
            AuthResult::Denied(_)
        ));
    }

    #[test]
    fn rejects_talk_before_the_campaign_begins() {
        let mut world = world_with_party(&["a"], 10);
        world.campaign.started = false;
        assert_eq!(
            authorize(&world, &talk_cmd("a")),
            AuthResult::Denied("Campaign has not begun.".into())
        );
    }

    #[test]
    fn join_rejects_a_non_player_character() {
        let mut world = world_with_party(&["a"], 10);
        let mut character = world.characters[&cid("a")].clone();
        character.kind = CharacterKind::Mob;
        world.campaign.started = true;
        assert_eq!(
            authorize(
                &world,
                &Command::JoinCampaign {
                    character: Box::new(character)
                }
            ),
            AuthResult::Denied("Only player characters can join a campaign.".into())
        );
    }
}
