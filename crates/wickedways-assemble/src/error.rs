//! Aggregated authoring errors: the validate pass collects EVERY problem and
//! reports them together.
//!
//! `assemble` consumes untrusted author data. Nothing here may panic.

use std::fmt;

// ---------------------------------------------------------------------------
// The top-level error `assemble` returns
// ---------------------------------------------------------------------------

/// The whole validation report: every [`Problem`] found, never just the first.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssembleError {
    pub problems: Vec<Problem>,
}

impl fmt::Display for AssembleError {
    // `Display` is Rust's `toString()`: what `{}` and `.to_string()` produce.
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

// An empty marker impl — roughly `class AssembleError extends Error`: it lets
// this type flow anywhere a generic `dyn Error` is expected.
impl std::error::Error for AssembleError {}

// ---------------------------------------------------------------------------
// The individual problems
// ---------------------------------------------------------------------------

/// One validation failure. A Rust enum whose variants carry data — the closest
/// TS shape is a discriminated union (`{ kind: "duplicateName", name: … } | …`),
/// except `match` forces every arm to be handled.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Problem {
    DuplicateName {
        // `&'static str` = a string literal baked into the binary, alive for the
        // whole program — which is why no allocation/ownership is needed here.
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
    /// A `mapGen.sealed` room named in no `mapGen.required` passage: the
    /// generator gives sealed rooms no generated edges, so an unanchored one is
    /// guaranteed unreachable — caught here as a labeled load-time problem
    /// instead of a `begin_campaign` violation at the table.
    SealedRoomUnanchored {
        room: String,
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
        // An exhaustive `match`: add a `Problem` variant and this fails to
        // compile until the new arm exists (no silent fall-through `default`).
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
            Problem::SealedRoomUnanchored { room } => write!(
                f,
                "mapGen.sealed room '{room}' appears in no mapGen.required passage — a sealed \
                 room's required door is its only entrance, so it would be unreachable."
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
