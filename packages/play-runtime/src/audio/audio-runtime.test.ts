import { describe, it, expect, vi } from "vitest";
import { AudioRuntime } from "./audio-runtime.js";
import { defaultChiptunePack } from "./default-pack.js";

function deps() {
  return {
    render: vi.fn(),
    bed: { setTension: vi.fn(), start: vi.fn(), stop: vi.fn(), get running() { return true; } },
    engine: { resume: () => true, suspend: () => {}, close: vi.fn(), get context() { return {} as never; }, play: vi.fn() },
  };
}

describe("AudioRuntime", () => {
  it("routes a cue through director → active pack → renderer when enabled", () => {
    const d = deps();
    const rt = AudioRuntime.forCampaign(undefined, d as never);
    rt.setEnabled(true);
    rt.playCue({ kind: "action", action: "move", actor: { id: "pc", name: "" } }, {} as never);
    expect(d.render).toHaveBeenCalledTimes(1);
    expect((d.render.mock.calls[0]![0] as { kind: string }).kind).toBe("synth");
  });
  it("stays silent when disabled", () => {
    const d = deps();
    const rt = AudioRuntime.forCampaign(undefined, d as never);
    rt.playCue({ kind: "action", action: "move", actor: { id: "pc", name: "" } }, {} as never);
    expect(d.render).not.toHaveBeenCalled();
  });
  it("stays disabled when engine.resume() returns false", () => {
    const d = deps();
    (d.engine as unknown as { resume: () => boolean }).resume = () => false;
    const rt = AudioRuntime.forCampaign(undefined, d as never);
    rt.setEnabled(true);
    expect(rt.enabled).toBe(false);
    expect(d.bed.start).not.toHaveBeenCalled();
  });
  it("stays disabled when engine.context is null", () => {
    const d = {
      ...deps(),
      engine: { resume: () => true, suspend: () => {}, close: vi.fn(), get context() { return null; }, play: vi.fn() },
    };
    const rt = AudioRuntime.forCampaign(undefined, d as never);
    rt.setEnabled(true);
    expect(rt.enabled).toBe(false);
    expect(d.bed.start).not.toHaveBeenCalled();
  });
  it("exposes the campaign soundpacks for the switcher", () => {
    const d = deps();
    const rt = AudioRuntime.forCampaign({ createDirector: () => ({ react: () => [], tension: () => 0 }), soundpacks: [defaultChiptunePack] }, d as never);
    expect(rt.soundpacks).toEqual([{ id: "chiptune", label: "Chiptune" }]);
  });

  describe("reset()", () => {
    it("recreates the director — createDirector called once at forCampaign, again after reset()", () => {
      const d = deps();
      const createDirector = vi.fn(() => ({ react: () => [], tension: () => 0 }));
      const rt = AudioRuntime.forCampaign({ createDirector, soundpacks: [defaultChiptunePack] }, d as never);
      expect(createDirector).toHaveBeenCalledTimes(1);
      rt.reset();
      expect(createDirector).toHaveBeenCalledTimes(2);
    });
  });

  describe("dispose()", () => {
    it("stops the bed and closes the engine", () => {
      const d = deps();
      const bedStop = vi.spyOn(d.bed, "stop");
      const engineClose = d.engine.close;
      const rt = AudioRuntime.forCampaign(undefined, d as never);
      rt.setEnabled(true);
      rt.dispose();
      expect(bedStop).toHaveBeenCalled();
      expect(engineClose).toHaveBeenCalled();
    });
    it("sets enabled to false", () => {
      const d = deps();
      const rt = AudioRuntime.forCampaign(undefined, d as never);
      rt.setEnabled(true);
      expect(rt.enabled).toBe(true);
      rt.dispose();
      expect(rt.enabled).toBe(false);
    });
    it("is safe to call when audio was never enabled (engine never opened)", () => {
      const d = deps();
      const engineClose = d.engine.close;
      const rt = AudioRuntime.forCampaign(undefined, d as never);
      // Never called setEnabled — should not throw
      expect(() => rt.dispose()).not.toThrow();
      expect(engineClose).toHaveBeenCalled();
    });
    it("is idempotent — safe to call multiple times", () => {
      const d = deps();
      const rt = AudioRuntime.forCampaign(undefined, d as never);
      rt.dispose();
      expect(() => rt.dispose()).not.toThrow();
    });
  });
});
