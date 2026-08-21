//! Layers 3 and 4 of the validation stack.
//!
//! **Layer 3 — per-body validation.** [`validate_body`] dispatches a single raw
//! DSL body to `wickedways_author::validate`'s span-bearing single-body parsers —
//! the same parsers `compile()` runs for that slot, so a body that validates here
//! parses identically in a full compile. Spans in the returned message are
//! relative to the body text: exactly what an in-editor marker needs. (This
//! replaced the MVP's probe-document hack when the upstream entry points landed —
//! the spec's P2 upstream change.)
//!
//! **Layer 4 — the authoritative gate.** [`check_campaign`] runs the real
//! pipeline: export TOML → `compile()` → `assemble()` (whose collect-all validate
//! returns every problem at once) → `World::from_snapshot` + `validate_mechanics`
//! (the replay-gate load pattern). On success the report carries the compiled
//! artifacts (description/catalog/genesis JSON — the same files `wwauthor`
//! writes) for download. The compiler is the trust boundary; the live layers
//! exist to make reaching a green gate pleasant, not to replace it.

use wickedways_assemble::{assemble, Seat};
use wickedways_author::{compile_all, validate};
use wickedways_core::World;

use crate::export::to_toml;
use crate::model::EditorDoc;

/// Which behavior-body field a raw-text editor is validating. The five mechanic
/// lifecycle hooks share one grammar, so one slot covers them all.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BodySlot {
    /// Exit `canPass` — a single predicate expression.
    ExitCanPass,
    /// Exit `runScript` — the one body where `pass <expr>` is legal.
    ExitRunScript,
    /// Scene `canPlay` — a predicate expression.
    SceneCanPlay,
    /// Scene `onEnter` / `onExit` — statement blocks.
    SceneBody,
    /// Item `onUse` / `onRead` — statement blocks.
    ItemBody,
    /// NPC dialogue `effects` — an emit-only body.
    NpcEffects,
    /// Mechanic lifecycle hooks (`onRoundStart` … `onAction`) — statement blocks.
    MechanicHook,
    /// Mechanic `modifyDamage` — its own transform grammar.
    ModifyDamage,
    /// A mechanic custom action body — statement block.
    MechanicAction,
    /// Card `onPlay` — a statement block.
    CardOnPlay,
    /// Victory `test` — a predicate expression.
    VictoryTest,
}

/// Validate `body` in isolation with the slot's real parser. `None` = valid;
/// `Some(message)` carries the compiler's error, spans relative to the body text.
#[must_use]
pub fn validate_body(slot: BodySlot, body: &str) -> Option<String> {
    if body.trim().is_empty() {
        return None;
    }
    let result = match slot {
        BodySlot::ExitCanPass | BodySlot::SceneCanPlay | BodySlot::VictoryTest => {
            validate::expression(body)
        }
        BodySlot::ExitRunScript => validate::exit_script(body),
        BodySlot::NpcEffects => validate::effects(body),
        BodySlot::ModifyDamage => validate::modify_damage(body),
        BodySlot::SceneBody
        | BodySlot::ItemBody
        | BodySlot::MechanicHook
        | BodySlot::MechanicAction
        | BodySlot::CardOnPlay => validate::statements(body),
    };
    result.err().map(|e| e.to_string())
}

/// The authoritative gate's findings, in pipeline order.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct GateReport {
    /// The exported TOML (present whenever serialization succeeded).
    pub toml: Option<String>,
    /// Compile findings — ALL of them at once (`compile_all`), each labeled with
    /// the body it came from.
    pub compile_errors: Vec<String>,
    /// The assembler's collect-all validation problems.
    pub assemble_problems: Vec<String>,
    /// The engine's `validate_mechanics` shape-check failure.
    pub mechanics_error: Option<String>,
    /// Pretty-printed compiled description JSON (green gate only) — the same
    /// artifact `wwauthor` writes.
    pub description_json: Option<String>,
    /// Pretty-printed compiled catalog JSON (green gate only).
    pub catalog_json: Option<String>,
    /// Pretty-printed pristine genesis JSON (green gate only) — the assembled,
    /// unseated campaign snapshot.
    pub genesis_json: Option<String>,
}

impl GateReport {
    /// Green: the campaign compiles, assembles, and loads.
    #[must_use]
    pub fn ok(&self) -> bool {
        self.compile_errors.is_empty()
            && self.assemble_problems.is_empty()
            && self.mechanics_error.is_none()
    }
}

/// Run the full authoritative pipeline over the document.
#[must_use]
pub fn check_campaign(doc: &EditorDoc) -> GateReport {
    let mut report = GateReport::default();
    let toml_src = match to_toml(doc) {
        Ok(s) => s,
        Err(e) => {
            report.compile_errors = vec![e];
            return report;
        }
    };
    report.toml = Some(toml_src.clone());
    let compiled = match compile_all(&toml_src) {
        Ok(c) => c,
        Err(errors) => {
            report.compile_errors = errors.iter().map(ToString::to_string).collect();
            return report;
        }
    };
    // One default seat (the GM, archetype-free — the TOML-author path) so the genesis
    // artifact is PLAYABLE: the Playtest handoff boots it directly, and the bundled
    // fixtures follow the same convention (seated, first seat = GM). Assemble still
    // runs the collect-all validate first, so the gate's authority is unchanged.
    let seats = [Seat {
        name: "Playtester".into(),
        archetype: None,
    }];
    let snap = match assemble(&compiled.description, &compiled.catalog, &seats) {
        Ok(snap) => snap,
        Err(e) => {
            report.assemble_problems = e.problems.iter().map(ToString::to_string).collect();
            return report;
        }
    };
    report.description_json = serde_json::to_string_pretty(&compiled.description).ok();
    report.catalog_json = serde_json::to_string_pretty(&compiled.catalog).ok();
    report.genesis_json = serde_json::to_string_pretty(&snap).ok();
    let world = World::from_snapshot(snap);
    if let Err(e) = world.validate_mechanics(&compiled.catalog) {
        report.mechanics_error = Some(e.to_string());
        report.description_json = None;
        report.catalog_json = None;
        report.genesis_json = None;
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::export::import;

    #[test]
    fn every_slot_accepts_a_valid_body() {
        let cases: &[(BodySlot, &str)] = &[
            (BodySlot::ExitCanPass, "hasKey(actor, 'vault')"),
            (BodySlot::ExitRunScript, "pass 'The door swings open.'"),
            (BodySlot::SceneCanPlay, "!stateGet('seen', false)"),
            (
                BodySlot::SceneBody,
                "guard round == 0\nemit cue('A cold draft.')\nset state.seen = true",
            ),
            (BodySlot::ItemBody, "emit adjustStat(actor, sanity, 6)"),
            (BodySlot::NpcEffects, "emit setVisible('npc:Probe', false)"),
            (
                BodySlot::MechanicHook,
                "guard !hasEquipped(actor, 'lantern')\nemit adjustStat(actor, sanity, -1)",
            ),
            (
                BodySlot::ModifyDamage,
                "damage.amount > 3 ? final 3 : damage.amount",
            ),
            (BodySlot::MechanicAction, "emit cue('You brace.')"),
            (BodySlot::CardOnPlay, "emit cue('The dark deepens.')"),
            (BodySlot::VictoryTest, "party[0].room.name == 'B'"),
        ];
        for (slot, body) in cases {
            assert_eq!(
                validate_body(*slot, body),
                None,
                "{slot:?} should accept {body:?}"
            );
        }
    }

    #[test]
    fn every_slot_rejects_a_bad_body_with_a_message() {
        let cases: &[(BodySlot, &str)] = &[
            (BodySlot::ExitCanPass, "hasKey(actor,"),
            (BodySlot::SceneBody, "explode everything"),
            (BodySlot::ItemBody, "emit fireball(actor)"),
            (BodySlot::NpcEffects, "guard round == 0"), // non-emit is illegal in effects
            (BodySlot::ModifyDamage, "final final final"),
            (BodySlot::VictoryTest, "nonsense_subject == 1"),
        ];
        for (slot, body) in cases {
            assert!(
                validate_body(*slot, body).is_some(),
                "{slot:?} should reject {body:?}"
            );
        }
        // `pass` is legal ONLY in exit runScript — the per-family context rule.
        assert!(validate_body(BodySlot::ItemBody, "pass 'x'").is_some());
        assert_eq!(validate_body(BodySlot::ExitRunScript, "pass 'x'"), None);
    }

    #[test]
    fn an_empty_body_is_not_an_error() {
        assert_eq!(validate_body(BodySlot::SceneBody, "  \n"), None);
    }

    #[test]
    fn the_gate_passes_a_consistent_campaign_and_yields_artifacts() {
        let doc = import(
            r#"
            title = "Mini"
            startRoom = "A"
            [[rooms]]
            name = "A"
            description = "a"
            [[rooms]]
            name = "B"
            description = "b"
            [[exits]]
            from = "A"
            to = "B"
            direction = "north"
            [[exits]]
            from = "B"
            to = "A"
            direction = "south"
            [[victory.win]]
            key = "reach-b"
            test = "party[0].room.name == 'B'"
        "#,
        )
        .unwrap();
        let report = check_campaign(&doc);
        assert!(report.ok(), "expected green gate: {report:?}");
        assert!(report.toml.is_some());
        // A green gate carries the compiled artifacts, and they are real JSON.
        for artifact in [
            &report.description_json,
            &report.catalog_json,
            &report.genesis_json,
        ] {
            let json = artifact.as_ref().expect("artifact present on green");
            serde_json::from_str::<serde_json::Value>(json).expect("artifact parses");
        }
    }

    #[test]
    fn the_gate_collects_assemble_problems() {
        let doc = import(
            r#"
            title = "Broken"
            startRoom = "Nowhere"
            [[rooms]]
            name = "A"
            description = "a"
        "#,
        )
        .unwrap();
        let report = check_campaign(&doc);
        assert!(!report.ok());
        assert!(
            report
                .assemble_problems
                .iter()
                .any(|p| p.contains("Nowhere")),
            "problems name the undefined room: {report:?}"
        );
        assert!(report.description_json.is_none(), "no artifacts on red");
    }
}
