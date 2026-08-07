//! Aggregated authoring errors: the validate pass collects EVERY problem and
//! reports them together.
//!
//! `assemble` consumes untrusted author data. Nothing here may panic.

use std::fmt;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Problem {
    DuplicateName {
        kind: &'static str,
        name: String,
    },
    UndefinedRoom {
        ctx: String,
        room: String,
    },
    UnregisteredItem {
        ctx: String,
        key: String,
    },
    // NOTE: no `UnregisteredRecipe` variant. The catalog now carries a `recipes` map
    // (used for the codex), so this variant is cheaply addable — recipe-key validation
    // is deliberately deferred until author input becomes untrusted (modding).
    UnregisteredCondition {
        ctx: String,
        key: String,
    },
    UnregisteredScene {
        key: String,
    },
    UnregisteredExit {
        from: String,
        to: String,
        key: String,
    },
    UnregisteredFormation {
        key: String,
    },
    UnregisteredNpc {
        npc: String,
        key: String,
    },
    DuplicateMechanic {
        key: String,
    },
    UnregisteredMechanic {
        key: String,
    },
    ChatBackfillWindow {
        got: i64,
    },
    AvMaxParticipants {
        got: i64,
    },
    UndefinedVillainCharacter {
        character: String,
    },
    UnregisteredCard {
        key: String,
    },
}

impl fmt::Display for Problem {
    /// Message wording is deliberate — the CLI surfaces these strings verbatim —
    /// but they are NOT byte-compared by the gate.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Problem::DuplicateName { kind, name } => write!(f, "Duplicate {kind} name '{name}'."),
            Problem::UndefinedRoom { ctx, room } => {
                write!(f, "{ctx} references undefined room '{room}'.")
            }
            Problem::UnregisteredItem { ctx, key } => {
                write!(f, "{ctx} references unregistered item key '{key}'.")
            }
            Problem::UnregisteredCondition { ctx, key } => {
                write!(f, "{ctx} references unregistered condition key '{key}'.")
            }
            Problem::UnregisteredScene { key } => {
                write!(f, "scene references unregistered scene key '{key}'.")
            }
            Problem::UnregisteredExit { from, to, key } => write!(
                f,
                "exit from '{from}' to '{to}' references unregistered exit key '{key}'."
            ),
            Problem::UnregisteredFormation { key } => write!(
                f,
                "formation references unregistered formation key '{key}'."
            ),
            Problem::UnregisteredNpc { npc, key } => {
                write!(f, "npc '{npc}' references unregistered npc key '{key}'.")
            }
            Problem::DuplicateMechanic { key } => {
                write!(f, "useMechanic key '{key}' is duplicated.")
            }
            Problem::UnregisteredMechanic { key } => write!(
                f,
                "useMechanic references unregistered mechanic key '{key}'."
            ),
            Problem::ChatBackfillWindow { got } => {
                write!(f, "chat.backfillWindow must be >= 1 (got {got}).")
            }
            Problem::AvMaxParticipants { got } => {
                write!(f, "av.maxParticipants must be >= 1 (got {got}).")
            }
            Problem::UndefinedVillainCharacter { character } => write!(
                f,
                "villain references undefined character '{character}' (declare a mob/npc by that name, or use \"@gm\")."
            ),
            Problem::UnregisteredCard { key } => {
                write!(f, "villain deck references unregistered card key '{key}'.")
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssembleError {
    pub problems: Vec<Problem>,
}

impl fmt::Display for AssembleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(
            f,
            "campaign failed to assemble ({} problems):",
            self.problems.len()
        )?;
        for p in &self.problems {
            writeln!(f, "  - {p}")?;
        }
        Ok(())
    }
}

impl std::error::Error for AssembleError {}
