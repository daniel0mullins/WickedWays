# Procedural audio for the play surface — design

**Date:** 2026-06-26
**Package:** `@wickedways/play` (`packages/play`)
**Status:** Approved (brainstorming); pending implementation plan

## Goal

Add ambient music and sound effects to the browser play surface using **procedural
Web Audio synthesis** (no shipped audio assets). The ambient bed reacts to the
player's **Sanity** stat; sound effects fire on combat, mob encounters, item
interactions, and movement/lights/UI events. A single master toggle (the audio
button already present on the monitor bezel) turns all audio on/off; audio starts
muted and never autoplays.

## Why procedural

- No asset sourcing, licensing, or bundle-size concerns.
- Fits the retro-CRT / chiptune aesthetic of the terminal.
- Fully deterministic and unit-testable when the sound *description* is separated
  from the Web Audio *playback*.

## Existing seams (already in the codebase)

- **Audio toggle** — `src/text/ui.ts` renders an `#audio-toggle` button in the
  monitor bezel with `aria-pressed`, a mute-slash SVG, and `root.dataset.audio`
  state. Its click handler holds an explicit `// SEAM (later audio spec)` comment
  and an `audioEnabled` boolean. Audio defaults to **off** (muted).
- **Typed presentation cues** — `session.execute(intent)` returns
  `{ cues: PresentationCue[]; error?: string; mobAttacks?: MobAttack[] }`.
  `PresentationCue` is a discriminated union already carrying an optional
  `sound?: AssetRef`:
  - `{ kind: "action"; action: ActionKind; actor; sound? }`
  - `{ kind: "encounter"; mob; room; sound? }`
  - `{ kind: "visibility"; room; lit }`
  - `{ kind: "resolution"; outcome; ... }`
  - `{ kind: "mechanic"; cue: MechanicCue }`
- **Central event flow** — `handle()` in `ui.ts` is where every event passes:
  intents → `renderAction` + `renderCues`, `printRoom` on move, `renderMobAttacks`,
  errors, restart, save/restore, and the THE END resolution.
- **State for ambient** — `session.view().status.sanity` (and `maxSanity`/scale)
  is already surfaced for the HUD; the ambient controller reads it.

## Architecture

New module: `packages/play/src/audio/`. Pure core is separated from the Web Audio
backend so the mapping logic is deterministic and unit-testable (vitest/jsdom has
no Web Audio).

| File | Responsibility | Tested |
|------|----------------|--------|
| `cue-sound.ts` | **Pure**: maps a `PresentationCue` / intent kind / sanity to a declarative `SoundSpec` (voice name + params: frequency, duration, envelope, type). No Web Audio, no side effects. Returns `null` for events with no sound. | unit |
| `synth.ts` | `AudioEngine` wrapping `AudioContext`; renders a `SoundSpec` via oscillator/noise + gain envelope. Constructs lazily; no-ops if `AudioContext` is unavailable or disabled. | smoke test with a stubbed `AudioContext` |
| `ambient.ts` | Sanity-reactive drone: layered oscillators through a filter; `setTension(0..1)` shifts toward dissonance as sanity drops. Pure `sanityToTension(sanity, max)` helper is unit-tested. | tension curve unit-tested |
| `audio-manager.ts` | Orchestrator. Owns enabled state + `AudioEngine` + ambient. API: `setEnabled(on)`, `playCue(cue)`, `noteAction(kind)`, `noteError()`, `update(view)`. Creates the `AudioContext` on first enable (user-gesture rule). | logic unit-tested with stub |

### Data flow

```
user click on #audio-toggle ──→ audioEnabled = !audioEnabled
                                   └─→ audio.setEnabled(audioEnabled)
                                         └─→ lazily create/resume AudioContext (gesture)
                                             start/stop ambient bed

session.execute(intent) ──→ { cues, error?, mobAttacks? }
   handle():
     for cue of cues          → audio.playCue(cue)        → cue-sound.ts → SoundSpec → synth
     on intent kind           → audio.noteAction(kind)    (use/take/equip blip, move whoosh)
     on error                 → audio.noteError()         (buzz)
     for atk of mobAttacks    → combat hit / KO sting
   refresh():
     audio.update(after)      → ambient.setTension(sanityToTension(view.status.sanity, max))
```

### Sound mapping (the four chosen categories)

- **Combat (strikes & death):** sharp percussive hit per `action`/`attack` cue and
  per `mobAttack`; a lower sting on KO/death.
- **Mob encounter:** rising dread sting on `encounter` cue.
- **Item use / pickup:** soft confirming blip on use/take/equip actions.
- **Movement, lights & UI:** whoosh on room change (move intent), click on
  `visibility` cue (lights), subtle buzz on parser/action error.

### Ambient bed

A continuous low drone (layered oscillators + low-pass filter) that starts when
audio is enabled and stops when disabled. `sanityToTension` maps the current sanity
(relative to its max) to a `0..1` tension value: **high sanity → calm/consonant**,
**low sanity → dissonant/tense** (e.g. detune + filter cutoff + added beating
interval scale with tension). Updated every turn from `refresh()`.

## Conventions & guardrails

- **No `Math.random`.** Per repo convention all randomness is injected; sound
  variation (slight pitch jitter for liveliness) is **deterministic**, derived from
  cue content (e.g. actor id hash), so no rng dependency is introduced.
- **Single master toggle (YAGNI).** One button mutes both ambient and SFX. No
  separate music/SFX sliders in this iteration.
- **Preference is in-memory.** Starts muted each load (matches today); not persisted
  to localStorage. (Persisting "on" can't auto-resume audio without a gesture anyway.)
- **No autoplay / accessibility.** Audio only ever starts from the toggle click.
  `prefers-reduced-motion` governs visual motion, not audio; the master toggle is the
  off switch.
- **Graceful degradation.** If `AudioContext` is missing/blocked, the manager
  no-ops; the game is unaffected.

## Testing

- Unit-test `cue-sound.ts`: each cue kind / action / error maps to the expected
  voice + params; no-sound events return `null`.
- Unit-test `sanityToTension`: monotonic, clamped to `[0,1]`, endpoints correct.
- Smoke-test `AudioEngine` / `AudioManager` with a stubbed `AudioContext`
  (`as unknown as` stubs are permitted in tests): enable creates a context, disable
  stops, `playCue` calls into the stub without throwing, missing context no-ops.
- Existing Playwright e2e must still pass with audio present (no assertions on sound;
  verify toggling audio doesn't crash the session).
- `pnpm checks` (lint + typecheck + test) green before done.

## Documentation

Update `README.md` and relevant TSDoc to describe the play-surface audio system
(procedural Web Audio, sanity-reactive ambient bed, master toggle) per the project's
living-documentation convention.

## Out of scope (this iteration)

- Bundled/recorded audio assets.
- Separate music vs SFX volume controls.
- Per-location soundscapes (ambient reacts to sanity, not room).
- Persisting the audio preference across reloads.
