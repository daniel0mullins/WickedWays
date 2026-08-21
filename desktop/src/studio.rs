//! Campaign Studio as a native desktop app — the authoring UI from
//! `wickedways-studio` in a windowed shell.
//!
//! The same thin-shell idiom as the play client's `main.rs`: parse CLI args into
//! the studio's platform param store (the desktop analog of the web build's URL
//! query — `--c <campaign-id>` deep-links a stored campaign, `--s <section>` a
//! section), then launch the same `studio_app` the browser mounts. Campaigns
//! persist as files under the shared WickedWays data dir
//! (`$WICKEDWAYS_DATA_DIR`, default the platform data dir); exports land in the
//! Downloads folder.

use wickedways_studio::platform;

/// CLI args → platform params (`--key=value`, `--key value`, bare `--flag`).
fn parse_args(args: impl Iterator<Item = String>) -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    let mut pending: Option<String> = None;
    for arg in args {
        if let Some(rest) = arg.strip_prefix("--") {
            if let Some(key) = pending.take() {
                pairs.push((key, String::new()));
            }
            match rest.split_once('=') {
                Some((k, v)) => pairs.push((k.into(), v.into())),
                None => pending = Some(rest.into()),
            }
        } else if let Some(key) = pending.take() {
            pairs.push((key, arg));
        }
    }
    if let Some(key) = pending {
        pairs.push((key, String::new()));
    }
    pairs
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!(
            "WickedWays Campaign Studio — graphical campaign authoring\n\n\
             USAGE: wickedways-studio-desktop [--c <campaign-id>] [--s <section>]\n\n\
             --c   deep-link a stored campaign by id; omit for the campaign list\n\
             --s   the editor section to open (rooms, map, exits, …)\n\n\
             Campaigns live under $WICKEDWAYS_DATA_DIR (default: the platform data\n\
             dir); exports are written to your Downloads folder."
        );
        return;
    }
    platform::init_params(parse_args(args.into_iter()));

    let window = dioxus::desktop::WindowBuilder::new()
        .with_title("WickedWays Campaign Studio")
        .with_inner_size(dioxus::desktop::tao::dpi::LogicalSize::new(1380.0, 900.0));
    dioxus::LaunchBuilder::desktop()
        .with_cfg(dioxus::desktop::Config::new().with_window(window))
        .launch(wickedways_studio::app::studio_app);
}
