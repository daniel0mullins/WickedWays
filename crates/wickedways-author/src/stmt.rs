//! Block statement parser: a newline-separated `'''...'''` TOML body → the
//! closed [`Stmt`] list `assemble` consumes. Reuses [`parse_expr`] for embedded
//! expressions. A modding trust boundary — panic-free on author input: every
//! failure is a [`CompileError`], never an `unwrap`/`expect`/`panic!`.
//!
//! Implemented so far: `guard` / `when` / `set state.<f> = …` / `emit cue(…)` /
//! `emit adjustStat(…)` / `emit giveItem(…)` / `emit setVisible(…)`. The deferred
//! forms — `pass`, subscripted `set state.m[k] = …` (`SetStateIn`), and `emit` of
//! any effect other than `cue`/`adjustStat`/`giveItem`/`setVisible` — are REJECTED
//! with a clear `CompileError` rather than silently mis-lowered, so a later slice
//! can land them without a hidden behavior change.
//!
//! [`parse_effects`] parses an **emit-only** block into a `Vec<EffectTemplate>`
//! (dialogue/effect bodies): any non-`emit` statement is an error.

use wickedways_core::script::ast::{EffectTemplate, Stmt};
use wickedways_core::stats::StatType;

use crate::error::{CompileError, Span};
use crate::expr::parse_expr;

/// Parse a newline-separated block of statements into a `Vec<Stmt>`.
///
/// Statements are split on newlines at brace-depth 0 (so a multi-line
/// `when … { … }` stays one unit), then dispatched by leading keyword. Blank
/// lines are skipped. `base` is passed through to `parse_expr` for embedded
/// expressions.
pub(crate) fn parse_stmts(src: &str, base: Span) -> Result<Vec<Stmt>, CompileError> {
    let mut stmts = Vec::new();
    for unit in split_top_level(src) {
        let trimmed = unit.trim();
        if trimmed.is_empty() {
            continue;
        }
        stmts.push(parse_stmt(trimmed, base)?);
    }
    Ok(stmts)
}

/// Dispatch a single (already-trimmed, non-empty) statement by its leading
/// keyword. Any unrecognized keyword — INCLUDING the deferred `pass` — is an
/// `ExprParse` error.
fn parse_stmt(stmt: &str, base: Span) -> Result<Stmt, CompileError> {
    let (kw, rest) = split_keyword(stmt);
    match kw {
        "guard" => Ok(Stmt::Guard { cond: parse_expr(rest, base)? }),
        "when" => parse_when(rest, base),
        "set" => parse_set(rest, base),
        "emit" => parse_emit(rest, base),
        _ => Err(CompileError::ExprParse {
            span: base,
            message: format!("unknown statement keyword '{kw}'"),
        }),
    }
}

/// Split off the leading whitespace-delimited keyword, returning
/// `(keyword, remainder)` with the remainder left-trimmed.
fn split_keyword(s: &str) -> (&str, &str) {
    let s = s.trim();
    match s.find(char::is_whitespace) {
        Some(i) => (&s[..i], s[i..].trim_start()),
        None => (s, ""),
    }
}

/// `when <cond> { <stmts> }` — parse the condition (up to the first top-level
/// `{`) and RECURSE into the brace-delimited inner block.
fn parse_when(rest: &str, base: Span) -> Result<Stmt, CompileError> {
    let open = find_open_brace(rest).ok_or_else(|| CompileError::ExprParse {
        span: base,
        message: "expected '{' to open a when block".into(),
    })?;
    let cond = parse_expr(rest[..open].trim(), base)?;
    let close = matching_brace(rest, open).ok_or_else(|| CompileError::ExprParse {
        span: base,
        message: "unterminated when block (missing '}')".into(),
    })?;
    // `open` and `close` index the ASCII `{`/`}`, so `open + 1` is a char boundary.
    let then = parse_stmts(&rest[open + 1..close], base)?;
    Ok(Stmt::When { cond, then })
}

/// `set state.<field> = <expr>` — a plain-field state write. A subscripted
/// target (`set state.<map>[<key>] = …`, i.e. `SetStateIn`) is deferred and MUST
/// error here rather than be silently dropped.
fn parse_set(rest: &str, base: Span) -> Result<Stmt, CompileError> {
    // The first `=` is the assignment: the LHS `state.<field>` never contains
    // one, and a comparison `==` in the RHS only appears after it.
    let eq = rest.find('=').ok_or_else(|| CompileError::ExprParse {
        span: base,
        message: "expected '=' in a set statement".into(),
    })?;
    let lhs = rest[..eq].trim();
    // `=` is one ASCII byte, so `eq + 1` is a char boundary.
    let rhs = rest[eq + 1..].trim();
    let field = lhs.strip_prefix("state.").ok_or_else(|| CompileError::ExprParse {
        span: base,
        message: "set target must be `state.<field>`".into(),
    })?;
    // Reject a subscripted / dotted / empty field: the deferred `SetStateIn`
    // (`state.m[k]`) must surface as an error, never a silent drop.
    if field.is_empty() || !field.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(CompileError::ExprParse {
            span: base,
            message: format!(
                "set target `state.{field}` must be a plain field \
                 (map/subscripted `set state.m[k] = …` is not yet supported)"
            ),
        });
    }
    let value = parse_expr(rhs, base)?;
    Ok(Stmt::SetState { field: field.to_string(), value })
}

/// `emit <effect>(<args>)` — emittable effects: `cue`, `adjustStat`, `giveItem`,
/// `setVisible`. `emit` of any other effect name (`heal`, `damage`, `grantImmunity`,
/// `status`) MUST error rather than be mis-lowered.
fn parse_emit(rest: &str, base: Span) -> Result<Stmt, CompileError> {
    let open = rest.find('(').ok_or_else(|| CompileError::ExprParse {
        span: base,
        message: "expected `<effect>(<args>)` after emit".into(),
    })?;
    let effect_name = rest[..open].trim();
    let close = rest.rfind(')').ok_or_else(|| CompileError::ExprParse {
        span: base,
        message: "expected ')' to close the effect argument list".into(),
    })?;
    if close < open {
        return Err(CompileError::ExprParse {
            span: base,
            message: "malformed effect argument list".into(),
        });
    }
    // `open`/`close` index the ASCII `(`/`)`, so `open + 1` is a char boundary.
    let args_src = &rest[open + 1..close];
    // Split the comma-separated arguments at top level (commas nested inside
    // `(...)`/`[...]` or single-quoted strings do not separate arguments).
    let args = split_args(args_src);
    match effect_name {
        // `cue(<text>)` — 1 expression argument.
        "cue" => {
            if args.len() != 1 {
                return Err(CompileError::ExprParse {
                    span: base,
                    message: format!("`cue(...)` takes 1 argument (got {})", args.len()),
                });
            }
            let text = parse_expr(args[0].trim(), base)?;
            Ok(Stmt::Emit { effect: EffectTemplate::Cue { text } })
        }
        // `adjustStat(<target>, <stat>, <delta>)` — 3 args. arg1/arg3 are
        // expressions; arg2 is a BARE stat KEYWORD (not an expression) mapped to
        // `StatType`, so an unknown keyword errors rather than parsing as an id.
        "adjustStat" => {
            if args.len() != 3 {
                return Err(CompileError::ExprParse {
                    span: base,
                    message: format!("`adjustStat(...)` takes 3 arguments (got {})", args.len()),
                });
            }
            let target = parse_expr(args[0].trim(), base)?;
            let stat = parse_stat_keyword(args[1].trim(), base)?;
            let delta = parse_expr(args[2].trim(), base)?;
            Ok(Stmt::Emit { effect: EffectTemplate::AdjustStat { target, stat, delta } })
        }
        // `giveItem(<from>, <to>, <item>)` — 3 expression arguments. Hands `item`
        // from `from` to `to`; all three resolve as ids at eval.
        "giveItem" => {
            if args.len() != 3 {
                return Err(CompileError::ExprParse {
                    span: base,
                    message: format!("`giveItem(...)` takes 3 arguments (got {})", args.len()),
                });
            }
            let from = parse_expr(args[0].trim(), base)?;
            let to = parse_expr(args[1].trim(), base)?;
            let item = parse_expr(args[2].trim(), base)?;
            Ok(Stmt::Emit { effect: EffectTemplate::GiveItem { from, to, item } })
        }
        // `setVisible(<target>, <visible>)` — 2 expression arguments. Flips
        // `target`'s visibility flag; `visible` is evaluated for JS truthiness.
        "setVisible" => {
            if args.len() != 2 {
                return Err(CompileError::ExprParse {
                    span: base,
                    message: format!("`setVisible(...)` takes 2 arguments (got {})", args.len()),
                });
            }
            let target = parse_expr(args[0].trim(), base)?;
            let visible = parse_expr(args[1].trim(), base)?;
            Ok(Stmt::Emit { effect: EffectTemplate::SetVisible { target, visible } })
        }
        // Every other effect (heal, damage, grantImmunity, status, …) is deferred.
        _ => Err(CompileError::ExprParse {
            span: base,
            message: format!(
                "only `emit cue(...)`, `emit adjustStat(...)`, `emit giveItem(...)`, \
                 and `emit setVisible(...)` are supported (got `{effect_name}`)"
            ),
        }),
    }
}

/// Parse an **emit-only** block into its effect templates: run [`parse_stmts`],
/// then require every resulting statement be an `emit` (a
/// [`Stmt::Emit`]), collecting the [`EffectTemplate`]s. A non-`emit` statement
/// (`guard`/`when`/`set`/`pass`) is an `ExprParse` error — an effects body may
/// only emit. This is how dialogue effect bodies (a `Vec<EffectTemplate>`, not a
/// `Vec<Stmt>`) are parsed.
pub(crate) fn parse_effects(src: &str, base: Span) -> Result<Vec<EffectTemplate>, CompileError> {
    let mut effects = Vec::new();
    for stmt in parse_stmts(src, base)? {
        match stmt {
            Stmt::Emit { effect } => effects.push(effect),
            _ => {
                return Err(CompileError::ExprParse {
                    span: base,
                    message: "an effects body may only contain `emit <effect>(...)` statements"
                        .into(),
                });
            }
        }
    }
    Ok(effects)
}

/// Map a bare stat keyword (`sanity`/`health`/`energy`) to [`StatType`]. An
/// unknown keyword is an `ExprParse` error — the stat argument is a keyword, not
/// an expression, so it is never parsed as an identifier.
fn parse_stat_keyword(kw: &str, base: Span) -> Result<StatType, CompileError> {
    match kw {
        "sanity" => Ok(StatType::Sanity),
        "health" => Ok(StatType::Health),
        "energy" => Ok(StatType::Energy),
        _ => Err(CompileError::ExprParse {
            span: base,
            message: format!(
                "unknown stat `{kw}` (expected `sanity`, `health`, or `energy`)"
            ),
        }),
    }
}

/// Split an argument list on top-level commas, tracking `(`/`[` nesting and
/// single-quoted string state so a comma inside a nested expression or string
/// literal does not separate arguments. An empty source yields no arguments.
fn split_args(src: &str) -> Vec<String> {
    if src.trim().is_empty() {
        return Vec::new();
    }
    let mut args = Vec::new();
    let mut current = String::new();
    let mut depth: i32 = 0;
    let mut in_str = false;
    for c in src.chars() {
        match c {
            '\'' => {
                in_str = !in_str;
                current.push(c);
            }
            '(' | '[' if !in_str => {
                depth += 1;
                current.push(c);
            }
            ')' | ']' if !in_str => {
                depth -= 1;
                current.push(c);
            }
            ',' if !in_str && depth <= 0 => {
                args.push(std::mem::take(&mut current));
            }
            _ => current.push(c),
        }
    }
    args.push(current);
    args
}

/// Split `src` into statement units on newlines at brace-depth 0, tracking
/// single-quoted string state (so `{`/`}`/newlines inside a literal don't count).
/// Blank units are dropped.
fn split_top_level(src: &str) -> Vec<String> {
    let mut units = Vec::new();
    let mut current = String::new();
    let mut depth: i32 = 0;
    let mut in_str = false;
    for c in src.chars() {
        match c {
            '\'' => {
                in_str = !in_str;
                current.push(c);
            }
            '{' if !in_str => {
                depth += 1;
                current.push(c);
            }
            '}' if !in_str => {
                depth -= 1;
                current.push(c);
            }
            '\n' if !in_str && depth <= 0 => {
                if !current.trim().is_empty() {
                    units.push(std::mem::take(&mut current));
                } else {
                    current.clear();
                }
            }
            _ => current.push(c),
        }
    }
    if !current.trim().is_empty() {
        units.push(current);
    }
    units
}

/// Byte index of the first `{` not inside a single-quoted string, if any.
fn find_open_brace(s: &str) -> Option<usize> {
    let mut in_str = false;
    for (i, c) in s.char_indices() {
        match c {
            '\'' => in_str = !in_str,
            '{' if !in_str => return Some(i),
            _ => {}
        }
    }
    None
}

/// Byte index of the `}` matching the `{` at `open`, tracking nesting and
/// single-quoted strings, if any.
fn matching_brace(s: &str, open: usize) -> Option<usize> {
    let mut depth: i32 = 0;
    let mut in_str = false;
    for (i, c) in s.char_indices() {
        if i < open {
            continue;
        }
        match c {
            '\'' => in_str = !in_str,
            '{' if !in_str => depth += 1,
            '}' if !in_str => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{parse_effects, parse_stmts};
    use crate::error::{CompileError, Span};
    use serde_json::json;

    /// The differential gate's number normalization (copied verbatim from the
    /// `expr` test module / `wickedways-assemble/tests/goldens.rs`, per the
    /// plan's Global Constraints — "copy it; do not re-derive"). `Value::Number`
    /// is an `f64`, so a numeric literal always serializes as a whole float
    /// (`0.0`), while these tests write it as a bare int (`0`) — and
    /// `serde_json`'s `Number` equality distinguishes `0.0` from `0`. Collapsing
    /// integer-valued floats to integers makes the comparison faithful to JSON
    /// value equality (the gate's authoritative semantics). It is NOT a
    /// relaxation: array order, keys, non-whole numbers, strings, and
    /// presence/absence all still differ.
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

    fn s(src: &str) -> serde_json::Value {
        let v = serde_json::to_value(parse_stmts(src, Span { line: 1, col: 1 }).expect("parse")).unwrap();
        canon_numbers(&v)
    }

    #[test]
    fn emit_cue_and_set_state() {
        assert_eq!(s("emit cue('hi')\nset state.seen = true"), json!([
            {"kind":"emit","effect":{"kind":"cue","text":{"kind":"lit","value":"hi"}}},
            {"kind":"setState","field":"seen","value":{"kind":"lit","value":true}}
        ]));
    }

    #[test]
    fn guard_and_nested_when() {
        assert_eq!(s("guard round == 0\nwhen round == 1 {\n  emit cue('x')\n}"), json!([
            {"kind":"guard","cond":{"kind":"bin","op":"eq","left":{"kind":"round"},"right":{"kind":"lit","value":0}}},
            {"kind":"when","cond":{"kind":"bin","op":"eq","left":{"kind":"round"},"right":{"kind":"lit","value":1}},
             "then":[{"kind":"emit","effect":{"kind":"cue","text":{"kind":"lit","value":"x"}}}]}
        ]));
    }

    #[test]
    fn pass_is_rejected() {
        assert!(matches!(parse_stmts("pass 'x'", Span { line: 1, col: 1 }).unwrap_err(),
            CompileError::ExprParse { .. }));
    }

    #[test]
    fn non_cue_effect_is_rejected() {
        assert!(matches!(
            parse_stmts("emit damage(actor, 5)", Span { line: 1, col: 1 }).unwrap_err(),
            CompileError::ExprParse { .. }
        ));
    }

    #[test]
    fn emit_adjust_stat() {
        assert_eq!(s("emit adjustStat(actor, sanity, 6)"), serde_json::json!([
            {"kind":"emit","effect":{"kind":"adjustStat","target":{"kind":"actor"},
             "stat":"sanity","delta":{"kind":"lit","value":6}}}
        ]));
    }

    #[test]
    fn adjust_stat_unknown_stat_rejected() {
        assert!(matches!(
            parse_stmts("emit adjustStat(actor, vigor, 6)", Span { line: 1, col: 1 }).unwrap_err(),
            CompileError::ExprParse { .. }
        ));
    }

    #[test]
    fn heal_effect_still_rejected() {
        // Emittable effects: cue/adjustStat/giveItem/setVisible; heal (and every other effect) still errors.
        assert!(matches!(
            parse_stmts("emit heal(actor, 6)", Span { line: 1, col: 1 }).unwrap_err(),
            CompileError::ExprParse { .. }
        ));
    }

    #[test]
    fn emit_give_item_and_set_visible() {
        assert_eq!(s("emit giveItem('npc:X', actor, 'npc:X:item#0')\nemit setVisible('npc:X', false)"),
            serde_json::json!([
            {"kind":"emit","effect":{"kind":"giveItem",
                "from":{"kind":"lit","value":"npc:X"},"to":{"kind":"actor"},
                "item":{"kind":"lit","value":"npc:X:item#0"}}},
            {"kind":"emit","effect":{"kind":"setVisible",
                "target":{"kind":"lit","value":"npc:X"},"visible":{"kind":"lit","value":false}}}
        ]));
    }

    #[test]
    fn parse_effects_collects_emit_only() {
        let effs = parse_effects("emit giveItem('a', actor, 'b')\nemit setVisible('a', false)",
            Span { line: 1, col: 1 }).expect("parse");
        assert_eq!(serde_json::to_value(&effs).unwrap(), serde_json::json!([
            {"kind":"giveItem","from":{"kind":"lit","value":"a"},"to":{"kind":"actor"},"item":{"kind":"lit","value":"b"}},
            {"kind":"setVisible","target":{"kind":"lit","value":"a"},"visible":{"kind":"lit","value":false}}
        ]));
    }

    #[test]
    fn parse_effects_rejects_non_emit() {
        // guard/when/set/pass are not effects — an effects body must be emit-only.
        assert!(parse_effects("set state.x = 1", Span { line: 1, col: 1 }).is_err());
    }

    #[test]
    fn set_state_in_map_is_rejected() {
        // `set state.m[k] = v` (SetStateIn) is deferred; must error, not silently drop.
        assert!(matches!(
            parse_stmts("set state.visits[actor] = true", Span { line: 1, col: 1 }).unwrap_err(),
            CompileError::ExprParse { .. }
        ));
    }
}
