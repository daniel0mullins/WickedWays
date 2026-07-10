//! The infix expression language: `parse_expr(src, base) -> Expr`.
//!
//! Authors write conditions/values as single-line infix strings embedded in
//! TOML (`canPass = "hasKey(actor, 'vault')"`). This module tokenizes and
//! Pratt-parses them into the closed [`wickedways_core::script::ast::Expr`] AST
//! that `assemble` consumes. It is a modding trust boundary: it must never
//! panic on author input — every failure is a [`crate::error::CompileError`].
mod lexer;
mod parser;
pub use parser::parse_expr;

#[cfg(test)]
mod tests {
    use super::parse_expr;
    use crate::error::{CompileError, Span};
    use serde_json::{json, Value};

    /// The differential gate's number normalization (copied verbatim from
    /// `wickedways-assemble/tests/goldens.rs`, per the plan's Global Constraints
    /// — "copy it; do not re-derive"). `Value::Number` is an `f64`, so a numeric
    /// literal always serializes as a whole float (`0.0`, `42.0`), while these
    /// tests write it as a bare int (`0`, `42`) — and `serde_json`'s `Number`
    /// equality distinguishes `0.0` from `0`. Collapsing integer-valued floats to
    /// integers makes the comparison faithful to JSON value equality (the gate's
    /// authoritative semantics). It is NOT a relaxation: array order, keys,
    /// non-whole numbers, strings, and presence/absence all still differ.
    fn canon_numbers(v: &Value) -> Value {
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

    fn p(s: &str) -> serde_json::Value {
        let e = parse_expr(s, Span { line: 1, col: 1 }).expect("parse");
        canon_numbers(&serde_json::to_value(e).expect("to_value"))
    }

    #[test]
    fn literals_and_subjects() {
        assert_eq!(p("'Vault'"), json!({"kind":"lit","value":"Vault"}));
        assert_eq!(p("42"), json!({"kind":"lit","value":42}));
        assert_eq!(p("true"), json!({"kind":"lit","value":true}));
        assert_eq!(p("actor"), json!({"kind":"actor"}));
        assert_eq!(p("party"), json!({"kind":"party"}));
        assert_eq!(p("round"), json!({"kind":"round"}));
        assert_eq!(p("maxRounds"), json!({"kind":"maxRounds"}));
    }

    #[test]
    fn index_then_field_chain() {
        assert_eq!(p("party[0].room.name"), json!({
            "kind":"get","field":"name","of":{
                "kind":"get","field":"room","of":{
                    "kind":"index","list":{"kind":"party"},"index":{"kind":"lit","value":0}}}}));
    }

    #[test]
    fn calls_map_to_typed_nodes() {
        assert_eq!(p("hasKey(actor, 'vault')"),
            json!({"kind":"hasKey","of":{"kind":"actor"},"keyCode":"vault"}));
        assert_eq!(p("hasItem(party[0], 'journal')"),
            json!({"kind":"hasItem","itemKey":"journal","of":{
                "kind":"index","list":{"kind":"party"},"index":{"kind":"lit","value":0}}}));
    }

    #[test]
    fn precedence_and_and_over_eq() {
        // a == b && c  parses as  (a == b) && c
        assert_eq!(p("round == 1 && actor"), json!({
            "kind":"bin","op":"and",
            "left":{"kind":"bin","op":"eq","left":{"kind":"round"},"right":{"kind":"lit","value":1}},
            "right":{"kind":"actor"}}));
    }

    #[test]
    fn comparison_and_ternary_and_not() {
        assert_eq!(p("round <= 3 ? 'lo' : 'hi'"), json!({
            "kind":"ifElse",
            "cond":{"kind":"bin","op":"lte","left":{"kind":"round"},"right":{"kind":"lit","value":3}},
            "then":{"kind":"lit","value":"lo"},"else":{"kind":"lit","value":"hi"}}));
        assert_eq!(p("!actor"), json!({"kind":"not","expr":{"kind":"actor"}}));
    }

    #[test]
    fn victory_expression_full() {
        assert_eq!(p("party[0].room.name == 'Vault'"), json!({
            "kind":"bin","op":"eq",
            "left":{"kind":"get","field":"name","of":{"kind":"get","field":"room","of":{
                "kind":"index","list":{"kind":"party"},"index":{"kind":"lit","value":0}}}},
            "right":{"kind":"lit","value":"Vault"}}));
    }

    #[test]
    fn unknown_call_is_unknown_reference() {
        let err = parse_expr("frobnicate(actor)", Span { line: 4, col: 11 }).unwrap_err();
        assert!(matches!(err, CompileError::UnknownReference { name, .. } if name == "frobnicate"));
    }

    #[test]
    fn syntax_error_is_expr_parse() {
        assert!(matches!(parse_expr("round ==", Span { line: 1, col: 1 }).unwrap_err(),
            CompileError::ExprParse { .. }));
    }
}
