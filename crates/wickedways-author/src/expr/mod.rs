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
        assert_eq!(p("damage"), json!({"kind":"damage"}));
    }

    #[test]
    fn damage_field_reads() {
        // The `modify_damage` subject's fields are read via postfix `.field`.
        assert_eq!(p("damage.amount"),
            json!({"kind":"get","field":"amount","of":{"kind":"damage"}}));
        assert_eq!(p("damage.amount > 3"), json!({
            "kind":"bin","op":"gt",
            "left":{"kind":"get","field":"amount","of":{"kind":"damage"}},
            "right":{"kind":"lit","value":3}}));
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
    fn has_equipped_maps_to_typed_node() {
        assert_eq!(p("hasEquipped(actor, 'lantern')"),
            json!({"kind":"hasEquipped","of":{"kind":"actor"},"itemKey":"lantern"}));
    }

    #[test]
    fn or_binds_looser_than_and() {
        // round == 1 && actor || party  parses as  ((round == 1) && actor) || party
        assert_eq!(p("round == 1 && actor || party"), json!({
            "kind":"bin","op":"or",
            "left":{"kind":"bin","op":"and",
                "left":{"kind":"bin","op":"eq","left":{"kind":"round"},"right":{"kind":"lit","value":1}},
                "right":{"kind":"actor"}},
            "right":{"kind":"party"}}));
    }

    #[test]
    fn call_arity_error_is_expr_parse() {
        // hasKey takes exactly 2 args; 1 arg is an arity error.
        assert!(matches!(parse_expr("hasKey(actor)", Span { line: 1, col: 1 }).unwrap_err(),
            CompileError::ExprParse { .. }));
    }

    #[test]
    fn non_string_second_arg_is_expr_parse() {
        // The 2nd argument must be a string literal; a subject is rejected.
        assert!(matches!(parse_expr("hasKey(actor, round)", Span { line: 1, col: 1 }).unwrap_err(),
            CompileError::ExprParse { .. }));
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

    #[test]
    fn state_get_expression() {
        assert_eq!(p("stateGet('seen', false)"),
            json!({"kind":"stateGet","field":"seen","default":false}));
        assert_eq!(p("!stateGet('seen', false)"),
            json!({"kind":"not","expr":{"kind":"stateGet","field":"seen","default":false}}));
    }

    #[test]
    fn action_and_element_subjects() {
        assert_eq!(p("action.kind"), json!({"kind":"get","field":"kind","of":{"kind":"action"}}));
        assert_eq!(p("element.status"),
            json!({"kind":"get","field":"status","of":{"kind":"element"}}));
    }

    #[test]
    fn map_lit_and_has_and_lookup() {
        // A small static table + membership/value-at over it (the storyteller's lore).
        assert_eq!(p("mapLit('Parlor', 'A mildewed parlor.')"),
            json!({"kind":"mapLit","entries":{"Parlor":"A mildewed parlor."}}));
        assert_eq!(p("has(mapLit('Parlor', 'x'), action.room.name)"), json!({
            "kind":"has",
            "map":{"kind":"mapLit","entries":{"Parlor":"x"}},
            "key":{"kind":"get","field":"name","of":{"kind":"get","field":"room","of":{"kind":"action"}}}}));
        assert_eq!(p("lookup(mapLit('Parlor', 'x'), action.room.name)"), json!({
            "kind":"lookup",
            "map":{"kind":"mapLit","entries":{"Parlor":"x"}},
            "key":{"kind":"get","field":"name","of":{"kind":"get","field":"room","of":{"kind":"action"}}}}));
    }

    #[test]
    fn map_lit_odd_arity_errors() {
        assert!(parse_expr("mapLit('a', 'b', 'c')", Span { line: 1, col: 1 }).is_err());
    }

    #[test]
    fn state_get_in_expression() {
        assert_eq!(p("stateGetIn('seen', action.room.name, false)"), json!({
            "kind":"stateGetIn","mapField":"seen","default":false,
            "key":{"kind":"get","field":"name","of":{"kind":"get","field":"room","of":{"kind":"action"}}}}));
    }

    #[test]
    fn str_length_first_concat() {
        assert_eq!(p("str(actor.sanity)"),
            json!({"kind":"str","num":{"kind":"get","field":"sanity","of":{"kind":"actor"}}}));
        assert_eq!(p("length(party)"), json!({"kind":"length","list":{"kind":"party"}}));
        // `first(party)` is the First node, distinct from the subscript `party[0]`→Index.
        assert_eq!(p("first(party)"), json!({"kind":"first","list":{"kind":"party"}}));
        assert_eq!(p("concat(str(round), '/', str(maxRounds))"), json!({
            "kind":"concat","parts":[
                {"kind":"str","num":{"kind":"round"}},
                {"kind":"lit","value":"/"},
                {"kind":"str","num":{"kind":"maxRounds"}}]}));
    }

    #[test]
    fn some_every_includes_quantifiers() {
        // sanity-zero: some(party, element.sanity <= 0)
        assert_eq!(p("some(party, element.sanity <= 0)"), json!({
            "kind":"some","list":{"kind":"party"},
            "pred":{"kind":"bin","op":"lte","left":{"kind":"get","field":"sanity","of":{"kind":"element"}},"right":{"kind":"lit","value":0}}}));
        // party-down: every(party, includes(element.status, 'ko'))
        assert_eq!(p("every(party, includes(element.status, 'ko'))"), json!({
            "kind":"every","list":{"kind":"party"},
            "pred":{"kind":"includes",
                "list":{"kind":"get","field":"status","of":{"kind":"element"}},
                "value":{"kind":"lit","value":"ko"}}}));
    }

    #[test]
    fn defined_call() {
        assert_eq!(p("defined(actor.room)"),
            json!({"kind":"defined","expr":{"kind":"get","field":"room","of":{"kind":"actor"}}}));
    }

    #[test]
    fn subscript_zero_still_index_not_first() {
        // The deliberate MVP rule survives: `[0]` is Index, only `first(...)` is First.
        assert_eq!(p("party[0]"),
            json!({"kind":"index","list":{"kind":"party"},"index":{"kind":"lit","value":0}}));
    }

    #[test]
    fn negative_number_literal() {
        assert_eq!(p("-1"), serde_json::json!({"kind":"lit","value":-1}));
        assert_eq!(p("-1.5"), serde_json::json!({"kind":"lit","value":-1.5}));
    }

    #[test]
    fn minus_between_operands_is_subtraction() {
        assert_eq!(p("round - 1"), serde_json::json!({
            "kind":"bin","op":"sub","left":{"kind":"round"},"right":{"kind":"lit","value":1}}));
    }

    #[test]
    fn unary_minus_on_non_number_errors() {
        // There is no unary-negation AST node; `-` is only valid before a number literal.
        assert!(crate::expr::parse_expr("-actor", crate::error::Span { line: 1, col: 1 }).is_err());
    }
}
