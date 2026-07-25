//! Campaign assembler: `description + catalog + party -> CampaignSnapshot`.
//!
//! The differential conformance gate against the committed genesis goldens is the
//! authority for correctness.
//!
//! This crate must never depend on `rand` or `uuid`: all ids are derived from content.

pub mod construct;
pub mod description;
pub mod error;
pub(crate) mod ids;
pub(crate) mod seat;
pub(crate) mod validate;

pub use description::CampaignDescription;
pub use error::{AssembleError, Problem};

use wickedways_core::world::descriptor::Catalog;
use wickedways_core::world::snapshot::CampaignSnapshot;

/// One player seat. `archetype` mirrors `CharacterSnapshot::archetype_id`
/// (`snapshot.rs:130`) — there is no `ArchetypeId` newtype in the core.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Seat {
    pub name: String,
    pub archetype: Option<String>,
}

/// `description + catalog + party -> CampaignSnapshot`.
///
/// `party` may be empty (pristine genesis), one seat (single-player), or many.
/// The FIRST seat becomes GM.
pub fn assemble(
    desc: &CampaignDescription,
    catalog: &Catalog,
    party: &[Seat],
) -> Result<CampaignSnapshot, AssembleError> {
    let problems = validate::validate(desc, catalog);
    if !problems.is_empty() {
        return Err(AssembleError { problems });
    }
    let mut snap = construct::construct(desc, catalog)?;
    seat::seat_party(&mut snap, desc, catalog, party)?;
    Ok(snap)
}
