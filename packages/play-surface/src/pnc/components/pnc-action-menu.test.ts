// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "./pnc-action-menu.js";
import type { PncActionMenu } from "./pnc-action-menu.js";

describe("<pnc-action-menu>", () => {
  let el: PncActionMenu;

  beforeEach(async () => {
    el = document.createElement("pnc-action-menu");
    document.body.appendChild(el);
    await el.updateComplete;
  });

  afterEach(() => {
    el.remove();
  });

  // ── defaults ────────────────────────────────────────────────────────────────

  it("renders with no actions (empty) by default without crashing", () => {
    expect(el.shadowRoot!.querySelectorAll("button")).toHaveLength(0);
  });

  // ── action buttons ───────────────────────────────────────────────────────────

  it("renders one button per action with the action's label", async () => {
    el.actions = [
      { label: "Look", index: 0 },
      { label: "Take", index: 1 },
      { label: "Use", index: 2 },
    ];
    await el.updateComplete;

    const buttons = el.shadowRoot!.querySelectorAll("button");
    expect(buttons).toHaveLength(3);
    expect(buttons[0]!.textContent).toContain("Look");
    expect(buttons[1]!.textContent).toContain("Take");
    expect(buttons[2]!.textContent).toContain("Use");
  });

  // ── placement ────────────────────────────────────────────────────────────────

  it("positions the popup at (x, y) via inline style or CSS custom properties", async () => {
    el.x = 120;
    el.y = 200;
    el.actions = [{ label: "Examine", index: 0 }];
    await el.updateComplete;

    const popup = el.shadowRoot!.querySelector<HTMLElement>(".action-menu")!;
    expect(popup).not.toBeNull();
    // Popup should reflect x/y placement — check style attribute or CSS
    const style = popup.getAttribute("style") ?? "";
    expect(style).toMatch(/left\s*:\s*120px/);
    expect(style).toMatch(/top\s*:\s*200px/);
  });

  // ── choose event ─────────────────────────────────────────────────────────────

  it("clicking a button emits 'choose' with the action index (bubbles + composed)", async () => {
    el.actions = [
      { label: "Look", index: 0 },
      { label: "Take", index: 5 },
    ];
    await el.updateComplete;

    let received: CustomEvent | null = null;
    document.addEventListener("choose", (ev) => {
      received = ev as CustomEvent;
    });

    const buttons = el.shadowRoot!.querySelectorAll<HTMLButtonElement>("button");
    buttons[1]!.click();

    document.removeEventListener("choose", received as unknown as EventListener);

    expect(received).not.toBeNull();
    expect((received as unknown as CustomEvent).detail.index).toBe(5);
    expect((received as unknown as CustomEvent).bubbles).toBe(true);
    expect((received as unknown as CustomEvent).composed).toBe(true);
  });

  // ── dismiss — Escape key ──────────────────────────────────────────────────────

  it("pressing Escape emits 'dismiss' (bubbles + composed)", async () => {
    el.actions = [{ label: "Look", index: 0 }];
    await el.updateComplete;

    let received: CustomEvent | null = null;
    document.addEventListener("dismiss", (ev) => {
      received = ev as CustomEvent;
    });

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    document.removeEventListener("dismiss", received as unknown as EventListener);

    expect(received).not.toBeNull();
    expect((received as unknown as CustomEvent).bubbles).toBe(true);
    expect((received as unknown as CustomEvent).composed).toBe(true);
  });

  // ── dismiss — outside click ───────────────────────────────────────────────────

  it("clicking outside the popup emits 'dismiss'", async () => {
    el.actions = [{ label: "Look", index: 0 }];
    await el.updateComplete;

    let received: CustomEvent | null = null;
    document.addEventListener("dismiss", (ev) => {
      received = ev as CustomEvent;
    });

    // Click on document body (outside the popup)
    document.body.click();

    document.removeEventListener("dismiss", received as unknown as EventListener);

    expect(received).not.toBeNull();
  });

  // ── no leak — listeners removed on disconnect ─────────────────────────────────

  it("disconnectedCallback removes the Escape keydown listener (no leak)", async () => {
    el.actions = [{ label: "Look", index: 0 }];
    await el.updateComplete;

    // Disconnect the element
    el.remove();

    let received: CustomEvent | null = null;
    document.addEventListener("dismiss", (ev) => {
      received = ev as CustomEvent;
    });

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    document.removeEventListener("dismiss", received as unknown as EventListener);

    // After disconnect, Escape should NOT trigger dismiss any more
    expect(received).toBeNull();
  });

  it("disconnectedCallback removes the outside-click listener (no leak)", async () => {
    el.actions = [{ label: "Look", index: 0 }];
    await el.updateComplete;

    el.remove();

    let received: CustomEvent | null = null;
    document.addEventListener("dismiss", (ev) => {
      received = ev as CustomEvent;
    });

    document.body.click();

    document.removeEventListener("dismiss", received as unknown as EventListener);

    expect(received).toBeNull();
  });

  // ── re-connect ─────────────────────────────────────────────────────────────────

  it("re-adding to the DOM re-attaches listeners", async () => {
    el.actions = [{ label: "Examine", index: 0 }];
    await el.updateComplete;
    el.remove();
    document.body.appendChild(el);
    await el.updateComplete;

    let received: CustomEvent | null = null;
    document.addEventListener("dismiss", (ev) => {
      received = ev as CustomEvent;
    });

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    document.removeEventListener("dismiss", received as unknown as EventListener);

    expect(received).not.toBeNull();
  });
});
