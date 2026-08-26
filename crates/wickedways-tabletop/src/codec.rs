//! The serial wire codec: COBS-framed JSON, one message per frame.
//!
//! The [`transport`](crate::transport) trait is abstract, but the *hardware* transport (a serial line
//! to the ESP32; see `docs/tabletop-firmware-sketch.md`) needs a concrete framing. This is it, kept
//! pure — no I/O, no `serialport` — so it lives in the wasm-safe bridge crate, is exercised by the
//! normal test gate, and can be reused by the on-screen simulator. The native `SerialTransport` in the
//! `wickedways-controller` crate is a thin wrapper: read/write bytes, defer all framing here.
//!
//! # Framing
//!
//! Each message is `serde_json`-encoded, then [COBS]-stuffed, then terminated with a single `0x00`
//! delimiter. COBS guarantees the payload never contains a `0x00`, so the delimiter unambiguously ends
//! a frame even if the link drops or resynchronizes mid-stream. JSON (not a binary format) is the wire
//! type because the protocol already derives it and a hobbyist can watch the link with a serial
//! monitor; `postcard` would be a drop-in binary alternative behind the same frame boundary.
//!
//! [COBS]: https://en.wikipedia.org/wiki/Consistent_Overhead_Byte_Stuffing

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::protocol::DeviceCommand;

/// The frame delimiter. COBS output never contains a zero byte, so this can only mean "end of frame".
pub const DELIMITER: u8 = 0x00;

// ─── COBS primitives ─────────────────────────────────────────────────────────

/// COBS-encode `data` (does **not** append the delimiter). The result never contains a `0x00` byte.
// `#[must_use]` makes the compiler warn if a caller drops the return value — for a pure function,
// calling it and ignoring the result is always a bug.
#[must_use]
pub fn cobs_encode(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + data.len() / 254 + 2);
    // Reserve the code byte for the block being built; back-patch it when the block closes.
    let mut code_index = out.len();
    out.push(0);
    let mut code: u8 = 1;
    for &byte in data {
        if byte == 0 {
            out[code_index] = code;
            code_index = out.len();
            out.push(0);
            code = 1;
        } else {
            out.push(byte);
            code += 1;
            if code == 0xFF {
                out[code_index] = code;
                code_index = out.len();
                out.push(0);
                code = 1;
            }
        }
    }
    out[code_index] = code;
    out
}

/// COBS-decode one frame's bytes (the delimiter must already be stripped). Returns `None` on a
/// malformed frame (an embedded zero, or a code that runs past the end).
#[must_use]
pub fn cobs_decode(frame: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(frame.len());
    let mut i = 0;
    while i < frame.len() {
        let code = usize::from(frame[i]);
        if code == 0 || i + code > frame.len() {
            return None;
        }
        out.extend_from_slice(&frame[i + 1..i + code]);
        i += code;
        // A block shorter than 0xFF implied a zero between it and the next — unless it was the last.
        if code < 0xFF && i < frame.len() {
            out.push(0);
        }
    }
    Some(out)
}

// ─── framing: message ↔ wire frame ───────────────────────────────────────────

/// Encode a value into a complete wire frame: COBS-stuffed JSON + the `0x00` delimiter.
///
/// # Panics
/// Panics only if the value fails to serialize to JSON, which the device protocol never does.
// `<T: Serialize>` is a bounded generic, like TS `<T extends Serializable>` — any serde-derived
// type frames the same way.
#[must_use]
pub fn encode<T: Serialize>(msg: &T) -> Vec<u8> {
    let json = serde_json::to_vec(msg).expect("device protocol serializes to JSON");
    let mut frame = cobs_encode(&json);
    frame.push(DELIMITER);
    frame
}

/// Encode one outbound [`DeviceCommand`] to a wire frame.
#[must_use]
pub fn encode_command(cmd: &DeviceCommand) -> Vec<u8> {
    encode(cmd)
}

// ─── stream reassembly ───────────────────────────────────────────────────────

/// Reassembles delimiter-terminated frames from a byte stream that may arrive in arbitrary chunks.
///
/// Bytes are buffered until a `0x00` is seen; each completed frame is COBS-decoded and, in
/// [`feed`](Self::feed_typed), deserialized. Malformed frames are dropped (the link self-heals on the
/// next delimiter) rather than poisoning the stream.
#[derive(Default)]
pub struct FrameDecoder {
    buf: Vec<u8>,
}

impl FrameDecoder {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed a chunk of bytes; return the COBS-decoded payload of every frame that completed.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<Vec<u8>> {
        let mut frames = Vec::new();
        for &byte in bytes {
            if byte == DELIMITER {
                if !self.buf.is_empty() {
                    if let Some(decoded) = cobs_decode(&self.buf) {
                        frames.push(decoded);
                    }
                    self.buf.clear();
                }
            } else {
                self.buf.push(byte);
            }
        }
        frames
    }

    /// Feed a chunk of bytes; deserialize each completed frame as `T`, dropping any that fail.
    pub fn feed_typed<T: DeserializeOwned>(&mut self, bytes: &[u8]) -> Vec<T> {
        // `.ok()` turns a parse `Result` into an `Option`, and `filter_map` keeps only the `Some`s
        // — i.e. a frame that fails to parse is silently dropped, matching the doc contract above.
        self.feed(bytes)
            .iter()
            .filter_map(|frame| serde_json::from_slice(frame).ok())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{DeviceEvent, PieceGlow};
    use wickedways_core::world::direction::Direction;

    fn roundtrip(data: &[u8]) {
        let encoded = cobs_encode(data);
        assert!(
            !encoded.contains(&0),
            "COBS output must never contain a zero byte"
        );
        assert_eq!(
            cobs_decode(&encoded).as_deref(),
            Some(data),
            "COBS round-trip"
        );
    }

    #[test]
    fn cobs_roundtrips_edge_shapes() {
        roundtrip(&[]);
        roundtrip(&[0]);
        roundtrip(&[0, 0, 0]);
        roundtrip(&[1, 2, 3]);
        roundtrip(&[0x11, 0x00, 0x22]);
        roundtrip(&[0x11, 0x00, 0x00, 0x00]);
        // A run longer than 254 non-zero bytes exercises the 0xFF block-split path.
        let long: Vec<u8> = (0..300).map(|i| (i % 255 + 1) as u8).collect();
        roundtrip(&long);
        // 254 non-zero bytes then a zero — the exact 0xFF boundary.
        let mut boundary: Vec<u8> = vec![7; 254];
        boundary.push(0);
        boundary.push(9);
        roundtrip(&boundary);
    }

    #[test]
    fn cobs_decode_rejects_malformed_frames() {
        assert_eq!(
            cobs_decode(&[0x00]),
            None,
            "an embedded zero is not valid COBS"
        );
        assert_eq!(
            cobs_decode(&[0x05, 0x01]),
            None,
            "a code that overruns the frame"
        );
    }

    #[test]
    fn command_frames_roundtrip_through_the_decoder() {
        let cmd = DeviceCommand::Piece {
            piece_id: "player:heir".into(),
            name: "Heir".into(),
            tile_id: "foyer".into(),
            glow: PieceGlow::Fear,
            active: true,
        };
        let frame = encode_command(&cmd);
        assert_eq!(
            *frame.last().unwrap(),
            DELIMITER,
            "frame ends with the delimiter"
        );

        let mut dec = FrameDecoder::new();
        let out: Vec<DeviceCommand> = dec.feed_typed(&frame);
        assert_eq!(out, vec![cmd]);
    }

    #[test]
    fn the_decoder_reassembles_frames_split_across_chunks() {
        let a = DeviceEvent::PieceMoved {
            actor_id: "player:heir".into(),
            dir: Direction::North,
        };
        let b = DeviceEvent::Lantern {
            tile_id: "cellar".into(),
            placed: true,
        };
        let mut wire = encode(&a);
        wire.extend(encode(&b));

        // Deliver the stream one byte at a time — nothing may be lost or duplicated at chunk seams.
        let mut dec = FrameDecoder::new();
        let mut events: Vec<DeviceEvent> = Vec::new();
        for byte in wire {
            events.extend(dec.feed_typed::<DeviceEvent>(&[byte]));
        }
        assert_eq!(events, vec![a, b]);
    }

    #[test]
    fn a_garbage_frame_is_dropped_without_derailing_the_stream() {
        let good = DeviceEvent::Lantern {
            tile_id: "hall".into(),
            placed: false,
        };
        let mut dec = FrameDecoder::new();
        // A lone delimiter (empty frame) then junk then a real frame: only the real one survives.
        let mut wire = vec![DELIMITER, 0x02, DELIMITER];
        wire.extend(encode(&good));
        let events: Vec<DeviceEvent> = dec.feed_typed(&wire);
        assert_eq!(events, vec![good]);
    }
}
