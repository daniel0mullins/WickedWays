//! Campaign assembler: `description + catalog + party -> CampaignSnapshot`.
//!
//! The differential conformance gate against the committed genesis goldens is the
//! authority for correctness.
//!
//! This crate must never depend on `rand` or `uuid`: all ids are derived from content.

pub mod construct;
pub mod description;
pub mod error;
// `pub(crate)` = visible inside this crate only — there is no JS equivalent short
// of "not exported from the package"; these three modules are implementation.
pub(crate) mod ids;
pub(crate) mod seat;
pub(crate) mod validate;

// Barrel re-exports (like `export { X } from './x'`): callers write
// `wickedways_assemble::AssembleError` without knowing the module layout.
pub use description::CampaignDescription;
pub use error::{AssembleError, Problem};

use wickedways_core::world::descriptor::Catalog;
use wickedways_core::world::snapshot::{CampaignSnapshot, VillainSnapshot};

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
///
/// All three parameters are borrows (`&` = read-only view, no copy); errors come
/// back as the `Err` arm of the `Result` rather than being thrown — the caller
/// must look, the compiler won't let them forget.
pub fn assemble(
    desc: &CampaignDescription,
    catalog: &Catalog,
    party: &[Seat],
) -> Result<CampaignSnapshot, AssembleError> {
    let problems = validate::validate(desc, catalog);
    if !problems.is_empty() {
        return Err(AssembleError { problems });
    }
    // `?` = "if this returned Err, return that Err from here too" — the
    // one-character version of a try/catch that only re-throws.
    let mut snap = construct::construct(desc, catalog)?;
    seat::seat_party(&mut snap, desc, catalog, party)?;

    // The "@gm" villain sentinel resolves against the seated GM — after
    // seating, like `gm_id` itself. An unseated (pristine) genesis carries no
    // villain designation yet, exactly as it carries no GM.
    if let Some(vdef) = &desc.villain {
        if vdef.character == "@gm" && snap.campaign.villain.is_none() {
            if let Some(gm) = snap.campaign.gm_id.clone() {
                snap.campaign.villain = Some(VillainSnapshot {
                    character_id: gm,
                    deck: vdef.deck.clone(),
                    hand: Vec::new(),
                    discard: Vec::new(),
                    card_action_taken: false,
                });
            }
        }
    }
    Ok(snap)
}
