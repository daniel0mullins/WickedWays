//! The device transport seam — the one thing that changes between the on-screen simulator and real
//! firmware. Everything else (the [`bridge`](crate::bridge) mappers, the [`protocol`](crate::protocol))
//! is transport-agnostic.

use std::collections::VecDeque;

use crate::protocol::{DeviceCommand, DeviceEvent};

/// A physical board (or its simulator): push commands out, poll events in.
pub trait DeviceTransport {
    /// Apply a batch of board commands (paint tiles, place pieces, drive dashboards/LEDs).
    fn send(&mut self, commands: &[DeviceCommand]);
    /// Drain any pending inbound events (piece moves, tile actions, lantern placements).
    fn poll(&mut self) -> Vec<DeviceEvent>;
}

/// An in-memory transport for tests: records every command sent and replays a scripted event queue.
#[derive(Default)]
pub struct FakeTransport {
    commands: Vec<DeviceCommand>,
    queued: VecDeque<DeviceEvent>,
}

impl FakeTransport {
    pub fn new() -> Self {
        Self::default()
    }

    /// Script an event that the next [`poll`](DeviceTransport::poll) will return.
    pub fn push_event(&mut self, event: DeviceEvent) {
        self.queued.push_back(event);
    }

    /// Every command sent so far.
    pub fn sent(&self) -> &[DeviceCommand] {
        &self.commands
    }

    /// Drain and return everything sent so far (resets the record) — convenient between test steps.
    pub fn take_sent(&mut self) -> Vec<DeviceCommand> {
        std::mem::take(&mut self.commands)
    }
}

impl DeviceTransport for FakeTransport {
    fn send(&mut self, commands: &[DeviceCommand]) {
        self.commands.extend_from_slice(commands);
    }

    fn poll(&mut self) -> Vec<DeviceEvent> {
        self.queued.drain(..).collect()
    }
}
