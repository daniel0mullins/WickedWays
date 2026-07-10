//! Party seating — STUB for Task 7.
//!
//! The pristine genesis gates assemble with an empty party, so this stub only
//! needs to be a no-op for that case; seating players, GM selection, and
//! `started`/round bookkeeping land in Task 7.

use wickedways_core::world::descriptor::Catalog;
use wickedways_core::world::snapshot::CampaignSnapshot;

use crate::description::CampaignDescription;
use crate::error::AssembleError;
use crate::Seat;

/// Seats `party` into `snap`. Task 7 implements the full behavior; for now an
/// empty party is a no-op (the pristine gates), and a non-empty party is not yet
/// supported.
pub(crate) fn seat_party(
    _snap: &mut CampaignSnapshot,
    _desc: &CampaignDescription,
    _catalog: &Catalog,
    party: &[Seat],
) -> Result<(), AssembleError> {
    if party.is_empty() {
        return Ok(());
    }
    unimplemented!("party seating lands in Task 7")
}
