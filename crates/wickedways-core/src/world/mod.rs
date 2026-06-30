//! The id-keyed runtime world model (Phase 1).
pub mod ids;
pub mod snapshot;

pub use ids::{CharacterId, ExitId, ItemId, LootId, MaterialCacheId, RoomId};
pub use snapshot::{ExitSnapshot, ItemSnapshot, LootSnapshot, MaterialCacheSnapshot, SceneSnapshot};
