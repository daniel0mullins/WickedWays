//! View projections handed to mechanic hooks (TS `CampaignView`/`CharacterView`/
//! `RoomView`/`DamageView`): read-only snapshots of `World` state built once
//! before dispatch, so a hook observes a stable, non-live view rather than
//! reaching into `World` mid-mutation. Task 2 adds `build_campaign_view` and the
//! `has_equipped`/`has_item` projections; Task 1 defines placeholder struct
//! shapes so `world::mechanics::mod` compiles.

use alloc::string::String;
use alloc::vec::Vec;

use crate::world::ids::{CharacterId, RoomId};

/// Read-only campaign-wide view (TS `CampaignView`). Placeholder shape — Task 2
/// adds `build_campaign_view` and any further fields the ops need.
#[derive(Clone, Debug, PartialEq)]
pub struct CampaignView {
    pub round: i64,
}

/// Read-only per-character view (TS `CharacterView`). Placeholder shape — Task 2
/// adds `has_equipped`/`has_item` and any further fields.
#[derive(Clone, Debug, PartialEq)]
pub struct CharacterView {
    pub id: CharacterId,
    pub name: String,
    pub current_room_id: RoomId,
}

/// Read-only per-room view (TS `RoomView`). Placeholder shape — Task 2 fleshes
/// out the projection.
#[derive(Clone, Debug, PartialEq)]
pub struct RoomView {
    pub id: RoomId,
    pub occupant_ids: Vec<CharacterId>,
}

/// The damage event passed to `MechanicOp::modify_damage` (TS `DamageView`).
#[derive(Clone, Debug, PartialEq)]
pub struct DamageView {
    pub target: CharacterId,
    pub amount: f64,
}
