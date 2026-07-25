//! The audio runtime (Phase 2c, sub-project D — slice 4, audio runtime).
//!
//! Ports `audio/audio-runtime.ts`: the session-lived orchestrator that ties the four layers together
//! (`AudioDirector → SoundPack → SoundSpec → AudioBackend`). It owns the procedural [`AudioEngine`]
//! and the [`AmbientBed`], holds the active [`AudioDirector`] + [`SoundPack`], and gates everything on
//! an enabled flag:
//!
//! - [`set_enabled`](AudioRuntime::set_enabled) resumes the engine and starts the bed on the same
//!   `AudioContext` (or stays disabled if Web Audio is unavailable / the context hasn't opened yet).
//! - [`play_cue`](AudioRuntime::play_cue) routes a `PresentationCue` through director → active pack →
//!   engine; [`note_error`](AudioRuntime::note_error) and [`play_mob_attack`](AudioRuntime::play_mob_attack)
//!   are the two fixed voices.
//! - [`update`](AudioRuntime::update) reads continuous tension off the view and drives the bed.
//! - [`reset`](AudioRuntime::reset) rebuilds the director (dropping session state) on restart;
//!   [`dispose`](AudioRuntime::dispose) releases the context entirely.
//!
//! The decision logic (director/pack) is pure and tested in [`crate::audio_pack`]; the enabled-gated
//! glue here that touches `web-sys` is exercised by the browser smoke. Host tests cover the parts that
//! never open a context (the disabled no-ops, the soundpack list, dispose-when-never-enabled).

use wickedways_core::presentation::PresentationCue;
use wickedways_core::world::submit::MobAttack;
use wickedways_core::world::view::ViewModel;

use crate::ambient::AmbientBed;
use crate::audio::{error_sound, sound_for_mob_attack};
use crate::audio_engine::AudioEngine;
use crate::audio_pack::{
    default_chiptune_pack, default_director, AudioDirector, CampaignAudio, SoundPack, SoundSpec,
};

/// The session-lived audio orchestrator. One per surface; created disabled.
pub struct AudioRuntime {
    enabled: bool,
    engine: AudioEngine,
    bed: AmbientBed,
    make_director: fn() -> Box<dyn AudioDirector>,
    director: Box<dyn AudioDirector>,
    packs: Vec<SoundPack>,
    active: usize,
}

impl AudioRuntime {
    /// Build the runtime for a campaign's audio config, or the flat default (default chiptune pack +
    /// flat bed) when the campaign supplies none. `soundpacks[0]` is active.
    pub fn for_campaign(audio: Option<CampaignAudio>) -> Self {
        let (make_director, packs) = match audio {
            Some(a) if !a.soundpacks.is_empty() => (a.make_director, a.soundpacks),
            Some(a) => (a.make_director, vec![default_chiptune_pack()]),
            None => (
                default_director as fn() -> Box<dyn AudioDirector>,
                vec![default_chiptune_pack()],
            ),
        };
        let director = make_director();
        Self {
            enabled: false,
            engine: AudioEngine::new(),
            bed: AmbientBed::default(),
            make_director,
            director,
            packs,
            active: 0,
        }
    }

    /// Whether audio is currently on.
    pub fn enabled(&self) -> bool {
        self.enabled
    }

    /// Enable or disable audio. Enabling resumes the engine and (if a context is live) starts the bed;
    /// it stays disabled if Web Audio is unavailable or the context hasn't opened yet, so a caller can
    /// retry on a later user gesture. Disabling stops the bed and suspends the context.
    pub fn set_enabled(&mut self, on: bool) {
        if on {
            if self.engine.resume() {
                if let Some(ctx) = self.engine.context() {
                    self.enabled = true;
                    if !self.bed.running() {
                        self.bed.start(&ctx);
                    }
                }
            }
        } else {
            self.enabled = false;
            self.bed.stop();
            self.engine.suspend();
        }
    }

    /// Fully release audio resources: stop the bed and close the engine's `AudioContext`. Idempotent
    /// and safe when audio was never enabled.
    pub fn dispose(&mut self) {
        self.enabled = false;
        self.bed.stop();
        self.engine.close();
    }

    /// Rebuild the director, dropping session-scoped state (e.g. the tension high-water mark). Called
    /// on restart. Does not change the active pack or the enabled state.
    pub fn reset(&mut self) {
        self.director = (self.make_director)();
    }

    /// The available soundpacks as `(id, label)` — the surface shows a switcher only when there are ≥ 2.
    pub fn soundpacks(&self) -> Vec<(&'static str, &'static str)> {
        self.packs.iter().map(|p| (p.id, p.label)).collect()
    }

    /// Select the active soundpack by id. Unknown ids are ignored.
    pub fn set_soundpack(&mut self, id: &str) {
        if let Some(i) = self.packs.iter().position(|p| p.id == id) {
            self.active = i;
        }
    }

    /// Route a presentation cue through director → active pack → engine. No-op when disabled.
    pub fn play_cue(&mut self, cue: &PresentationCue, view: &ViewModel) {
        if !self.enabled {
            return;
        }
        let cues = self.director.react(cue, view);
        let pack = &self.packs[self.active];
        for ac in &cues {
            if let Some(SoundSpec::Synth { voice }) = (pack.voice)(ac) {
                self.engine.play(&voice);
            }
        }
    }

    /// Voice a mob's strike landing on the player. No-op when disabled.
    pub fn play_mob_attack(&self, attack: &MobAttack) {
        if self.enabled {
            self.engine.play(&sound_for_mob_attack(attack));
        }
    }

    /// Buzz the fixed error voice for a rejected command. No-op when disabled.
    pub fn note_error(&self) {
        if self.enabled {
            self.engine.play(&error_sound());
        }
    }

    /// Drive the ambient bed from the view's continuous tension (via director → active pack). No-op
    /// when disabled.
    pub fn update(&mut self, view: &ViewModel) {
        if !self.enabled {
            return;
        }
        let tension = self.director.tension(view);
        let directive = (self.packs[self.active].ambient)(tension);
        self.bed.set_tension(directive.bed_tension);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio_pack::wickedways_campaign_audio;

    #[test]
    fn a_fresh_runtime_is_disabled() {
        assert!(!AudioRuntime::for_campaign(None).enabled());
    }

    #[test]
    fn the_default_runtime_lists_the_chiptune_pack() {
        assert_eq!(
            AudioRuntime::for_campaign(None).soundpacks(),
            vec![("chiptune", "Chiptune")]
        );
    }

    #[test]
    fn a_campaign_runtime_exposes_its_packs() {
        let rt = AudioRuntime::for_campaign(Some(wickedways_campaign_audio()));
        assert_eq!(rt.soundpacks(), vec![("chiptune", "Chiptune")]);
    }

    #[test]
    fn setting_an_unknown_soundpack_keeps_the_active_one() {
        let mut rt = AudioRuntime::for_campaign(None);
        rt.set_soundpack("nonsense");
        rt.set_soundpack("chiptune"); // known: no panic, index in range
        assert_eq!(rt.soundpacks().len(), 1);
    }

    #[test]
    fn disabled_error_and_mob_attack_are_silent_noops() {
        // While disabled these must never touch Web Audio (so they're safe on the host target).
        let rt = AudioRuntime::for_campaign(None);
        rt.note_error();
        rt.play_mob_attack(&MobAttack {
            name: "Wraith".into(),
            stat: wickedways_core::StatType::Health,
            amount: 3.0,
        });
    }

    #[test]
    fn dispose_is_safe_when_never_enabled_and_idempotent() {
        // dispose() stops the bed (never started) and closes the engine (never opened) — both no-ops
        // that must not touch Web Audio on the host target.
        let mut rt = AudioRuntime::for_campaign(None);
        rt.dispose();
        rt.dispose();
        assert!(!rt.enabled());
    }
}
