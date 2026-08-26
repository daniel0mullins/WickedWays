//! The party roster read from a live replica.
//!
//! A shared board shows every seat at once, so it needs each party member's location + stats — which
//! the `ViewModel` only exposes for the active viewer. [`party_roster`] reads them straight off the
//! replica `World` (`campaign.party_ids` → `characters[id]`), sidestepping the actorless `status` cue.

use serde::{Deserialize, Serialize};
use wickedways_core::world::afflictions::Status;
use wickedways_core::World;

/// A projected view of one party seat: where its piece stands and how it's doing.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SeatView {
    pub id: String,
    pub name: String,
    /// The room the seat's piece stands in (`None` before placement).
    pub room_id: Option<String>,
    pub health: f64,
    pub sanity: f64,
    pub ko: bool,
    pub panic: bool,
    pub fear: bool,
    pub confused: bool,
    /// Whether this is the seat whose turn it is.
    pub active: bool,
}

/// Read every party seat's location + stats from the live replica, in `party_ids` order.
pub fn party_roster(world: &World) -> Vec<SeatView> {
    // `.ok()` discards the error and keeps an `Option` — here we only care *whether* there is an
    // active seat, not why there isn't one.
    let active = world.active_character_id().ok();
    // `filter_map` is `.map().filter(Boolean)` in one pass: the closure returns an `Option`, and
    // `None`s are dropped. The `?` inside early-returns `None` from the *closure* (like optional
    // chaining bailing out), so a party id with no character record simply yields no row.
    world
        .campaign
        .party_ids
        .iter()
        .filter_map(|id| {
            let c = world.characters.get(id)?;
            let afl = &c.afflictions;
            Some(SeatView {
                id: id.0.clone(),
                name: c.name.clone(),
                room_id: c.current_room_id.as_ref().map(|r| r.0.clone()),
                health: c.stats.health,
                sanity: c.stats.sanity,
                ko: afl.is_active(Status::Ko),
                panic: afl.is_active(Status::Panic),
                fear: afl.is_active(Status::Fear),
                confused: afl.is_active(Status::Confused),
                active: active.as_ref() == Some(id),
            })
        })
        .collect()
}
