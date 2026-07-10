//! Campaign assembler: `description + catalog + party -> CampaignSnapshot`.
//!
//! A faithful port of `src/lib/authoring/assembler.ts`. The differential conformance
//! gate against the committed genesis goldens is the authority for correctness.
//!
//! This crate must never depend on `rand` or `uuid`: all ids are derived from content.

pub mod description;

pub use description::CampaignDescription;
