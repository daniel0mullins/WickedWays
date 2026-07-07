//! Closed runtime value type for the scripted-ops DSL. `alloc`-only.
use alloc::string::String;
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

/// The closed set of first-class script values (spec: value model). Serialized
/// UNTAGGED so authored literals read as plain JSON (`5`, `"x"`, `true`, `[..]`,
/// `null`). Numbers are f64 to match TS `number`.
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
    fn value_serializes_untagged_as_plain_json() {
        assert_eq!(serde_json::to_value(Value::Number(2.5)).unwrap(), serde_json::json!(2.5));
        assert_eq!(serde_json::to_value(Value::Str("x".into())).unwrap(), serde_json::json!("x"));
        assert_eq!(serde_json::to_value(Value::Bool(true)).unwrap(), serde_json::json!(true));
        assert_eq!(serde_json::to_value(Value::Null).unwrap(), serde_json::json!(null));
        assert_eq!(
            serde_json::to_value(Value::List(alloc::vec![Value::Number(1.0), Value::Str("a".into())])).unwrap(),
            serde_json::json!([1.0, "a"]));
        let v: Value = serde_json::from_value(serde_json::json!(["a", 2.0, null])).unwrap();
        assert_eq!(v, Value::List(alloc::vec![Value::Str("a".into()), Value::Number(2.0), Value::Null]));
    }
}
