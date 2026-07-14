//! The multiplayer sync layer (Phase 2c).
//!
//! Sub-project **A** lands here first: the actor-tagged [`Command`] union and the
//! [`authorize`] gate — the networked command model the room server and clients speak,
//! mirroring `src/lib/sync/types.ts` + `resolver.ts`. Sub-project **B** (the sync
//! `Authority`, `Delta` diff/apply, log, and `Replica`) builds on top of this module.
//!
//! See `docs/superpowers/specs/2026-07-14-rust-phase-2c-a-command-vocabulary-design.md`.

pub mod authorize;
pub mod command;

pub use authorize::{authorize, AuthResult};
pub use command::{Command, EquipmentSlot};
