//! Pure, host-agnostic engine core. `no_std`-friendly.
#![cfg_attr(not(feature = "std"), no_std)]
// `alloc` is always available (serde requires it; serde_json requires it).
extern crate alloc;

pub mod dice;
pub use dice::roll;

pub mod stats;
pub use stats::StatType;

pub mod damage;
pub use damage::{
    compute_mitigated_damage, DamageInput, LIGHT_VULNERABILITY, MAX_STAT, MITIGATION_PER_POINT,
};

pub mod presentation;
pub use presentation::{
    ActionKind, AssetRef, CampaignOutcome, EntityRef, MechanicCue, OutcomeNarration,
    PresentationCue, StatusField,
};

pub mod error;
pub use error::ProceduralViolation;

pub mod world;
pub use world::{snapshot::CampaignSnapshot, World};

pub mod script;

pub mod sync;
