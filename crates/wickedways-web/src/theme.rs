//! Launcher themes (Phase 2c, sub-project D — slice 4, launcher).
//!
//! `?theme=<id>` picks a built-in palette per surface, applied as CSS custom properties on the
//! surface root (the CRT's `.backdrop` `--color-*`, the PnC's `.pnc-app` `--pnc-*`). Pure string
//! lookups — the campaign-supplied theme lists from the TS surfaces are a launcher/manifest concern
//! for later; these are the client's built-ins so `?theme=` does something today. Unknown ids fall
//! back to each surface's default.

/// The CRT terminal palette vars for `id`, defaulting to the green-phosphor look.
pub fn crt_theme_vars(id: &str) -> &'static str {
    match id {
        "amber" => CRT_AMBER,
        "ice" => CRT_ICE,
        _ => CRT_GREEN,
    }
}

/// The point-and-click palette override vars for `id` (applied inline on `.pnc-app`, over the
/// `pnc.css` `:root` defaults), defaulting to the parchment/amber look (an empty override).
pub fn pnc_theme_vars(id: &str) -> &'static str {
    match id {
        "green" => PNC_GREEN,
        "ice" => PNC_ICE,
        _ => PNC_DEFAULT,
    }
}

const CRT_GREEN: &str = "--color-bg:#0b0e0a; --color-text:#9be89b; --color-accent:#d7ffd7; \
    --color-muted:#8a8f80; --color-border:#2a281f; --color-chip-bg:#25241d; --color-error:#e86b6b; \
    --font-body:'VT323',monospace; --base-size:23.4px; --crt-scanline:0.35; \
    --plastic:#c9c4b4; --plastic-light:#e6e1d2; --plastic-dark:#8f8b7d; --plastic-shadow:#5f5c52;";

const CRT_AMBER: &str = "--color-bg:#140f07; --color-text:#ffcf7a; --color-accent:#ffe6b0; \
    --color-muted:#9a8a68; --color-border:#2c2415; --color-chip-bg:#241d10; --color-error:#e8896b; \
    --font-body:'VT323',monospace; --base-size:23.4px; --crt-scanline:0.35; \
    --plastic:#c9c4b4; --plastic-light:#e6e1d2; --plastic-dark:#8f8b7d; --plastic-shadow:#5f5c52;";

const CRT_ICE: &str = "--color-bg:#080d13; --color-text:#9bd7e8; --color-accent:#d7f0ff; \
    --color-muted:#7f8f97; --color-border:#1f2a2e; --color-chip-bg:#101d24; --color-error:#e86b8f; \
    --font-body:'VT323',monospace; --base-size:23.4px; --crt-scanline:0.35; \
    --plastic:#b4c2c9; --plastic-light:#d2e0e6; --plastic-dark:#7d888f; --plastic-shadow:#52595f;";

// PnC overrides only need the base `--pnc-*` tokens; the derived `--color-*` aliases in pnc.css
// reference them, so overriding these on `.pnc-app` recolors the whole surface.
const PNC_DEFAULT: &str = "";

const PNC_GREEN: &str = "--pnc-bg:#0d130c; --pnc-panel:#182014; --pnc-ink:#cfe8c4; \
    --pnc-accent:#6fbf7a; --pnc-warn:#a8d443; --pnc-critical:#c04040; --pnc-hotspot:#4ac88e;";

const PNC_ICE: &str = "--pnc-bg:#0a0f16; --pnc-panel:#141c24; --pnc-ink:#cfe4ec; \
    --pnc-accent:#4a9ec8; --pnc-warn:#43b0d4; --pnc-critical:#c04060; --pnc-hotspot:#4ac8c8;";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crt_theme_lookup_selects_named_palettes_and_defaults_to_green() {
        assert!(crt_theme_vars("amber").contains("#ffcf7a"), "amber palette");
        assert!(crt_theme_vars("ice").contains("#9bd7e8"), "ice palette");
        // The default green phosphor for unknown/absent ids.
        assert!(crt_theme_vars("").contains("#9be89b"));
        assert!(crt_theme_vars("bogus").contains("#9be89b"));
        // Every CRT theme keeps the full var set the surface consumes.
        for id in ["green", "amber", "ice", "bogus"] {
            let vars = crt_theme_vars(id);
            for key in ["--color-bg", "--color-text", "--color-accent", "--plastic", "--crt-scanline"] {
                assert!(vars.contains(key), "{id} missing {key}");
            }
        }
    }

    #[test]
    fn pnc_theme_lookup_selects_named_palettes_and_defaults_to_empty_override() {
        assert!(pnc_theme_vars("green").contains("--pnc-accent:#6fbf7a"));
        assert!(pnc_theme_vars("ice").contains("--pnc-accent:#4a9ec8"));
        // Default (parchment) is the pnc.css :root — no override.
        assert_eq!(pnc_theme_vars(""), "");
        assert_eq!(pnc_theme_vars("bogus"), "");
    }
}
