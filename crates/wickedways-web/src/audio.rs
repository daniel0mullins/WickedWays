//! Cue → sound mapping.
//!
//! A **pure, backend-agnostic** description of the one-shot procedural sound each event makes
//! ([`SynthVoice`]), derived from the engine's [`PresentationCue`]/[`MobAttack`]. It never touches
//! Web Audio, so it is unit-tested exhaustively on the host; the Web Audio engine
//! ([`audio_engine`](crate::audio_engine)) renders these voices (oscillator/noise + gain envelope).
//! This is the foundation of the audio subtree.

use wickedways_core::presentation::{ActionKind, CampaignOutcome, EntityRef, PresentationCue};
use wickedways_core::world::intent::Intent;
use wickedways_core::world::submit::MobAttack;

/// The sound source a [`SynthVoice`] renders: an oscillator waveform, or a white-noise burst.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Sine,
    Square,
    Sawtooth,
    Triangle,
    Noise,
}

/// A declarative, backend-agnostic one-shot procedural sound.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SynthVoice {
    /// Oscillator waveform, or `Noise` for a white-noise burst.
    pub source: Source,
    /// Start frequency in Hz (ignored when `source` is `Noise`).
    pub freq: f64,
    /// Optional end frequency for a pitch glide; `None` holds `freq`.
    pub end_freq: Option<f64>,
    /// Total duration in seconds.
    pub duration: f64,
    /// Peak gain, 0..1.
    pub gain: f64,
    /// Attack time in seconds (linear ramp to peak).
    pub attack: f64,
}

/// Deterministic pitch multiplier in ~`[0.97, 1.03]` derived from an id string, so repeated events
/// feel alive without `Math.random` (repo convention): a 32-bit-wrapping `h*31 + unit` hash over the
/// id's UTF-16 code units, folded into a `[0,1)` fraction.
pub fn detune_factor(id: &str) -> f64 {
    let mut h: i32 = 0;
    for unit in id.encode_utf16() {
        h = h.wrapping_mul(31).wrapping_add(i32::from(unit));
    }
    // Fold |h| into [0, 1000) — `unsigned_abs`, not `abs`, which would overflow on i32::MIN.
    let frac = f64::from(h.unsigned_abs() % 1000) / 1000.0;
    0.97 + frac * 0.06
}

/// Maps a presentation cue to a sound, or `None` when the event is silent.
pub fn sound_for_cue(cue: &PresentationCue) -> Option<SynthVoice> {
    match cue {
        PresentationCue::Action { action, actor, .. } => match action {
            ActionKind::Attack => {
                let f = 190.0 * detune_factor(&actor.id);
                Some(SynthVoice {
                    source: Source::Square,
                    freq: f,
                    end_freq: Some(f * 0.5),
                    duration: 0.12,
                    gain: 0.18,
                    attack: 0.001,
                })
            }
            ActionKind::TakeDamage => Some(SynthVoice {
                source: Source::Noise,
                freq: 0.0,
                end_freq: None,
                duration: 0.14,
                gain: 0.16,
                attack: 0.001,
            }),
            ActionKind::PickUp => Some(SynthVoice {
                source: Source::Triangle,
                freq: 660.0,
                end_freq: Some(990.0),
                duration: 0.09,
                gain: 0.12,
                attack: 0.005,
            }),
            ActionKind::Drop => Some(SynthVoice {
                source: Source::Triangle,
                freq: 520.0,
                end_freq: Some(330.0),
                duration: 0.09,
                gain: 0.12,
                attack: 0.005,
            }),
            ActionKind::Move => Some(SynthVoice {
                source: Source::Noise,
                freq: 0.0,
                end_freq: None,
                duration: 0.22,
                gain: 0.06,
                attack: 0.04,
            }),
            // A played Wicked Ways card: a low, ominous descending sweep.
            ActionKind::PlayCard => Some(SynthVoice {
                source: Source::Sawtooth,
                freq: 220.0,
                end_freq: Some(88.0),
                duration: 0.35,
                gain: 0.14,
                attack: 0.02,
            }),
            ActionKind::Escape
            | ActionKind::Fumble
            | ActionKind::MechanicAction
            | ActionKind::Mulligan => None,
        },
        PresentationCue::Encounter { .. } => Some(SynthVoice {
            source: Source::Sawtooth,
            freq: 110.0,
            end_freq: Some(330.0),
            duration: 0.5,
            gain: 0.14,
            attack: 0.08,
        }),
        PresentationCue::Visibility { .. } => Some(SynthVoice {
            source: Source::Square,
            freq: 1200.0,
            end_freq: None,
            duration: 0.04,
            gain: 0.08,
            attack: 0.001,
        }),
        // "won" rises triumphantly; "lost" falls; any other outcome makes no sound.
        PresentationCue::Resolution { outcome, .. } => match outcome {
            CampaignOutcome::Won => Some(SynthVoice {
                source: Source::Triangle,
                freq: 523.0,
                end_freq: Some(784.0),
                duration: 0.6,
                gain: 0.16,
                attack: 0.02,
            }),
            CampaignOutcome::Lost => Some(SynthVoice {
                source: Source::Sine,
                freq: 220.0,
                end_freq: Some(55.0),
                duration: 0.8,
                gain: 0.16,
                attack: 0.02,
            }),
            _ => None,
        },
        PresentationCue::Mechanic { .. } | PresentationCue::Status { .. } => None,
    }
}

/// A mob's strike landing on the player.
pub fn sound_for_mob_attack(_attack: &MobAttack) -> SynthVoice {
    SynthVoice {
        source: Source::Square,
        freq: 150.0,
        end_freq: Some(80.0),
        duration: 0.13,
        gain: 0.16,
        attack: 0.001,
    }
}

/// A short low buzz for a rejected command or illegal action.
pub fn error_sound() -> SynthVoice {
    SynthVoice {
        source: Source::Square,
        freq: 90.0,
        end_freq: None,
        duration: 0.12,
        gain: 0.1,
        attack: 0.001,
    }
}

/// Reconstruct the `PresentationCue` a committed action intent stands for, if any
/// (attack/move/take/drop). The multiplayer wire doesn't carry cues, so a surface rebuilds one from
/// the intent it just submitted and feeds it to the audio runtime (director → pack → voice) — the
/// noun id rides along as the actor id so the per-actor pitch jitter (attack) still distinguishes
/// foes. Shared by both surfaces (the CRT terminal and the point-and-click scene).
pub fn cue_for_intent(intent: &Intent) -> Option<PresentationCue> {
    let entity = |id: &str| EntityRef {
        id: id.into(),
        name: String::new(),
    };
    Some(match intent {
        Intent::Attack { target_id } => PresentationCue::Action {
            action: ActionKind::Attack,
            actor: entity(target_id),
            sound: None,
        },
        Intent::Move { .. } => PresentationCue::Action {
            action: ActionKind::Move,
            actor: entity("move"),
            sound: None,
        },
        Intent::Take { target_id } => PresentationCue::Action {
            action: ActionKind::PickUp,
            actor: entity(target_id),
            sound: None,
        },
        Intent::Drop { target_id } => PresentationCue::Action {
            action: ActionKind::Drop,
            actor: entity(target_id),
            sound: None,
        },
        // A played card gets its ominous sweep (`sound_for_cue`); the mulligan
        // stays silent, like every other unvoiced action.
        Intent::PlayCard { card_key, .. } => PresentationCue::Action {
            action: ActionKind::PlayCard,
            actor: entity(card_key),
            sound: None,
        },
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use wickedways_core::presentation::{EntityRef, MechanicCue};
    use wickedways_core::world::direction::Direction;
    use wickedways_core::StatType;

    fn actor(id: &str) -> EntityRef {
        EntityRef {
            id: id.into(),
            name: id.to_uppercase(),
        }
    }

    fn action(kind: ActionKind, actor_id: &str) -> PresentationCue {
        PresentationCue::Action {
            action: kind,
            actor: actor(actor_id),
            sound: None,
        }
    }

    #[test]
    fn attack_is_a_square_hit() {
        let v = sound_for_cue(&action(ActionKind::Attack, "p1")).unwrap();
        assert_eq!(v.source, Source::Square);
        assert!(v.duration > 0.0);
        assert!(v.gain > 0.0);
    }

    #[test]
    fn take_damage_is_a_noise_thud() {
        assert_eq!(
            sound_for_cue(&action(ActionKind::TakeDamage, "p1"))
                .unwrap()
                .source,
            Source::Noise
        );
    }

    #[test]
    fn pickup_and_drop_are_triangles_with_opposite_glide() {
        let up = sound_for_cue(&action(ActionKind::PickUp, "p1")).unwrap();
        let down = sound_for_cue(&action(ActionKind::Drop, "p1")).unwrap();
        assert_eq!(up.source, Source::Triangle);
        assert_eq!(down.source, Source::Triangle);
        assert!(up.end_freq.unwrap() > up.freq, "pickUp glides up");
        assert!(down.end_freq.unwrap() < down.freq, "drop glides down");
    }

    #[test]
    fn move_is_a_noise_whoosh() {
        assert_eq!(
            sound_for_cue(&action(ActionKind::Move, "p1"))
                .unwrap()
                .source,
            Source::Noise
        );
    }

    #[test]
    fn escape_fumble_mechanic_action_and_mechanic_are_silent() {
        for kind in [
            ActionKind::Escape,
            ActionKind::Fumble,
            ActionKind::MechanicAction,
        ] {
            assert_eq!(sound_for_cue(&action(kind, "p1")), None);
        }
        let mechanic = PresentationCue::Mechanic {
            cue: MechanicCue {
                text: Some("x".into()),
                sound: None,
            },
        };
        assert_eq!(sound_for_cue(&mechanic), None);
    }

    #[test]
    fn encounter_is_a_rising_sawtooth() {
        let v = sound_for_cue(&PresentationCue::Encounter {
            mob: actor("m"),
            room: EntityRef {
                id: "r".into(),
                name: "R".into(),
            },
            sound: None,
        })
        .unwrap();
        assert_eq!(v.source, Source::Sawtooth);
        assert!(v.end_freq.unwrap() > v.freq);
    }

    #[test]
    fn visibility_is_a_short_click() {
        let v = sound_for_cue(&PresentationCue::Visibility {
            room: EntityRef {
                id: "r".into(),
                name: "R".into(),
            },
            lit: true,
        })
        .unwrap();
        assert!(v.duration < 0.1);
    }

    #[test]
    fn resolution_win_rises_and_loss_falls() {
        let win = sound_for_cue(&PresentationCue::Resolution {
            outcome: CampaignOutcome::Won,
            reason: None,
            narration: None,
        })
        .unwrap();
        let lose = sound_for_cue(&PresentationCue::Resolution {
            outcome: CampaignOutcome::Lost,
            reason: None,
            narration: None,
        })
        .unwrap();
        assert!(win.end_freq.unwrap() > win.freq);
        assert!(lose.end_freq.unwrap() < lose.freq);
        // Any other outcome is silent.
        for outcome in [
            CampaignOutcome::Ongoing,
            CampaignOutcome::TimedOut,
            CampaignOutcome::Ended,
        ] {
            assert_eq!(
                sound_for_cue(&PresentationCue::Resolution {
                    outcome,
                    reason: None,
                    narration: None
                }),
                None
            );
        }
    }

    #[test]
    fn attack_pitch_jitters_deterministically_by_actor_id() {
        let a = sound_for_cue(&action(ActionKind::Attack, "a")).unwrap();
        let b = sound_for_cue(&action(ActionKind::Attack, "b")).unwrap();
        let a2 = sound_for_cue(&action(ActionKind::Attack, "a")).unwrap();
        assert_eq!(a.freq, a2.freq, "deterministic for the same id");
        assert_ne!(a.freq, b.freq, "varies by id");
    }

    #[test]
    fn detune_factor_is_deterministic_and_within_a_small_band() {
        assert_eq!(detune_factor("p1"), detune_factor("p1"));
        assert!(detune_factor("p1") > 0.9);
        assert!(detune_factor("p1") < 1.1);
        // Spot check the hash fold for "p1":
        // h = ('p'=112)*31 + ('1'=49) = 3521 → 3521 % 1000 = 521 → 0.97 + 0.521*0.06 = 1.00126.
        assert!((detune_factor("p1") - 1.00126).abs() < 1e-9);
    }

    #[test]
    fn cue_for_intent_covers_the_four_voiced_actions_and_is_silent_otherwise() {
        // Each voiced intent reconstructs an Action cue that maps onto the expected waveform when run
        // back through `sound_for_cue` (the path the runtime's default pack takes).
        fn voice(intent: &Intent) -> Option<SynthVoice> {
            cue_for_intent(intent).as_ref().and_then(sound_for_cue)
        }
        assert_eq!(
            voice(&Intent::Attack {
                target_id: "m".into()
            })
            .unwrap()
            .source,
            Source::Square
        );
        assert_eq!(
            voice(&Intent::Move {
                dir: Direction::North
            })
            .unwrap()
            .source,
            Source::Noise
        );
        assert_eq!(
            voice(&Intent::Take {
                target_id: "i".into()
            })
            .unwrap()
            .source,
            Source::Triangle
        );
        assert_eq!(
            voice(&Intent::Drop {
                target_id: "i".into()
            })
            .unwrap()
            .source,
            Source::Triangle
        );
        // The attack's actor id rides through, so the pitch still jitters by target.
        let a = voice(&Intent::Attack {
            target_id: "a".into(),
        })
        .unwrap();
        let b = voice(&Intent::Attack {
            target_id: "b".into(),
        })
        .unwrap();
        assert_ne!(a.freq, b.freq);
        // A non-action intent has no cue.
        assert!(cue_for_intent(&Intent::Wait).is_none());
    }

    #[test]
    fn mob_attack_and_error_are_voiced() {
        let atk = sound_for_mob_attack(&MobAttack {
            name: "Wraith".into(),
            stat: StatType::Health,
            amount: 3.0,
        });
        assert!(atk.gain > 0.0);
        assert!(atk.duration > 0.0);
        assert!(error_sound().freq < 200.0);
    }
}
