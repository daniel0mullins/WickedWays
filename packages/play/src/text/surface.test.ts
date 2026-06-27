// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { crtSurface } from "./surface.js";

describe("crtSurface", () => {
  it("identifies as crt-terminal with a default theme", () => {
    expect(crtSurface.id).toBe("crt-terminal");
    expect(crtSurface.defaultTheme.id).toBeTruthy();
  });
  it("mount returns a handle whose unmount clears the container", () => {
    const app = document.createElement("div");
    const session = { view: () => ({ status: {}, room: {}, exits: [], lockedDoors: [], occupants: [], loot: [], inventory: { items: [], keys: [], equippedNames: [] }, scope: [], finished: false, outcome: "" }), finished: false } as never;
    const audio = { setEnabled: () => {}, enabled: false, soundpacks: [], playCue: () => {}, playMobAttack: () => {}, noteError: () => {}, update: () => {}, setSoundpack: () => {} } as never;
    const handle = crtSurface.mount({ app, session, manifest: { title: "T", intro: "", buttonText: "Go" } as never, themes: [crtSurface.defaultTheme], audio, onExit: vi.fn() });
    expect(typeof handle.unmount).toBe("function");
    handle.unmount();
    expect(app.childElementCount).toBe(0);
  });
});
