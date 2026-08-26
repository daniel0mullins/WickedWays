//! Pure, host-agnostic engine core for the WickedWays tabletop horror-RPG.
//!
//! Everything observable lives in [`World`]: it holds the campaign state, runs the turn
//! loop, and is driven exclusively through commands (see [`sync`]) so that every session
//! is a deterministic, replayable command log. [`script`] is the ops DSL that campaign
//! behaviors fall back to when no native behavior is registered.
//!
//! The remaining modules are the small shared vocabularies the engine and its hosts agree
//! on: [`dice`] (rolls and player-supplied dice), [`stats`] (the three character stats),
//! [`damage`] (the mitigation formula), [`presentation`] (cues the engine emits for a UI
//! to render), and [`error`] (the lifecycle-guard error type).
//!
//! The crate is `no_std`-capable: without the `std` feature it compiles against `core` +
//! `alloc` only (think "no Node APIs, standard library only" — it must run anywhere,
//! including wasm). That is why internal code imports `alloc::string::String` and friends
//! rather than the `std::` paths.
#![cfg_attr(not(feature = "std"), no_std)]
// `alloc` is always available (serde requires it; serde_json requires it).
extern crate alloc;

// The `pub use` lines below re-export each module's headline items at the crate root —
// the same move as a JS barrel file (`export * from './world'`), so hosts can write
// `wickedways_core::World` instead of `wickedways_core::world::World`.

// — The engine itself —

pub mod world;
pub use world::{snapshot::CampaignSnapshot, World};

pub mod sync;

pub mod script;

// — Shared mechanics vocabulary —

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
