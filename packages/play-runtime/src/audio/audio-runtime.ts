import type { PresentationCue } from "wickedways/lib/presentation";
import type { ICampaign } from "wickedways/lib/campaign";
import type { ViewModel } from "../viewmodel.js";
import type { MobAttack } from "../session.js";
import type { AudioDirector, CampaignAudio, Renderer, SoundPack } from "./contracts.js";
import { defaultChiptunePack, defaultDirector } from "./default-pack.js";
import { SynthRenderer } from "./renderer.js";
import { AudioEngine } from "./engine.js";
import { AmbientBed } from "./ambient.js";
import { soundForMobAttack, errorSound } from "./cue-sound.js";

interface AudioDeps { render: Renderer["render"]; bed: AmbientBed; engine: AudioEngine }

export class AudioRuntime {
  #enabled = false;
  readonly #deps: AudioDeps;
  readonly #director: AudioDirector;
  readonly #packs: SoundPack[];
  #active: SoundPack;

  private constructor(
    deps: AudioDeps,
    director: AudioDirector,
    packs: SoundPack[],
    active: SoundPack,
  ) {
    this.#deps = deps;
    this.#director = director;
    this.#packs = packs;
    this.#active = active;
  }

  static forCampaign(audio: CampaignAudio | undefined, deps?: Partial<AudioDeps>): AudioRuntime {
    const engine = deps?.engine ?? new AudioEngine();
    const bed = deps?.bed ?? new AmbientBed();
    const defaultRenderer = new SynthRenderer(engine);
    const renderer = deps?.render ?? ((spec) => defaultRenderer.render(spec));
    const director = audio ? audio.createDirector() : defaultDirector();
    const packs = audio?.soundpacks?.length ? audio.soundpacks : [defaultChiptunePack];
    return new AudioRuntime({ render: renderer, bed, engine }, director, packs, packs[0]!);
  }

  get enabled(): boolean { return this.#enabled; }
  setEnabled(on: boolean): void {
    if (on) {
      const ok = this.#deps.engine.resume();
      const ctx = this.#deps.engine.context;
      if (ok && ctx !== null) {
        this.#enabled = true;
        if (!this.#deps.bed.running) this.#deps.bed.start(ctx);
      }
      // resume failed / no context yet → stay disabled, no bed; caller may retry on a later gesture
    } else {
      this.#enabled = false;
      this.#deps.bed.stop();
      this.#deps.engine.suspend();
    }
  }

  /**
   * Fully release audio resources: stop the ambient bed and close the engine's
   * AudioContext (releasing the browser's AudioContext slot). Idempotent — safe
   * to call when audio was never enabled, and safe to call more than once.
   */
  dispose(): void {
    this.#enabled = false;
    this.#deps.bed.stop();
    this.#deps.engine.close();
  }

  get soundpacks(): { id: string; label: string }[] { return this.#packs.map((p) => ({ id: p.id, label: p.label })); }
  setSoundpack(id: string): void { const p = this.#packs.find((x) => x.id === id); if (p) this.#active = p; }

  playCue(cue: PresentationCue, view: ViewModel): void {
    if (!this.#enabled) return;
    for (const ac of this.#director.react(cue, view)) {
      const spec = this.#active.voice(ac);
      if (spec) this.#deps.render(spec);
    }
  }
  playMobAttack(atk: MobAttack): void {
    if (!this.#enabled) return;
    this.#deps.render({ kind: "synth", voice: soundForMobAttack(atk) });
  }
  noteError(): void { if (this.#enabled) this.#deps.render({ kind: "synth", voice: errorSound() }); }

  update(campaign: ICampaign): void {
    if (!this.#enabled) return;
    const directive = this.#active.ambient(this.#director.tension(campaign));
    this.#deps.bed.setTension(directive.bedTension);
  }
}
