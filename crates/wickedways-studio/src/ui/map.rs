//! The Map view — a read-only graph of rooms and exits (the spec's P3 item).
//!
//! Layout is not reinvented: the document is compiled and assembled (the same
//! pipeline as Check campaign), loaded into a `World`, and revealed into the
//! play client's own map model (`wickedways_tabletop::map::MapModel::reveal_world`
//! — the Villain's omniscient view), then laid out by `layout_map`. So the studio
//! map is byte-faithful to the geometry players see. Clicking a room jumps to its
//! editor form; editing stays in the forms (read-only view, per the spec).

use dioxus::prelude::*;

use wickedways_assemble::{assemble, Seat};
use wickedways_author::compile;
use wickedways_core::World;
use wickedways_tabletop::map::{layout_map, MapLayout, MapModel};

use crate::app::StudioStore;
use crate::export::to_toml;
use crate::model::EditorDoc;

/// Compile + assemble the document and lay out its full room graph.
/// `Err` carries a human message when the campaign doesn't build yet.
pub fn build_layout(doc: &EditorDoc) -> Result<MapLayout, String> {
    let toml_src = to_toml(doc)?;
    let compiled = compile(&toml_src).map_err(|e| format!("compile: {e}"))?;
    let seats: [Seat; 0] = [];
    let snap = assemble(&compiled.description, &compiled.catalog, &seats).map_err(|e| {
        let first = e
            .problems
            .first()
            .map_or_else(String::new, ToString::to_string);
        format!("assemble: {} problem(s) — first: {first}", e.problems.len())
    })?;
    let world = World::from_snapshot(snap);
    let mut model = MapModel::new();
    model.reveal_world(&world);
    Ok(layout_map(&model))
}

#[component]
pub fn MapScreen() -> Element {
    let store = use_context::<StudioStore>();
    let doc = (store.doc)();
    // Room name → (editor id, dark) for click-through and shading.
    let room_info: Vec<(String, u64, bool)> = doc
        .rooms
        .iter()
        .map(|r| (r.entry.name.clone(), r.id, r.entry.dark.unwrap_or(false)))
        .collect();
    match build_layout(&doc) {
        Ok(layout) => rsx! {
            div { class: "studio-map",
                p { class: "studio-hint",
                    "The assembled room graph — the same geometry the play client's map uses. Dashed links are locked doors; dark rooms are shaded. Click a room to edit it."
                }
                svg {
                    view_box: "0 0 {layout.width} {layout.height}",
                    class: "studio-map-svg",
                    width: "{layout.width}",
                    height: "{layout.height}",
                    for (i, lk) in layout.links.iter().enumerate() {
                        line {
                            key: "link-{i}",
                            x1: "{lk.x1}", y1: "{lk.y1}", x2: "{lk.x2}", y2: "{lk.y2}",
                            class: if lk.locked { "studio-map-link locked" } else { "studio-map-link" },
                        }
                    }
                    for (i, b) in layout.boxes.iter().enumerate() {
                        {
                            let info = room_info.iter().find(|(name, _, _)| *name == b.label);
                            // `target` is `Option<u64>` — a `Copy` type, so the
                            // `move` handler below captures it by value with no
                            // clone dance (contrast the `String` keys elsewhere).
                            let target = info.map(|(_, id, _)| *id);
                            let dark = info.is_some_and(|(_, _, dark)| *dark);
                            rsx! {
                                g {
                                    key: "room-{i}",
                                    class: "studio-map-room",
                                    onclick: move |_| {
                                        if let Some(id) = target {
                                            store.select("rooms", Some(id));
                                        }
                                    },
                                    rect {
                                        x: "{b.x}", y: "{b.y}", width: "{b.w}", height: "{b.h}", rx: "4",
                                        class: if dark { "studio-map-box dark" } else { "studio-map-box" },
                                    }
                                    text {
                                        x: "{b.x + b.w / 2.0}", y: "{b.y + b.h / 2.0}",
                                        class: "studio-map-label",
                                        text_anchor: "middle",
                                        dominant_baseline: "middle",
                                        "{b.label}"
                                    }
                                }
                            }
                        }
                    }
                }
            }
        },
        Err(msg) => rsx! {
            div { class: "studio-map",
                p { class: "studio-empty",
                    "The map needs a campaign that compiles and assembles — fix the problems below (or run Check campaign for the full report)."
                }
                p { class: "studio-field-err", "{msg}" }
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::build_layout;
    use crate::export::import;

    #[test]
    fn hollow_house_lays_out_every_room_with_locked_wards() {
        let src = include_str!("../../../../campaigns/hollow-house.toml");
        let layout = build_layout(&import(src).unwrap()).expect("hollow-house builds");
        assert_eq!(layout.boxes.len(), 9, "all nine rooms are placed");
        let mut labels: Vec<&str> = layout.boxes.iter().map(|b| b.label.as_str()).collect();
        labels.sort_unstable();
        labels.dedup();
        assert_eq!(labels.len(), 9, "labels are unique");
        assert!(!layout.links.is_empty(), "exits render as links");
        assert!(
            layout.links.iter().any(|l| l.locked),
            "the keyed doors render as locked links"
        );
        // No overlapping boxes: distinct top-left corners.
        let mut corners: Vec<(i64, i64)> = layout
            .boxes
            .iter()
            .map(|b| (b.x.round() as i64, b.y.round() as i64))
            .collect();
        corners.sort_unstable();
        corners.dedup();
        assert_eq!(corners.len(), 9, "no two rooms share a cell");
    }

    #[test]
    fn a_broken_campaign_reports_instead_of_panicking() {
        let doc = import("title = \"T\"\nstartRoom = \"Nowhere\"\n[[rooms]]\nname = \"A\"\ndescription = \"a\"\n").unwrap();
        let err = build_layout(&doc).unwrap_err();
        assert!(err.contains("Nowhere"), "message names the problem: {err}");
    }

    #[test]
    fn disconnected_components_still_all_place() {
        let doc = import(
            r#"
            title = "T"
            startRoom = "A"
            [[rooms]]
            name = "A"
            description = "a"
            [[rooms]]
            name = "Island"
            description = "unlinked"
        "#,
        )
        .unwrap();
        let layout = build_layout(&doc).expect("builds");
        assert_eq!(layout.boxes.len(), 2, "the unlinked room is still placed");
    }
}
