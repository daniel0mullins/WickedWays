// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { crtSurface } from "./surface.js";

/** Depth-first search across open shadow roots for the first match. happy-dom querySelector does not pierce. */
function deepQuery(root: ParentNode | Document, selector: string): Element | null {
  const direct = root.querySelector(selector);
  if (direct) return direct;
  const hosts = root.querySelectorAll("*");
  for (const host of hosts) {
    const sr = host.shadowRoot;
    if (sr) {
      const found = deepQuery(sr, selector);
      if (found) return found;
    }
  }
  return null;
}

/** Pump enough microtasks for Lit's firstUpdated to propagate through nested elements. */
async function flushRender(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

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
  execute: vi.fn(() => ({ cues: [], mobAttacks: [] })),
  read: vi.fn(() => []),
  restart: vi.fn(() => {}),
  save: vi.fn((): Promise<void> => Promise.resolve()),
  restore: vi.fn((): Promise<{ ok: boolean }> => Promise.resolve({ ok: false })),
  undo: vi.fn(() => false),
  get campaign() { return {}; },
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
  reset: () => {},
  setSoundpack: () => {},
  dispose: vi.fn(),
}) as never;

describe("crtSurface", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("identifies as crt-terminal with a default theme", () => {
    expect(crtSurface.id).toBe("crt-terminal");
    expect(crtSurface.defaultTheme.id).toBeTruthy();
  });

  it("mount returns a handle whose unmount clears the container", () => {
    const app = document.createElement("div");
    document.body.appendChild(app);
    const audio = makeAudio();
    const handle = crtSurface.mount({
      app,
      session: makeSession(),
      manifest: { title: "T", intro: "", buttonText: "Go" } as never,
      themes: [crtSurface.defaultTheme],
      audio,
      onExit: vi.fn(),
    });
    expect(typeof handle.unmount).toBe("function");
    handle.unmount();
    expect(app.childElementCount).toBe(0);
  });

  it("unmount disposes the AudioRuntime to stop audio and release the AudioContext", () => {
    const app = document.createElement("div");
    document.body.appendChild(app);
    const audio = makeAudio();
    const handle = crtSurface.mount({
      app,
      session: makeSession(),
      manifest: { title: "T", intro: "", buttonText: "Go" } as never,
      themes: [crtSurface.defaultTheme],
      audio,
      onExit: vi.fn(),
    });
    handle.unmount();
    expect((audio as { dispose: ReturnType<typeof vi.fn> }).dispose).toHaveBeenCalledOnce();
  });

  it("unmount removes the overlay keydown listener if an overlay is open", async () => {
    const app = document.createElement("div");
    document.body.appendChild(app);
    const handle = crtSurface.mount({
      app,
      session: makeSession(),
      manifest: { title: "T", intro: "", buttonText: "Go" } as never,
      themes: [crtSurface.defaultTheme],
      audio: makeAudio(),
      onExit: vi.fn(),
    });

    // Flush Lit render so all nested components (crt-game → crt-prompt) have run firstUpdated.
    await flushRender();

    // Start the game by dispatching the enter event from the welcome element.
    const welcome = app.querySelector("crt-welcome")!;
    welcome.dispatchEvent(new CustomEvent("enter", { bubbles: true, composed: true }));
    await flushRender();

    // Open the map overlay by submitting the "map" command via the shadow-DOM prompt.
    const input = deepQuery(app, "#cmd") as HTMLInputElement;
    const form = deepQuery(app, "#prompt-form") as HTMLFormElement;
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
