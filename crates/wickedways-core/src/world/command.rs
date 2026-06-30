use alloc::vec::Vec;
use serde::{Deserialize, Serialize};
use crate::error::ProceduralViolation;
use crate::presentation::PresentationCue;
use crate::world::direction::Direction;
use crate::world::World;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Command {
    StartTurn,
    EndTurn,
    Go { dir: Direction },
    NextPlayer,
}

pub fn apply_command(world: &mut World, cmd: Command,
                     cues: &mut Vec<PresentationCue>) -> Result<(), ProceduralViolation> {
    let actor = world.active_character_id()?;
    match cmd {
        Command::StartTurn => { world.start_turn(&actor); Ok(()) }
        Command::EndTurn => { world.end_turn(&actor); Ok(()) }
        Command::Go { dir } => world.go(&actor, dir, cues),
        Command::NextPlayer => world.next_player(cues),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::direction::Direction;
    use crate::world::test_support::world_two_rooms;

    #[test]
    fn apply_go_dispatches_to_active_character() {
        let mut w = world_two_rooms(false);
        let mut cues = Vec::new();
        apply_command(&mut w, Command::Go { dir: Direction::North }, &mut cues).unwrap();
        assert_eq!(cues.len(), 1); // action move cue
    }

    #[test]
    fn command_json_tag_shape() {
        let c: Command = serde_json::from_value(
            serde_json::json!({ "kind": "go", "dir": "north" })).unwrap();
        assert!(matches!(c, Command::Go { dir: Direction::North }));
        assert!(matches!(
            serde_json::from_value::<Command>(serde_json::json!({ "kind": "nextPlayer" })).unwrap(),
            Command::NextPlayer));
    }
}
