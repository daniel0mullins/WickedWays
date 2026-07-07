//! The interpreter. Pure and TOTAL: no panics, no clock, no io; missing/ill-typed
//! reads resolve to `Null`/defaults. `alloc`-only.
use super::ast::{BinOp, Expr};
use super::value::coerce_str;
use super::value::Value;

/// Evaluation context. Task-1 placeholder — Task 3 replaces this with the real
/// borrowing context (view/state/actor/action/damage/rooms/rng).
pub struct Ctx;

pub fn eval_expr(e: &Expr, cx: &mut Ctx) -> Value {
    match e {
        Expr::Lit { value } => value.clone(),
        // A bare MapLit is only legal under Lookup/Has (load-time check, Task 9).
        Expr::MapLit { .. } => Value::Null,
        Expr::Not { expr } => Value::Bool(!eval_expr(expr, cx).truthy()),
        Expr::IfElse { cond, then, r#else } => {
            if eval_expr(cond, cx).truthy() { eval_expr(then, cx) } else { eval_expr(r#else, cx) }
        }
        Expr::Defined { expr } => Value::Bool(!matches!(eval_expr(expr, cx), Value::Null)),
        Expr::Str { num } => Value::Str(coerce_str(&eval_expr(num, cx))),
        Expr::Concat { parts } => {
            let mut out = alloc::string::String::new();
            for p in parts {
                out.push_str(&coerce_str(&eval_expr(p, cx)));
            }
            Value::Str(out)
        }
        Expr::Bin { op, left, right } => {
            let l = eval_expr(left, cx);
            let r = eval_expr(right, cx);
            eval_bin(*op, &l, &r)
        }
    }
}

fn eval_bin(op: BinOp, l: &Value, r: &Value) -> Value {
    use BinOp::*;
    match op {
        And => Value::Bool(l.truthy() && r.truthy()),
        Or => Value::Bool(l.truthy() || r.truthy()),
        Eq => Value::Bool(vals_eq(l, r)),
        Ne => Value::Bool(!vals_eq(l, r)),
        Add | Sub | Mul | Div => match (l, r) {
            (Value::Number(a), Value::Number(b)) => Value::Number(match op {
                Add => a + b, Sub => a - b, Mul => a * b, Div => a / b,
                _ => unreachable!(),
            }),
            _ => Value::Null, // non-numeric arithmetic: total, defined
        },
        Lt | Lte | Gt | Gte => match (l, r) {
            (Value::Number(a), Value::Number(b)) => Value::Bool(match op {
                Lt => a < b, Lte => a <= b, Gt => a > b, Gte => a >= b,
                _ => unreachable!(),
            }),
            _ => Value::Bool(false),
        },
    }
}

/// Strict same-type equality (mirrors the oracle's `===` uses). Mixed types are
/// never equal; `Null == Null` is true.
fn vals_eq(l: &Value, r: &Value) -> bool {
    match (l, r) {
        (Value::Number(a), Value::Number(b)) => a == b,
        (Value::Str(a), Value::Str(b)) => a == b,
        (Value::Bool(a), Value::Bool(b)) => a == b,
        (Value::Null, Value::Null) => true,
        (Value::List(a), Value::List(b)) => a == b,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::script::ast::{BinOp, Expr};
    use crate::script::value::Value;

    fn lit(v: Value) -> Box<Expr> { Box::new(Expr::Lit { value: v }) }
    fn n(x: f64) -> Box<Expr> { lit(Value::Number(x)) }
    fn ev(e: &Expr) -> Value { eval_expr(e, &mut Ctx) }

    #[test]
    fn arithmetic_is_ieee_f64() {
        assert_eq!(ev(&Expr::Bin { op: BinOp::Add, left: n(0.1), right: n(0.2) }),
                   Value::Number(0.1 + 0.2)); // bit-identical to JS 0.1+0.2
        assert_eq!(ev(&Expr::Bin { op: BinOp::Mul, left: n(3.0), right: n(1.2) }),
                   Value::Number(3.0 * 1.2));
        assert_eq!(ev(&Expr::Bin { op: BinOp::Div, left: n(1.0), right: n(0.0) }),
                   Value::Number(f64::INFINITY)); // JS 1/0
        // non-number operand -> Null (total, defined)
        assert_eq!(ev(&Expr::Bin { op: BinOp::Add, left: n(1.0), right: lit(Value::Null) }),
                   Value::Null);
    }

    #[test]
    fn comparisons_and_equality() {
        assert_eq!(ev(&Expr::Bin { op: BinOp::Lt,  left: n(2.0), right: n(3.0) }), Value::Bool(true));
        assert_eq!(ev(&Expr::Bin { op: BinOp::Lte, left: n(3.0), right: n(3.0) }), Value::Bool(true));
        assert_eq!(ev(&Expr::Bin { op: BinOp::Gt,  left: n(2.0), right: n(3.0) }), Value::Bool(false));
        assert_eq!(ev(&Expr::Bin { op: BinOp::Gte, left: n(3.0), right: n(3.0) }), Value::Bool(true));
        assert_eq!(ev(&Expr::Bin { op: BinOp::Eq,
            left: lit(Value::Str("move".into())), right: lit(Value::Str("move".into())) }),
            Value::Bool(true));
        assert_eq!(ev(&Expr::Bin { op: BinOp::Ne,
            left: lit(Value::Str("move".into())), right: lit(Value::Str("take".into())) }),
            Value::Bool(true));
        // mixed types are never equal; Null == Null is true (JS null === null)
        assert_eq!(ev(&Expr::Bin { op: BinOp::Eq, left: n(1.0), right: lit(Value::Str("1".into())) }),
                   Value::Bool(false));
        assert_eq!(ev(&Expr::Bin { op: BinOp::Eq, left: lit(Value::Null), right: lit(Value::Null) }),
                   Value::Bool(true));
    }

    #[test]
    fn boolean_logic_uses_js_truthiness() {
        assert_eq!(ev(&Expr::Bin { op: BinOp::And,
            left: lit(Value::Bool(true)), right: lit(Value::Bool(false)) }), Value::Bool(false));
        assert_eq!(ev(&Expr::Bin { op: BinOp::Or,
            left: lit(Value::Bool(false)), right: n(5.0) }), Value::Bool(true)); // 5 is truthy
        assert_eq!(ev(&Expr::Not { expr: lit(Value::Str(String::new())) }), Value::Bool(true)); // "" falsy
        assert_eq!(ev(&Expr::Not { expr: lit(Value::Null) }), Value::Bool(true));
    }

    #[test]
    fn str_and_concat_build_js_strings() {
        assert_eq!(ev(&Expr::Str { num: n(16.0) }), Value::Str("16".into()));
        assert_eq!(ev(&Expr::Str { num: lit(Value::Str("x".into())) }), Value::Str("x".into()));
        // `${round}/${maxRounds}` shape:
        assert_eq!(ev(&Expr::Concat { parts: alloc::vec![
            Expr::Str { num: n(3.0) },
            Expr::Lit { value: Value::Str("/".into()) },
            Expr::Str { num: n(150.0) },
        ]}), Value::Str("3/150".into()));
    }

    #[test]
    fn if_else_and_defined() {
        assert_eq!(ev(&Expr::IfElse {
            cond: lit(Value::Bool(true)), then: n(1.0), r#else: n(2.0) }), Value::Number(1.0));
        assert_eq!(ev(&Expr::IfElse {
            cond: lit(Value::Null), then: n(1.0), r#else: n(2.0) }), Value::Number(2.0));
        assert_eq!(ev(&Expr::Defined { expr: n(0.0) }), Value::Bool(true)); // 0 is defined
        assert_eq!(ev(&Expr::Defined { expr: lit(Value::Null) }), Value::Bool(false));
    }
}
