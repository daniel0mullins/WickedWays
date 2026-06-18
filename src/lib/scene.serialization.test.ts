import { describe, it, expect, vi } from "vitest";
import { Scene } from "./scene";
import { SERIALIZE } from "./serialization/symbols";
import { hydrateScene } from "./scene";
import { CampaignRegistry } from "./serialization/registry";
import { HydrateContext } from "./serialization/context";
import { ProceduralViolation } from "./util";

describe("Scene serialization", () => {
  it("round-trips phase + persisted state and reattaches behavior from the registry", () => {
    const script = vi.fn((_room, state: { fired: boolean }) => { state.fired = true; });
    const reg = new CampaignRegistry();
    reg.registerScene("trap", { preconditions: [], script: script as never });
    const ctx = new HydrateContext(reg, () => 0.5);

    const scene = new Scene<{ fired: boolean }>({
      phase: "enter", preconditions: [], script, initialState: { fired: true }, behaviorKey: "trap",
    });

    const snap = scene[SERIALIZE]();
    expect(snap).toMatchObject({ behaviorKey: "trap", phase: "enter", state: { fired: true } });

    const restored = hydrateScene(snap, ctx);
    expect(restored.id).toBe(scene.id);
    const room = {} as never;
    restored.playScene("enter", room); // precondition empty → script runs, mutates restored state
    expect(script).toHaveBeenCalled();
  });

  it("throws on serialize when behaviorKey is missing", () => {
    const scene = new Scene({ preconditions: [], script: () => {} });
    expect(() => scene[SERIALIZE]()).toThrow(ProceduralViolation);
    expect(() => scene[SERIALIZE]()).toThrow(/behaviorKey/);
  });
});
