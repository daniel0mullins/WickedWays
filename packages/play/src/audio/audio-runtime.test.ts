import { describe, it, expect, vi } from "vitest";
import { AudioRuntime } from "./audio-runtime.js";
import { defaultChiptunePack } from "./default-pack.js";

function deps() {
  return {
    render: vi.fn(),
    bed: { setTension: vi.fn(), start: vi.fn(), stop: vi.fn(), get running() { return true; } },
    engine: { resume: () => true, suspend: () => {}, close: () => {}, get context() { return {} as never; }, play: vi.fn() },
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
      engine: { resume: () => true, suspend: () => {}, close: () => {}, get context() { return null; }, play: vi.fn() },
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
});
