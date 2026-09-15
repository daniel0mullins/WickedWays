//! The multiplayer sync layer.
//!
//! The actor-tagged [`Command`] union and the [`authorize`] gate form the
//! networked command model the room server and clients speak; the sync
//! [`SyncAuthority`], [`Delta`] diff/apply, log, and coordinator build on top.
//! [`redact`] is the per-recipient projection the room server applies at the
//! wire boundary (the Villain's hidden card piles).

pub mod applier;
pub mod authority;
pub mod authorize;
pub mod command;
pub mod coordinator;
pub mod delta;
pub mod redact;

// Re-exports flatten the public surface (a barrel `index.ts`, in JS terms):
// callers write `sync::Command` rather than `sync::command::Command`.
pub use applier::apply as apply_delta;
pub use authority::{AuthorityOpts, LogEntry, SubmitResult, SyncAuthority};
pub use authorize::{authorize, AuthResult};
pub use command::{Command, EquipmentSlot};
pub use coordinator::{InProcessTransport, SyncCoordinator, SyncTransport};
pub use delta::{diff, CampaignCoreDelta, Delta, EntitySnapshot};
pub use redact::{delta_villain, redact_delta, redact_snapshot, redact_villain, REDACTED_CARD_KEY};
