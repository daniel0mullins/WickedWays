//! Lowers a `[behaviors.mechanic.<key>]` surface entry into a core
//! [`MechanicScript`]: a literal `init` state seed plus the five parsed hook
//! bodies. `actions`/`modifyDamage` are deferred to a later slice. Panic-free on
//! author input.
use wickedways_core::script::ast::{MechanicHooks, MechanicScript, Stmt};

use crate::author_doc::MechanicBehaviorEntry;
use crate::error::{CompileError, Span};
use crate::stmt::parse_stmts;

const BASE: Span = Span { line: 1, col: 1 };

fn hook(src: &Option<String>) -> Result<Option<Vec<Stmt>>, CompileError> {
    match src {
        Some(s) => Ok(Some(parse_stmts(s, BASE)?)),
        None => Ok(None),
    }
}

/// Lower a mechanic behavior entry into a [`MechanicScript`]. `init` becomes the
/// literal JSON state seed (absent → `{}`; a non-serializable value also falls
/// back to `{}`); each present `on_*` hook is parsed into a statement body.
pub(crate) fn to_mechanic_script(
    entry: &MechanicBehaviorEntry,
) -> Result<MechanicScript, CompileError> {
    let init = match &entry.init {
        Some(v) => serde_json::to_value(v).unwrap_or_else(|_| serde_json::json!({})),
        None => serde_json::json!({}),
    };
    Ok(MechanicScript {
        init,
        hooks: MechanicHooks {
            on_round_start: hook(&entry.on_round_start)?,
            on_round_end: hook(&entry.on_round_end)?,
            on_turn_start: hook(&entry.on_turn_start)?,
            on_turn_end: hook(&entry.on_turn_end)?,
            on_action: hook(&entry.on_action)?,
            modify_damage: None,
        },
        actions: Default::default(),
    })
}

#[cfg(test)]
mod tests {
    use super::to_mechanic_script;
    use crate::author_doc::MechanicBehaviorEntry;
    use serde_json::json;

    // Script `Value` numbers are f64, so a `-1` literal serializes as `-1.0`.
    // Canonicalize integral floats back to ints before comparing (the same
    // convention `stmt.rs`'s tests use), so the asserted JSON reads naturally.
    fn canon_numbers(v: &serde_json::Value) -> serde_json::Value {
        use serde_json::Value;
        match v {
            Value::Number(n) => {
                if let Some(f) = n.as_f64() {
                    if f.is_finite() && f.fract() == 0.0 && n.as_i64().is_none() && n.as_u64().is_none()
                    {
                        if f >= 0.0 && f <= u64::MAX as f64 {
                            return Value::Number((f as u64).into());
                        }
                        if f >= i64::MIN as f64 && f <= i64::MAX as f64 {
                            return Value::Number((f as i64).into());
                        }
                    }
                }
                v.clone()
            }
            Value::Array(a) => Value::Array(a.iter().map(canon_numbers).collect()),
            Value::Object(o) => {
                Value::Object(o.iter().map(|(k, x)| (k.clone(), canon_numbers(x))).collect())
            }
            _ => v.clone(),
        }
    }

    fn script_json(toml_src: &str) -> serde_json::Value {
        let entry: MechanicBehaviorEntry = toml::from_str(toml_src).expect("toml");
        let v = serde_json::to_value(to_mechanic_script(&entry).expect("convert")).expect("json");
        canon_numbers(&v)
    }

    #[test]
    fn init_and_on_turn_start_hook() {
        let v = script_json(r#"
            init = { }
            onTurnStart = "guard !hasEquipped(actor, 'lantern')\nemit adjustStat(actor, sanity, -1)"
        "#);
        assert_eq!(v, json!({
            "init":{},
            "hooks":{"onTurnStart":[
                {"kind":"guard","cond":{"kind":"not","expr":{"kind":"hasEquipped","of":{"kind":"actor"},"itemKey":"lantern"}}},
                {"kind":"emit","effect":{"kind":"adjustStat","target":{"kind":"actor"},"stat":"sanity","delta":{"kind":"lit","value":-1}}}]},
            "actions":{}
        }));
    }

    #[test]
    fn init_defaults_to_empty_object() {
        let v = script_json("onRoundStart = \"emit cue('dawn')\"");
        assert_eq!(v["init"], json!({}));
    }
}
