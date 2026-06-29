// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "./pnc-menu.js";
import type { PncMenu } from "./pnc-menu.js";

describe("<pnc-menu>", () => {
  let el: PncMenu;

  beforeEach(async () => {
    el = document.createElement("pnc-menu");
    document.body.appendChild(el);
    await el.updateComplete;
  });

  afterEach(() => {
    el.remove();
  });

  // ── render ─────────────────────────────────────────────────────────────────

  it("renders all 6 action buttons", () => {
    const buttons = el.shadowRoot!.querySelectorAll("button[data-action]");
    expect(buttons).toHaveLength(6);
  });

  it("renders correct button labels including 'Back to menu'", () => {
    const buttons = el.shadowRoot!.querySelectorAll("button[data-action]");
    const labels = Array.from(buttons).map((b) => b.textContent?.trim());
    expect(labels).toContain("Save");
    expect(labels).toContain("Restore");
    expect(labels).toContain("Undo");
    expect(labels).toContain("Restart");
    expect(labels).toContain("Fullscreen");
    expect(labels).toContain("Back to menu");
  });

  it("renders a close/✕ button", () => {
    const closeBtn = el.shadowRoot!.querySelector(".close-btn");
    expect(closeBtn).not.toBeNull();
  });

  // ── command events ──────────────────────────────────────────────────────────

  it("clicking Save emits 'command' with action 'save' (bubbles + composed)", () => {
    let received: CustomEvent | null = null;
    const handler = (ev: Event) => {
      received = ev as CustomEvent;
    };
    document.addEventListener("command", handler);

    el.shadowRoot!.querySelector<HTMLButtonElement>('button[data-action="save"]')!.click();

    document.removeEventListener("command", handler);

    expect(received).not.toBeNull();
    expect((received as unknown as CustomEvent).detail.action).toBe("save");
    expect((received as unknown as CustomEvent).bubbles).toBe(true);
    expect((received as unknown as CustomEvent).composed).toBe(true);
  });

  it("clicking Restore emits 'command' with action 'restore'", () => {
    let received: CustomEvent | null = null;
    const handler = (ev: Event) => {
      received = ev as CustomEvent;
    };
    document.addEventListener("command", handler);
    el.shadowRoot!.querySelector<HTMLButtonElement>('button[data-action="restore"]')!.click();
    document.removeEventListener("command", handler);
    expect((received as unknown as CustomEvent).detail.action).toBe("restore");
  });

  it("clicking Undo emits 'command' with action 'undo'", () => {
    let received: CustomEvent | null = null;
    const handler = (ev: Event) => {
      received = ev as CustomEvent;
    };
    document.addEventListener("command", handler);
    el.shadowRoot!.querySelector<HTMLButtonElement>('button[data-action="undo"]')!.click();
    document.removeEventListener("command", handler);
    expect((received as unknown as CustomEvent).detail.action).toBe("undo");
  });

  it("clicking Restart emits 'command' with action 'restart'", () => {
    let received: CustomEvent | null = null;
    const handler = (ev: Event) => {
      received = ev as CustomEvent;
    };
    document.addEventListener("command", handler);
    el.shadowRoot!.querySelector<HTMLButtonElement>('button[data-action="restart"]')!.click();
    document.removeEventListener("command", handler);
    expect((received as unknown as CustomEvent).detail.action).toBe("restart");
  });

  it("clicking Fullscreen emits 'command' with action 'fullscreen'", () => {
    let received: CustomEvent | null = null;
    const handler = (ev: Event) => {
      received = ev as CustomEvent;
    };
    document.addEventListener("command", handler);
    el.shadowRoot!.querySelector<HTMLButtonElement>('button[data-action="fullscreen"]')!.click();
    document.removeEventListener("command", handler);
    expect((received as unknown as CustomEvent).detail.action).toBe("fullscreen");
  });

  it("clicking 'Back to menu' emits 'command' with action 'exit'", () => {
    let received: CustomEvent | null = null;
    const handler = (ev: Event) => {
      received = ev as CustomEvent;
    };
    document.addEventListener("command", handler);
    el.shadowRoot!.querySelector<HTMLButtonElement>('button[data-action="exit"]')!.click();
    document.removeEventListener("command", handler);

    expect(received).not.toBeNull();
    expect((received as unknown as CustomEvent).detail.action).toBe("exit");
  });

  // ── dismiss events ──────────────────────────────────────────────────────────

  it("clicking the close/✕ button emits 'dismiss' (bubbles + composed)", () => {
    let received: CustomEvent | null = null;
    const handler = (ev: Event) => {
      received = ev as CustomEvent;
    };
    document.addEventListener("dismiss", handler);
    el.shadowRoot!.querySelector<HTMLButtonElement>(".close-btn")!.click();
    document.removeEventListener("dismiss", handler);

    expect(received).not.toBeNull();
    expect((received as unknown as CustomEvent).bubbles).toBe(true);
    expect((received as unknown as CustomEvent).composed).toBe(true);
  });

  it("pressing Escape emits 'dismiss' (bubbles + composed)", () => {
    let received: CustomEvent | null = null;
    const handler = (ev: Event) => {
      received = ev as CustomEvent;
    };
    document.addEventListener("dismiss", handler);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.removeEventListener("dismiss", handler);

    expect(received).not.toBeNull();
    expect((received as unknown as CustomEvent).bubbles).toBe(true);
    expect((received as unknown as CustomEvent).composed).toBe(true);
  });

  it("clicking outside the menu emits 'dismiss'", () => {
    let received: CustomEvent | null = null;
    const handler = (ev: Event) => {
      received = ev as CustomEvent;
    };
    document.addEventListener("dismiss", handler);
    document.body.click();
    document.removeEventListener("dismiss", handler);

    expect(received).not.toBeNull();
  });

  it("non-Escape keys do NOT emit 'dismiss'", () => {
    let received: CustomEvent | null = null;
    const handler = (ev: Event) => {
      received = ev as CustomEvent;
    };
    document.addEventListener("dismiss", handler);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    document.removeEventListener("dismiss", handler);

    expect(received).toBeNull();
  });

  // ── teardown — no leak ──────────────────────────────────────────────────────

  it("disconnectedCallback removes the keydown listener (no leak)", () => {
    const spy = vi.spyOn(window, "removeEventListener");
    el.remove();
    expect(spy).toHaveBeenCalledWith("keydown", expect.any(Function));
    spy.mockRestore();
  });

  it("disconnectedCallback removes the outside-click listener (no leak)", () => {
    const spy = vi.spyOn(window, "removeEventListener");
    el.remove();
    expect(spy).toHaveBeenCalledWith("click", expect.any(Function));
    spy.mockRestore();
  });

  // ── re-connect re-attaches listeners ────────────────────────────────────────

  it("re-adding to DOM re-attaches listeners — Escape still emits dismiss", async () => {
    el.remove();
    document.body.appendChild(el);
    await el.updateComplete;

    let dismissCount = 0;
    const handler = () => {
      dismissCount++;
    };
    document.addEventListener("dismiss", handler);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.removeEventListener("dismiss", handler);

    expect(dismissCount).toBe(1);
  });
});
