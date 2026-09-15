//! Per-recipient redaction of the replicated projection — the Villain's hidden information.
//!
//! The authority keeps the **full** state (it validates `playCard`/`mulligan` against the real
//! hand), but the Villain's card piles are hidden information: only the client that *controls* the
//! villain may see them. Everything else in a campaign — rooms, characters, items, the rest of the
//! campaign core — is public table state and replicates verbatim. The room server applies
//! [`redact_snapshot`]/[`redact_delta`] to every checkpoint, backfilled entry, `committed` ack, and
//! broadcast `entry` bound for a recipient who does not control the villain, *before* the payload
//! leaves the server — a client-side gate would be cosmetic, since the wire itself would still
//! carry the hand.
//!
//! The projection **blinds rather than strips**: every card key in `hand`, `deck`, and `discard`
//! is replaced by [`REDACTED_CARD_KEY`], so pile *sizes* stay public (what a physical table shows)
//! while the hand's contents, the draw order, and the discards do not. `characterId` and the
//! per-turn `cardActionTaken` latch are kept — who the villain is, and whether it has acted this
//! turn, are public.
//!
//! A redacted replica converges structurally like any other: [`apply`](super::apply_delta)
//! replaces the campaign core wholesale, so a non-controller's replica always holds the blinded
//! projection of the authority's latest core, never a mix of real and blinded cards. Snapshot and
//! delta *shapes* are untouched — this is a projection at the transport boundary, not a schema
//! change — so the golden gates are unaffected. The offline single-player host never redacts: the
//! local player legitimately drives every seat.

use alloc::string::String;

use crate::world::snapshot::{CampaignSnapshot, VillainSnapshot};

use super::delta::Delta;

/// The card key that stands in for every card a recipient may not see. Never a real card key
/// (native keys are `wicked:*`; authored keys are identifiers), so a blinded card resolves to no
/// catalog face — surfaces render it face-down.
pub const REDACTED_CARD_KEY: &str = "?";

/// Blinds every pile of `villain` in place: each card key in `hand`, `deck`, and `discard`
/// becomes [`REDACTED_CARD_KEY`]. Pile sizes, the `characterId`, and the `cardActionTaken` latch
/// are preserved.
pub fn redact_villain(villain: &mut VillainSnapshot) {
    for pile in [&mut villain.hand, &mut villain.deck, &mut villain.discard] {
        for key in pile.iter_mut() {
            *key = String::from(REDACTED_CARD_KEY);
        }
    }
}

/// Redacts a checkpoint snapshot for a recipient who does not control the villain. A villain-less
/// snapshot is untouched.
pub fn redact_snapshot(snapshot: &mut CampaignSnapshot) {
    if let Some(villain) = snapshot.campaign.villain.as_mut() {
        redact_villain(villain);
    }
}

/// Redacts a delta for a recipient who does not control the villain. Only a delta carrying the
/// campaign core (the wholesale-diffed `campaignCore` payload) can carry villain state; every other
/// delta is untouched.
pub fn redact_delta(delta: &mut Delta) {
    if let Some(villain) = delta_villain_mut(delta) {
        redact_villain(villain);
    }
}

/// The villain state `delta` would replicate, if it carries the campaign core of a villain
/// campaign — the one case a recipient-specific projection is needed for.
pub fn delta_villain(delta: &Delta) -> Option<&VillainSnapshot> {
    delta
        .campaign_core
        .as_ref()
        .and_then(|cc| cc.core.villain.as_ref())
}

fn delta_villain_mut(delta: &mut Delta) -> Option<&mut VillainSnapshot> {
    delta
        .campaign_core
        .as_mut()
        .and_then(|cc| cc.core.villain.as_mut())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::applier::apply;
    use crate::sync::authority::{AuthorityOpts, SubmitResult, SyncAuthority};
    use crate::sync::command::Command;
    use crate::sync::delta::diff;
    use crate::world::descriptor::Catalog;
    use crate::world::ids::CharacterId;
    use crate::world::test_support::world_with_party;
    use crate::world::World;
    use alloc::string::ToString;
    use alloc::vec;
    use alloc::vec::Vec;

    /// A started two-hero + villain world whose villain holds a dealt hand, a draw pile, and a
    /// discard — every pile non-empty, so a redaction that misses one is caught.
    fn villain_world() -> World {
        let mut w = world_with_party(&["hero", "vill"], 10);
        w.campaign.gm_id = Some(CharacterId("vill".into()));
        w.campaign.villain = Some(VillainSnapshot {
            character_id: CharacterId("vill".into()),
            deck: vec!["wicked:ruin".into(), "hex".into()],
            hand: vec![
                "wicked:lights-out".into(),
                "wicked:shadow-step".into(),
                "wicked:scatter".into(),
            ],
            discard: vec!["wicked:lights-out".into()],
            card_action_taken: true,
        });
        w
    }

    fn blinded(n: usize) -> Vec<String> {
        vec![REDACTED_CARD_KEY.to_string(); n]
    }

    #[test]
    fn redact_villain_blinds_every_pile_but_keeps_sizes_identity_and_latch() {
        let mut v = villain_world().campaign.villain.unwrap();
        redact_villain(&mut v);
        assert_eq!(v.hand, blinded(3), "hand contents hidden, size kept");
        assert_eq!(v.deck, blinded(2), "draw order hidden, size kept");
        assert_eq!(v.discard, blinded(1), "discards hidden, size kept");
        assert_eq!(
            v.character_id,
            CharacterId("vill".into()),
            "who the villain is stays public"
        );
        assert!(v.card_action_taken, "the per-turn latch stays public");
    }

    #[test]
    fn a_blinded_card_resolves_to_no_catalog_face() {
        // The sentinel must never collide with a real card: the native keys are namespaced, and a
        // catalog face lookup for it must miss (surfaces then render it face-down).
        assert!(!REDACTED_CARD_KEY.starts_with("wicked:"));
        assert!(!Catalog::default().cards.contains_key(REDACTED_CARD_KEY));
    }

    #[test]
    fn redact_snapshot_touches_only_the_villain() {
        let full = villain_world().to_snapshot();
        let mut redacted = full.clone();
        redact_snapshot(&mut redacted);
        assert_ne!(redacted, full, "the villain piles were blinded");
        // Everything but the villain is byte-identical.
        let mut unblinded = redacted.clone();
        unblinded
            .campaign
            .villain
            .clone_from(&full.campaign.villain);
        assert_eq!(unblinded, full);
    }

    #[test]
    fn a_villain_less_snapshot_and_a_core_less_delta_are_untouched() {
        let snap = world_with_party(&["a", "b"], 10).to_snapshot();
        let mut out = snap.clone();
        redact_snapshot(&mut out);
        assert_eq!(out, snap);

        let before = villain_world().to_snapshot();
        let mut after = before.clone();
        after.characters[0].stats.health = 1.0;
        let delta = diff(&before, &after);
        assert!(
            delta.campaign_core.is_none(),
            "a character-only change carries no core"
        );
        assert!(delta_villain(&delta).is_none());
        let mut out = delta.clone();
        redact_delta(&mut out);
        assert_eq!(out, delta);
    }

    #[test]
    fn redact_delta_blinds_the_core_villain() {
        let before = villain_world().to_snapshot();
        let mut after = before.clone();
        after.campaign.round = 2;
        let mut delta = diff(&before, &after);
        assert_eq!(
            delta_villain(&delta).map(|v| v.hand.len()),
            Some(3),
            "a core-carrying delta replicates the villain"
        );
        redact_delta(&mut delta);
        let v = delta_villain(&delta).expect("the villain is still present");
        assert_eq!(v.hand, blinded(3));
        assert_eq!(v.deck, blinded(2));
        assert_eq!(v.discard, blinded(1));
        // The rest of the core rides through unchanged.
        assert_eq!(delta.campaign_core.as_ref().unwrap().core.round, 2);
    }

    #[test]
    fn a_redacted_replica_converges_to_the_redacted_authority() {
        // The convergence guarantee for a non-controller: applying redacted deltas to a redacted
        // seed reproduces exactly `redact_snapshot(authority)` after every step — the replica is
        // never a mix of real and blinded cards, and everything else stays in lockstep.
        let genesis = villain_world();
        let mut auth = SyncAuthority::new(
            genesis.clone(),
            Catalog::default(),
            AuthorityOpts::default(),
        );
        let mut seed = genesis.to_snapshot();
        redact_snapshot(&mut seed);
        let mut replica = World::from_snapshot(seed);

        for cmd in [
            Command::NextPlayer,
            Command::NextPlayer,
            Command::NextPlayer,
        ] {
            let mut delta = match auth.submit(cmd) {
                SubmitResult::Committed { delta, .. } => delta,
                SubmitResult::Denied { reason } => panic!("expected commit, denied: {reason}"),
            };
            redact_delta(&mut delta);
            apply(&mut replica, &delta);
            let mut expected = auth.snapshot();
            redact_snapshot(&mut expected);
            assert_eq!(replica.to_snapshot(), expected);
            assert!(
                replica
                    .campaign
                    .villain
                    .as_ref()
                    .unwrap()
                    .hand
                    .iter()
                    .all(|k| k == REDACTED_CARD_KEY),
                "no real card key ever reaches the replica"
            );
        }
    }
}
