//! Engine lifecycle-guard error — illegal operations throw rather than no-op.
use alloc::string::String;
use core::fmt;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProceduralViolation(pub String);

impl fmt::Display for ProceduralViolation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}
#[cfg(feature = "std")]
impl std::error::Error for ProceduralViolation {}
