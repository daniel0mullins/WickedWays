//! The WickedWays desktop app — the launcher/surfaces from `wickedways-web` in a native window.
//!
//! A thin shell: parse CLI args into the client's platform param store (the desktop analog of
//! the web build's URL query — same keys, same routing), install the window services the
//! library can't provide itself (fullscreen needs `dioxus::desktop`), then launch the same
//! `launcher_app` the browser mounts. Single-player only for now — the desktop build has no
//! multiplayer transport, so the launcher lists only offline campaigns.

use wickedways_web::platform::{self, DesktopHooks};

/// CLI args → platform params. Accepts `--key=value`, `--key value`, and bare `--flag`
/// (seeded with an empty value — present for `has_flag`, absent for `query_param`). The keys
/// are the web build's query params: `--campaign hollow-house`, `--surface crt-terminal`,
/// `--theme <id>`, `--debug`.
fn parse_args(args: impl Iterator<Item = String>) -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    let mut pending: Option<String> = None;
    for arg in args {
        if let Some(rest) = arg.strip_prefix("--") {
            if let Some(key) = pending.take() {
                pairs.push((key, String::new())); // previous key was a bare flag
            }
            match rest.split_once('=') {
                Some((k, v)) => pairs.push((k.into(), v.into())),
                None => pending = Some(rest.into()),
            }
        } else if let Some(key) = pending.take() {
            pairs.push((key, arg));
        }
        // A bare positional with no pending key is ignored.
    }
    if let Some(key) = pending {
        pairs.push((key, String::new()));
    }
    pairs
}

/// Toggle window fullscreen (borderless), reporting whether we're entering it — the surfaces
/// narrate the new state. Installed as a platform hook; runs inside the app's runtime scope.
fn toggle_fullscreen() -> bool {
    let window = dioxus::desktop::window();
    let entering = window.fullscreen().is_none();
    window.set_fullscreen(entering);
    entering
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!(
            "WickedWays — turn-based tabletop horror\n\n\
             USAGE: wickedways-desktop [--campaign <slug>] [--surface <id>] [--theme <id>] [--debug]\n\n\
             --campaign   deep-link a campaign (e.g. hollow-house); omit for the menu\n\
             --surface    crt-terminal | point-and-click\n\
             --theme      a built-in palette id\n\
             --debug      unlock the demo/conformance campaigns\n\n\
             Saves live under $WICKEDWAYS_DATA_DIR (default: the platform data dir)."
        );
        return;
    }
    platform::init_params(parse_args(args.into_iter()));
    platform::install_desktop_hooks(DesktopHooks { toggle_fullscreen });

    let window = dioxus::desktop::WindowBuilder::new()
        .with_title("WickedWays")
        .with_inner_size(dioxus::desktop::tao::dpi::LogicalSize::new(1280.0, 860.0));
    dioxus::LaunchBuilder::desktop()
        .with_cfg(dioxus::desktop::Config::new().with_window(window))
        .launch(wickedways_web::launcher::launcher_app);
}

#[cfg(test)]
mod tests {
    use super::parse_args;

    #[test]
    fn parses_eq_space_and_flag_forms() {
        let got = parse_args(
            ["--campaign=hollow-house", "--surface", "crt-terminal", "--debug"]
                .into_iter()
                .map(String::from),
        );
        assert_eq!(
            got,
            vec![
                ("campaign".to_string(), "hollow-house".to_string()),
                ("surface".to_string(), "crt-terminal".to_string()),
                ("debug".to_string(), String::new()),
            ]
        );
    }

    #[test]
    fn a_flag_before_another_key_stays_a_flag() {
        let got = parse_args(["--debug", "--theme=amber"].into_iter().map(String::from));
        assert_eq!(
            got,
            vec![
                ("debug".to_string(), String::new()),
                ("theme".to_string(), "amber".to_string()),
            ]
        );
    }
}
