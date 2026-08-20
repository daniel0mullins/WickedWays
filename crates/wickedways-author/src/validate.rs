//! Public, span-bearing single-body validators — the editor-tooling seam
//! (docs/campaign-studio-spec.md §Required upstream changes, item 2).
//!
//! Each function checks ONE raw behavior body against the same parser
//! `compile()` runs for that body slot, so a body that validates here parses
//! identically inside a full campaign compile — no probe-document scaffolding
//! needed. Errors carry spans relative to the body text (line 1, col 1 is the
//! body's first character), which is exactly what an in-editor marker wants.
//!
//! These wrappers are parse-level checks (the per-family grammar, including
//! `pass`-only-in-scripts and emit-only effects). Deeper shape rules that need
//! whole-catalog context (`validate_behavior`'s `MapLit` placement, key
//! resolution) still belong to the full pipeline.

use crate::damage_body::parse_damage_body;
use crate::error::{CompileError, Span};
use crate::expr::parse_expr;
use crate::stmt::{parse_effects, parse_script, parse_stmts};

/// Bodies are validated in isolation, so spans are relative to the body text.
const BASE: Span = Span { line: 1, col: 1 };

/// A single predicate/value expression (exit `canPass`, scene `canPlay`,
/// victory `test`).
pub fn expression(src: &str) -> Result<(), CompileError> {
    parse_expr(src, BASE).map(|_| ())
}

/// A statement block (scene `onEnter`/`onExit`, item `onUse`/`onRead`,
/// mechanic lifecycle hooks and custom actions, card `onPlay`). `pass` is
/// rejected here — it is legal only in exit scripts.
pub fn statements(src: &str) -> Result<(), CompileError> {
    parse_stmts(src, BASE).map(|_| ())
}

/// An exit `runScript` body — the one block where `pass <expr>` is legal.
pub fn exit_script(src: &str) -> Result<(), CompileError> {
    parse_script(src, BASE).map(|_| ())
}

/// An NPC dialogue `effects` body — emit-only (any other statement form is
/// rejected).
pub fn effects(src: &str) -> Result<(), CompileError> {
    parse_effects(src, BASE).map(|_| ())
}

/// A mechanic `modifyDamage` transform (`<cond> ? final <expr> : <expr>` /
/// bare value grammar).
pub fn modify_damage(src: &str) -> Result<(), CompileError> {
    parse_damage_body(src, BASE).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_validator_accepts_its_grammar() {
        assert!(expression("hasKey(actor, 'vault') && round < maxRounds").is_ok());
        assert!(statements("guard round == 0\nemit cue('x')\nset state.seen = true").is_ok());
        assert!(exit_script("pass 'The door swings open.'").is_ok());
        assert!(effects("emit giveItem('a', actor, 'b')\nemit setVisible('a', false)").is_ok());
        assert!(modify_damage("damage.amount > 3 ? final 3 : damage.amount").is_ok());
    }

    #[test]
    fn per_family_context_rules_hold() {
        // `pass` is legal ONLY in exit scripts.
        assert!(statements("pass 'x'").is_err());
        assert!(exit_script("pass 'x'").is_ok());
        // Effects bodies are emit-only.
        assert!(effects("guard round == 0").is_err());
        // Unknown identifiers/effects are rejected, not ignored.
        assert!(expression("nonsense_subject == 1").is_err());
        assert!(statements("emit fireball(actor)").is_err());
    }

    #[test]
    fn errors_carry_body_relative_spans() {
        let err = expression("round ==").unwrap_err();
        let shown = err.to_string();
        assert!(shown.contains("1:"), "span is body-relative: {shown}");
    }
}
