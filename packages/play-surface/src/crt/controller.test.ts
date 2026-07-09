// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mountTerminal } from "./controller.js";
import { defaultCrtTheme } from "./theme.js";
import type { CrtGame } from "./components/crt-game.js";
import type { CrtWelcome } from "./components/crt-welcome.js";
import type { CrtPrompt } from "./components/crt-prompt.js";

/** Walk shadow roots recursively — happy-dom `querySelector` does not pierce them. */
function deepQuery(root: ParentNode, selector: string): Element | null {
  const direct = root.querySelector(selector);
  if (direct) return direct;
  const candidates: Element[] = Array.from(root.querySelectorAll("*"));
  // Include the root itself so its own shadow root is searched too.
  if (root instanceof Element) candidates.unshift(root);
  for (const el of candidates) {
    const sr = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
    if (sr) {
      const found = deepQuery(sr, selector);
      if (found) return found;
    }
  }
  return null;
}

/** Pump enough microtasks so Lit's firstUpdated has run for the tree + nested elements. */
async function flushRender(...els: Array<{ updateComplete?: Promise<unknown> } | null>): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
    for (const el of els) if (el?.updateComplete) await el.updateComplete;
  }
}

const makeView = (overrides: Record<string, unknown> = {}) => ({
  status: { locationName: "Cellar" },
  room: { id: "r1", name: "Cellar", description: "A damp stone cellar.", isLit: true },
  exits: [],
  lockedDoors: [],
  occupants: [],
  loot: [],
  inventory: { items: [], keys: [], equippedNames: [], slots: 6 },
  scope: [],
  finished: false,
  outcome: "",
  ...overrides,
});

const makeSession = () => {
  let finished = false;
  const session = {
    view: () => makeView({ finished }),
    execute: vi.fn(() => ({ cues: [], mobAttacks: [] })),
    read: vi.fn(() => []),
    examine: vi.fn((): unknown[] => []),
    takeStartupCues: vi.fn(() => []),
    restart: vi.fn(() => {}),
    save: vi.fn((): Promise<void> => Promise.resolve()),
    restore: vi.fn((): Promise<{ ok: boolean }> => Promise.resolve({ ok: false })),
    undo: vi.fn(() => false),
    /** Test hook: flip the session into a finished state. */
    finish() {
      finished = true;
    },
  };
  return session;
};

const makeAudio = () => {
  let enabled = false;
  return {
    setEnabled: vi.fn((v: boolean) => {
      enabled = v;
    }),
    get enabled() {
      return enabled;
    },
    soundpacks: [] as { id: string; label: string }[],
    playCue: vi.fn(),
    playMobAttack: vi.fn(),
    noteError: vi.fn(),
    update: vi.fn(),
    reset: vi.fn(),
    setSoundpack: vi.fn(),
    dispose: vi.fn(),
  };
};

const mount = () => {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const session = makeSession();
  const audio = makeAudio();
  const onExit = vi.fn();
  const handle = mountTerminal(root, session as never, {
    title: "Test",
    intro: "An intro.",
    buttonText: "Enter",
    audio: audio as never,
    themes: [defaultCrtTheme],
    onExit,
  });
  const housing = root.querySelector("crt-housing")!;
  const welcome = housing.querySelector<CrtWelcome>("crt-welcome")!;
  const game = housing.querySelector<CrtGame>("crt-game")!;
  return { root, session, audio, onExit, handle, housing, welcome, game };
};

describe("mountTerminal (controller)", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("builds the housing + slotted components with the game hidden", () => {
    const { root, welcome, game } = mount();
    expect(root.querySelector("crt-housing")).toBeTruthy();
    expect(welcome).toBeTruthy();
    expect(root.dataset.crtHousing).toBe("");
    expect(game.hidden).toBe(true);
    expect(welcome.hidden).toBe(false);
  });

  it("starts the game on `enter`, hiding welcome and printing the room", async () => {
    const { welcome, game } = mount();
    await flushRender(game, game.transcript);
    welcome.dispatchEvent(new CustomEvent("enter", { bubbles: true, composed: true }));
    await flushRender(game, game.transcript);

    expect(welcome.hidden).toBe(true);
    expect(game.hidden).toBe(false);
    const transcript = deepQuery(game, "#transcript")!;
    expect(transcript.textContent).toContain("Cellar");
  });

  it("runs a turn from a `command` event without throwing", async () => {
    const { game } = mount();
    await flushRender(game, game.transcript);
    game.dispatchEvent(new CustomEvent("enter", { bubbles: true, composed: true }));
    await flushRender(game, game.transcript);

    game.dispatchEvent(new CustomEvent("command", { detail: { line: "look" }, bubbles: true }));
    await flushRender(game, game.transcript);
    const transcript = deepQuery(game, "#transcript")!;
    expect(transcript.textContent).toContain("> look");
  });

  it("routes `examine <npc>` to session.examine and prints the NPC description cue", async () => {
    const { session, game } = mount();
    await flushRender(game, game.transcript);
    game.dispatchEvent(new CustomEvent("enter", { bubbles: true, composed: true }));
    await flushRender(game, game.transcript);

    const keeper = { id: "npc-keeper", name: "The Keeper", aliases: ["keeper"], kind: "occupant" };
    session.view = () => makeView({ scope: [keeper], occupants: [keeper] });
    session.examine.mockReturnValueOnce([
      { kind: "mechanic", cue: { text: "A stooped man in a moth-eaten coat." } },
    ]);

    game.dispatchEvent(new CustomEvent("command", { detail: { line: "examine keeper" }, bubbles: true }));
    await flushRender(game, game.transcript);

    // Occupant target takes the engine NPC-examine path, not the item `read` path.
    expect(session.examine).toHaveBeenCalledWith("npc-keeper");
    expect(session.read).not.toHaveBeenCalled();
    const transcript = deepQuery(game, "#transcript")!;
    expect(transcript.textContent).toContain("A stooped man in a moth-eaten coat.");
  });

  it("prints THE END and disables the prompt when the session finishes", async () => {
    const { session, game } = mount();
    await flushRender(game, game.transcript);
    game.dispatchEvent(new CustomEvent("enter", { bubbles: true, composed: true }));
    await flushRender(game, game.transcript);

    session.execute.mockImplementationOnce(() => {
      session.finish();
      return { cues: [], mobAttacks: [] };
    });
    game.dispatchEvent(new CustomEvent("command", { detail: { line: "wait" }, bubbles: true }));
    await flushRender(game, game.transcript);

    const transcript = deepQuery(game, "#transcript")!;
    expect(transcript.textContent).toContain("— THE END —");
    const prompt = deepQuery(game, "crt-prompt") as unknown as CrtPrompt;
    expect(prompt.disabled).toBe(true);
  });

  it("confirms `restart` on the second command and reprints", async () => {
    const { session, game } = mount();
    await flushRender(game, game.transcript);
    game.dispatchEvent(new CustomEvent("enter", { bubbles: true, composed: true }));
    await flushRender(game, game.transcript);

    game.dispatchEvent(new CustomEvent("command", { detail: { line: "restart" }, bubbles: true }));
    await flushRender(game, game.transcript);
    expect(session.restart).not.toHaveBeenCalled();
    expect(deepQuery(game, "#transcript")!.textContent).toContain("Restart from the beginning");

    game.dispatchEvent(new CustomEvent("command", { detail: { line: "restart" }, bubbles: true }));
    await flushRender(game, game.transcript);
    expect(session.restart).toHaveBeenCalledOnce();
  });

  it("opens a map overlay on the `map` command", async () => {
    const { game } = mount();
    await flushRender(game, game.transcript);
    game.dispatchEvent(new CustomEvent("enter", { bubbles: true, composed: true }));
    await flushRender(game, game.transcript);

    game.dispatchEvent(new CustomEvent("command", { detail: { line: "map" }, bubbles: true }));
    await flushRender(game, game.transcript);
    expect(deepQuery(game, ".overlay")).toBeTruthy();
  });

  it("unmount disposes audio and empties the root", () => {
    const { root, audio, handle } = mount();
    handle.unmount();
    expect(audio.dispose).toHaveBeenCalledOnce();
    expect(root.childElementCount).toBe(0);
  });

  it("mount with initialThemeId applies that theme and sets bezel.activeTheme", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const session = makeSession();
    const audio = makeAudio();
    const secondTheme = {
      id: "dark",
      label: "Dark",
      palette: { bg: "#000", fg: "#fff", accent: "#ccc", warn: "#ff0", critical: "#f00" },
      fonts: { body: "monospace", display: "monospace" },
      effects: { scanlineIntensity: 0, glow: 0, flicker: 0 },
    };
    mountTerminal(root, session as never, {
      title: "Test",
      intro: "Intro",
      audio: audio as never,
      themes: [defaultCrtTheme, secondTheme],
      onExit: vi.fn(),
      initialThemeId: "dark",
    });

    const housing = root.querySelector("crt-housing")!;
    const bezel = housing.querySelector("crt-bezel")! as Element & {
      updateComplete: Promise<unknown>;
      activeTheme: string;
    };
    await flushRender(bezel);

    // bezel.activeTheme must reflect the initialThemeId, not themes[0].
    expect(bezel.activeTheme).toBe("dark");
    // The CSS custom property must come from the second theme's palette.
    expect(root.style.getPropertyValue("--crt-bg")).toBe("#000");
  });

  it("mount falls back to themes[0] when initialThemeId is absent or unknown", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const session = makeSession();
    const audio = makeAudio();
    const secondTheme = {
      id: "dark",
      label: "Dark",
      palette: { bg: "#000", fg: "#fff", accent: "#ccc", warn: "#ff0", critical: "#f00" },
      fonts: { body: "monospace", display: "monospace" },
      effects: { scanlineIntensity: 0, glow: 0, flicker: 0 },
    };

    // No initialThemeId — should use themes[0].
    mountTerminal(root, session as never, {
      title: "Test",
      intro: "Intro",
      audio: audio as never,
      themes: [defaultCrtTheme, secondTheme],
      onExit: vi.fn(),
    });
    const housing = root.querySelector("crt-housing")!;
    const bezel = housing.querySelector("crt-bezel")! as Element & { activeTheme: string };
    expect(bezel.activeTheme).toBe(defaultCrtTheme.id);
    expect(root.style.getPropertyValue("--crt-bg")).toBe(defaultCrtTheme.palette.bg);
  });

  it("theme-change event calls onThemeChange spy with the chosen id", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const session = makeSession();
    const audio = makeAudio();
    const onThemeChange = vi.fn();
    const secondTheme = {
      id: "dark",
      label: "Dark",
      palette: { bg: "#000", fg: "#fff", accent: "#ccc", warn: "#ff0", critical: "#f00" },
      fonts: { body: "monospace", display: "monospace" },
      effects: { scanlineIntensity: 0, glow: 0, flicker: 0 },
    };
    mountTerminal(root, session as never, {
      title: "Test",
      intro: "Intro",
      audio: audio as never,
      themes: [defaultCrtTheme, secondTheme],
      onExit: vi.fn(),
      onThemeChange,
    });

    const housing = root.querySelector("crt-housing")!;
    const bezel = housing.querySelector("crt-bezel")! as Element & { updateComplete: Promise<unknown> };
    await flushRender(bezel);

    bezel.dispatchEvent(
      new CustomEvent("theme-change", { detail: { id: "dark" }, bubbles: true, composed: true }),
    );
    await flushRender(bezel);

    expect(onThemeChange).toHaveBeenCalledOnce();
    expect(onThemeChange).toHaveBeenCalledWith("dark");
  });

  it("REGRESSION: bezel theme/soundpack selects do not snap back after toggle-audio re-render", async () => {
    // Mount with ≥2 themes and ≥2 soundpacks so both selects render in the bezel.
    const root = document.createElement("div");
    document.body.appendChild(root);
    const session = makeSession();
    const audio = makeAudio();
    audio.soundpacks = [
      { id: "sp-default", label: "Default" },
      { id: "haunted", label: "Haunted" },
    ];
    const secondTheme = {
      id: "dark",
      label: "Dark",
      palette: { bg: "#000", fg: "#fff", accent: "#ccc", warn: "#ff0", critical: "#f00" },
      fonts: { body: "monospace", display: "monospace" },
      effects: { scanlineIntensity: 0, glow: 0, flicker: 0 },
    };
    mountTerminal(root, session as never, {
      title: "Test",
      intro: "Intro",
      audio: audio as never,
      themes: [defaultCrtTheme, secondTheme],
      onExit: vi.fn(),
    });

    const housing = root.querySelector("crt-housing")!;
    const bezel = housing.querySelector("crt-bezel")! as Element & { updateComplete: Promise<unknown> };
    await flushRender(bezel);

    // Dispatch theme-change and soundpack-change with non-default ids.
    bezel.dispatchEvent(
      new CustomEvent("theme-change", { detail: { id: "dark" }, bubbles: true, composed: true }),
    );
    bezel.dispatchEvent(
      new CustomEvent("soundpack-change", { detail: { id: "haunted" }, bubbles: true, composed: true }),
    );
    await flushRender(bezel);

    // Dispatch toggle-audio — the controller sets bezel.audioEnabled, triggering a Lit re-render.
    // Without Fix 1, this re-render reasserts ?selected against the stale activeTheme/activeSoundpack,
    // snapping the displayed select values back to the originals.
    bezel.dispatchEvent(new CustomEvent("toggle-audio", { bubbles: true, composed: true }));
    await flushRender(bezel);

    // After the re-render, the select values must still reflect the chosen ids.
    const themeSelect = deepQuery(bezel, 'select[aria-label="Theme"]') as HTMLSelectElement | null;
    const soundpackSelect = deepQuery(bezel, 'select[aria-label="Sound pack"]') as HTMLSelectElement | null;
    expect(themeSelect).not.toBeNull();
    expect(soundpackSelect).not.toBeNull();
    expect(themeSelect!.value).toBe("dark");
    expect(soundpackSelect!.value).toBe("haunted");
  });
});
