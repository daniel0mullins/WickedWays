//! Layers 3 and 4 of the validation stack.
//!
//! **Layer 3 — probe-doc body validation.** [`validate_body`] compiles a single
//! behavior body in isolation by wrapping it in a minimal, otherwise-valid probe
//! `AuthorDoc` and running the real `compile()`. The scaffolding never fails, so any
//! error is the body's; `ExprParse`/`UnknownReference` spans are relative to the
//! body string — exactly what an in-editor marker needs. (The spec's P2 replaces
//! this with public parse entry points upstream; the probe works today with zero
//! upstream changes.)
//!
//! **Layer 4 — the authoritative gate.** [`check_campaign`] runs the real pipeline:
//! export TOML → `compile()` → `assemble()` (whose collect-all validate returns
//! every problem at once) → `World::from_snapshot` + `validate_mechanics` (the
//! replay-gate load pattern). The compiler is the trust boundary; the live layers
//! exist to make reaching a green gate pleasant, not to replace it.

use wickedways_assemble::{assemble, Seat};
use wickedways_author::author_doc::{
    AuthorDoc, Behaviors, CardBehaviorEntry, CardEntryToml, ConditionEntry, DialogueEntryToml,
    ExitBehaviorEntry, ExitEntry, ItemBehaviorEntry, ItemEntry, MatchToml, MechanicBehaviorEntry,
    MechanicEntryToml, NpcBehaviorEntry, NpcEntry, RoomEntry, SceneBehaviorEntry, SceneEntry,
    Victory,
};
use wickedways_author::compile;
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

fn blank_doc() -> AuthorDoc {
    AuthorDoc {
        title: "probe".into(),
        start_room: None,
        opts: wickedways_assemble::description::CampaignOpts::default(),
        archetypes: Vec::new(),
        rooms: Vec::new(),
        exits: Vec::new(),
        items: Vec::new(),
        loot: Vec::new(),
        caches: Vec::new(),
        recipes: Vec::new(),
        scenes: Vec::new(),
        npcs: Vec::new(),
        mobs: Vec::new(),
        formations: Vec::new(),
        mechanics: Vec::new(),
        villain: None,
        cards: Vec::new(),
        behaviors: Behaviors::default(),
        victory: Victory::default(),
        timeout_narration: None,
    }
}

fn probe_room(name: &str) -> RoomEntry {
    RoomEntry {
        name: name.into(),
        description: "probe".into(),
        dark: None,
        spawn_modifier: None,
        lights: Vec::new(),
    }
}

fn probe_stats() -> wickedways_core::world::snapshot::Stats {
    wickedways_core::world::snapshot::Stats {
        energy: 1.0,
        sanity: 1.0,
        health: 1.0,
    }
}

/// Build the minimal probe document exercising `body` in `slot`.
fn probe_doc(slot: BodySlot, body: &str) -> AuthorDoc {
    let mut doc = blank_doc();
    match slot {
        BodySlot::ExitCanPass | BodySlot::ExitRunScript => {
            doc.rooms = vec![probe_room("A"), probe_room("B")];
            doc.exits = vec![ExitEntry {
                from: "A".into(),
                to: "B".into(),
                direction: "north".into(),
                behavior: Some("probe".into()),
                name: None,
                initial_state: None,
                one_way: None,
            }];
            let (can_pass, run_script) = match slot {
                BodySlot::ExitCanPass => (body.to_string(), None),
                _ => ("true".to_string(), Some(body.to_string())),
            };
            doc.behaviors.exit.insert(
                "probe".into(),
                ExitBehaviorEntry {
                    can_pass,
                    run_script,
                    pass_message: None,
                    fail_message: None,
                },
            );
        }
        BodySlot::SceneCanPlay | BodySlot::SceneBody => {
            doc.rooms = vec![probe_room("A")];
            doc.scenes = vec![SceneEntry {
                room: "A".into(),
                key: "probe".into(),
                phase: None,
                initial_state: None,
            }];
            let (can_play, on_enter) = match slot {
                BodySlot::SceneCanPlay => (Some(body.to_string()), None),
                _ => (None, Some(body.to_string())),
            };
            doc.behaviors.scene.insert(
                "probe".into(),
                SceneBehaviorEntry {
                    can_play,
                    on_enter,
                    on_exit: None,
                },
            );
        }
        BodySlot::ItemBody => {
            doc.items = vec![ItemEntry {
                key: "probe".into(),
                name: "Probe".into(),
                key_code: None,
                type_: Some("consumable".into()),
                stat: None,
                modifier: None,
                usable: Some(true),
                destroyable: None,
                recipe: None,
                equippable: None,
                droppable: None,
                slot: None,
                two_handed: None,
                emits_light: None,
                max_durability: None,
                lore: None,
                aliases: Vec::new(),
            }];
            doc.behaviors.item.insert(
                "probe".into(),
                ItemBehaviorEntry {
                    on_use: Some(body.to_string()),
                    on_read: None,
                },
            );
        }
        BodySlot::NpcEffects => {
            doc.rooms = vec![probe_room("A")];
            doc.npcs = vec![NpcEntry {
                name: "Probe".into(),
                stats: probe_stats(),
                room: Some("A".into()),
                behavior: "probe".into(),
                holds: Vec::new(),
            }];
            doc.behaviors.npc.insert(
                "probe".into(),
                NpcBehaviorEntry {
                    description: "probe".into(),
                    default: DialogueEntryToml {
                        match_: MatchToml::Exact(String::new()),
                        response: "…".into(),
                        once: false,
                        effects: Some(body.to_string()),
                    },
                    dialogue: Vec::new(),
                },
            );
        }
        BodySlot::MechanicHook | BodySlot::ModifyDamage | BodySlot::MechanicAction => {
            doc.mechanics = vec![MechanicEntryToml {
                key: "probe".into(),
                config: None,
            }];
            let mut entry = MechanicBehaviorEntry {
                init: None,
                on_round_start: None,
                on_round_end: None,
                on_turn_start: None,
                on_turn_end: None,
                on_action: None,
                modify_damage: None,
                actions: std::collections::BTreeMap::new(),
            };
            match slot {
                BodySlot::MechanicHook => entry.on_turn_start = Some(body.to_string()),
                BodySlot::ModifyDamage => entry.modify_damage = Some(body.to_string()),
                _ => {
                    entry.actions.insert("probe".into(), body.to_string());
                }
            }
            doc.behaviors.mechanic.insert("probe".into(), entry);
        }
        BodySlot::CardOnPlay => {
            doc.cards = vec![CardEntryToml {
                key: "probe".into(),
                name: "Probe".into(),
                text: None,
                config: None,
            }];
            doc.behaviors.card.insert(
                "probe".into(),
                CardBehaviorEntry {
                    on_play: Some(body.to_string()),
                },
            );
        }
        BodySlot::VictoryTest => {
            doc.victory.win = vec![ConditionEntry {
                key: "probe".into(),
                test: body.to_string(),
                narration: None,
            }];
        }
    }
    doc
}

/// Compile `body` in isolation. `None` = valid; `Some(message)` carries the
/// compiler's error — spans inside it are relative to the body text.
#[must_use]
pub fn validate_body(slot: BodySlot, body: &str) -> Option<String> {
    if body.trim().is_empty() {
        return None;
    }
    let doc = probe_doc(slot, body);
    let toml_src = match toml::to_string(&doc) {
        Ok(s) => s,
        Err(e) => return Some(format!("serialize probe: {e}")),
    };
    compile(&toml_src).err().map(|e| e.to_string())
}

/// The authoritative gate's findings, in pipeline order.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct GateReport {
    /// The exported TOML (present whenever serialization succeeded).
    pub toml: Option<String>,
    /// A serialization or `compile()` failure (fail-fast — one at a time).
    pub compile_error: Option<String>,
    /// The assembler's collect-all validation problems.
    pub assemble_problems: Vec<String>,
    /// The engine's `validate_mechanics` shape-check failure.
    pub mechanics_error: Option<String>,
}

impl GateReport {
    /// Green: the campaign compiles, assembles, and loads.
    #[must_use]
    pub fn ok(&self) -> bool {
        self.compile_error.is_none()
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
            report.compile_error = Some(e);
            return report;
        }
    };
    report.toml = Some(toml_src.clone());
    let compiled = match compile(&toml_src) {
        Ok(c) => c,
        Err(e) => {
            report.compile_error = Some(e.to_string());
            return report;
        }
    };
    // Empty party = the pristine genesis — assemble runs the collect-all validate.
    let seats: [Seat; 0] = [];
    let snap = match assemble(&compiled.description, &compiled.catalog, &seats) {
        Ok(snap) => snap,
        Err(e) => {
            report.assemble_problems = e.problems.iter().map(ToString::to_string).collect();
            return report;
        }
    };
    let world = World::from_snapshot(snap);
    if let Err(e) = world.validate_mechanics(&compiled.catalog) {
        report.mechanics_error = Some(e.to_string());
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
    fn the_gate_passes_a_consistent_campaign() {
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
    }
}
