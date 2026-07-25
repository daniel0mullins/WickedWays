//! The warm local mirror.
//!
//! The local log + head + snapshot + gap buffer that the server subscription feeds, so every
//! *synchronous* read the
//! [`SyncTransport`](wickedways_core::sync::SyncTransport) makes (`head`/`entries_since`/
//! `load_snapshot`) is served locally and only `submit` awaits the server. This is the pure,
//! browser-free heart of the transport — the `web-sys` socket binding (open/message/close,
//! handshake, reconnect, the async `submit` await) wraps it in [`crate::transport`].
//!
//! Entries arrive on the wire as [`WireLogEntry`](wickedways_transport::WireLogEntry) (opaque
//! `command`/`delta` `Value`s); the mirror deserializes them into native
//! [`LogEntry`](wickedways_core::sync::LogEntry)s so the [`SyncCoordinator`] can apply the typed
//! deltas. Out-of-order entries are gap-buffered and the run heals once it is contiguous, so a
//! replica driven off `entries_since` converges regardless of arrival order.
//!
//! [`SyncCoordinator`]: wickedways_core::sync::SyncCoordinator

use std::collections::BTreeMap;

use wickedways_core::sync::LogEntry;
use wickedways_core::CampaignSnapshot;
use wickedways_transport::WireLogEntry;

/// The warm local mirror of a campaign's committed log + head + latest checkpoint.
#[derive(Default)]
pub struct Mirror {
    log: Vec<LogEntry>,
    head: u64,
    snapshot: Option<(u64, CampaignSnapshot)>,
    /// Entries received ahead of the contiguous run, held by seq until the gap fills.
    buffer: BTreeMap<u64, LogEntry>,
}

impl Mirror {
    /// A fresh, empty mirror (head 0, no snapshot).
    pub fn new() -> Self {
        Self::default()
    }

    /// Handshake seed: the mirror is "caught up to" `seq` even though it holds no entries yet
    /// (entries stream from `seq + 1` onward). A `None` snapshot (unknown campaign) leaves the
    /// checkpoint unset while still advancing the head.
    pub fn seed(&mut self, seq: u64, snapshot: Option<CampaignSnapshot>) {
        self.head = seq;
        self.snapshot = snapshot.map(|s| (seq, s));
    }

    /// Highest committed seq in the mirror.
    pub fn head(&self) -> u64 {
        self.head
    }

    /// Committed entries with `seq >= from_seq`, in order (the `entries_since` read).
    pub fn entries_since(&self, from_seq: u64) -> Vec<LogEntry> {
        self.log
            .iter()
            .filter(|e| e.seq >= from_seq)
            .cloned()
            .collect()
    }

    /// The latest checkpoint `(seq, snapshot)`, if the handshake seeded one.
    pub fn load_snapshot(&self) -> Option<(u64, CampaignSnapshot)> {
        self.snapshot.clone()
    }

    /// Applies a native entry: a duplicate (`seq <= head`, including our own committed delta) is
    /// skipped; a gap (`seq > head + 1`) is buffered; otherwise it commits and drains any now-
    /// contiguous buffered entries.
    pub fn apply_entry(&mut self, entry: LogEntry) {
        if entry.seq <= self.head {
            return; // duplicate
        }
        if entry.seq > self.head + 1 {
            self.buffer.insert(entry.seq, entry); // gap: hold until the missing seqs arrive
            return;
        }
        self.commit(entry);
        while let Some(next) = self.buffer.remove(&(self.head + 1)) {
            self.commit(next);
        }
    }

    /// Deserializes a wire entry (opaque `command`/`delta`) into a native [`LogEntry`] and applies
    /// it. A malformed entry (bad JSON shape) is returned as an error and left unapplied — a correct
    /// server never sends one.
    pub fn apply_wire_entry(&mut self, wire: &WireLogEntry) -> Result<(), serde_json::Error> {
        let entry = LogEntry {
            seq: wire.seq,
            base_seq: wire.base_seq,
            command: serde_json::from_value(wire.command.clone())?,
            delta: serde_json::from_value(wire.delta.clone())?,
        };
        self.apply_entry(entry);
        Ok(())
    }

    fn commit(&mut self, entry: LogEntry) {
        self.head = entry.seq;
        self.log.push(entry);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wickedways_core::sync::{Command, Delta};

    /// A native entry with an empty delta (the mirror stores entries; it doesn't apply deltas, so
    /// the delta content is irrelevant to its logic).
    fn entry(seq: u64) -> LogEntry {
        LogEntry {
            seq,
            base_seq: seq - 1,
            command: Command::NextPlayer,
            delta: Delta {
                created: vec![],
                changed: vec![],
                removed: vec![],
                campaign_core: None,
                cues: vec![],
            },
        }
    }

    fn seqs(m: &Mirror) -> Vec<u64> {
        m.entries_since(0).iter().map(|e| e.seq).collect()
    }

    #[test]
    fn in_order_entries_advance_head_and_log() {
        let mut m = Mirror::new();
        m.apply_entry(entry(1));
        m.apply_entry(entry(2));
        m.apply_entry(entry(3));
        assert_eq!(m.head(), 3);
        assert_eq!(seqs(&m), vec![1, 2, 3]);
    }

    #[test]
    fn a_duplicate_or_stale_entry_is_skipped() {
        let mut m = Mirror::new();
        m.apply_entry(entry(1));
        m.apply_entry(entry(1)); // duplicate (our own committed delta echoes this)
        assert_eq!(m.head(), 1);
        assert_eq!(seqs(&m), vec![1]);
    }

    #[test]
    fn a_gap_buffers_then_heals_when_the_run_is_contiguous() {
        let mut m = Mirror::new();
        m.apply_entry(entry(1));
        // 3 and 4 arrive before 2 — held, head does not advance past 1.
        m.apply_entry(entry(3));
        m.apply_entry(entry(4));
        assert_eq!(m.head(), 1, "the gap holds the run at 1");
        assert_eq!(seqs(&m), vec![1]);
        // 2 fills the gap → 2, then 3 and 4 drain in order.
        m.apply_entry(entry(2));
        assert_eq!(m.head(), 4, "the run heals to 4");
        assert_eq!(seqs(&m), vec![1, 2, 3, 4]);
    }

    #[test]
    fn seed_sets_head_and_snapshot_without_entries() {
        let mut m = Mirror::new();
        // A minimal snapshot round-tripped through the wire form.
        let snap: CampaignSnapshot = serde_json::from_str(
            &std::fs::read_to_string(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../conformance/fixtures/sync-move.genesis.json"),
            )
            .expect("read genesis"),
        )
        .expect("parse");
        m.seed(5, Some(snap.clone()));
        assert_eq!(m.head(), 5, "seeded head is the snapshot seq");
        assert!(
            seqs(&m).is_empty(),
            "no entries yet — they stream from seq+1"
        );
        let (seq, got) = m.load_snapshot().expect("snapshot seeded");
        assert_eq!(seq, 5);
        assert_eq!(got, snap);
        // Entries below the seeded head are ignored; the next contiguous entry (6) applies.
        m.apply_entry(entry(3));
        assert!(seqs(&m).is_empty());
        m.apply_entry(entry(6));
        assert_eq!(m.head(), 6);
    }

    #[test]
    fn apply_wire_entry_deserializes_the_opaque_payloads() {
        let mut m = Mirror::new();
        let wire = WireLogEntry {
            seq: 1,
            base_seq: 0,
            command: json!({ "kind": "nextPlayer" }),
            delta: json!({ "changed": [], "created": [], "removed": [] }),
        };
        m.apply_wire_entry(&wire)
            .expect("well-formed wire entry applies");
        assert_eq!(m.head(), 1);
        assert_eq!(seqs(&m), vec![1]);
    }

    #[test]
    fn a_malformed_wire_entry_is_rejected_not_applied() {
        let mut m = Mirror::new();
        let bad = WireLogEntry {
            seq: 1,
            base_seq: 0,
            command: json!({ "kind": "notACommand" }),
            delta: json!({}),
        };
        assert!(m.apply_wire_entry(&bad).is_err());
        assert_eq!(m.head(), 0, "a malformed entry leaves the mirror untouched");
    }
}
