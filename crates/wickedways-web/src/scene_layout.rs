//! Point-and-click scene geometry (Phase 2c, sub-project D — slice 3).
//!
//! Ports the pure placement logic of `packages/play-surface/src/pnc/components/pnc-scene.ts`: where
//! each [`Hotspot`] sits in the scene box. Exits and locked doors go on the perimeter by compass
//! bearing ([`dir_position`]); occupants, loot, and floor items spread deterministically across a
//! central band ([`body_position`]). [`partition_hotspots`] splits a hotspot list into those two
//! groups in render order. This is the scene analog of [`map::layout_map`](crate::map::layout_map) —
//! pure geometry the (later) Dioxus `pnc-scene` component consumes to place its DOM, so it is
//! browser-free and unit-tested on the host.

use wickedways_core::world::direction::Direction;

use crate::affordances::{Hotspot, HotspotKind};

/// A position within the scene box, as percentages (0–100) of its width/height. The render maps
/// these straight to `left`/`top` CSS.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScenePosition {
    pub left: f64,
    pub top: f64,
}

/// Every compass bearing's perimeter position inside the scene box. Mirrors the TS `DIR_POSITION`
/// table exactly (percentages within the scene container).
pub fn dir_position(dir: Direction) -> ScenePosition {
    use Direction::*;
    let (left, top) = match dir {
        North => (50.0, 5.0),
        South => (50.0, 90.0),
        East => (90.0, 50.0),
        West => (5.0, 50.0),
        Northeast => (85.0, 10.0),
        Northwest => (10.0, 10.0),
        Southeast => (85.0, 85.0),
        Southwest => (10.0, 85.0),
    };
    ScenePosition { left, top }
}

/// Deterministic placement for body hotspots (occupants, loot, floor items): spread evenly across a
/// central horizontal band at 48% height. Same input always produces the same position, so
/// re-renders are stable. Mirrors the TS `bodyPosition`.
pub fn body_position(index: usize, total: usize) -> ScenePosition {
    let left = if total <= 1 {
        50.0
    } else {
        // `20 + (index / (total - 1)) * 60`, rounded (JS `Math.round`; values are non-negative here
        // so round-half-up and round-half-away-from-zero agree).
        (20.0 + (index as f64 / (total - 1) as f64) * 60.0).round()
    };
    ScenePosition { left, top: 48.0 }
}

/// Split a hotspot list into the two render groups, preserving order:
///
/// - **perimeter**: exits and locked doors (they carry a `dir`) — placed by compass bearing and
///   stacked above the body (z-index 2) so a doorway stays clickable even with an occupant over it.
/// - **body**: occupants, loot containers, floor items — spread across the central band (z-index 1).
///
/// Mirrors the two `.filter(...)` passes in `pnc-scene.ts`'s `render`.
pub fn partition_hotspots(hotspots: &[Hotspot]) -> (Vec<&Hotspot>, Vec<&Hotspot>) {
    let perimeter = hotspots
        .iter()
        .filter(|h| matches!(h.kind, HotspotKind::Exit | HotspotKind::Locked) && h.dir.is_some())
        .collect();
    let body = hotspots
        .iter()
        .filter(|h| {
            matches!(
                h.kind,
                HotspotKind::Occupant
                    | HotspotKind::Player
                    | HotspotKind::Loot
                    | HotspotKind::Item
                    | HotspotKind::Cache
            )
        })
        .collect();
    (perimeter, body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hs(key: &str, kind: HotspotKind, dir: Option<Direction>) -> Hotspot {
        Hotspot {
            key: key.into(),
            label: key.into(),
            kind,
            dir,
            image: None,
            actions: Vec::new(),
        }
    }

    #[test]
    fn dir_position_matches_the_ts_table_for_all_eight_bearings() {
        assert_eq!(
            dir_position(Direction::North),
            ScenePosition {
                left: 50.0,
                top: 5.0
            }
        );
        assert_eq!(
            dir_position(Direction::South),
            ScenePosition {
                left: 50.0,
                top: 90.0
            }
        );
        assert_eq!(
            dir_position(Direction::East),
            ScenePosition {
                left: 90.0,
                top: 50.0
            }
        );
        assert_eq!(
            dir_position(Direction::West),
            ScenePosition {
                left: 5.0,
                top: 50.0
            }
        );
        assert_eq!(
            dir_position(Direction::Northeast),
            ScenePosition {
                left: 85.0,
                top: 10.0
            }
        );
        assert_eq!(
            dir_position(Direction::Northwest),
            ScenePosition {
                left: 10.0,
                top: 10.0
            }
        );
        assert_eq!(
            dir_position(Direction::Southeast),
            ScenePosition {
                left: 85.0,
                top: 85.0
            }
        );
        assert_eq!(
            dir_position(Direction::Southwest),
            ScenePosition {
                left: 10.0,
                top: 85.0
            }
        );
    }

    #[test]
    fn body_position_centers_a_lone_item() {
        assert_eq!(
            body_position(0, 1),
            ScenePosition {
                left: 50.0,
                top: 48.0
            }
        );
        // total == 0 is defensive (no body items) but must not divide by zero.
        assert_eq!(
            body_position(0, 0),
            ScenePosition {
                left: 50.0,
                top: 48.0
            }
        );
    }

    #[test]
    fn body_position_spreads_two_items_to_the_band_edges() {
        assert_eq!(
            body_position(0, 2),
            ScenePosition {
                left: 20.0,
                top: 48.0
            }
        );
        assert_eq!(
            body_position(1, 2),
            ScenePosition {
                left: 80.0,
                top: 48.0
            }
        );
    }

    #[test]
    fn body_position_places_the_middle_of_three_at_center() {
        assert_eq!(
            body_position(0, 3),
            ScenePosition {
                left: 20.0,
                top: 48.0
            }
        );
        assert_eq!(
            body_position(1, 3),
            ScenePosition {
                left: 50.0,
                top: 48.0
            }
        );
        assert_eq!(
            body_position(2, 3),
            ScenePosition {
                left: 80.0,
                top: 48.0
            }
        );
    }

    #[test]
    fn body_position_rounds_uneven_divisions() {
        // total 5 → step 15%: index 1 → 35, index 2 → 50.
        assert_eq!(body_position(1, 5).left, 35.0);
        assert_eq!(body_position(2, 5).left, 50.0);
        // total 4 → step 20%: index 1 → 40, index 2 → 60.
        assert_eq!(body_position(1, 4).left, 40.0);
        assert_eq!(body_position(2, 4).left, 60.0);
    }

    #[test]
    fn partition_puts_exits_and_locked_doors_on_the_perimeter_and_the_rest_in_the_body() {
        let hotspots = vec![
            hs("north", HotspotKind::Exit, Some(Direction::North)),
            hs("east", HotspotKind::Locked, Some(Direction::East)),
            hs("mob", HotspotKind::Occupant, None),
            hs("chest", HotspotKind::Loot, None),
            hs("torch", HotspotKind::Item, None),
        ];
        let (perimeter, body) = partition_hotspots(&hotspots);
        assert_eq!(
            perimeter.iter().map(|h| h.key.as_str()).collect::<Vec<_>>(),
            ["north", "east"]
        );
        assert_eq!(
            body.iter().map(|h| h.key.as_str()).collect::<Vec<_>>(),
            ["mob", "chest", "torch"]
        );
    }

    #[test]
    fn partition_preserves_input_order_within_each_group() {
        let hotspots = vec![
            hs("mob", HotspotKind::Occupant, None),
            hs("west", HotspotKind::Exit, Some(Direction::West)),
            hs("item", HotspotKind::Item, None),
            hs("north", HotspotKind::Exit, Some(Direction::North)),
        ];
        let (perimeter, body) = partition_hotspots(&hotspots);
        assert_eq!(
            perimeter.iter().map(|h| h.key.as_str()).collect::<Vec<_>>(),
            ["west", "north"]
        );
        assert_eq!(
            body.iter().map(|h| h.key.as_str()).collect::<Vec<_>>(),
            ["mob", "item"]
        );
    }
}
