//! Parses a mechanic's `modifyDamage` transform body string into the core
//! [`DamageBody`] mini-AST. A modding trust boundary — panic-free on author
//! input: every failure is a [`CompileError`], never an `unwrap`/`panic!`.
//!
//! Grammar (mirrors the TS `modifyDamage` closures, e.g. the conformance dread's
//! `d => d.amount > 3 ? { value: 3, final: true } : d.amount`):
//!
//! ```text
//! body := `final` <expr>                 -> DamageBody::Final   (halts the fold)
//!       | <cond> `?` <body> `:` <body>   -> DamageBody::IfElse
//!       | <expr>                         -> DamageBody::Value
//! ```
//!
//! `<cond>` is a boolean/comparison [`Expr`](wickedways_core::script::ast::Expr)
//! parsed by [`parse_expr`]; it must NOT itself be a ternary (the first top-level
//! `?` is taken to open the transform's ternary). The two branches recurse, so
//! `a ? final X : b ? final Y : Z` chains to the right. The damage subject and its
//! `.amount` field are read via the `damage` expression subject + postfix `.field`.

use wickedways_core::script::ast::DamageBody;

use crate::error::{CompileError, Span};
use crate::expr::parse_expr;

/// Recursion-depth ceiling for the `modifyDamage` ternary. A modding trust
/// boundary: a deeply-chained `a ? … : b ? … : …` transform would otherwise
/// overflow the stack (and blow up the per-level rescans). Real transforms nest
/// one or two deep.
const MAX_DAMAGE_DEPTH: usize = 128;

/// Parse a `modifyDamage` body into a [`DamageBody`]. `base` is threaded through
/// to [`parse_expr`] so embedded-expression error spans point into the source.
pub(crate) fn parse_damage_body(src: &str, base: Span) -> Result<DamageBody, CompileError> {
    parse_damage_body_at(src, base, 0)
}

fn parse_damage_body_at(src: &str, base: Span, depth: usize) -> Result<DamageBody, CompileError> {
    if depth > MAX_DAMAGE_DEPTH {
        return Err(CompileError::ExprParse {
            span: base,
            message: "modifyDamage nested too deeply".into(),
        });
    }
    let src = src.trim();
    if src.is_empty() {
        return Err(CompileError::ExprParse {
            span: base,
            message: "empty modifyDamage body".into(),
        });
    }
    // A top-level ternary `<cond> ? <then> : <else>` -> IfElse. The FIRST
    // top-level `?` opens it; the `:` at ternary-depth 0 ends the `then` branch,
    // so a nested ternary inside `then` stays attached to it and a trailing chain
    // recurses into `else`.
    if let Some(q) = top_level_question(src) {
        let cond = parse_expr(src[..q].trim(), base)?;
        // `?` is one ASCII byte, so `q + 1` is a char boundary.
        let rest = &src[q + 1..];
        let colon = matching_colon(rest).ok_or_else(|| CompileError::ExprParse {
            span: base,
            message: "modifyDamage ternary is missing its ':'".into(),
        })?;
        let then = parse_damage_body_at(&rest[..colon], base, depth + 1)?;
        // `:` is one ASCII byte, so `colon + 1` is a char boundary.
        let els = parse_damage_body_at(&rest[colon + 1..], base, depth + 1)?;
        return Ok(DamageBody::IfElse { cond, then: Box::new(then), r#else: Box::new(els) });
    }
    // `final <expr>` -> Final (the value that halts the transformer chain).
    if let Some(rest) = strip_final_keyword(src) {
        return Ok(DamageBody::Final { expr: parse_expr(rest.trim(), base)? });
    }
    // Otherwise a bare value expression.
    Ok(DamageBody::Value { expr: parse_expr(src, base)? })
}

/// String-state tracker (both quote kinds): `None` outside a string, `Some(q)`
/// inside one opened by `q`. The other quote kind inside is a literal character.
fn track_quote(state: Option<char>, c: char) -> Option<char> {
    match state {
        None if c == '\'' || c == '"' => Some(c),
        Some(q) if q == c => None,
        other => other,
    }
}

/// Byte index of the first `?` at bracket-depth 0 and outside a string, if any —
/// the opener of the outermost ternary.
fn top_level_question(s: &str) -> Option<usize> {
    let mut depth: i32 = 0;
    let mut quote: Option<char> = None;
    for (i, c) in s.char_indices() {
        match c {
            '\'' | '"' => quote = track_quote(quote, c),
            '(' | '[' if quote.is_none() => depth += 1,
            ')' | ']' if quote.is_none() => depth -= 1,
            '?' if quote.is_none() && depth <= 0 => return Some(i),
            _ => {}
        }
    }
    None
}

/// Given the text AFTER a ternary's opening `?`, the byte index of the `:` that
/// closes it: the first top-level `:` at ternary-depth 0 (a nested `?` raises the
/// depth, its `:` lowers it). Bracket-nested and in-string `?`/`:` are ignored.
fn matching_colon(s: &str) -> Option<usize> {
    let mut ternary_depth: i32 = 0;
    let mut bracket_depth: i32 = 0;
    let mut quote: Option<char> = None;
    for (i, c) in s.char_indices() {
        match c {
            '\'' | '"' => quote = track_quote(quote, c),
            '(' | '[' if quote.is_none() => bracket_depth += 1,
            ')' | ']' if quote.is_none() => bracket_depth -= 1,
            '?' if quote.is_none() && bracket_depth <= 0 => ternary_depth += 1,
            ':' if quote.is_none() && bracket_depth <= 0 => {
                if ternary_depth == 0 {
                    return Some(i);
                }
                ternary_depth -= 1;
            }
            _ => {}
        }
    }
    None
}

/// If `s` begins with the `final` keyword followed by a whitespace boundary,
/// return the remainder (an identifier like `finalize` is NOT matched). The
/// caller trims the remainder before parsing it as the halting value expression.
fn strip_final_keyword(s: &str) -> Option<&str> {
    let rest = s.strip_prefix("final")?;
    match rest.chars().next() {
        Some(c) if c.is_whitespace() => Some(rest),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::parse_damage_body;
    use crate::error::{CompileError, Span};
    use serde_json::json;

    const BASE: Span = Span { line: 1, col: 1 };

    /// Collapse integer-valued floats to ints (the differential gate's number
    /// normalization, copied per the plan's Global Constraints) so a `lit 3`
    /// serialized as `3.0` compares equal to the `3` written in the assertions.
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

    fn d(src: &str) -> serde_json::Value {
        let body = parse_damage_body(src, BASE).expect("parse");
        canon_numbers(&serde_json::to_value(body).expect("json"))
    }

    // The `.amount` read, shared by several assertions.
    fn amount() -> serde_json::Value {
        json!({"kind":"get","field":"amount","of":{"kind":"damage"}})
    }

    #[test]
    fn dread_damage_cap() {
        // The conformance dread transform: cap at 3 (halting), else pass through.
        assert_eq!(d("damage.amount > 3 ? final 3 : damage.amount"), json!({
            "kind":"ifElse",
            "cond":{"kind":"bin","op":"gt","left":amount(),"right":{"kind":"lit","value":3}},
            "then":{"kind":"final","expr":{"kind":"lit","value":3}},
            "else":{"kind":"value","expr":amount()}
        }));
    }

    #[test]
    fn bare_value_body() {
        assert_eq!(d("damage.amount"), json!({"kind":"value","expr":amount()}));
    }

    #[test]
    fn final_only_body() {
        assert_eq!(d("final 0"), json!({"kind":"final","expr":{"kind":"lit","value":0}}));
    }

    #[test]
    fn nested_ternary_chains_right() {
        // a ? final 5 : b ? final 3 : v  ->  IfElse(a, Final 5, IfElse(b, Final 3, Value v))
        assert_eq!(d("damage.amount > 5 ? final 5 : damage.amount > 3 ? final 3 : damage.amount"), json!({
            "kind":"ifElse",
            "cond":{"kind":"bin","op":"gt","left":amount(),"right":{"kind":"lit","value":5}},
            "then":{"kind":"final","expr":{"kind":"lit","value":5}},
            "else":{"kind":"ifElse",
                "cond":{"kind":"bin","op":"gt","left":amount(),"right":{"kind":"lit","value":3}},
                "then":{"kind":"final","expr":{"kind":"lit","value":3}},
                "else":{"kind":"value","expr":amount()}}
        }));
    }

    #[test]
    fn missing_colon_is_expr_parse() {
        assert!(matches!(
            parse_damage_body("damage.amount > 3 ? final 3", BASE).unwrap_err(),
            CompileError::ExprParse { .. }
        ));
    }

    #[test]
    fn empty_body_is_expr_parse() {
        assert!(matches!(
            parse_damage_body("   ", BASE).unwrap_err(),
            CompileError::ExprParse { .. }
        ));
    }

    #[test]
    fn deeply_nested_ternary_errors_not_panics() {
        // A deeply-chained transform is a clean error, not a stack-overflow abort
        // (or a quadratic hang).
        let body = format!("{}final 0{}", "damage.amount > 1 ? ".repeat(4000), " : final 1".repeat(4000));
        assert!(matches!(parse_damage_body(&body, BASE).unwrap_err(),
            CompileError::ExprParse { .. }));
    }

    #[test]
    fn finalize_is_not_the_final_keyword() {
        // `finalize` is an identifier, not the `final` keyword -> it parses as a
        // value expression, and (being an unknown reference) errors as such.
        assert!(parse_damage_body("finalize", BASE).is_err());
    }
}
