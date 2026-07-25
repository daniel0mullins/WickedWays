//! The multiplayer sync layer.
//!
//! The actor-tagged [`Command`] union and the [`authorize`] gate form the
//! networked command model the room server and clients speak; the sync
//! [`SyncAuthority`], [`Delta`] diff/apply, log, and coordinator build on top.

pub mod applier;
pub mod authority;
pub mod authorize;
pub mod command;
pub mod coordinator;
pub mod delta;

pub use applier::apply as apply_delta;
pub use authority::{AuthorityOpts, LogEntry, SubmitResult, SyncAuthority};
pub use authorize::{authorize, AuthResult};
pub use command::{Command, EquipmentSlot};
pub use coordinator::{InProcessTransport, SyncCoordinator, SyncTransport};
pub use delta::{diff, CampaignCoreDelta, Delta, EntitySnapshot};
