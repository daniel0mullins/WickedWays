# Procedural Play-Surface Audio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add ambient music and sound effects to the `@wickedways/play` browser surface using procedural Web Audio synthesis — no shipped audio assets.

**Architecture:** A pure, unit-tested core (`cue-sound.ts`, `tension.ts`) maps engine events and game state to declarative descriptions; thin Web Audio backends (`synth.ts`, `ambient.ts`) render them; an orchestrator (`audio-manager.ts`) owns enabled state and wires both. The existing `#audio-toggle` button and the central `handle()`/`refresh()` flow in `ui.ts` drive it.

**Tech Stack:** TypeScript (strict, NodeNext, `noUncheckedIndexedAccess`), Vite, Web Audio API, Vitest (node environment).

## Global Constraints

- Package: `packages/play` (`@wickedways/play`). All new files live under `packages/play/src/audio/`.
- **Test environment is `node`** (root `vitest.config.ts`) — no `window`, `document`, `AudioContext`, or `matchMedia` in tests. Web Audio classes MUST accept an injected context factory so tests pass a fake; never reference browser globals at module top level or in tested code paths.
- **No `Math.random`** (repo convention: randomness is injected). Sound variation is deterministic, derived by hashing cue identity.
- TypeScript strictness: `strict` + `noUncheckedIndexedAccess` + `noImplicitOverride`, NodeNext resolution. Use `#private` fields, handle `T | undefined` from indexed access, import with `.js` extensions.
- Tests may use `as unknown as X` stubs (the repo relaxes `no-unsafe-*` in `*.test.ts`).
- Run a single test from the repo root: `pnpm vitest run packages/play/src/audio/<file>.test.ts`.
- Final gate: `pnpm checks` (lint + root typecheck + per-package typecheck + full test suite) must pass.
- Audio defaults to **off** (muted); never autoplays. One master toggle controls both ambient and SFX. Preference is in-memory (not persisted).

---

## File Structure

| File | Responsibility |
|------|----------------|
| `packages/play/src/audio/cue-sound.ts` | Pure: `SoundSpec` type + `soundForCue`, `soundForMobAttack`, `errorSound`, deterministic `detuneFactor`. |
| `packages/play/src/audio/cue-sound.test.ts` | Unit tests for the mapping. |
| `packages/play/src/audio/tension.ts` | Pure: `sanityToTension(current, baseline)`. |
| `packages/play/src/audio/tension.test.ts` | Unit tests for the tension curve. |
| `packages/play/src/audio/synth.ts` | `AudioEngine`: renders a `SoundSpec` via Web Audio; injected context factory. |
| `packages/play/src/audio/synth.test.ts` | Smoke test with a fake `AudioContext`. |
| `packages/play/src/audio/ambient.ts` | `AmbientBed`: sanity-reactive drone; `start`/`setTension`/`stop`. |
| `packages/play/src/audio/ambient.test.ts` | Smoke test with a fake `AudioContext`. |
| `packages/play/src/audio/fake-audio-context.ts` | Shared test helper: a minimal recording fake `AudioContext`. (Not a `.test.ts`, but test-only.) |
| `packages/play/src/audio/audio-manager.ts` | `AudioManager`: enabled state, lazy context, `setEnabled`/`playCue`/`playMobAttack`/`noteError`/`update`. |
| `packages/play/src/audio/audio-manager.test.ts` | Unit tests with a fake engine. |
| `packages/play/src/text/ui.ts` | Modify: replace the audio SEAM, hook `handle()` and `refresh()`. |
| `packages/play/README.md`, root `README.md` | Docs update. |

---

### Task 1: Cue → sound mapping (pure core)

**Files:**
- Create: `packages/play/src/audio/cue-sound.ts`
- Test: `packages/play/src/audio/cue-sound.test.ts`

**Interfaces:**
- Consumes: `PresentationCue`, `ActionKind`, `AssetRef` from `wickedways/lib/presentation`; `MobAttack` from `../core/session.js`.
- Produces:
  - `type Waveform = "sine" | "square" | "sawtooth" | "triangle"`
  - `interface SoundSpec { source: Waveform | "noise"; freq: number; endFreq?: number; duration: number; gain: number; attack: number }`
  - `soundForCue(cue: PresentationCue): SoundSpec | null`
  - `soundForMobAttack(atk: MobAttack): SoundSpec`
  - `errorSound(): SoundSpec`
  - `detuneFactor(id: string): number` (deterministic, ~`0.97..1.03`)

`ActionKind` is exactly: `"attack" | "move" | "pickUp" | "drop" | "escape" | "takeDamage" | "fumble" | "mechanicAction"`. Mapping:

| Cue | SoundSpec intent |
|-----|------------------|
| `action` `attack` | square hit, pitch-jittered per `actor.id` |
| `action` `takeDamage` | noise thud |
| `action` `pickUp` | triangle blip up |
| `action` `drop` | triangle blip down |
| `action` `move` | noise whoosh |
| `action` `escape`/`fumble`/`mechanicAction` | `null` |
| `encounter` | sawtooth rising dread sting |
| `visibility` | short square click |
| `resolution` win | triangle victory rise; lose | sine death fall |
| `mechanic` | `null` (too frequent — would be noise) |

- [ ] **Step 1: Write the failing test**

```ts
// packages/play/src/audio/cue-sound.test.ts
import { describe, it, expect } from "vitest";
import type { PresentationCue } from "wickedways/lib/presentation";
import { soundForCue, soundForMobAttack, errorSound, detuneFactor } from "./cue-sound.js";

const actor = { id: "p1", name: "Heir" };

describe("soundForCue", () => {
  it("voices an attack action as a square hit", () => {
    const spec = soundForCue({ kind: "action", action: "attack", actor });
    expect(spec).not.toBeNull();
    expect(spec!.source).toBe("square");
    expect(spec!.duration).toBeGreaterThan(0);
    expect(spec!.gain).toBeGreaterThan(0);
  });

  it("voices takeDamage as a noise thud", () => {
    expect(soundForCue({ kind: "action", action: "takeDamage", actor })!.source).toBe("noise");
  });

  it("voices pickUp and drop as triangle blips with opposite glide", () => {
    const up = soundForCue({ kind: "action", action: "pickUp", actor })!;
    const down = soundForCue({ kind: "action", action: "drop", actor })!;
    expect(up.source).toBe("triangle");
    expect(down.source).toBe("triangle");
    expect(up.endFreq!).toBeGreaterThan(up.freq);
    expect(down.endFreq!).toBeLessThan(down.freq);
  });

  it("voices move as a noise whoosh", () => {
    expect(soundForCue({ kind: "action", action: "move", actor })!.source).toBe("noise");
  });

  it("returns null for escape, fumble, mechanicAction, and mechanic cues", () => {
    for (const action of ["escape", "fumble", "mechanicAction"] as const) {
      expect(soundForCue({ kind: "action", action, actor })).toBeNull();
    }
    expect(soundForCue({ kind: "mechanic", cue: { text: "x" } })).toBeNull();
  });

  it("voices an encounter as a rising sawtooth sting", () => {
    const spec = soundForCue({ kind: "encounter", mob: actor, room: { id: "r", name: "R" } })!;
    expect(spec.source).toBe("sawtooth");
    expect(spec.endFreq!).toBeGreaterThan(spec.freq);
  });

  it("voices visibility as a short click", () => {
    const spec = soundForCue({ kind: "visibility", room: { id: "r", name: "R" }, lit: true })!;
    expect(spec.duration).toBeLessThan(0.1);
  });

  it("voices resolution win as a rise and loss as a fall", () => {
    const win = soundForCue({ kind: "resolution", outcome: "won" })!;
    const lose = soundForCue({ kind: "resolution", outcome: "lost" })!;
    expect(win.endFreq!).toBeGreaterThan(win.freq);
    expect(lose.endFreq!).toBeLessThan(lose.freq);
  });

  it("jitters attack pitch deterministically by actor id", () => {
    const a = soundForCue({ kind: "action", action: "attack", actor: { id: "a", name: "A" } })!;
    const b = soundForCue({ kind: "action", action: "attack", actor: { id: "b", name: "B" } })!;
    const a2 = soundForCue({ kind: "action", action: "attack", actor: { id: "a", name: "A" } })!;
    expect(a.freq).toBe(a2.freq);   // deterministic
    expect(a.freq).not.toBe(b.freq); // varies by id
  });
});

describe("detuneFactor", () => {
  it("is deterministic and within a small band", () => {
    expect(detuneFactor("p1")).toBe(detuneFactor("p1"));
    expect(detuneFactor("p1")).toBeGreaterThan(0.9);
    expect(detuneFactor("p1")).toBeLessThan(1.1);
  });
});

describe("soundForMobAttack / errorSound", () => {
  it("voices a mob attack as a hit", () => {
    const spec = soundForMobAttack({ name: "Wraith", stat: 0 as unknown as never, amount: 3 });
    expect(spec.gain).toBeGreaterThan(0);
    expect(spec.duration).toBeGreaterThan(0);
  });
  it("produces a low error buzz", () => {
    expect(errorSound().freq).toBeLessThan(200);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/play/src/audio/cue-sound.test.ts`
Expected: FAIL — `Cannot find module './cue-sound.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/play/src/audio/cue-sound.ts
import type { PresentationCue } from "wickedways/lib/presentation";
import type { MobAttack } from "../core/session.js";

/** Oscillator waveforms a SoundSpec can request. */
export type Waveform = "sine" | "square" | "sawtooth" | "triangle";

/**
 * A declarative, backend-agnostic description of a one-shot sound. The Web Audio
 * backend ({@link AudioEngine}) renders it; this module never touches Web Audio,
 * so the mapping stays pure and unit-testable under the node test environment.
 */
export interface SoundSpec {
  /** Oscillator waveform, or "noise" for a white-noise burst. */
  source: Waveform | "noise";
  /** Start frequency in Hz (ignored when `source` is "noise"). */
  freq: number;
  /** Optional end frequency for a pitch glide; defaults to `freq`. */
  endFreq?: number;
  /** Total duration in seconds. */
  duration: number;
  /** Peak gain, 0..1. */
  gain: number;
  /** Attack time in seconds (linear ramp to peak). */
  attack: number;
}

/**
 * Deterministic pitch multiplier in ~`[0.97, 1.03]` derived from an id string,
 * so repeated events feel alive without using `Math.random` (repo convention).
 */
export function detuneFactor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  const frac = (Math.abs(h) % 1000) / 1000; // 0..1
  return 0.97 + frac * 0.06;
}

/** Maps a presentation cue to a sound, or `null` when the event is silent. */
export function soundForCue(cue: PresentationCue): SoundSpec | null {
  switch (cue.kind) {
    case "action":
      switch (cue.action) {
        case "attack": {
          const f = 190 * detuneFactor(cue.actor.id);
          return { source: "square", freq: f, endFreq: f * 0.5, duration: 0.12, gain: 0.18, attack: 0.001 };
        }
        case "takeDamage":
          return { source: "noise", freq: 0, duration: 0.14, gain: 0.16, attack: 0.001 };
        case "pickUp":
          return { source: "triangle", freq: 660, endFreq: 990, duration: 0.09, gain: 0.12, attack: 0.005 };
        case "drop":
          return { source: "triangle", freq: 520, endFreq: 330, duration: 0.09, gain: 0.12, attack: 0.005 };
        case "move":
          return { source: "noise", freq: 0, duration: 0.22, gain: 0.06, attack: 0.04 };
        case "escape":
        case "fumble":
        case "mechanicAction":
          return null;
      }
      return null;
    case "encounter":
      return { source: "sawtooth", freq: 110, endFreq: 330, duration: 0.5, gain: 0.14, attack: 0.08 };
    case "visibility":
      return { source: "square", freq: 1200, duration: 0.04, gain: 0.08, attack: 0.001 };
    case "resolution":
      // CampaignOutcome: "ongoing" | "won" | "lost" | "timed-out" | "ended".
      // "won" rises triumphantly; every other terminal outcome falls.
      return cue.outcome === "won"
        ? { source: "triangle", freq: 523, endFreq: 784, duration: 0.6, gain: 0.16, attack: 0.02 }
        : { source: "sine", freq: 220, endFreq: 55, duration: 0.8, gain: 0.16, attack: 0.02 };
    case "mechanic":
      return null;
  }
}

/** A mob's strike landing on the player. */
export function soundForMobAttack(_atk: MobAttack): SoundSpec {
  return { source: "square", freq: 150, endFreq: 80, duration: 0.13, gain: 0.16, attack: 0.001 };
}

/** A short low buzz for a rejected command or illegal action. */
export function errorSound(): SoundSpec {
  return { source: "square", freq: 90, duration: 0.12, gain: 0.1, attack: 0.001 };
}
```

Note: `resolution.outcome` is `CampaignOutcome` = `"ongoing" | "won" | "lost" | "timed-out" | "ended"` (verified in `src/lib/victory.ts`). Only `"won"` is pinned (the rise); every other terminal outcome takes the `else` fall.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/play/src/audio/cue-sound.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add packages/play/src/audio/cue-sound.ts packages/play/src/audio/cue-sound.test.ts
git commit -m "feat(play): pure cue→sound mapping for procedural audio"
```

---

### Task 2: Sanity → tension curve (pure core)

**Files:**
- Create: `packages/play/src/audio/tension.ts`
- Test: `packages/play/src/audio/tension.test.ts`

**Interfaces:**
- Produces: `sanityToTension(current: number, baseline: number): number` — returns `0..1`; `0` when `current >= baseline` (calm), approaching `1` as `current` falls to `0` (tense). Returns `0` when `baseline <= 0`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/play/src/audio/tension.test.ts
import { describe, it, expect } from "vitest";
import { sanityToTension } from "./tension.js";

describe("sanityToTension", () => {
  it("is calm (0) at or above baseline", () => {
    expect(sanityToTension(16, 16)).toBe(0);
    expect(sanityToTension(20, 16)).toBe(0);
  });
  it("is fully tense (1) at zero sanity", () => {
    expect(sanityToTension(0, 16)).toBe(1);
  });
  it("rises monotonically as sanity falls", () => {
    expect(sanityToTension(12, 16)).toBeLessThan(sanityToTension(4, 16));
  });
  it("clamps to [0,1] and guards a non-positive baseline", () => {
    expect(sanityToTension(-5, 16)).toBe(1);
    expect(sanityToTension(5, 0)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/play/src/audio/tension.test.ts`
Expected: FAIL — `Cannot find module './tension.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/play/src/audio/tension.ts

/**
 * Map current sanity to an ambient tension value in `[0, 1]`, normalized against
 * a baseline (the high-water mark of sanity seen this session). High sanity →
 * 0 (calm/consonant); zero sanity → 1 (dissonant/tense).
 */
export function sanityToTension(current: number, baseline: number): number {
  if (baseline <= 0) return 0;
  const ratio = current / baseline;
  return Math.min(1, Math.max(0, 1 - ratio));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/play/src/audio/tension.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/play/src/audio/tension.ts packages/play/src/audio/tension.test.ts
git commit -m "feat(play): sanity→tension curve for ambient bed"
```

---

### Task 3: Web Audio backend (`AudioEngine`) + shared fake context

**Files:**
- Create: `packages/play/src/audio/synth.ts`
- Create: `packages/play/src/audio/fake-audio-context.ts` (test helper)
- Test: `packages/play/src/audio/synth.test.ts`

**Interfaces:**
- Consumes: `SoundSpec` from `./cue-sound.js`.
- Produces:
  - `class AudioEngine { constructor(factory?: () => AudioContext); resume(): boolean; get context(): AudioContext | null; play(spec: SoundSpec): void; close(): void }`
  - `fake-audio-context.ts`: `makeFakeAudioContext(): { ctx: AudioContext; counts: { oscillators: number; gains: number; buffers: number } }`

`resume()` lazily creates the context via the factory (default `() => new AudioContext()`), calls `ctx.resume()`, and returns `true`; if the factory throws (e.g. node, where `AudioContext` is undefined), it returns `false` and the engine stays inert. `play()` no-ops when there is no context.

- [ ] **Step 1: Write the fake context helper**

```ts
// packages/play/src/audio/fake-audio-context.ts
/* Test-only: a minimal recording stand-in for AudioContext (node has no Web Audio). */

interface Counts { oscillators: number; gains: number; buffers: number; filters: number }

const fakeParam = () => ({
  value: 0,
  setValueAtTime() { return this; },
  linearRampToValueAtTime() { return this; },
  exponentialRampToValueAtTime() { return this; },
});

export function makeFakeAudioContext(): { ctx: AudioContext; counts: Counts } {
  const counts: Counts = { oscillators: 0, gains: 0, buffers: 0, filters: 0 };
  const node = () => ({ connect() { /* chainable */ }, start() {}, stop() {}, disconnect() {} });
  const ctx = {
    currentTime: 0,
    state: "running",
    destination: {},
    resume: () => Promise.resolve(),
    close: () => Promise.resolve(),
    createOscillator: () => { counts.oscillators++; return { ...node(), type: "sine", frequency: fakeParam(), detune: fakeParam() }; },
    createGain: () => { counts.gains++; return { ...node(), gain: fakeParam() }; },
    createBiquadFilter: () => { counts.filters++; return { ...node(), type: "lowpass", frequency: fakeParam(), Q: fakeParam() }; },
    createBufferSource: () => ({ ...node(), buffer: null }),
    createBuffer: (_ch: number, len: number) => { counts.buffers++; return { getChannelData: () => new Float32Array(len) }; },
    sampleRate: 44100,
  };
  return { ctx: ctx as unknown as AudioContext, counts };
}
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/play/src/audio/synth.test.ts
import { describe, it, expect } from "vitest";
import { AudioEngine } from "./synth.js";
import { makeFakeAudioContext } from "./fake-audio-context.js";

describe("AudioEngine", () => {
  it("stays inert when the context factory throws", () => {
    const engine = new AudioEngine(() => { throw new Error("no AudioContext"); });
    expect(engine.resume()).toBe(false);
    expect(engine.context).toBeNull();
    expect(() => engine.play({ source: "square", freq: 100, duration: 0.1, gain: 0.1, attack: 0.001 })).not.toThrow();
  });

  it("creates a context on resume and builds an oscillator on play", () => {
    const { ctx, counts } = makeFakeAudioContext();
    const engine = new AudioEngine(() => ctx);
    expect(engine.resume()).toBe(true);
    engine.play({ source: "square", freq: 200, endFreq: 100, duration: 0.12, gain: 0.18, attack: 0.001 });
    expect(counts.oscillators).toBe(1);
    expect(counts.gains).toBe(1);
  });

  it("builds a buffer source for noise specs", () => {
    const { ctx, counts } = makeFakeAudioContext();
    const engine = new AudioEngine(() => ctx);
    engine.resume();
    engine.play({ source: "noise", freq: 0, duration: 0.2, gain: 0.06, attack: 0.04 });
    expect(counts.buffers).toBe(1);
    expect(counts.oscillators).toBe(0);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run packages/play/src/audio/synth.test.ts`
Expected: FAIL — `Cannot find module './synth.js'`.

- [ ] **Step 4: Write the implementation**

```ts
// packages/play/src/audio/synth.ts
import type { SoundSpec } from "./cue-sound.js";

/**
 * Web Audio backend that renders {@link SoundSpec}s as one-shot sounds. The
 * `AudioContext` is created lazily through an injected factory so tests can pass
 * a fake (the node test environment has no Web Audio) and so construction is
 * deferred until a user gesture enables audio.
 */
export class AudioEngine {
  #ctx: AudioContext | null = null;
  readonly #factory: () => AudioContext;

  constructor(factory: () => AudioContext = () => new AudioContext()) {
    this.#factory = factory;
  }

  /** Create/resume the context. Returns false if Web Audio is unavailable. */
  resume(): boolean {
    if (this.#ctx === null) {
      try {
        this.#ctx = this.#factory();
      } catch {
        this.#ctx = null;
        return false;
      }
    }
    void this.#ctx.resume();
    return true;
  }

  get context(): AudioContext | null {
    return this.#ctx;
  }

  /** Render a one-shot sound now. No-op if there is no context. */
  play(spec: SoundSpec): void {
    const ctx = this.#ctx;
    if (ctx === null) return;
    const t0 = ctx.currentTime;
    const end = t0 + spec.duration;

    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(spec.gain, t0 + spec.attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);

    if (spec.source === "noise") {
      const src = ctx.createBufferSource();
      const frames = Math.max(1, Math.floor(ctx.sampleRate * spec.duration));
      const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      // Deterministic pseudo-noise (no Math.random): a cheap LCG over the buffer.
      let seed = 1;
      for (let i = 0; i < frames; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        data[i] = (seed / 0x40000000) - 1;
      }
      src.buffer = buffer;
      src.connect(gain);
      src.start(t0);
      src.stop(end);
    } else {
      const osc = ctx.createOscillator();
      osc.type = spec.source;
      osc.frequency.setValueAtTime(spec.freq, t0);
      if (spec.endFreq !== undefined && spec.endFreq !== spec.freq) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(1, spec.endFreq), end);
      }
      osc.connect(gain);
      osc.start(t0);
      osc.stop(end);
    }
  }

  /** Tear down the context (releases audio hardware). */
  close(): void {
    if (this.#ctx !== null) {
      void this.#ctx.close();
      this.#ctx = null;
    }
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run packages/play/src/audio/synth.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/play/src/audio/synth.ts packages/play/src/audio/fake-audio-context.ts packages/play/src/audio/synth.test.ts
git commit -m "feat(play): Web Audio engine for one-shot SFX"
```

---

### Task 4: Sanity-reactive ambient bed (`AmbientBed`)

**Files:**
- Create: `packages/play/src/audio/ambient.ts`
- Test: `packages/play/src/audio/ambient.test.ts`

**Interfaces:**
- Consumes: `AudioContext` (passed in); `sanityToTension` is NOT used here (the manager computes tension and calls `setTension`).
- Produces: `class AmbientBed { start(ctx: AudioContext): void; setTension(t: number): void; stop(): void; get running(): boolean }`

The bed is two low oscillators through a low-pass filter into a gain node. `setTension(0..1)` detunes the second oscillator wider (more dissonant), opens the filter brighter/harsher, and lifts the gain slightly as tension rises. `start` is idempotent (no double-start); `stop` disconnects and clears state.

- [ ] **Step 1: Write the failing test**

```ts
// packages/play/src/audio/ambient.test.ts
import { describe, it, expect } from "vitest";
import { AmbientBed } from "./ambient.js";
import { makeFakeAudioContext } from "./fake-audio-context.js";

describe("AmbientBed", () => {
  it("starts two oscillators through a filter and reports running", () => {
    const { ctx, counts } = makeFakeAudioContext();
    const bed = new AmbientBed();
    bed.start(ctx);
    expect(bed.running).toBe(true);
    expect(counts.oscillators).toBe(2);
    expect(counts.filters).toBe(1);
  });

  it("is idempotent on repeated start", () => {
    const { ctx, counts } = makeFakeAudioContext();
    const bed = new AmbientBed();
    bed.start(ctx);
    bed.start(ctx);
    expect(counts.oscillators).toBe(2);
  });

  it("accepts setTension without a running bed (no-op) and after start", () => {
    const { ctx } = makeFakeAudioContext();
    const bed = new AmbientBed();
    expect(() => bed.setTension(0.5)).not.toThrow();
    bed.start(ctx);
    expect(() => bed.setTension(1)).not.toThrow();
    bed.stop();
    expect(bed.running).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/play/src/audio/ambient.test.ts`
Expected: FAIL — `Cannot find module './ambient.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/play/src/audio/ambient.ts

/**
 * A continuous, sanity-reactive drone. Two detuned low oscillators feed a
 * low-pass filter and a master gain. As tension rises (sanity falls), the second
 * oscillator detunes wider (beating → dissonance), the filter opens brighter, and
 * the gain lifts slightly. Designed to run only in the browser; tests inject a
 * fake AudioContext.
 */
export class AmbientBed {
  #ctx: AudioContext | null = null;
  #osc2: OscillatorNode | null = null;
  #filter: BiquadFilterNode | null = null;
  #gain: GainNode | null = null;
  #nodes: AudioScheduledSourceNode[] = [];

  static readonly #BASE_HZ = 55; // A1

  get running(): boolean {
    return this.#ctx !== null;
  }

  /** Begin playback. Idempotent — a second call while running is ignored. */
  start(ctx: AudioContext): void {
    if (this.#ctx !== null) return;
    this.#ctx = ctx;
    const now = ctx.currentTime;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.04, now);
    gain.connect(ctx.destination);

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(400, now);
    filter.connect(gain);

    const osc1 = ctx.createOscillator();
    osc1.type = "sine";
    osc1.frequency.setValueAtTime(AmbientBed.#BASE_HZ, now);
    osc1.connect(filter);
    osc1.start(now);

    const osc2 = ctx.createOscillator();
    osc2.type = "sawtooth";
    osc2.frequency.setValueAtTime(AmbientBed.#BASE_HZ * 1.01, now);
    osc2.connect(filter);
    osc2.start(now);

    this.#gain = gain;
    this.#filter = filter;
    this.#osc2 = osc2;
    this.#nodes = [osc1, osc2];
    this.setTension(0);
  }

  /** Update the drone's unease, `t` in `[0, 1]`. No-op when not running. */
  setTension(t: number): void {
    const ctx = this.#ctx;
    if (ctx === null || this.#osc2 === null || this.#filter === null || this.#gain === null) return;
    const clamped = Math.min(1, Math.max(0, t));
    const now = ctx.currentTime;
    // Wider detune → dissonant beating as tension rises.
    this.#osc2.frequency.setValueAtTime(AmbientBed.#BASE_HZ * (1.01 + clamped * 0.06), now);
    // Brighter/harsher filter and a touch louder when tense.
    this.#filter.frequency.setValueAtTime(300 + clamped * 900, now);
    this.#gain.gain.setValueAtTime(0.04 + clamped * 0.05, now);
  }

  /** Stop and disconnect all nodes. */
  stop(): void {
    const ctx = this.#ctx;
    if (ctx === null) return;
    const now = ctx.currentTime;
    for (const n of this.#nodes) {
      try { n.stop(now); } catch { /* already stopped */ }
      n.disconnect();
    }
    this.#filter?.disconnect();
    this.#gain?.disconnect();
    this.#nodes = [];
    this.#osc2 = null;
    this.#filter = null;
    this.#gain = null;
    this.#ctx = null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/play/src/audio/ambient.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/play/src/audio/ambient.ts packages/play/src/audio/ambient.test.ts
git commit -m "feat(play): sanity-reactive ambient drone"
```

---

### Task 5: Orchestrator (`AudioManager`)

**Files:**
- Create: `packages/play/src/audio/audio-manager.ts`
- Test: `packages/play/src/audio/audio-manager.test.ts`

**Interfaces:**
- Consumes: `AudioEngine` (`synth.js`), `AmbientBed` (`ambient.js`), `soundForCue`/`soundForMobAttack`/`errorSound` (`cue-sound.js`), `sanityToTension` (`tension.js`), `PresentationCue`, `MobAttack`.
- Produces:
  - `interface AudioDeps { engine?: AudioEngine; ambient?: AmbientBed }` (for test injection)
  - `class AudioManager { constructor(deps?: AudioDeps); get enabled(): boolean; setEnabled(on: boolean): void; playCue(cue: PresentationCue): void; playMobAttack(atk: MobAttack): void; noteError(): void; update(sanity: number): void }`

Behavior:
- `update(sanity)` always records the high-water-mark baseline and remembers the last sanity (so enabling later applies the right tension), and — when enabled and running — sets ambient tension.
- `setEnabled(true)` resumes the engine; only if that succeeds does it start the ambient bed and apply the remembered tension. `setEnabled(false)` stops the bed.
- `playCue`/`playMobAttack`/`noteError` no-op when disabled.

- [ ] **Step 1: Write the failing test**

```ts
// packages/play/src/audio/audio-manager.test.ts
import { describe, it, expect, vi } from "vitest";
import { AudioManager } from "./audio-manager.js";
import { AudioEngine } from "./synth.js";
import { AmbientBed } from "./ambient.js";
import { makeFakeAudioContext } from "./fake-audio-context.js";

function harness() {
  const { ctx } = makeFakeAudioContext();
  const engine = new AudioEngine(() => ctx);
  const ambient = new AmbientBed();
  const playSpy = vi.spyOn(engine, "play");
  const startSpy = vi.spyOn(ambient, "start");
  const stopSpy = vi.spyOn(ambient, "stop");
  const tensionSpy = vi.spyOn(ambient, "setTension");
  const mgr = new AudioManager({ engine, ambient });
  return { mgr, playSpy, startSpy, stopSpy, tensionSpy };
}

describe("AudioManager", () => {
  it("starts muted and plays nothing while disabled", () => {
    const { mgr, playSpy } = harness();
    expect(mgr.enabled).toBe(false);
    mgr.playCue({ kind: "action", action: "attack", actor: { id: "p", name: "P" } });
    mgr.playMobAttack({ name: "W", stat: 0 as unknown as never, amount: 1 });
    mgr.noteError();
    expect(playSpy).not.toHaveBeenCalled();
  });

  it("enabling starts the ambient bed; disabling stops it", () => {
    const { mgr, startSpy, stopSpy } = harness();
    mgr.setEnabled(true);
    expect(startSpy).toHaveBeenCalledOnce();
    mgr.setEnabled(false);
    expect(stopSpy).toHaveBeenCalledOnce();
  });

  it("plays SFX only when enabled, and skips silent cues", () => {
    const { mgr, playSpy } = harness();
    mgr.setEnabled(true);
    mgr.playCue({ kind: "mechanic", cue: { text: "x" } }); // silent
    expect(playSpy).not.toHaveBeenCalled();
    mgr.playCue({ kind: "action", action: "attack", actor: { id: "p", name: "P" } });
    mgr.noteError();
    expect(playSpy).toHaveBeenCalledTimes(2);
  });

  it("drives ambient tension from sanity against a high-water baseline", () => {
    const { mgr, tensionSpy } = harness();
    mgr.update(16); // baseline = 16, calm
    mgr.setEnabled(true);
    tensionSpy.mockClear();
    mgr.update(4); // tense
    const last = tensionSpy.mock.calls.at(-1)?.[0] ?? 0;
    expect(last).toBeGreaterThan(0.5);
  });

  it("remembers tension set before enabling and applies it on enable", () => {
    const { mgr, tensionSpy } = harness();
    mgr.update(16);
    mgr.update(8); // disabled — recorded but not applied to a running bed
    mgr.setEnabled(true);
    const applied = tensionSpy.mock.calls.at(-1)?.[0] ?? -1;
    expect(applied).toBeCloseTo(0.5, 5);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/play/src/audio/audio-manager.test.ts`
Expected: FAIL — `Cannot find module './audio-manager.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/play/src/audio/audio-manager.ts
import type { PresentationCue } from "wickedways/lib/presentation";
import type { MobAttack } from "../core/session.js";
import { AudioEngine } from "./synth.js";
import { AmbientBed } from "./ambient.js";
import { soundForCue, soundForMobAttack, errorSound } from "./cue-sound.js";
import { sanityToTension } from "./tension.js";

/** Injection seam for tests; production uses the defaults. */
export interface AudioDeps {
  engine?: AudioEngine;
  ambient?: AmbientBed;
}

/**
 * Owns audio enabled-state and routes game events to sound. Construction is
 * cheap and side-effect-free; the AudioContext is created only when the user
 * enables audio (browser autoplay rule). The single master switch governs both
 * the ambient bed and one-shot SFX.
 */
export class AudioManager {
  readonly #engine: AudioEngine;
  readonly #ambient: AmbientBed;
  #enabled = false;
  #baselineSanity = 0; // high-water mark for tension normalization
  #lastSanity = 0;

  constructor(deps: AudioDeps = {}) {
    this.#engine = deps.engine ?? new AudioEngine();
    this.#ambient = deps.ambient ?? new AmbientBed();
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /** Turn all audio on/off. Enabling resumes the context and starts the drone. */
  setEnabled(on: boolean): void {
    this.#enabled = on;
    if (on) {
      const ok = this.#engine.resume();
      const ctx = this.#engine.context;
      if (ok && ctx !== null) {
        this.#ambient.start(ctx);
        this.#ambient.setTension(this.#currentTension());
      }
    } else {
      this.#ambient.stop();
    }
  }

  /** Play the sound for a presentation cue, if any and if enabled. */
  playCue(cue: PresentationCue): void {
    if (!this.#enabled) return;
    const spec = soundForCue(cue);
    if (spec !== null) this.#engine.play(spec);
  }

  /** Play a mob's strike landing. */
  playMobAttack(atk: MobAttack): void {
    if (!this.#enabled) return;
    this.#engine.play(soundForMobAttack(atk));
  }

  /** Play the error buzz for a rejected command. */
  noteError(): void {
    if (!this.#enabled) return;
    this.#engine.play(errorSound());
  }

  /** Feed the current sanity each turn so the ambient drone tracks the arc. */
  update(sanity: number): void {
    this.#lastSanity = sanity;
    if (sanity > this.#baselineSanity) this.#baselineSanity = sanity;
    if (this.#enabled) this.#ambient.setTension(this.#currentTension());
  }

  #currentTension(): number {
    return sanityToTension(this.#lastSanity, this.#baselineSanity);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/play/src/audio/audio-manager.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/play/src/audio/audio-manager.ts packages/play/src/audio/audio-manager.test.ts
git commit -m "feat(play): audio orchestrator wiring SFX + ambient to game state"
```

---

### Task 6: Wire `AudioManager` into the terminal UI

**Files:**
- Modify: `packages/play/src/text/ui.ts` (audio toggle block ~lines 62-75; intent/error handling ~lines 322-352; `refresh` ~lines 137 + its end)

**Interfaces:**
- Consumes: `AudioManager` from `../audio/audio-manager.js`.
- Produces: no new exports; behavioral change only.

This task has no unit test (the node test env has no DOM; `ui.ts` is exercised by Playwright e2e). Verification is typecheck + the existing test suite staying green + a manual browser smoke. Each sub-edit is small; do them together and verify once.

- [ ] **Step 1: Import and construct the manager**

At the top of `ui.ts`, add to the imports:

```ts
import { AudioManager } from "../audio/audio-manager.js";
```

Inside `mountTerminal`, right after `let narrator = new Narrator();`, add:

```ts
  const audio = new AudioManager();
```

- [ ] **Step 2: Replace the audio-toggle SEAM**

Replace the existing toggle block (the comment + handler at ~lines 62-75) so the click drives the manager. New block:

```ts
  // Audio toggle — master switch on the bezel for procedural music + SFX.
  // Audio starts muted; the first enable resumes the AudioContext (this click is
  // the required user gesture) and starts the sanity-reactive ambient bed.
  const audioToggle = root.querySelector<HTMLButtonElement>("#audio-toggle")!;
  let audioEnabled = false; // starts muted
  root.dataset.audio = "off";
  audioToggle.addEventListener("click", () => {
    audioEnabled = !audioEnabled;
    audioToggle.setAttribute("aria-pressed", String(audioEnabled));
    audioToggle.title = `Audio: ${audioEnabled ? "on" : "off"}`;
    root.dataset.audio = audioEnabled ? "on" : "off";
    audio.setEnabled(audioEnabled);
    if (gameStarted) input.focus(); // #cmd isn't focusable on the welcome screen
  });
```

- [ ] **Step 3: Feed sanity to the ambient bed each turn**

At the END of the `refresh` arrow function (after the exits block appends, just before the closing `};`), add:

```ts
    // Drive the ambient drone from the current Sanity each turn.
    audio.update(vm.status.sanity);
```

(`vm` is already in scope — `const vm = session.view();` at the top of `refresh`.)

- [ ] **Step 4: Play SFX from the intent result and errors**

In `handle()`, the parser-level error case currently reads:

```ts
      case "error": print([res.message], "error"); return;
```

Change it to also buzz:

```ts
      case "error": audio.noteError(); print([res.message], "error"); return;
```

In the `case "intent":` block, the current body is:

```ts
        const result = session.execute(res.intent);
        if (result.error) { print([result.error], "error"); return; }
        const after = session.view();
        print([...narrator.renderAction(res.intent, before, after), ...narrator.renderCues(result.cues)]);
        if (res.intent.kind === "move") printRoom(after);
        // Mob reactions print last ...
        const mobLines = narrator.renderMobAttacks(result.mobAttacks ?? []);
        if (mobLines.length) print(mobLines);
        refresh();
        if (after.finished) print(["", "— THE END —"], "end");
        return;
```

Replace it with (adds error buzz, cue SFX, and mob-attack SFX — ordering preserved):

```ts
        const result = session.execute(res.intent);
        if (result.error) { audio.noteError(); print([result.error], "error"); return; }
        const after = session.view();
        for (const cue of result.cues) audio.playCue(cue);
        print([...narrator.renderAction(res.intent, before, after), ...narrator.renderCues(result.cues)]);
        if (res.intent.kind === "move") printRoom(after);
        // Mob reactions print last ...
        const mobAttacks = result.mobAttacks ?? [];
        for (const atk of mobAttacks) audio.playMobAttack(atk);
        const mobLines = narrator.renderMobAttacks(mobAttacks);
        if (mobLines.length) print(mobLines);
        refresh();
        if (after.finished) print(["", "— THE END —"], "end");
        return;
```

- [ ] **Step 5: Typecheck and run the full suite**

Run: `pnpm -r run typecheck && pnpm test`
Expected: typecheck clean; all unit tests (engine + play audio) PASS.

- [ ] **Step 6: Manual browser smoke**

Run: `pnpm --filter @wickedways/play dev`
Then in the browser: click **Enter**, click the **speaker** button (bezel) — confirm a low drone starts; attack a mob and confirm hit/strike sounds; pick up an item (blip); move rooms (whoosh); type a bad command (buzz); watch the drone grow tense as Sanity drops. Toggle the speaker off — all audio stops.

- [ ] **Step 7: Commit**

```bash
git add packages/play/src/text/ui.ts
git commit -m "feat(play): drive procedural audio from the terminal UI"
```

---

### Task 7: Documentation + final checks

**Files:**
- Modify: root `README.md` (play-surface / presentation-audio section), `packages/play/README.md`
- TSDoc already written inline in Tasks 1-6.

- [ ] **Step 1: Document the audio system**

Add a short subsection to `packages/play/README.md` (and a pointer in the root `README.md` play-surface section) describing: procedural Web Audio (no assets); the four SFX categories (combat strikes/death, mob encounter, item use/pickup, movement/lights/UI); the sanity-reactive ambient drone normalized against a high-water-mark baseline; the single master toggle on the monitor bezel (starts muted, in-memory). Note the seam: cues → `AudioManager.playCue`, mob strikes → `playMobAttack`, sanity → `update`.

Verify against the spec's "Documentation" section: `docs/superpowers/specs/2026-06-26-play-audio-design.md`.

- [ ] **Step 2: Run the full check gate**

Run: `pnpm checks`
Expected: lint, root typecheck, per-package typecheck, and the full test suite all PASS.

- [ ] **Step 3: Commit**

```bash
git add README.md packages/play/README.md
git commit -m "docs: document procedural play-surface audio"
```

---

## Self-Review

**Spec coverage:**
- Procedural Web Audio, no assets → Tasks 1, 3, 4 (no asset imports anywhere). ✅
- Sanity-reactive ambient bed → Tasks 2, 4, 5 (`sanityToTension` + `AmbientBed` + `update`). ✅
- Four SFX categories (combat strikes/death, encounter, item use/pickup, movement/lights/UI) → Task 1 mapping + Task 6 mob-attack wiring. Combat death = `resolution` cue (`"won"` rise / else fall), per spec note. ✅
- Single master toggle, starts muted, in-memory → Task 5 `setEnabled` + Task 6 toggle (no localStorage). ✅
- No autoplay / gesture rule → Task 5 lazy `resume()` on enable; Task 6 enables on click. ✅
- No `Math.random` → `detuneFactor` hash (Task 1), LCG noise (Task 3). ✅
- Graceful degradation → `AudioEngine.resume()` returns false / `play` no-ops (Task 3); manager guards (Task 5). ✅
- Determinism + tested core → pure Tasks 1-2 fully tested; Web Audio via injected fake context (Tasks 3-5). ✅
- `pnpm checks` green; README/TSDoc updated → Task 7. ✅

**Placeholder scan:** No TBD/TODO; every code step shows complete code. One verification note (confirm `CampaignOutcome` win-variant name) is an explicit grep instruction, not a placeholder.

**Type consistency:** `SoundSpec`, `AudioEngine`, `AmbientBed`, `AudioManager`, `AudioDeps`, `sanityToTension`, `soundForCue`/`soundForMobAttack`/`errorSound`, `makeFakeAudioContext` are named identically across the tasks that define and consume them. `MobAttack`/`PresentationCue` match the engine signatures verified during planning. `update(sanity: number)` is fed `vm.status.sanity` (a `number`) in Task 6.

**Externally-pinned strings:** `ActionKind` values and `CampaignOutcome` (`"won"`) were both confirmed against the engine (`src/lib/character/history.ts`, `src/lib/victory.ts`) during planning. No open verification items remain.
