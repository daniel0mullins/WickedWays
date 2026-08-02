//! The web client's map view.
//!
//! The fog-of-war model and pure grid geometry (`MapModel`, `layout_map`, the `Laid*`/`Map*` types)
//! now live in the transport-agnostic [`wickedways_tabletop::map`] bridge crate and are re-exported
//! here, so the CRT/PnC/tabletop surfaces keep importing them from `crate::map`. This module adds only
//! the Dioxus SVG emitter ([`map_svg`]) — the one wasm/DOM half that can't live in the bridge.

use dioxus::prelude::*;

pub use wickedways_tabletop::map::*;

/// Thin RSX emitter: turn a layout into an `<svg>`. Styled via the `.map-*` CSS classes.
pub fn map_svg(layout: &MapLayout) -> Element {
    rsx! {
        svg {
            view_box: "0 0 {layout.width} {layout.height}",
            class: "map-svg",
            width: "{layout.width}",
            height: "{layout.height}",
            for (i, s) in layout.stubs.iter().enumerate() {
                line {
                    key: "stub-{i}",
                    x1: "{s.x1}", y1: "{s.y1}", x2: "{s.x2}", y2: "{s.y2}",
                    class: if s.locked { "map-stub locked" } else { "map-stub" },
                }
                text {
                    key: "stub-q-{i}",
                    x: "{s.qx}", y: "{s.qy}",
                    class: "map-q",
                    text_anchor: "middle",
                    dominant_baseline: "middle",
                    "?"
                }
            }
            for (i, lk) in layout.links.iter().enumerate() {
                line {
                    key: "link-{i}",
                    x1: "{lk.x1}", y1: "{lk.y1}", x2: "{lk.x2}", y2: "{lk.y2}",
                    class: if lk.locked { "map-link locked" } else { "map-link" },
                }
            }
            for (i, b) in layout.boxes.iter().enumerate() {
                rect {
                    key: "box-{i}",
                    x: "{b.x}", y: "{b.y}", width: "{b.w}", height: "{b.h}", rx: "4",
                    class: if b.current { "map-box current" } else { "map-box" },
                }
                text {
                    key: "label-{i}",
                    x: "{b.x + b.w / 2.0}", y: "{b.y + b.h / 2.0}",
                    class: "map-label",
                    text_anchor: "middle",
                    dominant_baseline: "middle",
                    "{b.label}"
                }
                if b.remains {
                    text {
                        key: "remains-{i}",
                        x: "{b.x + b.w - 8.0}", y: "{b.y + 10.0}",
                        class: "map-remains",
                        text_anchor: "middle",
                        dominant_baseline: "middle",
                        "✕"
                    }
                }
            }
        }
    }
}
