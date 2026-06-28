// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { crtSurface } from "./surface.js";

const makeSession = () => ({
  view: () => ({
    status: { locationName: "Test Room" },
    room: { id: "r1", name: "Test Room", description: null, isLit: true },
    exits: [],
    lockedDoors: [],
    occupants: [],
    loot: [],
    inventory: { items: [], keys: [], equippedNames: [] },
    scope: [],
    finished: false,
    outcome: "",
  }),
  finished: false,
}) as never;

const makeAudio = () => ({
  setEnabled: () => {},
  enabled: false,
  soundpacks: [],
  playCue: () => {},
  playMobAttack: () => {},
  noteError: () => {},
  update: () => {},
  setSoundpack: () => {},
  dispose: vi.fn(),
}) as never;

describe("crtSurface", () => {
  it("identifies as crt-terminal with a default theme", () => {
    expect(crtSurface.id).toBe("crt-terminal");
    expect(crtSurface.defaultTheme.id).toBeTruthy();
  });

  it("mount returns a handle whose unmount clears the container", () => {
    const app = document.createElement("div");
    const audio = makeAudio();
    const handle = crtSurface.mount({ app, session: makeSession(), manifest: { title: "T", intro: "", buttonText: "Go" } as never, themes: [crtSurface.defaultTheme], audio, onExit: vi.fn() });
    expect(typeof handle.unmount).toBe("function");
    handle.unmount();
    expect(app.childElementCount).toBe(0);
  });

  it("unmount disposes the AudioRuntime to stop audio and release the AudioContext", () => {
    const app = document.createElement("div");
    const audio = makeAudio();
    const handle = crtSurface.mount({ app, session: makeSession(), manifest: { title: "T", intro: "", buttonText: "Go" } as never, themes: [crtSurface.defaultTheme], audio, onExit: vi.fn() });
    handle.unmount();
    expect((audio as { dispose: ReturnType<typeof vi.fn> }).dispose).toHaveBeenCalledOnce();
  });

  it("unmount removes the overlay keydown listener if an overlay is open", async () => {
    const app = document.createElement("div");
    const handle = crtSurface.mount({ app, session: makeSession(), manifest: { title: "T", intro: "", buttonText: "Go" } as never, themes: [crtSurface.defaultTheme], audio: makeAudio(), onExit: vi.fn() });

    // Open the map overlay by submitting the "map" command via the form.
    const input = app.querySelector<HTMLInputElement>("#cmd")!;
    const form = app.querySelector<HTMLFormElement>("#prompt-form")!;
    input.value = "map";
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    // Let the async onSubmit handler proceed (openMap() fires before the first await).
    await Promise.resolve();

    // Spy on window.removeEventListener before unmount to detect cleanup.
    const spy = vi.spyOn(window, "removeEventListener");
    handle.unmount();

    expect(spy).toHaveBeenCalledWith("keydown", expect.any(Function), true);
    spy.mockRestore();
    expect(app.childElementCount).toBe(0);
  });
});
