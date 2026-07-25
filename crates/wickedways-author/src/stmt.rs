//! Block statement parser: a newline-separated `'''...'''` TOML body → the
//! closed [`Stmt`] list `assemble` consumes. Reuses [`parse_expr`] for embedded
//! expressions. A modding trust boundary — panic-free on author input: every
//! failure is a [`CompileError`], never an `unwrap`/`expect`/`panic!`.
//!
//! Statement forms: `guard` / `when`, the plain and subscripted `set` targets
//! (`set state.<f> = …` → `SetState`; `set state.m[k] = …` → `SetStateIn`),
//! `emit` of the full effect family (`cue` / `adjustStat` / `giveItem` /
//! `setVisible` / `status` / `damage` / `heal` / `grantImmunity`), plus
//! `pass <expr>` in **script** bodies (via [`parse_script`]). An unknown
//! statement keyword or effect name is REJECTED with a clear `CompileError`
//! rather than silently mis-lowered; `pass` outside a script body is likewise
//! an error.
//!
//! [`parse_effects`] parses an **emit-only** block into a `Vec<EffectTemplate>`
//! (dialogue/effect bodies): any non-`emit` statement is an error.

use wickedways_core::script::ast::{EffectTemplate, FieldTemplate, Stmt};
use wickedways_core::stats::StatType;

use crate::error::{CompileError, Span};
use crate::expr::parse_expr;

/// Parse a newline-separated block of statements into a `Vec<Stmt>`.
///
/// Statements are split on newlines at brace-depth 0 (so a multi-line
/// `when … { … }` stays one unit), then dispatched by leading keyword. Blank
/// lines are skipped. `base` is passed through to `parse_expr` for embedded
/// expressions.
/// Recursion-depth ceiling for nested `when` blocks. A modding trust boundary:
/// deeply-nested `when { when { … } }` author input would otherwise overflow the
/// stack and abort. Real bodies nest a level or two; this is a comfortable margin.
const MAX_STMT_DEPTH: usize = 128;

pub(crate) fn parse_stmts(src: &str, base: Span) -> Result<Vec<Stmt>, CompileError> {
    parse_body(src, base, false, 0)
}

/// Parse a **script** body — an exit `runScript` — where `pass <expr>` (exit
/// narration, `Stmt::Pass`) is legal. Effect/hook bodies use [`parse_stmts`],
/// which rejects `pass`.
pub(crate) fn parse_script(src: &str, base: Span) -> Result<Vec<Stmt>, CompileError> {
    parse_body(src, base, true, 0)
}

/// Parse a newline-separated block into a `Vec<Stmt>`. `allow_pass` gates the
/// `pass` statement (legal only in script bodies); `depth` is the nested-`when`
/// recursion depth, capped at [`MAX_STMT_DEPTH`] against stack overflow.
fn parse_body(
    src: &str,
    base: Span,
    allow_pass: bool,
    depth: usize,
) -> Result<Vec<Stmt>, CompileError> {
    if depth > MAX_STMT_DEPTH {
        return Err(CompileError::ExprParse {
            span: base,
            message: "statement body nested too deeply".into(),
        });
    }
    let mut stmts = Vec::new();
    for unit in split_top_level(src) {
        let trimmed = unit.trim();
        if trimmed.is_empty() {
            continue;
        }
        stmts.push(parse_stmt(trimmed, base, allow_pass, depth)?);
    }
    Ok(stmts)
}

/// Dispatch a single (already-trimmed, non-empty) statement by its leading
/// keyword. `pass` is accepted only when `allow_pass` (script bodies); anywhere
/// else — and any other unrecognized keyword — is an `ExprParse` error.
fn parse_stmt(
    stmt: &str,
    base: Span,
    allow_pass: bool,
    depth: usize,
) -> Result<Stmt, CompileError> {
    let (kw, rest) = split_keyword(stmt);
    match kw {
        "guard" => Ok(Stmt::Guard {
            cond: parse_expr(rest, base)?,
        }),
        "when" => parse_when(rest, base, allow_pass, depth),
        "set" => parse_set(rest, base),
        "emit" => parse_emit(rest, base),
        // `pass <expr>` — exit narration (the last `Pass` wins). Script-only.
        "pass" if allow_pass => Ok(Stmt::Pass {
            value: parse_expr(rest, base)?,
        }),
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
/// `{`) and RECURSE into the brace-delimited inner block. `allow_pass` threads
/// through so a `pass` inside a script-body `when` stays legal.
fn parse_when(
    rest: &str,
    base: Span,
    allow_pass: bool,
    depth: usize,
) -> Result<Stmt, CompileError> {
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
    let then = parse_body(&rest[open + 1..close], base, allow_pass, depth + 1)?;
    Ok(Stmt::When { cond, then })
}

/// `set state.<field> = <expr>` (a plain-field write, `SetState`) or
/// `set state.<map>[<key>] = <expr>` (a dynamic string-keyed map write,
/// `SetStateIn`, where `<key>` is an expression).
fn parse_set(rest: &str, base: Span) -> Result<Stmt, CompileError> {
    // Find the assignment `=`: a lone `=` at bracket-depth 0 (so `==` inside the
    // RHS, or a comparison inside a `[<key>]` subscript, is not mistaken for it).
    let eq = find_assignment_eq(rest).ok_or_else(|| CompileError::ExprParse {
        span: base,
        message: "expected '=' in a set statement".into(),
    })?;
    let lhs = rest[..eq].trim();
    // `=` is one ASCII byte, so `eq + 1` is a char boundary.
    let rhs = rest[eq + 1..].trim();
    let target = lhs
        .strip_prefix("state.")
        .ok_or_else(|| CompileError::ExprParse {
            span: base,
            message: "set target must be `state.<field>` or `state.<map>[<key>]`".into(),
        })?;
    let value = parse_expr(rhs, base)?;

    // Subscripted target `state.<map>[<key>]` -> SetStateIn.
    if let Some(open) = target.find('[') {
        let map_field = &target[..open];
        let close = target
            .strip_suffix(']')
            .map(|_| target.len() - 1)
            .filter(|&c| c > open);
        let close = close.ok_or_else(|| CompileError::ExprParse {
            span: base,
            message: "set map target must be `state.<map>[<key>]`".into(),
        })?;
        if map_field.is_empty()
            || !map_field
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            return Err(CompileError::ExprParse {
                span: base,
                message: format!("set map field `{map_field}` must be a plain field"),
            });
        }
        // `[`/`]` are ASCII, so `open + 1`/`close` are char boundaries.
        let key = parse_expr(target[open + 1..close].trim(), base)?;
        return Ok(Stmt::SetStateIn {
            map_field: map_field.to_string(),
            key,
            value,
        });
    }

    // Plain field `state.<field>` -> SetState.
    if target.is_empty()
        || !target
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return Err(CompileError::ExprParse {
            span: base,
            message: format!(
                "set target `state.{target}` must be a plain field or `state.<map>[<key>]`"
            ),
        });
    }
    Ok(Stmt::SetState {
        field: target.to_string(),
        value,
    })
}

/// String-state tracker shared by the top-level scanners: `None` outside a string,
/// `Some(q)` inside one opened by quote `q` (`'` or `"`). The other quote kind inside
/// a string is a literal character — so a double-quoted string may contain
/// apostrophes (the storyteller lore) and a single-quoted one may contain `"`.
fn track_quote(state: Option<char>, c: char) -> Option<char> {
    match state {
        None if c == '\'' || c == '"' => Some(c),
        Some(q) if q == c => None,
        other => other,
    }
}

/// Byte index of the assignment `=`: a single `=` (not part of `==`/`!=`/`<=`/
/// `>=`) at bracket-depth 0 and outside a string. `None` if absent.
fn find_assignment_eq(s: &str) -> Option<usize> {
    let mut depth: i32 = 0;
    let mut quote: Option<char> = None;
    let bytes = s.as_bytes();
    for (i, c) in s.char_indices() {
        match c {
            '\'' | '"' => quote = track_quote(quote, c),
            '[' | '(' if quote.is_none() => depth += 1,
            ']' | ')' if quote.is_none() => depth -= 1,
            '=' if quote.is_none() && depth <= 0 => {
                let prev = if i > 0 { bytes[i - 1] } else { b' ' };
                let next = if i + 1 < bytes.len() {
                    bytes[i + 1]
                } else {
                    b' '
                };
                // Skip `==`; skip the second `=` of `!=`/`<=`/`>=`/`==`.
                if next != b'=' && !matches!(prev, b'=' | b'!' | b'<' | b'>') {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
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
            Ok(Stmt::Emit {
                effect: EffectTemplate::Cue { text },
            })
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
            Ok(Stmt::Emit {
                effect: EffectTemplate::AdjustStat {
                    target,
                    stat,
                    delta,
                },
            })
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
            Ok(Stmt::Emit {
                effect: EffectTemplate::GiveItem { from, to, item },
            })
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
            Ok(Stmt::Emit {
                effect: EffectTemplate::SetVisible { target, visible },
            })
        }
        // `damage(<target>, <amount>)` / `heal(<target>, <amount>)` — adjust Health
        // by a magnitude; `grantImmunity(<target>, <turns>)` — grant all-status
        // immunity. Each is 2 expression arguments.
        "damage" | "heal" | "grantImmunity" => {
            if args.len() != 2 {
                return Err(CompileError::ExprParse {
                    span: base,
                    message: format!(
                        "`{effect_name}(...)` takes 2 arguments (got {})",
                        args.len()
                    ),
                });
            }
            let target = parse_expr(args[0].trim(), base)?;
            let second = parse_expr(args[1].trim(), base)?;
            Ok(Stmt::Emit {
                effect: match effect_name {
                    "damage" => EffectTemplate::Damage {
                        target,
                        amount: second,
                    },
                    "heal" => EffectTemplate::Heal {
                        target,
                        amount: second,
                    },
                    // The match arm restricts this to "grantImmunity".
                    _ => EffectTemplate::GrantImmunity {
                        target,
                        turns: second,
                    },
                },
            })
        }
        // `status(field(<label>, <value>[, <emphasis>]), …)` — a HUD status readout.
        // Each argument is a `field(...)` form; the whole list becomes the effect's
        // `Vec<FieldTemplate>`.
        "status" => {
            let mut fields = Vec::with_capacity(args.len());
            for arg in &args {
                fields.push(parse_field(arg.trim(), base)?);
            }
            Ok(Stmt::Emit {
                effect: EffectTemplate::Status { fields },
            })
        }
        // The effect family above is exhaustive; an unrecognized name is an error.
        _ => Err(CompileError::ExprParse {
            span: base,
            message: format!(
                "unknown effect `{effect_name}` (expected cue/adjustStat/giveItem/setVisible/\
                 status/damage/heal/grantImmunity)"
            ),
        }),
    }
}

/// Parse one `field(<label>, <value>[, <emphasis>])` argument of an `emit
/// status(...)` into a [`FieldTemplate`]. `label` is a string literal; `value` and
/// the optional `emphasis` are expressions.
fn parse_field(src: &str, base: Span) -> Result<FieldTemplate, CompileError> {
    let open = src.find('(').ok_or_else(|| CompileError::ExprParse {
        span: base,
        message: "status entries must be `field(<label>, <value>[, <emphasis>])`".into(),
    })?;
    if src[..open].trim() != "field" {
        return Err(CompileError::ExprParse {
            span: base,
            message: format!(
                "expected `field(...)` in status, got `{}`",
                src[..open].trim()
            ),
        });
    }
    let close = src
        .rfind(')')
        .filter(|&c| c > open)
        .ok_or_else(|| CompileError::ExprParse {
            span: base,
            message: "unterminated `field(...)` in status".into(),
        })?;
    // `(`/`)` are ASCII, so `open + 1`/`close` are char boundaries.
    let field_args = split_args(&src[open + 1..close]);
    if field_args.len() < 2 || field_args.len() > 3 {
        return Err(CompileError::ExprParse {
            span: base,
            message: format!(
                "field(...) takes 2 or 3 arguments (got {})",
                field_args.len()
            ),
        });
    }
    let wickedways_core::script::ast::Expr::Lit {
        value: wickedways_core::script::value::Value::Str(label),
    } = parse_expr(field_args[0].trim(), base)?
    else {
        return Err(CompileError::ExprParse {
            span: base,
            message: "field's first argument (label) must be a string literal".into(),
        });
    };
    let value = parse_expr(field_args[1].trim(), base)?;
    let emphasis = match field_args.get(2) {
        Some(e) => Some(parse_expr(e.trim(), base)?),
        None => None,
    };
    Ok(FieldTemplate {
        label,
        value,
        emphasis,
    })
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
            message: format!("unknown stat `{kw}` (expected `sanity`, `health`, or `energy`)"),
        }),
    }
}

/// Split an argument list on top-level commas, tracking `(`/`[` nesting and
/// string state (both quote kinds) so a comma inside a nested expression or string
/// literal does not separate arguments. An empty source yields no arguments.
fn split_args(src: &str) -> Vec<String> {
    if src.trim().is_empty() {
        return Vec::new();
    }
    let mut args = Vec::new();
    let mut current = String::new();
    let mut depth: i32 = 0;
    let mut quote: Option<char> = None;
    for c in src.chars() {
        match c {
            '\'' | '"' => {
                quote = track_quote(quote, c);
                current.push(c);
            }
            '(' | '[' if quote.is_none() => {
                depth += 1;
                current.push(c);
            }
            ')' | ']' if quote.is_none() => {
                depth -= 1;
                current.push(c);
            }
            ',' if quote.is_none() && depth <= 0 => {
                args.push(std::mem::take(&mut current));
            }
            _ => current.push(c),
        }
    }
    args.push(current);
    args
}

/// Split `src` into statement units on newlines at brace-depth 0, tracking string
/// state (both quote kinds) so `{`/`}`/newlines inside a literal don't count.
/// Blank units are dropped.
fn split_top_level(src: &str) -> Vec<String> {
    let mut units = Vec::new();
    let mut current = String::new();
    let mut depth: i32 = 0;
    let mut quote: Option<char> = None;
    for c in src.chars() {
        match c {
            '\'' | '"' => {
                quote = track_quote(quote, c);
                current.push(c);
            }
            '{' if quote.is_none() => {
                depth += 1;
                current.push(c);
            }
            '}' if quote.is_none() => {
                depth -= 1;
                current.push(c);
            }
            '\n' if quote.is_none() && depth <= 0 => {
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

/// Byte index of the first `{` not inside a string, if any.
fn find_open_brace(s: &str) -> Option<usize> {
    let mut quote: Option<char> = None;
    for (i, c) in s.char_indices() {
        match c {
            '\'' | '"' => quote = track_quote(quote, c),
            '{' if quote.is_none() => return Some(i),
            _ => {}
        }
    }
    None
}

/// Byte index of the `}` matching the `{` at `open`, tracking nesting and string
/// state (both quote kinds), if any.
fn matching_brace(s: &str, open: usize) -> Option<usize> {
    let mut depth: i32 = 0;
    let mut quote: Option<char> = None;
    for (i, c) in s.char_indices() {
        if i < open {
            continue;
        }
        match c {
            '\'' | '"' => quote = track_quote(quote, c),
            '{' if quote.is_none() => depth += 1,
            '}' if quote.is_none() => {
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

    /// The differential gate's number normalization, copied verbatim from the
    /// `expr` test module / `wickedways-assemble/tests/goldens.rs` (keep the
    /// copies identical; do not re-derive it). `Value::Number`
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
                    if f.is_finite()
                        && f.fract() == 0.0
                        && n.as_i64().is_none()
                        && n.as_u64().is_none()
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
            Value::Object(o) => Value::Object(
                o.iter()
                    .map(|(k, x)| (k.clone(), canon_numbers(x)))
                    .collect(),
            ),
            _ => v.clone(),
        }
    }

    fn s(src: &str) -> serde_json::Value {
        let v = serde_json::to_value(parse_stmts(src, Span { line: 1, col: 1 }).expect("parse"))
            .unwrap();
        canon_numbers(&v)
    }

    #[test]
    fn emit_cue_and_set_state() {
        assert_eq!(
            s("emit cue('hi')\nset state.seen = true"),
            json!([
                {"kind":"emit","effect":{"kind":"cue","text":{"kind":"lit","value":"hi"}}},
                {"kind":"setState","field":"seen","value":{"kind":"lit","value":true}}
            ])
        );
    }

    #[test]
    fn guard_and_nested_when() {
        assert_eq!(
            s("guard round == 0\nwhen round == 1 {\n  emit cue('x')\n}"),
            json!([
                {"kind":"guard","cond":{"kind":"bin","op":"eq","left":{"kind":"round"},"right":{"kind":"lit","value":0}}},
                {"kind":"when","cond":{"kind":"bin","op":"eq","left":{"kind":"round"},"right":{"kind":"lit","value":1}},
                 "then":[{"kind":"emit","effect":{"kind":"cue","text":{"kind":"lit","value":"x"}}}]}
            ])
        );
    }

    #[test]
    fn deeply_nested_when_errors_not_panics() {
        // Nested `when { when { … } }` past the depth cap is a clean error, not a
        // stack-overflow abort.
        let body = format!(
            "{}emit cue('x')\n{}",
            "when actor {\n".repeat(4000),
            "}\n".repeat(4000)
        );
        assert!(matches!(
            parse_stmts(&body, Span { line: 1, col: 1 }).unwrap_err(),
            CompileError::ExprParse { .. }
        ));
    }

    #[test]
    fn pass_is_rejected_in_effect_bodies() {
        // `pass` is script-only: an effect/hook body (parse_stmts) still rejects it.
        assert!(matches!(
            parse_stmts("pass 'x'", Span { line: 1, col: 1 }).unwrap_err(),
            CompileError::ExprParse { .. }
        ));
    }

    #[test]
    fn pass_is_accepted_in_script_bodies() {
        // A script body (exit runScript) accepts `pass <expr>`, incl. nested in `when`.
        let v = serde_json::to_value(
            super::parse_script(
                "when !stateGet('unlocked', false) {\n  set state.unlocked = true\n  pass 'opened'\n}",
                Span { line: 1, col: 1 },
            )
            .expect("parse"),
        )
        .unwrap();
        assert_eq!(
            v,
            json!([{
            "kind":"when",
            "cond":{"kind":"not","expr":{"kind":"stateGet","field":"unlocked","default":false}},
            "then":[
                {"kind":"setState","field":"unlocked","value":{"kind":"lit","value":true}},
                {"kind":"pass","value":{"kind":"lit","value":"opened"}}
            ]}])
        );
    }

    #[test]
    fn malformed_emit_is_rejected() {
        // A missing argument list is still a parse error.
        assert!(matches!(
            parse_stmts("emit cue", Span { line: 1, col: 1 }).unwrap_err(),
            CompileError::ExprParse { .. }
        ));
    }

    #[test]
    fn emit_adjust_stat() {
        assert_eq!(
            s("emit adjustStat(actor, sanity, 6)"),
            serde_json::json!([
                {"kind":"emit","effect":{"kind":"adjustStat","target":{"kind":"actor"},
                 "stat":"sanity","delta":{"kind":"lit","value":6}}}
            ])
        );
    }

    #[test]
    fn adjust_stat_negative_delta() {
        assert_eq!(
            s("emit adjustStat(actor, sanity, -1)"),
            serde_json::json!([
                {"kind":"emit","effect":{"kind":"adjustStat","target":{"kind":"actor"},
                 "stat":"sanity","delta":{"kind":"lit","value":-1}}}
            ])
        );
    }

    #[test]
    fn adjust_stat_unknown_stat_rejected() {
        assert!(matches!(
            parse_stmts("emit adjustStat(actor, vigor, 6)", Span { line: 1, col: 1 }).unwrap_err(),
            CompileError::ExprParse { .. }
        ));
    }

    #[test]
    fn damage_heal_grant_immunity_effects() {
        assert_eq!(
            s("emit damage(actor, 5)"),
            json!([{"kind":"emit","effect":{
            "kind":"damage","target":{"kind":"actor"},"amount":{"kind":"lit","value":5}}}])
        );
        assert_eq!(
            s("emit heal(actor, 6)"),
            json!([{"kind":"emit","effect":{
            "kind":"heal","target":{"kind":"actor"},"amount":{"kind":"lit","value":6}}}])
        );
        assert_eq!(
            s("emit grantImmunity(actor, 2)"),
            json!([{"kind":"emit","effect":{
            "kind":"grantImmunity","target":{"kind":"actor"},"turns":{"kind":"lit","value":2}}}])
        );
    }

    #[test]
    fn unknown_effect_is_rejected() {
        // The effect family is exhaustive; an unknown effect name errors.
        assert!(matches!(
            parse_stmts("emit frobnicate(actor, 6)", Span { line: 1, col: 1 }).unwrap_err(),
            CompileError::ExprParse { .. }
        ));
    }

    #[test]
    fn emit_give_item_and_set_visible() {
        assert_eq!(
            s("emit giveItem('npc:X', actor, 'npc:X:item#0')\nemit setVisible('npc:X', false)"),
            serde_json::json!([
                {"kind":"emit","effect":{"kind":"giveItem",
                    "from":{"kind":"lit","value":"npc:X"},"to":{"kind":"actor"},
                    "item":{"kind":"lit","value":"npc:X:item#0"}}},
                {"kind":"emit","effect":{"kind":"setVisible",
                    "target":{"kind":"lit","value":"npc:X"},"visible":{"kind":"lit","value":false}}}
            ])
        );
    }

    #[test]
    fn parse_effects_collects_emit_only() {
        let effs = parse_effects(
            "emit giveItem('a', actor, 'b')\nemit setVisible('a', false)",
            Span { line: 1, col: 1 },
        )
        .expect("parse");
        assert_eq!(
            serde_json::to_value(&effs).unwrap(),
            serde_json::json!([
                {"kind":"giveItem","from":{"kind":"lit","value":"a"},"to":{"kind":"actor"},"item":{"kind":"lit","value":"b"}},
                {"kind":"setVisible","target":{"kind":"lit","value":"a"},"visible":{"kind":"lit","value":false}}
            ])
        );
    }

    #[test]
    fn parse_effects_rejects_non_emit() {
        // guard/when/set/pass are not effects — an effects body must be emit-only.
        assert!(parse_effects("set state.x = 1", Span { line: 1, col: 1 }).is_err());
    }

    #[test]
    fn set_state_in_map_write() {
        // `set state.<map>[<keyExpr>] = <value>` -> SetStateIn (the storyteller's
        // `seen[action.room.name] = true`). The key is a full expression.
        assert_eq!(
            s("set state.seen[action.room.name] = true"),
            json!([{
            "kind":"setStateIn","mapField":"seen",
            "key":{"kind":"get","field":"name","of":{"kind":"get","field":"room","of":{"kind":"action"}}},
            "value":{"kind":"lit","value":true}}])
        );
    }

    #[test]
    fn emit_status_with_fields() {
        // The status-bar readout: a labelled Sanity field (with emphasis) + a Round
        // field whose value is a concat. `field(label, value[, emphasis])`.
        assert_eq!(
            s("emit status(field('Sanity', str(actor.sanity), 'warn'), field('Round', concat(str(round), '/', str(maxRounds))))"),
            json!([{"kind":"emit","effect":{"kind":"status","fields":[
                {"label":"Sanity","value":{"kind":"str","num":{"kind":"get","field":"sanity","of":{"kind":"actor"}}},"emphasis":{"kind":"lit","value":"warn"}},
                {"label":"Round","value":{"kind":"concat","parts":[
                    {"kind":"str","num":{"kind":"round"}},
                    {"kind":"lit","value":"/"},
                    {"kind":"str","num":{"kind":"maxRounds"}}]}}
            ]}}]));
    }

    #[test]
    fn status_field_without_emphasis_omits_it() {
        // `emphasis` is skip-when-None: a 2-arg field emits no `emphasis` key.
        let v = s("emit status(field('Round', str(round)))");
        assert_eq!(v[0]["effect"]["fields"][0].get("emphasis"), None);
    }

    #[test]
    fn set_plain_field_still_works() {
        assert_eq!(
            s("set state.unlocked = true"),
            json!([{
            "kind":"setState","field":"unlocked","value":{"kind":"lit","value":true}}])
        );
    }
}
