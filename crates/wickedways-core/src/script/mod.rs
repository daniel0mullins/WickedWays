//! Scripted-ops DSL (spec: 2026-07-06-rust-engine-scripted-ops-dsl-design.md).
//! A closed, serde-serializable AST + a pure, total, deterministic interpreter.
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
    let bad = |why: &str| Err(ProceduralViolation(format!("Behavior '{key}' is invalid: {why}")));
    match b {
        BehaviorScript::Mechanic { script } => {
            let hooks = [
                &script.hooks.on_round_start, &script.hooks.on_round_end,
                &script.hooks.on_turn_start, &script.hooks.on_turn_end,
                &script.hooks.on_action,
            ];
            for body in hooks.into_iter().flatten() {
                check_stmts(body, /*allow_pass=*/false, /*allow_emit=*/true)
                    .or_else(bad)?;
            }
            for body in script.actions.values() {
                check_stmts(body, false, true).or_else(bad)?;
            }
            Ok(())
        }
        BehaviorScript::Exit { script } => {
            check_expr(&script.can_pass).or_else(bad)?;
            check_stmts(&script.run_script, /*allow_pass=*/true, /*allow_emit=*/false)
                .or_else(bad)
        }
        BehaviorScript::Victory { script } => check_expr(&script.test).or_else(bad),
        BehaviorScript::Item { script } => {
            if let Some(body) = &script.on_use {
                check_stmts(body, /*allow_pass=*/false, /*allow_emit=*/true).or_else(bad)?;
            }
            if let Some(body) = &script.on_read {
                check_stmts(body, /*allow_pass=*/false, /*allow_emit=*/true).or_else(bad)?;
            }
            Ok(())
        }
    }
}

fn check_stmts(stmts: &[Stmt], allow_pass: bool, allow_emit: bool) -> Result<(), &'static str> {
    for s in stmts {
        match s {
            Stmt::Pass { .. } if !allow_pass => return Err("Pass is not legal in an effect body"),
            Stmt::Pass { value } => check_expr(value)?,
            Stmt::Emit { .. } if !allow_emit => return Err("Emit is not legal in an exit script"),
            Stmt::Emit { effect } => check_effect(effect)?,
            Stmt::Guard { cond } => check_expr(cond)?,
            Stmt::When { cond, then } => {
                check_expr(cond)?;
                check_stmts(then, allow_pass, allow_emit)?;
            }
            Stmt::SetState { value, .. } => check_expr(value)?,
            Stmt::SetStateIn { key, value, .. } => { check_expr(key)?; check_expr(value)?; }
        }
    }
    Ok(())
}

fn check_effect(t: &ast::EffectTemplate) -> Result<(), &'static str> {
    use ast::EffectTemplate as T;
    match t {
        T::Damage { target, amount } | T::Heal { target, amount } => {
            check_expr(target)?; check_expr(amount)
        }
        T::AdjustStat { target, delta, .. } => { check_expr(target)?; check_expr(delta) }
        T::GrantImmunity { target, turns } => { check_expr(target)?; check_expr(turns) }
        T::Cue { text } => check_expr(text),
        T::Status { fields } => {
            for f in fields {
                check_expr(&f.value)?;
                if let Some(e) = &f.emphasis { check_expr(e)?; }
            }
            Ok(())
        }
        T::GiveItem { from, to, item } => { check_expr(from)?; check_expr(to)?; check_expr(item) }
        T::SetVisible { target, visible } => { check_expr(target)?; check_expr(visible) }
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
        Expr::Bin { left, right, .. } => { check_expr(left)?; check_expr(right) }
        Expr::Not { expr } | Expr::Defined { expr } | Expr::Str { num: expr }
        | Expr::Length { list: expr } | Expr::First { list: expr } => check_expr(expr),
        Expr::IfElse { cond, then, r#else } => {
            check_expr(cond)?; check_expr(then)?; check_expr(r#else)
        }
        Expr::Index { list, index } => { check_expr(list)?; check_expr(index) }
        Expr::Includes { list, value } => { check_expr(list)?; check_expr(value) }
        Expr::Get { of, .. } | Expr::HasEquipped { of, .. }
        | Expr::HasItem { of, .. } | Expr::HasKey { of, .. } => check_expr(of),
        Expr::StateGetIn { key, .. } => check_expr(key),
        Expr::Some { list, pred } | Expr::Every { list, pred } => {
            check_expr(list)?; check_expr(pred)
        }
        Expr::Concat { parts } => { for p in parts { check_expr(p)?; } Ok(()) }
        Expr::Lit { .. } | Expr::MapLit { .. } | Expr::Round | Expr::MaxRounds
        | Expr::Party | Expr::Actor | Expr::Action | Expr::Damage | Expr::Element
        | Expr::StateGet { .. } => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::script::ast::{BehaviorScript, EffectTemplate, Expr, ItemScript, Stmt};
    use crate::script::value::Value;
    use crate::stats::StatType;

    #[test]
    fn validate_accepts_item_script_with_effect_bodies() {
        let b = BehaviorScript::Item {
            script: ItemScript {
                on_use: Some(alloc::vec![Stmt::Emit {
                    effect: EffectTemplate::AdjustStat {
                        target: Expr::Actor,
                        stat: StatType::Sanity,
                        delta: Expr::Lit { value: Value::Number(6.0) },
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
                    value: Expr::Lit { value: Value::Str("x".into()) },
                }]),
                on_read: None,
            },
        };
        assert!(validate_behavior("items/bad", &b).is_err());
    }
}
