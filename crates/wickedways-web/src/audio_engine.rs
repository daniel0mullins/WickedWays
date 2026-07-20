//! The Web Audio renderer (Phase 2c, sub-project D — slice 4, audio).
//!
//! Ports `packages/play-runtime/src/audio/engine.ts`: the [`AudioEngine`] renders a pure
//! [`SynthVoice`](crate::audio::SynthVoice) as a one-shot sound — an oscillator (or a white-noise
//! buffer) through a gain node with a linear-attack / exponential-decay envelope. The `AudioContext`
//! is created lazily on the first [`resume`](AudioEngine::resume) (a user gesture), so nothing touches
//! Web Audio until the player enables sound.
//!
//! Only [`noise_samples`] (the deterministic pseudo-noise fill) is pure and host-tested; the rest is
//! `web-sys` calls the wasm build exercises. Best-effort throughout: a failed node/param call is
//! swallowed (audio must never crash the game). The runtime that decides *what* to play — the
//! director, soundpacks, and ambient bed — is a follow-up slice; this is just the backend that makes
//! the sound.

use web_sys::{AudioContext, AudioScheduledSourceNode, OscillatorType};

use crate::audio::{Source, SynthVoice};

/// A tiny gain floor for the exponential decay ramp — `exponentialRampToValueAtTime` can't target 0.
const SILENCE: f32 = 0.0001;

/// Deterministic pseudo-noise samples in `[-1, 1)` for a white-noise burst — a cheap LCG over the
/// buffer (no `Math.random`, per repo convention). Not byte-identical to the TS LCG (JS computes it in
/// f64 with precision loss); parity doesn't matter for inaudible noise texture, only that it's
/// deterministic and in range.
pub fn noise_samples(frames: usize) -> Vec<f32> {
    let mut data = vec![0.0f32; frames];
    let mut seed: u32 = 1;
    for x in data.iter_mut() {
        seed = seed.wrapping_mul(1103515245).wrapping_add(12345) & 0x7fff_ffff;
        *x = seed as f32 / 0x4000_0000u32 as f32 - 1.0;
    }
    data
}

/// The Web Audio backend that renders [`SynthVoice`]s. Holds a lazily-created [`AudioContext`].
#[derive(Default)]
pub struct AudioEngine {
    ctx: Option<AudioContext>,
}

impl AudioEngine {
    pub fn new() -> Self {
        Self::default()
    }

    /// Create (on first call) and resume the context. Returns `false` if Web Audio is unavailable.
    pub fn resume(&mut self) -> bool {
        if self.ctx.is_none() {
            match AudioContext::new() {
                Ok(ctx) => self.ctx = Some(ctx),
                Err(_) => return false,
            }
        }
        if let Some(ctx) = &self.ctx {
            let _ = ctx.resume();
        }
        true
    }

    /// Suspend the context to release audio hardware while muted. No-op if none.
    pub fn suspend(&self) {
        if let Some(ctx) = &self.ctx {
            let _ = ctx.suspend();
        }
    }

    /// Tear down the context (releases the browser's audio slot). Idempotent.
    pub fn close(&mut self) {
        if let Some(ctx) = self.ctx.take() {
            let _ = ctx.close();
        }
    }

    /// Render a one-shot procedural voice now. No-op if there is no context.
    pub fn play(&self, voice: &SynthVoice) {
        let Some(ctx) = &self.ctx else { return };
        let t0 = ctx.current_time();
        let end = t0 + voice.duration;

        let Ok(gain) = ctx.create_gain() else { return };
        let _ = gain.connect_with_audio_node(&ctx.destination());
        let g = gain.gain();
        let _ = g.set_value_at_time(SILENCE, t0);
        let _ = g.linear_ramp_to_value_at_time(voice.gain as f32, t0 + voice.attack);
        let _ = g.exponential_ramp_to_value_at_time(SILENCE, end);

        match voice.source {
            Source::Noise => {
                let frames = (ctx.sample_rate() as f64 * voice.duration).floor().max(1.0) as u32;
                let Ok(buffer) = ctx.create_buffer(1, frames, ctx.sample_rate()) else { return };
                let samples = noise_samples(frames as usize);
                let _ = buffer.copy_to_channel(&samples, 0);
                let Ok(src) = ctx.create_buffer_source() else { return };
                src.set_buffer(Some(&buffer));
                let _ = src.connect_with_audio_node(&gain);
                schedule(&src, t0, end);
            }
            osc_source => {
                let Ok(osc) = ctx.create_oscillator() else { return };
                osc.set_type(oscillator_type(osc_source));
                let freq = osc.frequency();
                let _ = freq.set_value_at_time(voice.freq as f32, t0);
                if let Some(target) = voice.end_freq {
                    if target != voice.freq {
                        let _ = freq.exponential_ramp_to_value_at_time(target.max(1.0) as f32, end);
                    }
                }
                let _ = osc.connect_with_audio_node(&gain);
                schedule(&osc, t0, end);
            }
        }
    }
}

/// Start a scheduled source at `t0` and stop it at `end`, via the base [`AudioScheduledSourceNode`]
/// (the non-deprecated timed start/stop, shared by oscillator + buffer-source nodes).
fn schedule(node: &AudioScheduledSourceNode, t0: f64, end: f64) {
    let _ = node.start_with_when(t0);
    let _ = node.stop_with_when(end);
}

/// Map a (non-noise) [`Source`] to its Web Audio [`OscillatorType`].
fn oscillator_type(source: Source) -> OscillatorType {
    match source {
        Source::Sine => OscillatorType::Sine,
        Source::Square => OscillatorType::Square,
        Source::Sawtooth => OscillatorType::Sawtooth,
        Source::Triangle => OscillatorType::Triangle,
        // Noise never reaches here (handled by the buffer path); default to sine defensively.
        Source::Noise => OscillatorType::Sine,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn noise_samples_are_in_range_and_deterministic() {
        let a = noise_samples(256);
        let b = noise_samples(256);
        assert_eq!(a.len(), 256);
        assert_eq!(a, b, "same length → identical samples (no RNG)");
        assert!(a.iter().all(|&s| (-1.0..1.0).contains(&s)), "every sample in [-1, 1)");
        // Not a constant — the LCG actually varies.
        assert!(a.iter().any(|&s| s != a[0]));
    }

    #[test]
    fn noise_samples_handles_a_single_frame() {
        assert_eq!(noise_samples(1).len(), 1);
        assert!(noise_samples(0).is_empty());
    }
}
