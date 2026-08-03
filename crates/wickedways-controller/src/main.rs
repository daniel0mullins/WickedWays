//! The host controller binary — the Tier-0 prototype's software (see `docs/tabletop-prototype-bom.md`).
//!
//! It boots the engine solo, paints the board over a serial link, and turns inbound board events
//! (a tagged piece moved) back into engine moves via [`wickedways_tabletop::bridge`]. Illegal moves are
//! rejected by the engine's `authorize` gate and surfaced as a `reject` LED — no turn logic lives on
//! the far side of the wire.
//!
//! ```text
//! wickedways-controller <serial-port> [baud]   # drive real hardware (default 115200 baud)
//! wickedways-controller --dry-run              # run the whole engine → bridge → codec path, no device
//! ```

mod session;
mod transport;

use std::time::Duration;

use wickedways_core::world::direction::Direction;

use wickedways_tabletop::codec::encode_command;
use wickedways_tabletop::protocol::{DeviceCommand, DeviceEvent, LedEffect};
use wickedways_tabletop::transport::DeviceTransport;

use crate::session::Controller;
use crate::transport::SerialTransport;

fn main() {
    let args: Vec<String> = std::env::args().collect();

    if args.iter().any(|a| a == "--dry-run") {
        dry_run();
        return;
    }

    let Some(port) = args.get(1) else {
        eprintln!("usage: wickedways-controller <serial-port> [baud]   |   --dry-run");
        std::process::exit(2);
    };
    let baud: u32 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(115_200);

    if let Err(err) = run(port, baud) {
        eprintln!("controller: {err}");
        std::process::exit(1);
    }
}

/// The hardware loop: paint the opening board, then repaint on every applied event.
fn run(port: &str, baud: u32) -> Result<(), serialport::Error> {
    let mut controller = Controller::boot();
    let mut device = SerialTransport::open(port, baud)?;
    println!("controller: {port} @ {baud} baud — engine booted, painting the opening board");
    device.send(&controller.board());

    loop {
        for event in device.poll() {
            match controller.handle(&event) {
                Ok(true) => device.send(&controller.board()),
                Ok(false) => {}
                Err(reason) => {
                    eprintln!("rejected: {reason}");
                    if let Some(tile) = reject_tile(&controller, &event) {
                        device.send(&[DeviceCommand::Led {
                            tile_id: tile,
                            effect: LedEffect::Reject,
                        }]);
                    }
                }
            }
        }
        // Idle between polls; the read timeout already bounds each poll.
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// The tile to flash red when a board event is rejected — the acting piece's current tile.
fn reject_tile(controller: &Controller, event: &DeviceEvent) -> Option<String> {
    match event {
        DeviceEvent::PieceMoved { actor_id, .. } | DeviceEvent::TileAction { actor_id, .. } => {
            controller.actor_tile(actor_id)
        }
        DeviceEvent::Lantern { tile_id, .. } => Some(tile_id.clone()),
    }
}

/// Exercise the full engine → bridge → codec path with no serial device: print the opening board, then
/// drive one legal piece move (Foyer → Hall, North) and reprint. This is the offline smoke test for the
/// controller wiring the Tier-0 hardware would run.
fn dry_run() {
    let mut controller = Controller::boot();
    println!("== opening board ==");
    print_board(&controller.board());

    let event = DeviceEvent::PieceMoved {
        actor_id: controller.active_actor(),
        dir: Direction::North,
    };
    println!("\n== inbound event: {event:?} ==");
    match controller.handle(&event) {
        Ok(true) => {
            println!("applied — repainting\n");
            print_board(&controller.board());
        }
        Ok(false) => println!("local-only event; no engine command"),
        Err(reason) => println!("rejected: {reason}"),
    }
}

/// Print each command as it would go on the wire, with its framed byte length.
fn print_board(commands: &[DeviceCommand]) {
    for cmd in commands {
        let json = serde_json::to_string(cmd).unwrap_or_default();
        let bytes = encode_command(cmd).len();
        println!("  {json}  ({bytes} wire bytes)");
    }
}
