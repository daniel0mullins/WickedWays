//! Aggregated, spanned compile errors. `compile` consumes untrusted author text;
//! nothing here may panic.
use std::fmt;

/// 1-based line/column into the TOML source.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Span {
    pub line: usize,
    pub col: usize,
}

/// Every way a compile can fail. A Rust enum with payloads is a discriminated
/// union (TS: `{ kind: "tomlParse", message } | { kind: "exprParse", span, … }`);
/// callers `match` on it, and the compiler checks every variant is handled.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CompileError {
    TomlParse { message: String },
    ExprParse { span: Span, message: String },
    UnknownReference { span: Span, name: String },
    UnresolvedKey { kind: &'static str, key: String },
    InvalidImagePath { path: String },
}

// `Display` is the human-readable rendering (≈ `toString()`). Some of these
// strings are replay-observable and pinned by the golden gates — don't reword.
impl fmt::Display for CompileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CompileError::TomlParse { message } => write!(f, "TOML parse error: {message}"),
            CompileError::ExprParse { span, message } => write!(
                f,
                "expression syntax error at {}:{}: {message}",
                span.line, span.col
            ),
            CompileError::UnknownReference { span, name } => write!(
                f,
                "unknown reference '{name}' at {}:{}",
                span.line, span.col
            ),
            CompileError::UnresolvedKey { kind, key } => {
                write!(f, "{kind} references undefined behavior key '{key}'")
            }
            CompileError::InvalidImagePath { path } => {
                write!(
                    f,
                    "invalid image path '{path}': must be a plain relative path \
                     (no leading '/', no '..' or '.' segments, no '\\', no ':')"
                )
            }
        }
    }
}
impl std::error::Error for CompileError {}
