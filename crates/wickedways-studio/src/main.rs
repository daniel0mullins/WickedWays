//! Campaign Studio — the binary entry point.
//!
//! `main` launches the [`app`](wickedways_studio::app): without `?c=` it shows the
//! campaign list; with a campaign id it deep-links into the editor shell. Everything
//! lives in the library so the logic layers stay host-testable; this file is just the
//! entry.

fn main() {
    dioxus::launch(wickedways_studio::app::studio_app);
}
