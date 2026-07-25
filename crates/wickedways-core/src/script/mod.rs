//! Scripted-ops DSL: a closed, serde-serializable AST + a pure, total,
//! deterministic interpreter.
//! `alloc`-only — this module must build under `--no-default-features`.
pub mod ast;
pub mod eval;
pub mod ops;
pub mod value;

use crate::error::ProceduralViolation;
use alloc::format;
use ast::{BehaviorScript, Expr, Stmt};

/// Load-time shape check for a scripted behavior — fail fast at load, never
/// mid-turn. The interpreter is total, so this rejects only AUTHORING mistakes:
/// a `Pass` in an effect body, an `Emit` in an exit script, a non-`MapLit`
/// `Lookup`/`Has` operand.
pub fn validate_behavior(key: &str, b: &BehaviorScript) -> Result<(), ProceduralViolation> {
    let bad = |why: &str| {
        Err(ProceduralViolation(format!(
            "Behavior '{key}' is invalid: {why}"
        )))
    };
    match b {
        BehaviorScript::Mechanic { script } => {
            let hooks = [
                &script.hooks.on_round_start,
                &script.hooks.on_round_end,
                &script.hooks.on_turn_start,
                &script.hooks.on_turn_end,
                &script.hooks.on_action,
            ];
            for body in hooks.into_iter().flatten() {
                check_stmts(body, /*allow_pass=*/ false, /*allow_emit=*/ true).or_else(bad)?;
            }
            for body in script.actions.values() {
                check_stmts(body, false, true).or_else(bad)?;
            }
            Ok(())
        }
        BehaviorScript::Exit { script } => {
            check_expr(&script.can_pass).or_else(bad)?;
            check_stmts(
                &script.run_script,
                /*allow_pass=*/ true,
                /*allow_emit=*/ false,
            )
            .or_else(bad)
        }
        BehaviorScript::Victory { script } => check_expr(&script.test).or_else(bad),
        BehaviorScript::Item { script } => {
            if let Some(body) = &script.on_use {
                check_stmts(body, /*allow_pass=*/ false, /*allow_emit=*/ true).or_else(bad)?;
            }
            if let Some(body) = &script.on_read {
                check_stmts(body, /*allow_pass=*/ false, /*allow_emit=*/ true).or_else(bad)?;
            }
            Ok(())
        }
        BehaviorScript::Npc { script } => {
            // Each entry's text `response` is a DSL Expr and its `effects` are
            // effect templates (allow_emit=true, allow_pass=false — a dialogue
            // entry is an effect context, not a script body). `match_` is data.
            check_dialogue_entry(&script.default).or_else(bad)?;
            for entry in &script.dialogue {
                check_dialogue_entry(entry).or_else(bad)?;
            }
            Ok(())
        }
        BehaviorScript::Scene { script } => {
            // `can_play` is a predicate; `on_enter`/`on_exit` are effect bodies
            // (allow_pass=false, allow_emit=true), like item/mechanic hook bodies.
            if let Some(pred) = &script.can_play {
                check_expr(pred).or_else(bad)?;
            }
            if let Some(body) = &script.on_enter {
                check_stmts(body, /*allow_pass=*/ false, /*allow_emit=*/ true).or_else(bad)?;
            }
            if let Some(body) = &script.on_exit {
                check_stmts(body, /*allow_pass=*/ false, /*allow_emit=*/ true).or_else(bad)?;
            }
            Ok(())
        }
    }
}

fn check_dialogue_entry(entry: &ast::DialogueEntry) -> Result<(), &'static str> {
    check_expr(&entry.response)?;
    for effect in &entry.effects {
        check_effect(effect)?;
    }
    Ok(())
}

fn check_stmts(stmts: &[Stmt], allow_pass: bool, allow_emit: bool) -> Result<(), &'static str> {
    for s in stmts {
        match s {
            Stmt::Pass { .. } if !allow_pass => return Err("Pass is not legal in an effect body"),
            Stmt::Emit { .. } if !allow_emit => return Err("Emit is not legal in an exit script"),
            Stmt::Emit { effect } => check_effect(effect)?,
            Stmt::Pass { value: e } | Stmt::Guard { cond: e } => check_expr(e)?,
            Stmt::When { cond, then } => {
                check_expr(cond)?;
                check_stmts(then, allow_pass, allow_emit)?;
            }
            Stmt::SetState { value, .. } => check_expr(value)?,
            Stmt::SetStateIn { key, value, .. } => {
                check_expr(key)?;
                check_expr(value)?;
            }
        }
    }
    Ok(())
}

fn check_effect(t: &ast::EffectTemplate) -> Result<(), &'static str> {
    use ast::EffectTemplate as T;
    match t {
        T::Damage { target, amount } | T::Heal { target, amount } => {
            check_expr(target)?;
            check_expr(amount)
        }
        T::AdjustStat { target, delta, .. } => {
            check_expr(target)?;
            check_expr(delta)
        }
        T::GrantImmunity { target, turns } => {
            check_expr(target)?;
            check_expr(turns)
        }
        T::Cue { text } => check_expr(text),
        T::Status { fields } => {
            for f in fields {
                check_expr(&f.value)?;
                if let Some(e) = &f.emphasis {
                    check_expr(e)?;
                }
            }
            Ok(())
        }
        T::GiveItem { from, to, item } => {
            check_expr(from)?;
            check_expr(to)?;
            check_expr(item)
        }
        T::SetVisible { target, visible } => {
            check_expr(target)?;
            check_expr(visible)
        }
    }
}

/// Recursive expression walk: `Lookup`/`Has` must take a `MapLit` map operand.
fn check_expr(e: &Expr) -> Result<(), &'static str> {
    match e {
        Expr::Lookup { map, key } | Expr::Has { map, key } => {
            if !matches!(map.as_ref(), Expr::MapLit { .. }) {
                return Err("Lookup/Has requires a MapLit operand");
            }
            check_expr(key)
        }
        Expr::Bin { left, right, .. } => {
            check_expr(left)?;
            check_expr(right)
        }
        Expr::Not { expr }
        | Expr::Defined { expr }
        | Expr::Str { num: expr }
        | Expr::Length { list: expr }
        | Expr::First { list: expr } => check_expr(expr),
        Expr::IfElse { cond, then, r#else } => {
            check_expr(cond)?;
            check_expr(then)?;
            check_expr(r#else)
        }
        Expr::Index { list, index } => {
            check_expr(list)?;
            check_expr(index)
        }
        Expr::Includes { list, value } => {
            check_expr(list)?;
            check_expr(value)
        }
        Expr::Get { of, .. }
        | Expr::HasEquipped { of, .. }
        | Expr::HasItem { of, .. }
        | Expr::HasKey { of, .. } => check_expr(of),
        Expr::StateGetIn { key, .. } => check_expr(key),
        Expr::Some { list, pred } | Expr::Every { list, pred } => {
            check_expr(list)?;
            check_expr(pred)
        }
        Expr::Concat { parts } => {
            for p in parts {
                check_expr(p)?;
            }
            Ok(())
        }
        Expr::Lit { .. }
        | Expr::MapLit { .. }
        | Expr::Round
        | Expr::MaxRounds
        | Expr::Party
        | Expr::Actor
        | Expr::Action
        | Expr::Damage
        | Expr::Element
        | Expr::StateGet { .. } => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::script::ast::{
        BehaviorScript, DialogueEntry, DialogueMatch, EffectTemplate, Expr, ItemScript, NpcScript,
        SceneScript, Stmt,
    };
    use crate::script::value::Value;
    use crate::stats::StatType;

    fn exact(text: &str, response: &str) -> DialogueEntry {
        DialogueEntry {
            match_: DialogueMatch::Exact { text: text.into() },
            response: Expr::Lit {
                value: Value::Str(response.into()),
            },
            effects: alloc::vec![],
            once: false,
        }
    }

    /// A well-formed NPC behavior: description + default + one exact + one fuzzy
    /// entry, plus an entry carrying an effect.
    fn sample_npc_script() -> NpcScript {
        NpcScript {
            description: "A hunched caretaker.".into(),
            default: exact("", "The caretaker says nothing of note."),
            dialogue: alloc::vec![
                exact("hello", "Good evening to you."),
                DialogueEntry {
                    match_: DialogueMatch::Fuzzy {
                        tokens: alloc::vec!["how".into(), "out".into()],
                    },
                    response: Expr::Lit {
                        value: Value::Str("The gate is west.".into())
                    },
                    effects: alloc::vec![],
                    once: false,
                },
                DialogueEntry {
                    match_: DialogueMatch::Exact { text: "key".into() },
                    response: Expr::Lit {
                        value: Value::Str("Take it.".into())
                    },
                    effects: alloc::vec![EffectTemplate::SetVisible {
                        target: Expr::Actor,
                        visible: Expr::Lit {
                            value: Value::Bool(true)
                        },
                    }],
                    once: true,
                },
            ],
        }
    }

    #[test]
    fn validate_accepts_item_script_with_effect_bodies() {
        let b = BehaviorScript::Item {
            script: ItemScript {
                on_use: Some(alloc::vec![Stmt::Emit {
                    effect: EffectTemplate::AdjustStat {
                        target: Expr::Actor,
                        stat: StatType::Sanity,
                        delta: Expr::Lit {
                            value: Value::Number(6.0)
                        },
                    },
                }]),
                on_read: None,
            },
        };
        assert!(validate_behavior("items/laudanum", &b).is_ok());
    }

    #[test]
    fn validate_rejects_pass_in_item_body() {
        // `Pass` is script-body-only (exit run_script); an item body is an effect
        // body, so a Pass statement must be rejected at load (allow_pass = false).
        let b = BehaviorScript::Item {
            script: ItemScript {
                on_use: Some(alloc::vec![Stmt::Pass {
                    value: Expr::Lit {
                        value: Value::Str("x".into())
                    },
                }]),
                on_read: None,
            },
        };
        assert!(validate_behavior("items/bad", &b).is_err());
    }

    #[test]
    fn validate_accepts_npc_script() {
        let b = BehaviorScript::Npc {
            script: sample_npc_script(),
        };
        assert!(validate_behavior("npc/caretaker", &b).is_ok());
    }

    #[test]
    fn validate_rejects_npc_ill_typed_effect() {
        // A dialogue entry's effect carries an ill-typed Expr: `Lookup` requires a
        // `MapLit` map operand, so a `Lookup` over `Actor` must be rejected at load.
        let mut script = sample_npc_script();
        script.dialogue.push(DialogueEntry {
            match_: DialogueMatch::Exact {
                text: "curse".into(),
            },
            response: Expr::Lit {
                value: Value::Str("Beware.".into()),
            },
            effects: alloc::vec![EffectTemplate::Cue {
                text: Expr::Lookup {
                    map: alloc::boxed::Box::new(Expr::Actor),
                    key: alloc::boxed::Box::new(Expr::Lit {
                        value: Value::Str("x".into())
                    }),
                },
            }],
            once: false,
        });
        let b = BehaviorScript::Npc { script };
        assert!(validate_behavior("npc/bad", &b).is_err());
    }

    #[test]
    fn validate_accepts_scene_script() {
        // A well-formed scene: a `can_play` predicate plus enter/exit effect
        // bodies (allow_emit=true). Mirrors the item-script accept test.
        let b = BehaviorScript::Scene {
            script: SceneScript {
                can_play: Some(Expr::Not {
                    expr: alloc::boxed::Box::new(Expr::Defined {
                        expr: alloc::boxed::Box::new(Expr::StateGet {
                            field: "played".into(),
                            default: Value::Bool(false),
                        }),
                    }),
                }),
                on_enter: Some(alloc::vec![Stmt::Emit {
                    effect: EffectTemplate::Cue {
                        text: Expr::Lit {
                            value: Value::Str("The candles gutter.".into())
                        },
                    },
                }]),
                on_exit: Some(alloc::vec![Stmt::SetState {
                    field: "played".into(),
                    value: Expr::Lit {
                        value: Value::Bool(true)
                    },
                }]),
            },
        };
        assert!(validate_behavior("scene/opening", &b).is_ok());
    }

    #[test]
    fn validate_rejects_pass_in_scene_body() {
        // A scene body is an effect body (allow_pass=false); `Pass` is
        // script-body-only, so a Pass statement must be rejected at load.
        let b = BehaviorScript::Scene {
            script: SceneScript {
                can_play: None,
                on_enter: Some(alloc::vec![Stmt::Pass {
                    value: Expr::Lit {
                        value: Value::Str("x".into())
                    },
                }]),
                on_exit: None,
            },
        };
        assert!(validate_behavior("scene/bad", &b).is_err());
    }

    #[test]
    fn npc_script_serde_round_trip() {
        let b = BehaviorScript::Npc {
            script: sample_npc_script(),
        };
        let json = serde_json::to_string(&b).expect("serialize");
        // `family = "npc"` family tag + the `match` rename both surface in JSON.
        assert!(
            json.contains("\"family\":\"npc\""),
            "family tag missing: {json}"
        );
        assert!(json.contains("\"match\""), "match rename missing: {json}");
        let back: BehaviorScript = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(b, back);
    }

    #[test]
    fn scene_script_serde_round_trip() {
        // Populated scene: a `can_play` predicate plus enter/exit effect bodies
        // (Emit + SetState), mirroring `validate_accepts_scene_script`.
        let b = BehaviorScript::Scene {
            script: SceneScript {
                can_play: Some(Expr::Not {
                    expr: alloc::boxed::Box::new(Expr::Defined {
                        expr: alloc::boxed::Box::new(Expr::StateGet {
                            field: "played".into(),
                            default: Value::Bool(false),
                        }),
                    }),
                }),
                on_enter: Some(alloc::vec![Stmt::Emit {
                    effect: EffectTemplate::Cue {
                        text: Expr::Lit {
                            value: Value::Str("The candles gutter.".into())
                        },
                    },
                }]),
                on_exit: Some(alloc::vec![Stmt::SetState {
                    field: "played".into(),
                    value: Expr::Lit {
                        value: Value::Bool(true)
                    },
                }]),
            },
        };
        let json = serde_json::to_string(&b).expect("serialize");
        // `family = "scene"` family tag + the camelCase `canPlay`/`onEnter`/`onExit`
        // renames all surface in JSON.
        assert!(
            json.contains("\"family\":\"scene\""),
            "family tag missing: {json}"
        );
        assert!(
            json.contains("\"canPlay\""),
            "canPlay rename missing: {json}"
        );
        assert!(
            json.contains("\"onEnter\""),
            "onEnter rename missing: {json}"
        );
        assert!(json.contains("\"onExit\""), "onExit rename missing: {json}");
        let back: BehaviorScript = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(b, back);

        // Empty scene: absent `can_play`/`on_enter`/`on_exit`. Per the serde shape,
        // `canPlay` (`#[serde(default)]`) is ALWAYS emitted (as `null`), while
        // `onEnter`/`onExit` (`skip_serializing_if = "Option::is_none"`) are omitted.
        let empty = BehaviorScript::Scene {
            script: SceneScript {
                can_play: None,
                on_enter: None,
                on_exit: None,
            },
        };
        let json = serde_json::to_string(&empty).expect("serialize");
        assert!(
            json.contains("\"canPlay\":null"),
            "canPlay should serialize as null: {json}"
        );
        assert!(
            !json.contains("\"onEnter\""),
            "onEnter should be skipped: {json}"
        );
        assert!(
            !json.contains("\"onExit\""),
            "onExit should be skipped: {json}"
        );
        let back: BehaviorScript = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(empty, back);
    }
}
