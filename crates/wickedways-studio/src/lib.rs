//! Campaign Studio — a graphical authoring app for the TOML campaign format.
//!
//! See `docs/campaign-studio-spec.md`. The studio's in-memory model
//! ([`model::EditorDoc`]) is `AuthorDoc`-shaped; validation is layered
//! ([`refs::check_refs`] live, [`gate::check_campaign`] authoritative); campaigns
//! persist as JSON blobs in browser storage ([`store`]); TOML is the interchange
//! format ([`export`]).

pub mod app;
pub mod export;
pub mod gate;
pub mod model;
pub mod platform;
pub mod refs;
pub mod store;
pub mod ui;
