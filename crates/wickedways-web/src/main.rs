//! The WickedWays Dioxus web client (Phase 2c, sub-project D) — the binary entry point.
//!
//! `main` launches the [`launcher`](wickedways_web::launcher): without `?campaign=` it shows the
//! campaign menu; with a campaign it deep-links or shows the surface picker, then mounts the chosen
//! surface (the CRT terminal [`crt`](wickedways_web::crt) or the point-and-click
//! [`pnc`](wickedways_web::pnc)). Everything above the transport lives in the library so the launcher
//! can mount either surface; this file is just the entry.

fn main() {
    dioxus::launch(wickedways_web::launcher::launcher_app);
}
