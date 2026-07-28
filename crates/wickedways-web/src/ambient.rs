//! The ambient bed.
//!
//! A continuous, sanity-reactive drone. Two detuned sawtooth oscillators
//! feed a fixed dark low-pass filter and a master gain — a deep sub-bass hum. Dread is expressed
//! purely as BEAT RATE: the two oscillators beat at a frequency equal to their detune (Hz), so as
//! tension rises the partner drifts further from the fundamental and the pulse quickens (slow calm
//! throb when sane → fast anxious throb as sanity drains). Timbre and loudness stay constant, so it
//! never reads as "getting louder."
//!
//! Browser-only (all `web-sys`); best-effort throughout (a failed node call never crashes the game).
//! Driven by [`crate::audio_runtime::AudioRuntime`], which starts it on the engine's `AudioContext`
//! when the player enables sound and feeds it a 0–1 tension on every view update.

#[cfg(not(feature = "native-app"))]
use web_sys::{
    AudioContext, BiquadFilterNode, BiquadFilterType, GainNode, OscillatorNode, OscillatorType,
};

#[cfg(feature = "native-app")]
use crate::audio_engine::AudioContext;

// Tunable voice — dialed by ear on the running dev server. (Web path only.)
#[cfg(not(feature = "native-app"))]
const BASE_HZ: f32 = 55.0; // A1 fundamental
#[cfg(not(feature = "native-app"))]
const DETUNE_HZ: f32 = 0.5; // calm beat rate: osc2 sits BASE + DETUNE (~0.5 Hz pulse)
#[cfg(not(feature = "native-app"))]
const DETUNE_SPREAD_HZ: f32 = 5.5; // beat rate at full dread: BASE + DETUNE + SPREAD (~6 Hz throb)
#[cfg(not(feature = "native-app"))]
const CUTOFF: f32 = 120.0; // fixed dark sub-bass cutoff
#[cfg(not(feature = "native-app"))]
const LEVEL: f32 = 0.3; // bed gain
#[cfg(not(feature = "native-app"))]
const FADE_S: f64 = 0.12; // gain fade-in to avoid a click on enable
#[cfg(not(feature = "native-app"))]
const GLIDE_S: f64 = 0.05; // per-update beat glide
#[cfg(not(feature = "native-app"))]
const SILENCE: f32 = 0.0001; // fade floor (a linear ramp from true 0 would click)

/// The desktop stand-in for the drone: same API, never runs (the engine never yields a
/// context, so [`start`](AmbientBed::start) is unreachable in practice — but it must accept
/// the inert context type so the runtime wiring compiles).
// Not a unit struct: the shared runtime constructs it with `default()`, which clippy's
// `default_constructed_unit_structs` would flag on a fieldless type.
#[cfg(feature = "native-app")]
#[derive(Default)]
pub struct AmbientBed(());

#[cfg(feature = "native-app")]
impl AmbientBed {
    pub fn running(&self) -> bool {
        false
    }

    pub fn start(&mut self, _ctx: &AudioContext) {}

    pub fn set_tension(&self, _t: f64) {}

    pub fn stop(&mut self) {}
}

/// A continuous sanity-reactive drone. Idle until [`start`](AmbientBed::start); a [`stop`](AmbientBed::stop)
/// tears the graph down fully so toggling doesn't accumulate detached nodes.
#[cfg(not(feature = "native-app"))]
#[derive(Default)]
pub struct AmbientBed {
    ctx: Option<AudioContext>,
    osc2: Option<OscillatorNode>,
    filter_gain: Option<(BiquadFilterNode, GainNode)>,
    nodes: Vec<OscillatorNode>,
}

#[cfg(not(feature = "native-app"))]
impl AmbientBed {
    /// Whether the bed is currently playing.
    pub fn running(&self) -> bool {
        self.ctx.is_some()
    }

    /// Begin playback on `ctx`. Idempotent — a second call while running is ignored.
    pub fn start(&mut self, ctx: &AudioContext) {
        if self.ctx.is_some() {
            return;
        }
        let now = ctx.current_time();

        let Ok(gain) = ctx.create_gain() else { return };
        let _ = gain.connect_with_audio_node(&ctx.destination());

        let Ok(filter) = ctx.create_biquad_filter() else {
            return;
        };
        filter.set_type(BiquadFilterType::Lowpass);
        let _ = filter.frequency().set_value_at_time(CUTOFF, now);
        let _ = filter.connect_with_audio_node(&gain);

        let Ok(osc1) = ctx.create_oscillator() else {
            return;
        };
        osc1.set_type(OscillatorType::Sawtooth);
        let _ = osc1.frequency().set_value_at_time(BASE_HZ, now);
        let _ = osc1.connect_with_audio_node(&filter);
        let _ = osc1.start_with_when(now);

        let Ok(osc2) = ctx.create_oscillator() else {
            return;
        };
        osc2.set_type(OscillatorType::Sawtooth);
        let _ = osc2.frequency().set_value_at_time(BASE_HZ + DETUNE_HZ, now);
        let _ = osc2.connect_with_audio_node(&filter);
        let _ = osc2.start_with_when(now);

        // Fade in from silence so enabling audio doesn't click.
        let g = gain.gain();
        let _ = g.set_value_at_time(SILENCE, now);
        let _ = g.linear_ramp_to_value_at_time(LEVEL, now + FADE_S);

        self.ctx = Some(ctx.clone());
        self.nodes = vec![osc1, osc2.clone()];
        self.osc2 = Some(osc2);
        self.filter_gain = Some((filter, gain));
    }

    /// Update the drone's unease, `t` in `[0, 1]`. No-op when not running. Dread = beat rate only:
    /// drift the detuned partner further from the fundamental so the two oscillators beat faster,
    /// glided so it doesn't click; loudness and timbre stay fixed.
    pub fn set_tension(&self, t: f64) {
        let (Some(ctx), Some(osc2)) = (&self.ctx, &self.osc2) else {
            return;
        };
        let clamped = t.clamp(0.0, 1.0) as f32;
        let end = ctx.current_time() + GLIDE_S;
        let _ = osc2
            .frequency()
            .linear_ramp_to_value_at_time(BASE_HZ + DETUNE_HZ + clamped * DETUNE_SPREAD_HZ, end);
    }

    /// Stop and disconnect every node. The runtime suspends the context right after, so this tears
    /// down synchronously (a scheduled fade-out would be cut off mid-ramp anyway) — that keeps the
    /// graph from accumulating detached filter/gain nodes across toggle cycles.
    pub fn stop(&mut self) {
        let Some(ctx) = self.ctx.take() else { return };
        let now = ctx.current_time();
        for n in self.nodes.drain(..) {
            let _ = n.stop_with_when(now);
            let _ = n.disconnect();
        }
        if let Some((filter, gain)) = self.filter_gain.take() {
            let _ = filter.disconnect();
            let _ = gain.disconnect();
        }
        self.osc2 = None;
    }
}
