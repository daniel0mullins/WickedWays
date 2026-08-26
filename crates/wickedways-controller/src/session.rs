//! The host controller session: an in-process **solo** engine wired to the tabletop bridge.
//!
//! This owns the [`SyncAuthority`] (the game) and the fog-of-war [`MapModel`], and exposes exactly the
//! two bridge operations a transport needs: [`board`](Controller::board) projects the current turn into
//! [`DeviceCommand`]s to paint, and [`handle`](Controller::handle) resolves one inbound
//! [`DeviceEvent`] into an engine command, submits it, and advances the map. It is transport-agnostic —
//! the real [`SerialTransport`](crate::transport::SerialTransport) and the `--dry-run` path both drive
//! the same session.

use std::collections::BTreeSet;

use wickedways_core::sync::{
    AuthorityOpts, Command, InProcessTransport, SubmitResult, SyncAuthority, SyncCoordinator,
};
use wickedways_core::world::descriptor::Catalog;
use wickedways_core::world::view::ViewModel;
use wickedways_core::{CampaignSnapshot, World};

use wickedways_tabletop::bridge::{render, resolve};
use wickedways_tabletop::map::MapModel;
use wickedways_tabletop::protocol::{DeviceCommand, DeviceEvent};
use wickedways_tabletop::roster::party_roster;

// The Tier-0 prototype plays the Hollow House opening; the fixtures ship in the golden corpus.
// `include_str!` embeds the file's text into the binary at compile time — the build-step
// analog of a bundler inlining a JSON import, so the binary needs no files at runtime.
const GENESIS: &str = include_str!("../../../conformance/fixtures/hollow-house.genesis.json");
const CATALOG: &str = include_str!("../../../conformance/fixtures/hollow-house.catalog.json");

/// The engine + bridge, ready to paint and to accept board events.
pub struct Controller {
    transport: InProcessTransport,
    coord: SyncCoordinator,
    catalog: Catalog,
    map: MapModel,
}

impl Controller {
    /// Boot the bundled campaign solo, begin it, and seed the map with the start room.
    ///
    /// # Panics
    /// Panics if the bundled fixtures fail to parse or the campaign refuses to begin — both are
    /// build-time-fixed invariants, not runtime conditions.
    #[must_use]
    pub fn boot() -> Self {
        let genesis: CampaignSnapshot =
            serde_json::from_str(GENESIS).expect("bundled genesis parses");
        let catalog: Catalog = serde_json::from_str(CATALOG).expect("bundled catalog parses");
        let world = World::from_snapshot(genesis);
        let authority = SyncAuthority::new(
            world,
            catalog.clone(),
            AuthorityOpts {
                solo: true,
                ..Default::default()
            },
        );
        let mut transport = InProcessTransport::new(authority);
        let mut coord = SyncCoordinator::join(&transport);
        if let SubmitResult::Denied { reason } =
            coord.submit(&mut transport, Command::BeginCampaign)
        {
            panic!("bundled campaign refused to begin: {reason}");
        }
        coord.sync(&transport);

        let mut this = Self {
            transport,
            coord,
            catalog,
            map: MapModel::new(),
        };
        let start = this.view();
        this.map.observe(&start);
        this
    }

    /// The active viewer's [`ViewModel`] for the current turn.
    #[must_use]
    pub fn view(&self) -> ViewModel {
        self.coord
            .replica()
            .view(&self.catalog, &BTreeSet::new())
            .expect("the active character always projects a view")
    }

    /// The full board render for the current turn (tiles, pieces, dashboards, banner, resolution).
    #[must_use]
    pub fn board(&self) -> Vec<DeviceCommand> {
        let view = self.view();
        let seats = party_roster(self.coord.replica());
        render(&view, &seats, &self.map, self.coord.status_fields())
    }

    /// The `actor_id` whose turn it currently is (its NFC-tagged piece is the one the board expects to
    /// move next).
    #[must_use]
    pub fn active_actor(&self) -> String {
        self.coord
            .replica()
            .active_character_id()
            .map(|id| id.0)
            .unwrap_or_default()
    }

    /// The tile a given actor currently stands on — where a `reject` LED should flash on a bad move.
    #[must_use]
    pub fn actor_tile(&self, actor_id: &str) -> Option<String> {
        party_roster(self.coord.replica())
            .into_iter()
            .find(|seat| seat.id == actor_id)
            .and_then(|seat| seat.room_id)
    }

    /// Resolve, submit, and apply one inbound board event.
    ///
    /// - `Ok(true)` — an engine command was committed; repaint the board.
    /// - `Ok(false)` — a local-only event (a container open, a lantern) — nothing changed.
    /// - `Err(reason)` — the move was blocked or denied; the caller flashes a `reject` LED.
    pub fn handle(&mut self, event: &DeviceEvent) -> Result<bool, String> {
        let before = self.view();
        // `resolve` returns Result<Option<Command>, String> — two layers, unwrapped in
        // one line: `?` propagates a blocked move as our Err, then let-else peels the
        // Option, returning Ok(false) for a local-only event that maps to no command.
        let Some(command) = resolve(event, self.coord.replica(), &self.catalog)? else {
            return Ok(false);
        };
        match self.coord.submit(&mut self.transport, command) {
            SubmitResult::Committed { .. } => {}
            SubmitResult::Denied { reason } => return Err(reason),
        }
        self.coord.sync(&self.transport);

        let after = self.view();
        // Record a move BEFORE observing, so the new room is placed relative to the one we left.
        if let DeviceEvent::PieceMoved { dir, .. } = event {
            self.map.record_move(&before.room.id, *dir, &after.room.id);
        }
        self.map.observe(&after);
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wickedways_core::world::direction::Direction;

    fn piece_tiles(cmds: &[DeviceCommand]) -> Vec<(String, String)> {
        cmds.iter()
            .filter_map(|c| match c {
                DeviceCommand::Piece {
                    piece_id, tile_id, ..
                } => Some((piece_id.clone(), tile_id.clone())),
                _ => None,
            })
            .collect()
    }

    fn has_tile(cmds: &[DeviceCommand], id: &str) -> bool {
        cmds.iter()
            .any(|c| matches!(c, DeviceCommand::Tile { tile_id, .. } if tile_id == id))
    }

    #[test]
    fn boot_paints_the_start_room_with_the_seated_piece() {
        let controller = Controller::boot();
        let board = controller.board();
        let actor = controller.active_actor();
        let start = controller.view().room.id;

        assert!(has_tile(&board, &start), "a tile for the start room");
        assert_eq!(
            piece_tiles(&board),
            vec![(actor, start)],
            "the seated piece stands on the start tile",
        );
    }

    #[test]
    fn a_legal_move_advances_the_engine_and_places_the_new_tile() {
        let mut controller = Controller::boot();
        let actor = controller.active_actor();
        // The Foyer opens North to the Hall.
        let moved = controller
            .handle(&DeviceEvent::PieceMoved {
                actor_id: actor.clone(),
                dir: Direction::North,
            })
            .expect("a legal move is accepted");
        assert!(moved, "a committed move asks for a repaint");

        let board = controller.board();
        let dest = controller.view().room.id;
        assert_ne!(dest, "room:Foyer", "the active piece left the Foyer");
        assert!(
            has_tile(&board, &dest),
            "the newly entered room is now on the board",
        );
        assert_eq!(
            piece_tiles(&board),
            vec![(actor, dest)],
            "the piece is drawn on its new tile",
        );
    }

    #[test]
    fn an_illegal_move_is_rejected_and_leaves_the_engine_untouched() {
        let mut controller = Controller::boot();
        let actor = controller.active_actor();
        let before = controller.view().room.id;
        // No diagonal exit from the Foyer — the engine's exit check rejects it (→ a reject LED).
        let result = controller.handle(&DeviceEvent::PieceMoved {
            actor_id: actor,
            dir: Direction::Northeast,
        });
        assert!(result.is_err(), "an exit-less direction is rejected");
        assert_eq!(
            controller.view().room.id,
            before,
            "a rejected move does not advance the engine",
        );
    }
}
