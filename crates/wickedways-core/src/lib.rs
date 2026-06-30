//! Pure, host-agnostic engine core. `no_std`-friendly (invariant 5).
#![cfg_attr(not(feature = "std"), no_std)]
// modules are wired up as they are implemented in Tasks 2–5

pub mod dice;
pub use dice::roll;

pub mod stats;
pub use stats::StatType;

pub mod damage;
pub use damage::{compute_mitigated_damage, DamageInput, LIGHT_VULNERABILITY, MAX_STAT, MITIGATION_PER_POINT};
