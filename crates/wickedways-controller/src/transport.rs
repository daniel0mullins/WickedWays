//! The native [`SerialTransport`]: the [`DeviceTransport`] over a UART/USB-CDC serial line.
//!
//! It is deliberately thin — all framing lives in [`wickedways_tabletop::codec`] (COBS-stuffed JSON,
//! `0x00`-delimited), so this only moves bytes: `send` writes each command's frame; `poll` reads
//! whatever bytes are available and feeds the [`FrameDecoder`], which yields decoded
//! [`DeviceEvent`]s. A short read timeout keeps `poll` non-blocking for the controller loop.

use std::io::{Read, Write};
use std::time::Duration;

use serialport::SerialPort;

use wickedways_tabletop::codec::{encode_command, FrameDecoder};
use wickedways_tabletop::protocol::{DeviceCommand, DeviceEvent};
use wickedways_tabletop::transport::DeviceTransport;

/// A device link over a serial port. Wraps an open port plus the inbound frame reassembler.
pub struct SerialTransport {
    port: Box<dyn SerialPort>,
    decoder: FrameDecoder,
    scratch: [u8; 1024],
}

impl SerialTransport {
    /// Open `path` at `baud` with a short read timeout so `poll` never blocks the loop.
    ///
    /// # Errors
    /// Returns the underlying [`serialport::Error`] if the port can't be opened (missing device,
    /// permissions, busy).
    pub fn open(path: &str, baud: u32) -> serialport::Result<Self> {
        let port = serialport::new(path, baud)
            .timeout(Duration::from_millis(10))
            .open()?;
        Ok(Self {
            port,
            decoder: FrameDecoder::new(),
            scratch: [0u8; 1024],
        })
    }
}

impl DeviceTransport for SerialTransport {
    fn send(&mut self, commands: &[DeviceCommand]) {
        for cmd in commands {
            let frame = encode_command(cmd);
            if let Err(err) = self.port.write_all(&frame) {
                eprintln!("serial write failed: {err}");
                return;
            }
        }
        if let Err(err) = self.port.flush() {
            eprintln!("serial flush failed: {err}");
        }
    }

    fn poll(&mut self) -> Vec<DeviceEvent> {
        let mut events = Vec::new();
        loop {
            match self.port.read(&mut self.scratch) {
                Ok(0) => break,
                Ok(n) => {
                    let decoded = self.decoder.feed_typed::<DeviceEvent>(&self.scratch[..n]);
                    events.extend(decoded);
                }
                // A timeout just means "no bytes right now" — the loop's normal idle state.
                Err(ref err) if err.kind() == std::io::ErrorKind::TimedOut => break,
                Err(err) => {
                    eprintln!("serial read failed: {err}");
                    break;
                }
            }
        }
        events
    }
}
