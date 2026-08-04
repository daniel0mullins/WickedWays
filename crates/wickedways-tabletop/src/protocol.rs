//! The device wire protocol: what crosses the bridge ↔ board boundary.
//!
//! Outbound [`DeviceCommand`]s paint the board (tiles, pieces, dashboards, LEDs, sound); inbound
//! [`DeviceEvent`]s report what the table did (a piece moved, a tile action, a light placed). The same
//! union drives the on-screen simulator today and real firmware over a serial line later — the transport
//! ([`crate::transport::DeviceTransport`]) is the only thing that changes.

use serde::{Deserialize, Serialize};
use wickedways_core::presentation::StatusField;
use wickedways_core::world::direction::Direction;
use wickedways_core::world::intent::Intent;

/// How a piece glows — its worst affliction (the "glowing piece"). The active-turn ring is a separate
/// `active` flag on [`DeviceCommand::Piece`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PieceGlow {
    Normal,
    Fear,
    Panic,
    Ko,
}

/// A transient LED effect on a tile (the fast channel e-ink can't drive).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LedEffect {
    Encounter,
    Combat,
    Reject,
    Off,
}

/// A command from the bridge to the board (or its on-screen simulator).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DeviceCommand {
    /// Paint a room onto a tile — the tile id *is* the room id. `concealed` (dark + unlit) hides the
    /// art until a light is brought; `remains` marks a defeated-mob tile.
    Tile {
        tile_id: String,
        label: String,
        lit: bool,
        concealed: bool,
        remains: bool,
    },
    /// Place/refresh a seat's piece on a tile, glowing per its state; `active` rings the current seat.
    Piece {
        piece_id: String,
        name: String,
        tile_id: String,
        glow: PieceGlow,
        active: bool,
    },
    /// A seat's dashboard readout.
    Dashboard {
        seat_id: String,
        name: String,
        health: f64,
        sanity: f64,
        afflictions: Vec<String>,
        active: bool,
    },
    /// The shared campaign status banner (the authored status-bar readout).
    Banner { fields: Vec<StatusField> },
    /// Fire a transient LED effect on a tile (reserved for the firmware fast channel).
    Led { tile_id: String, effect: LedEffect },
    /// Play a resolved cue sound (opaque asset ref; reserved for the firmware audio channel).
    Sound { asset: serde_json::Value },
    /// The campaign ended.
    Resolution { outcome: String },
    /// Wipe the board (new game / restart).
    Clear,
}

/// An event from the board to the bridge.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DeviceEvent {
    /// A piece — identified by its NFC tag, which *is* the `actor_id` — moved a compass direction.
    PieceMoved { actor_id: String, dir: Direction },
    /// A contextual action taken as a seat (a tile button / item tap in hardware; a rail click on screen).
    TileAction { actor_id: String, intent: Intent },
    /// A light prop was placed on / removed from a tile.
    Lantern { tile_id: String, placed: bool },
    /// Physical dice were rolled at the table (a dice tray, or a manual entry) — the `values` are
    /// supplied to the engine for its upcoming rolls of that `sides` size (e.g. a mob to-hit d20). A
    /// player with no dice picks "Roll for me" instead, which emits no event (the house rolls).
    DiceRolled { sides: u32, values: Vec<u32> },
}
