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

  it("does not mark audio enabled if context resume fails", () => {
    const engine = new AudioEngine(() => {
      throw new Error("gated");
    });
    const ambient = new AmbientBed();
    const playSpy = vi.spyOn(engine, "play");
    const startSpy = vi.spyOn(ambient, "start");
    const mgr = new AudioManager({ engine, ambient });

    mgr.setEnabled(true);
    expect(mgr.enabled).toBe(false);

    mgr.playCue({ kind: "action", action: "attack", actor: { id: "p", name: "P" } });
    expect(playSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
  });
});
