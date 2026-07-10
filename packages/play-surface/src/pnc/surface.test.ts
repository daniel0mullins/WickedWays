// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { pncSurface } from "./surface.js";
import { defaultPncTheme } from "./theme.js";

const makeSession = () => ({
  view: () => ({
    status: { locationName: "Test Room", turn: 0, maxTurns: 10, sanity: 5, health: 5 },
    room: { id: "r1", name: "Test Room", description: "A room.", isLit: true },
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
  takeStartupCues: vi.fn(() => []),
  restart: vi.fn(() => {}),
  save: vi.fn((): Promise<void> => Promise.resolve()),
  restore: vi.fn((): Promise<{ ok: boolean }> => Promise.resolve({ ok: false })),
  undo: vi.fn(() => false),
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

describe("pncSurface", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("identifies as point-and-click with a default theme", () => {
    expect(pncSurface.id).toBe("point-and-click");
    expect(pncSurface.label).toBe("Point & Click");
    expect(pncSurface.description).toBe("Point-and-click scene");
    expect(pncSurface.defaultTheme.id).toBe(defaultPncTheme.id);
  });

  it("mount returns a handle whose unmount disposes audio and clears the container", () => {
    const app = document.createElement("div");
    document.body.appendChild(app);
    const audio = makeAudio();
    const handle = pncSurface.mount({
      app,
      session: makeSession(),
      manifest: { title: "T", intro: "", buttonText: "Go" } as never,
      themes: [pncSurface.defaultTheme],
      audio,
      onExit: vi.fn(),
    });
    expect(typeof handle.unmount).toBe("function");
    handle.unmount();
    expect(app.childElementCount).toBe(0);
    expect((audio as { dispose: ReturnType<typeof vi.fn> }).dispose).toHaveBeenCalledOnce();
  });
});
