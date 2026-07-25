//! The soundpack / director layer (Phase 2c, sub-project D — slice 4, audio runtime).
//!
//! Layers 1–2 of the 4-layer audio architecture (`AudioDirector → SoundPack → SoundSpec →
//! AudioBackend`), ported from `audio/contracts.ts`, `audio/default-pack.ts`, and `audio/tension.ts`:
//!
//! - An [`AudioDirector`] is the **audio brain** — it turns an engine [`PresentationCue`] into zero or
//!   more discrete [`AudioCue`]s and reads a continuous `tension` (0–1) off the [`ViewModel`] DTO for
//!   the ambient bed. Directors are DTO-only (they never see live engine objects) and may be stateful
//!   (the sanity director closes over a session high-water mark).
//! - A [`SoundPack`] is the **theme** — it maps an [`AudioCue`] to a [`SoundSpec`] (or silence) and a
//!   tension to an [`AmbientDirective`]. The runtime ships one pack, [`default_chiptune_pack`],
//!   covering every base cue by reusing the [`crate::audio`] cue→voice mapping so the timbre is
//!   unchanged.
//!
//! All of this is pure and host-tested; the Web Audio backend that renders a [`SoundSpec`] lives in
//! [`crate::audio_engine`] / [`crate::ambient`], driven by [`crate::audio_runtime`].

use wickedways_core::presentation::{ActionKind, CampaignOutcome, EntityRef, PresentationCue};
use wickedways_core::world::submit::MobAttack;
use wickedways_core::world::view::ViewModel;
use wickedways_core::StatType;

use crate::audio::{error_sound, sound_for_cue, sound_for_mob_attack, SynthVoice};

/// How to produce one sound event. The `Synth` arm is rendered by the procedural engine; the
/// `Sample` arm (a decoded `AudioBuffer` / asset path) is deferred — scored audio is a later slice,
/// but the type stays an enum so it can be added without touching the contract.
#[derive(Clone, Debug, PartialEq)]
pub enum SoundSpec {
    Synth { voice: SynthVoice },
}

/// A discrete sound event produced by an [`AudioDirector`] from a [`PresentationCue`]. `kind` is an
/// open vocabulary (the base set is `strike`/`death`/`pickup`/`drop`/`move`/`light`/`encounter`/
/// `win`/`lose`/`error`/`takeDamage`; campaigns may add their own), and `entity_id` seeds per-actor
/// pitch jitter where a voice uses it.
#[derive(Clone, Debug, PartialEq)]
pub struct AudioCue {
    pub kind: String,
    pub entity_id: Option<String>,
}

impl AudioCue {
    fn bare(kind: &str) -> Self {
        Self {
            kind: kind.into(),
            entity_id: None,
        }
    }
    fn of(kind: &str, entity_id: &str) -> Self {
        Self {
            kind: kind.into(),
            entity_id: Some(entity_id.into()),
        }
    }
}

/// How a soundpack wants the ambient bed to behave right now (a 0–1 tension the bed maps to beat rate).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AmbientDirective {
    pub bed_tension: f64,
}

/// The audio brain: `PresentationCue` → discrete [`AudioCue`]s, and `ViewModel` → continuous tension.
/// Stateful (hence `&mut self`): the sanity director tracks a session high-water mark.
pub trait AudioDirector {
    /// Map one presentation cue to zero or more discrete audio events.
    fn react(&mut self, cue: &PresentationCue, view: &ViewModel) -> Vec<AudioCue>;
    /// Continuous tension (0–1) from the current view, for the ambient bed.
    fn tension(&mut self, view: &ViewModel) -> f64;
}

/// A campaign-owned audio theme: [`AudioCue`] → [`SoundSpec`] and tension → [`AmbientDirective`].
/// Uses fn-pointers (the packs are stateless) so it stays `Copy`-cheap to clone into the runtime.
#[derive(Clone)]
pub struct SoundPack {
    pub id: &'static str,
    pub label: &'static str,
    pub voice: fn(&AudioCue) -> Option<SoundSpec>,
    pub ambient: fn(f64) -> AmbientDirective,
}

/// Campaign-supplied audio config: a director factory (called once per boot/restart, so session state
/// resets) and the available soundpacks (`soundpacks[0]` is active by default; the surface shows a
/// switcher only when there are ≥ 2).
pub struct CampaignAudio {
    pub make_director: fn() -> Box<dyn AudioDirector>,
    pub soundpacks: Vec<SoundPack>,
}

/// Map current sanity to a tension in `[0, 1]`, normalized against a baseline (the session
/// high-water mark). At or above baseline → 0 (calm); zero sanity → 1 (tense). Mirrors
/// `sanityToTension`.
pub fn sanity_to_tension(current: f64, baseline: f64) -> f64 {
    if baseline <= 0.0 {
        return 0.0;
    }
    (1.0 - current / baseline).clamp(0.0, 1.0)
}

/// The stateful sanity→tension tracker: raises its baseline to the highest sanity seen this session,
/// so tension only climbs as sanity falls below where it has been (a fresh scare, not steady state).
#[derive(Default)]
pub struct SanityTension {
    baseline: f64,
}

impl SanityTension {
    /// Fold in the current sanity and return the resulting tension.
    pub fn observe(&mut self, sanity: f64) -> f64 {
        self.baseline = self.baseline.max(sanity);
        sanity_to_tension(sanity, self.baseline)
    }
}

/// Map an engine `PresentationCue` to base [`AudioCue`]s. Mirrors `cuesFor` — the same triggers the
/// original `sound_for_cue` fired on.
pub fn cues_for(cue: &PresentationCue) -> Vec<AudioCue> {
    match cue {
        PresentationCue::Action { action, actor, .. } => match action {
            ActionKind::Attack => vec![AudioCue::of("strike", &actor.id)],
            ActionKind::TakeDamage => vec![AudioCue::of("takeDamage", &actor.id)],
            ActionKind::PickUp => vec![AudioCue::of("pickup", &actor.id)],
            ActionKind::Drop => vec![AudioCue::of("drop", &actor.id)],
            ActionKind::Move => vec![AudioCue::of("move", &actor.id)],
            _ => vec![],
        },
        PresentationCue::Encounter { mob, .. } => vec![AudioCue::of("encounter", &mob.id)],
        PresentationCue::Visibility { .. } => vec![AudioCue::bare("light")],
        PresentationCue::Resolution { outcome, .. } => match outcome {
            CampaignOutcome::Won => vec![AudioCue::bare("win")],
            CampaignOutcome::Lost => vec![AudioCue::bare("lose")],
            _ => vec![],
        },
        _ => vec![],
    }
}

/// Base [`AudioCue`] → [`SynthVoice`], reusing the [`crate::audio`] voices by reconstructing a
/// representative cue so the chiptune timbre is unchanged. Mirrors `voiceFor`.
fn voice_for(cue: &AudioCue) -> Option<SynthVoice> {
    let id = cue.entity_id.clone().unwrap_or_default();
    let actor = || EntityRef {
        id: id.clone(),
        name: String::new(),
    };
    let nowhere = || EntityRef {
        id: String::new(),
        name: String::new(),
    };
    let action = |kind| {
        sound_for_cue(&PresentationCue::Action {
            action: kind,
            actor: actor(),
            sound: None,
        })
    };
    match cue.kind.as_str() {
        "strike" => action(ActionKind::Attack),
        "takeDamage" => action(ActionKind::TakeDamage),
        "error" => Some(error_sound()),
        "pickup" => action(ActionKind::PickUp),
        "drop" => action(ActionKind::Drop),
        "move" => action(ActionKind::Move),
        "light" => sound_for_cue(&PresentationCue::Visibility {
            room: nowhere(),
            lit: true,
        }),
        "encounter" => sound_for_cue(&PresentationCue::Encounter {
            mob: actor(),
            room: nowhere(),
            sound: None,
        }),
        // Reserved for custom directors; no default engine event maps to "death".
        "death" => Some(sound_for_mob_attack(&MobAttack {
            name: String::new(),
            stat: StatType::Sanity,
            amount: 1.0,
        })),
        "win" => sound_for_cue(&PresentationCue::Resolution {
            outcome: CampaignOutcome::Won,
            reason: None,
            narration: None,
        }),
        "lose" => sound_for_cue(&PresentationCue::Resolution {
            outcome: CampaignOutcome::Lost,
            reason: None,
            narration: None,
        }),
        _ => None,
    }
}

fn chiptune_voice(cue: &AudioCue) -> Option<SoundSpec> {
    voice_for(cue).map(|voice| SoundSpec::Synth { voice })
}

fn chiptune_ambient(tension: f64) -> AmbientDirective {
    AmbientDirective {
        bed_tension: tension,
    }
}

/// The default soundpack: covers every base cue with the original chiptune voices and passes tension
/// straight through to the bed. Mirrors `defaultChiptunePack`.
pub fn default_chiptune_pack() -> SoundPack {
    SoundPack {
        id: "chiptune",
        label: "Chiptune",
        voice: chiptune_voice,
        ambient: chiptune_ambient,
    }
}

/// A stateless director: discrete cues via [`cues_for`], and a **flat** ambient bed (tension is always
/// 0, ignoring the view). Mirrors `defaultDirector`.
struct DefaultDirector;

impl AudioDirector for DefaultDirector {
    fn react(&mut self, cue: &PresentationCue, _view: &ViewModel) -> Vec<AudioCue> {
        cues_for(cue)
    }
    fn tension(&mut self, _view: &ViewModel) -> f64 {
        0.0
    }
}

/// The sanity-reactive director shipped for the bundled WickedWays campaigns: discrete cues via
/// [`cues_for`], and tension from sanity vs. the session high-water mark (the ambient bed tightens as
/// sanity drains). The analog of hollow-house's `createHollowHouseDirector` — every bundled campaign
/// is sanity-driven horror.
#[derive(Default)]
struct SanityDirector {
    tension: SanityTension,
}

impl AudioDirector for SanityDirector {
    fn react(&mut self, cue: &PresentationCue, _view: &ViewModel) -> Vec<AudioCue> {
        cues_for(cue)
    }
    fn tension(&mut self, view: &ViewModel) -> f64 {
        self.tension.observe(view.status.sanity)
    }
}

/// A fresh flat director (no view reactivity). Mirrors `defaultDirector`.
pub fn default_director() -> Box<dyn AudioDirector> {
    Box::new(DefaultDirector)
}

/// A fresh sanity-reactive director (resets the high-water mark). Used by [`wickedways_campaign_audio`].
pub fn sanity_director() -> Box<dyn AudioDirector> {
    Box::<SanityDirector>::default()
}

/// The audio config for the bundled WickedWays campaigns: a sanity-reactive director over the default
/// chiptune pack, so the ambient bed breathes with the active character's sanity.
pub fn wickedways_campaign_audio() -> CampaignAudio {
    CampaignAudio {
        make_director: sanity_director,
        soundpacks: vec![default_chiptune_pack()],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &[&str] = &[
        "strike",
        "death",
        "pickup",
        "drop",
        "move",
        "light",
        "encounter",
        "win",
        "lose",
        "error",
        "takeDamage",
    ];

    #[test]
    fn default_pack_voices_every_base_cue_as_synth() {
        let pack = default_chiptune_pack();
        for &kind in BASE {
            let spec = (pack.voice)(&AudioCue::bare(kind));
            assert!(
                matches!(spec, Some(SoundSpec::Synth { .. })),
                "{kind} should voice a synth spec"
            );
        }
    }

    #[test]
    fn default_pack_maps_tension_straight_to_the_bed() {
        assert_eq!(
            (default_chiptune_pack().ambient)(0.7),
            AmbientDirective { bed_tension: 0.7 }
        );
    }

    #[test]
    fn an_unknown_cue_is_silent() {
        assert_eq!(
            (default_chiptune_pack().voice)(&AudioCue::bare("nonsense")),
            None
        );
    }

    #[test]
    fn cues_for_maps_attack_to_strike_and_take_damage_distinctly() {
        let actor = EntityRef {
            id: "m".into(),
            name: "Wraith".into(),
        };
        let strike = cues_for(&PresentationCue::Action {
            action: ActionKind::Attack,
            actor: actor.clone(),
            sound: None,
        });
        assert_eq!(strike, vec![AudioCue::of("strike", "m")]);
        let hurt = cues_for(&PresentationCue::Action {
            action: ActionKind::TakeDamage,
            actor,
            sound: None,
        });
        assert_eq!(hurt, vec![AudioCue::of("takeDamage", "m")]);
        assert_ne!(strike, hurt);
    }

    #[test]
    fn sanity_tension_tracks_a_high_water_mark() {
        let mut t = SanityTension::default();
        // First observation sets the baseline; at baseline → calm.
        assert_eq!(t.observe(16.0), 0.0);
        // Sanity drops below the mark → tension rises.
        let mid = t.observe(8.0);
        assert!(
            mid > 0.0 && mid < 1.0,
            "half sanity → mid tension, got {mid}"
        );
        assert!((mid - 0.5).abs() < 1e-9, "8/16 → 1 - 0.5 = 0.5");
        // Zero sanity → fully tense.
        assert_eq!(t.observe(0.0), 1.0);
        // Recovering toward (but not above) the mark eases tension back down.
        assert!(t.observe(12.0) < mid);
    }

    #[test]
    fn sanity_to_tension_clamps_and_guards_a_nonpositive_baseline() {
        assert_eq!(sanity_to_tension(16.0, 16.0), 0.0);
        assert_eq!(sanity_to_tension(20.0, 16.0), 0.0); // above baseline clamps to 0
        assert_eq!(sanity_to_tension(0.0, 16.0), 1.0);
        assert_eq!(sanity_to_tension(-5.0, 16.0), 1.0); // below zero clamps to 1
        assert_eq!(sanity_to_tension(5.0, 0.0), 0.0); // non-positive baseline → 0
        assert!(sanity_to_tension(12.0, 16.0) < sanity_to_tension(4.0, 16.0)); // monotone
    }

    #[test]
    fn wickedways_campaign_audio_ships_the_chiptune_pack() {
        let audio = wickedways_campaign_audio();
        assert_eq!(audio.soundpacks.len(), 1);
        assert_eq!(audio.soundpacks[0].id, "chiptune");
    }
}
