// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mountPointAndClick } from "./controller.js";
import { defaultPncTheme } from "./theme.js";
import type { PncScene } from "./components/pnc-scene.js";
import type { PncInventory } from "./components/pnc-inventory.js";
import type { PncTopbar } from "./components/pnc-topbar.js";
import type { PncLog } from "./components/pnc-log.js";

/** Walk shadow roots recursively — happy-dom `querySelector` does not pierce them. */
function deepQuery(root: ParentNode, selector: string): Element | null {
  const direct = root.querySelector(selector);
  if (direct) return direct;
  const candidates: Element[] = Array.from(root.querySelectorAll("*"));
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
  status: { locationName: "Cellar", turn: 0, maxTurns: 10, sanity: 5, health: 5 },
  room: { id: "r1", name: "Cellar", description: "A damp stone cellar.", isLit: true },
  exits: [],
  lockedDoors: [],
  occupants: [],
  loot: [],
  inventory: { items: [], keys: [], equippedNames: [] },
  scope: [],
  finished: false,
  outcome: "",
  ...overrides,
});

const makeSession = (viewFn?: () => Record<string, unknown>) => {
  let finished = false;
  const session = {
    view: () => ({ ...(viewFn ? viewFn() : makeView()), finished }),
    execute: vi.fn(() => ({ cues: [], mobAttacks: [] })),
    read: vi.fn(() => []),
    restart: vi.fn(() => {}),
    save: vi.fn((): Promise<void> => Promise.resolve()),
    restore: vi.fn((): Promise<{ ok: boolean }> => Promise.resolve({ ok: false })),
    undo: vi.fn(() => false),
    get campaign() {
      return {};
    },
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

const mount = (opts: { view?: () => Record<string, unknown>; themes?: { id: string; label: string }[] } = {}) => {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const session = makeSession(opts.view);
  const audio = makeAudio();
  const onExit = vi.fn();
  const onThemeChange = vi.fn();
  const handle = mountPointAndClick(root, session as never, {
    title: "Test",
    intro: "An intro.",
    buttonText: "Enter",
    audio: audio as never,
    themes: opts.themes ?? [defaultPncTheme],
    onExit,
    onThemeChange,
  });
  const welcome = deepQuery(root, "pnc-welcome") as HTMLElement;
  const scene = deepQuery(root, "pnc-scene") as unknown as PncScene & HTMLElement;
  const topbar = deepQuery(root, "pnc-topbar") as unknown as PncTopbar & HTMLElement;
  const inventory = deepQuery(root, "pnc-inventory") as unknown as PncInventory & HTMLElement;
  const log = deepQuery(root, "pnc-log") as unknown as PncLog & HTMLElement;
  return { root, session, audio, onExit, onThemeChange, handle, welcome, scene, topbar, inventory, log };
};

const enter = async (welcome: HTMLElement, ...els: Array<{ updateComplete?: Promise<unknown> } | null>) => {
  welcome.dispatchEvent(new CustomEvent("enter", { bubbles: true, composed: true }));
  await flushRender(...els);
};

describe("mountPointAndClick (controller)", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("builds the topbar / scene / sidebar layout with the welcome shown", () => {
    const { welcome, scene, topbar, inventory, log } = mount();
    expect(welcome).toBeTruthy();
    expect(scene).toBeTruthy();
    expect(topbar).toBeTruthy();
    expect(inventory).toBeTruthy();
    expect(log).toBeTruthy();
    expect(welcome.hidden).toBe(false);
  });

  it("reveals the scene and prints the opening room on `enter`", async () => {
    const { welcome, scene, log } = mount();
    await flushRender(scene, log);
    await enter(welcome, scene, log);

    expect(welcome.hidden).toBe(true);
    const logEl = deepQuery(log, "#pnc-log")!;
    expect(logEl.textContent).toContain("Cellar");
    expect(logEl.textContent).toContain("damp stone cellar");
  });

  it("opens an action menu for a multi-verb hotspot and runs the chosen attack", async () => {
    const view = () =>
      makeView({
        occupants: [{ id: "m1", name: "Revenant", aliases: ["revenant"], kind: "occupant", health: 3, defeated: false }],
        scope: [{ id: "m1", name: "Revenant", aliases: ["revenant"], kind: "occupant", health: 3, defeated: false }],
      });
    const { welcome, scene, session, log } = mount({ view });
    await flushRender(scene, log);
    await enter(welcome, scene, log);

    scene.dispatchEvent(new CustomEvent("hotspot", { detail: { key: "m1" }, bubbles: true, composed: true }));
    await flushRender(scene);

    const menu = deepQuery(document.body, "pnc-action-menu")!;
    expect(menu).toBeTruthy();
    const buttons = Array.from((menu.shadowRoot ?? menu).querySelectorAll("button"));
    expect(buttons.length).toBe(2); // Examine + Attack

    // Choose the Attack action (index 1).
    menu.dispatchEvent(new CustomEvent("choose", { detail: { index: 1 }, bubbles: true, composed: true }));
    await flushRender(scene, log);

    expect(session.execute).toHaveBeenCalledWith({ kind: "attack", targetId: "m1" });
    expect(deepQuery(log, "#pnc-log")!.textContent).toContain("Revenant");
  });

  it("real .click() on a scene hotspot does not self-dismiss the action menu (opening-click bug)", async () => {
    // Multi-verb hotspot: occupant → Examine + Attack
    const view = () =>
      makeView({
        occupants: [{ id: "m1", name: "Revenant", aliases: ["revenant"], kind: "occupant", health: 3, defeated: false }],
        scope: [{ id: "m1", name: "Revenant", aliases: ["revenant"], kind: "occupant", health: 3, defeated: false }],
      });
    const { welcome, scene, session, log } = mount({ view });
    await flushRender(scene, log);
    await enter(welcome, scene, log);
    // Ensure pnc-scene has rendered the hotspot div into its shadow root.
    await flushRender(scene);

    // Find the actual hotspot div inside pnc-scene's shadow root.
    const hotspotDiv = deepQuery(document.body, '[data-key="m1"]') as HTMLElement | null;
    expect(hotspotDiv, "hotspot div must be rendered before clicking").not.toBeNull();

    // Fire a REAL click (not a synthetic CustomEvent) — it bubbles to window and
    // triggers the opening-click self-dismiss bug in the unfixed code.
    hotspotDiv!.click();

    // Flush microtasks: with the fix the window listener is armed NOW (after the click).
    await Promise.resolve();

    // The menu must still be open — it must NOT have self-dismissed on the opening click.
    const menu = deepQuery(document.body, "pnc-action-menu");
    expect(menu, "pnc-action-menu must still be open after the opening click").not.toBeNull();

    // Verify action routing still works: choose Attack (index 1).
    menu!.dispatchEvent(new CustomEvent("choose", { detail: { index: 1 }, bubbles: true, composed: true }));
    await flushRender(scene, log);
    expect(session.execute).toHaveBeenCalledWith({ kind: "attack", targetId: "m1" });
  });

  it("moves immediately when an exit hotspot is clicked (single move-intent)", async () => {
    const view = () => makeView({ exits: [{ dir: "north", toName: "Hall" }] });
    const { welcome, scene, session, log } = mount({ view });
    await flushRender(scene, log);
    await enter(welcome, scene, log);

    scene.dispatchEvent(new CustomEvent("hotspot", { detail: { key: "north" }, bubbles: true, composed: true }));
    await flushRender(scene, log);

    expect(session.execute).toHaveBeenCalledWith({ kind: "move", dir: "north" });
    // No action menu — the move ran straight away.
    expect(deepQuery(document.body, "pnc-action-menu")).toBeNull();
  });

  it("opens an action menu for an inventory item", async () => {
    const view = () =>
      makeView({
        inventory: { items: [{ id: "i1", name: "Torch", aliases: ["torch"], kind: "item" }], keys: [], equippedNames: [] },
        scope: [{ id: "i1", name: "Torch", aliases: ["torch"], kind: "item" }],
      });
    const { welcome, scene, inventory, log } = mount({ view });
    await flushRender(scene, inventory, log);
    await enter(welcome, scene, inventory, log);

    inventory.dispatchEvent(new CustomEvent("inventory-activate", { detail: { id: "i1" }, bubbles: true, composed: true }));
    await flushRender(inventory);

    const menu = deepQuery(document.body, "pnc-action-menu")!;
    expect(menu).toBeTruthy();
    const buttons = Array.from((menu.shadowRoot ?? menu).querySelectorAll("button"));
    expect(buttons.length).toBe(4); // Examine + Equip + Use + Drop
  });

  it("invokes session.undo() when the system menu's Undo is chosen", async () => {
    const { welcome, scene, topbar, session, log } = mount();
    await flushRender(scene, log);
    await enter(welcome, scene, log);

    topbar.dispatchEvent(new CustomEvent("open-menu", { bubbles: true, composed: true }));
    await flushRender(topbar);
    const menu = deepQuery(document.body, "pnc-menu")!;
    expect(menu).toBeTruthy();

    menu.dispatchEvent(new CustomEvent("command", { detail: { action: "undo" }, bubbles: true, composed: true }));
    await flushRender(log);
    expect(session.undo).toHaveBeenCalledOnce();
  });

  it("prints THE END and disables interaction when the session finishes", async () => {
    const view = () => makeView({ exits: [{ dir: "north", toName: "Hall" }] });
    const { welcome, scene, session, log } = mount({ view });
    await flushRender(scene, log);
    await enter(welcome, scene, log);

    session.execute.mockImplementationOnce(() => {
      session.finish();
      return { cues: [], mobAttacks: [] };
    });
    scene.dispatchEvent(new CustomEvent("hotspot", { detail: { key: "north" }, bubbles: true, composed: true }));
    await flushRender(scene, log);

    expect(deepQuery(log, "#pnc-log")!.textContent).toContain("— THE END —");

    // Interaction is locked: a further hotspot does nothing.
    session.execute.mockClear();
    scene.dispatchEvent(new CustomEvent("hotspot", { detail: { key: "north" }, bubbles: true, composed: true }));
    await flushRender(scene);
    expect(session.execute).not.toHaveBeenCalled();
  });

  it("applies a PnC theme and fires onThemeChange on `theme-change`", async () => {
    const second = { ...defaultPncTheme, id: "fog", label: "Fog", palette: { ...defaultPncTheme.palette, bg: "#001122" } };
    const { root, topbar, onThemeChange } = mount({ themes: [defaultPncTheme, second] });
    await flushRender(topbar);

    topbar.dispatchEvent(new CustomEvent("theme-change", { detail: { id: "fog" }, bubbles: true, composed: true }));
    await flushRender(topbar);

    expect(root.style.getPropertyValue("--pnc-bg")).toBe("#001122");
    expect(onThemeChange).toHaveBeenCalledWith("fog");
  });

  it("unmount disposes audio and empties the root", () => {
    const { root, audio, handle } = mount();
    handle.unmount();
    expect(audio.dispose).toHaveBeenCalledOnce();
    expect(root.childElementCount).toBe(0);
  });
});
