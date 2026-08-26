//! Campaign Studio — a graphical authoring app for the TOML campaign format.
//!
//! See `docs/campaign-studio-spec.md`. The studio's in-memory model
//! ([`model::EditorDoc`]) is `AuthorDoc`-shaped; validation is layered
//! ([`refs::check_refs`] live, [`gate::check_campaign`] authoritative); campaigns
//! persist as JSON blobs in browser storage ([`store`]); TOML is the interchange
//! format ([`export`]).
//!
//! **Orientation for readers coming from JavaScript/TypeScript:** the UI layer is
//! Dioxus, which is React-shaped — a `#[component]` function is a function
//! component, `rsx!` is JSX, `use_signal` is `useState`, `use_context` is React
//! context, and an `EventHandler<T>` prop is a callback (`onChange: (v: T) => void`).
//! The recurring differences are ownership-driven, not framework-driven: an event
//! handler is a `move` closure that OWNS everything it captures (hence the
//! `.clone()` before each handler that a garbage collector would make
//! unnecessary), and a `Signal<T>` is a `Copy` *handle* to state, not the state
//! itself — call it like a function to read (and subscribe), `.set()`/`.write()`
//! to update. Comments at the trickier sites point out the rest (`Option` /
//! `Result` plumbing, exhaustive `match`, serde).

pub mod app;
pub mod export;
pub mod gate;
pub mod model;
pub mod platform;
pub mod refs;
pub mod store;
pub mod ui;
