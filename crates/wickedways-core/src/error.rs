//! Engine lifecycle-guard error — illegal operations throw rather than no-op.
//!
//! Rust has no exceptions: fallible engine calls return
//! `Result<T, ProceduralViolation>` and callers unwind early with the `?` operator —
//! the moral equivalent of `throw`/re-throw, but visible in every signature. Some of
//! these error strings are replay-observable and pinned by the golden gates, so treat
//! the messages as part of the wire.
use alloc::string::String;
use core::fmt;

/// The one engine error. A "tuple struct" — a single-field wrapper around the message
/// `String` (a newtype, like a class whose only member is `this.message`); the payload
/// is reached as `.0`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProceduralViolation(pub String);

// `Display` is the `toString()` of Rust — implementing it is what lets `format!("{v}")`
// and friends print the violation.
impl fmt::Display for ProceduralViolation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}
// Compiled only when the `std` feature is on: `std::error::Error` does not exist in
// `no_std` builds (`cfg` is a compile-time `#if`, not a runtime check).
#[cfg(feature = "std")]
impl std::error::Error for ProceduralViolation {}
