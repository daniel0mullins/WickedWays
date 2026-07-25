//! Closed runtime value type for the scripted-ops DSL. `alloc`-only.
use alloc::format;
use alloc::string::String;
use alloc::string::ToString;
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

/// The closed set of first-class script values. Serialized UNTAGGED so
/// authored literals read as plain JSON (`5`, `"x"`, `true`, `[..]`,
/// `null`). Numbers are f64 (JS `number` semantics).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export, rename = "ScriptValue"))]
#[serde(untagged)]
pub enum Value {
    Bool(bool),
    Number(f64),
    Str(String),
    List(Vec<Value>),
    Null,
}

impl Value {
    /// JS `ToBoolean`: `false`, `0`, `-0`, `NaN`, `""` and `null` are falsy;
    /// everything else (including empty lists — JS objects) is truthy.
    pub fn truthy(&self) -> bool {
        match self {
            Value::Bool(b) => *b,
            Value::Number(n) => *n != 0.0 && !n.is_nan(),
            Value::Str(s) => !s.is_empty(),
            Value::List(_) => true,
            Value::Null => false,
        }
    }
}

/// Byte-for-byte JS `Number.prototype.toString` (ECMA-262 §6.1.6.1.20, base 10).
/// Digits come from Rust's `{:e}` (shortest round-trip — the same unique digit
/// string V8 computes); this function only re-assembles the NOTATION, since JS
/// switches to exponential form outside [1e-6, 1e21) while Rust never does.
pub fn format_js_number(n: f64) -> String {
    if n.is_nan() {
        return "NaN".to_string();
    }
    if n.is_infinite() {
        return if n > 0.0 {
            "Infinity".to_string()
        } else {
            "-Infinity".to_string()
        };
    }
    if n == 0.0 {
        return "0".to_string();
    } // covers -0.0: JS String(-0) === "0"
    let neg = n < 0.0;
    let a = if neg { -n } else { n };
    // "d.dddde<exp>" or "d e<exp>"; mantissa digits are ASCII.
    let exp_str = format!("{a:e}");
    let (mant, exp) = exp_str
        .split_once('e')
        .expect("LowerExp always contains 'e'");
    let exp: i32 = exp.parse().expect("LowerExp exponent is an integer");
    let all: String = mant.chars().filter(|c| *c != '.').collect();
    let trimmed = all.trim_end_matches('0');
    let digits = if trimmed.is_empty() { "0" } else { trimmed };
    let k = digits.len() as i32; // significant digit count
    let pos = exp + 1; // ECMA "n": value = digits × 10^(pos − k)
    let mut s = String::new();
    if neg {
        s.push('-');
    }
    if k <= pos && pos <= 21 {
        // integer, zero-padded: e.g. 1e2 -> "100"
        s.push_str(digits);
        for _ in 0..(pos - k) {
            s.push('0');
        }
    } else if 0 < pos && pos <= 21 {
        // decimal point inside the digits: e.g. "2.5", "123456789.123"
        s.push_str(&digits[..pos as usize]);
        s.push('.');
        s.push_str(&digits[pos as usize..]);
    } else if -6 < pos && pos <= 0 {
        // leading zeros: e.g. "0.000001"
        s.push_str("0.");
        for _ in 0..(-pos) {
            s.push('0');
        }
        s.push_str(digits);
    } else {
        // exponential: e.g. "1e+21", "1e-7", "1.5e+22"
        s.push_str(&digits[..1]);
        if digits.len() > 1 {
            s.push('.');
            s.push_str(&digits[1..]);
        }
        s.push('e');
        let e = pos - 1;
        if e >= 0 {
            s.push('+');
        }
        s.push_str(&format!("{e}"));
    }
    s
}

/// JS `String()` coercion over the closed value set (used by `Str`, `Concat`,
/// and cue-text coercion).
pub fn coerce_str(v: &Value) -> String {
    match v {
        Value::Str(s) => s.clone(),
        Value::Number(n) => format_js_number(*n),
        Value::Bool(true) => "true".to_string(),
        Value::Bool(false) => "false".to_string(),
        Value::Null => "null".to_string(),
        Value::List(items) => {
            // JS Array.prototype.toString: comma-joined elements (null -> "").
            let mut out = String::new();
            for (i, it) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                if !matches!(it, Value::Null) {
                    out.push_str(&coerce_str(it));
                }
            }
            out
        }
    }
}

/// JSON -> script value. Objects collapse to `Null` (nested objects are only
/// reachable through `StateGetIn`, which indexes them directly).
pub fn json_to_value(j: &serde_json::Value) -> Value {
    match j {
        serde_json::Value::Null | serde_json::Value::Object(_) => Value::Null,
        serde_json::Value::Bool(b) => Value::Bool(*b),
        serde_json::Value::Number(n) => Value::Number(n.as_f64().unwrap_or(f64::NAN)),
        serde_json::Value::String(s) => Value::Str(s.clone()),
        serde_json::Value::Array(items) => Value::List(items.iter().map(json_to_value).collect()),
    }
}

/// Script value -> JSON, for writing back into a script's own state.
pub fn value_to_json(v: &Value) -> serde_json::Value {
    match v {
        Value::Null => serde_json::Value::Null,
        Value::Bool(b) => serde_json::json!(b),
        Value::Number(n) => serde_json::json!(n),
        Value::Str(s) => serde_json::json!(s),
        Value::List(items) => serde_json::Value::Array(items.iter().map(value_to_json).collect()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truthiness_matches_js_to_boolean() {
        assert!(Value::Bool(true).truthy());
        assert!(!Value::Bool(false).truthy());
        assert!(Value::Number(5.0).truthy());
        assert!(!Value::Number(0.0).truthy());
        assert!(!Value::Number(f64::NAN).truthy());
        assert!(Value::Str("x".into()).truthy());
        assert!(!Value::Str(String::new()).truthy());
        assert!(Value::List(alloc::vec![]).truthy()); // JS: [] is truthy
        assert!(!Value::Null.truthy());
    }

    #[test]
    fn format_js_number_matches_number_prototype_tostring() {
        // Oracle values produced with: node -e 'for (const x of [16,2.5,0.1,3.6,-1.5,0,-0,15,7,3.2,
        // 0.30000000000000004,1/3,1e21,1e-7,0.000001,123456789.123]) console.log(String(x))'
        let cases: &[(f64, &str)] = &[
            (16.0, "16"),
            (2.5, "2.5"),
            (0.1, "0.1"),
            (3.6, "3.6"), // the dread pre-cap damage value
            (-1.5, "-1.5"),
            (0.0, "0"),
            (-0.0, "0"), // JS String(-0) === "0"
            (15.0, "15"),
            (7.0, "7"),
            (3.2, "3.2"),                       // a darkness-multiplier-shaped fraction
            (0.1 + 0.2, "0.30000000000000004"), // shortest-roundtrip 17 digits
            (1.0 / 3.0, "0.3333333333333333"),
            (1e21, "1e+21"),        // exponential at the 1e21 boundary
            (1e-7, "1e-7"),         // exponential below 1e-6
            (0.000001, "0.000001"), // fixed AT the 1e-6 boundary
            (123456789.123, "123456789.123"),
        ];
        for (n, want) in cases {
            assert_eq!(format_js_number(*n), *want, "for {n:?}");
        }
        assert_eq!(format_js_number(f64::NAN), "NaN");
        assert_eq!(format_js_number(f64::INFINITY), "Infinity");
        assert_eq!(format_js_number(f64::NEG_INFINITY), "-Infinity");
    }

    #[test]
    fn value_serializes_untagged_as_plain_json() {
        assert_eq!(
            serde_json::to_value(Value::Number(2.5)).unwrap(),
            serde_json::json!(2.5)
        );
        assert_eq!(
            serde_json::to_value(Value::Str("x".into())).unwrap(),
            serde_json::json!("x")
        );
        assert_eq!(
            serde_json::to_value(Value::Bool(true)).unwrap(),
            serde_json::json!(true)
        );
        assert_eq!(
            serde_json::to_value(Value::Null).unwrap(),
            serde_json::json!(null)
        );
        assert_eq!(
            serde_json::to_value(Value::List(alloc::vec![
                Value::Number(1.0),
                Value::Str("a".into())
            ]))
            .unwrap(),
            serde_json::json!([1.0, "a"])
        );
        let v: Value = serde_json::from_value(serde_json::json!(["a", 2.0, null])).unwrap();
        assert_eq!(
            v,
            Value::List(alloc::vec![
                Value::Str("a".into()),
                Value::Number(2.0),
                Value::Null
            ])
        );
    }
}
