// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "./pnc-map-overlay.js";
import type { PncMapOverlay } from "./pnc-map-overlay.js";

describe("<pnc-map-overlay>", () => {
  let el: PncMapOverlay;

  beforeEach(async () => {
    el = document.createElement("pnc-map-overlay");
    document.body.appendChild(el);
    await el.updateComplete;
  });

  afterEach(() => {
    el.remove();
  });

  // ── render ──────────────────────────────────────────────────────────────────

  it("renders without crashing when svg prop is null", () => {
    expect(el.shadowRoot).not.toBeNull();
    expect(el.shadowRoot!.querySelector(".map-overlay")).not.toBeNull();
  });

  it("inserts passed SVGElement into the render root", async () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("data-testid", "map-svg");
    el.svg = svg;
    await el.updateComplete;

    const found = el.shadowRoot!.querySelector("[data-testid='map-svg']");
    expect(found).not.toBeNull();
  });

  it("replaces the old SVG when svg prop changes", async () => {
    const svg1 = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg1.setAttribute("data-testid", "svg-one");
    el.svg = svg1;
    await el.updateComplete;

    const svg2 = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg2.setAttribute("data-testid", "svg-two");
    el.svg = svg2;
    await el.updateComplete;

    expect(el.shadowRoot!.querySelector("[data-testid='svg-one']")).toBeNull();
    expect(el.shadowRoot!.querySelector("[data-testid='svg-two']")).not.toBeNull();
  });

  it("clears the SVG slot when svg prop set to null", async () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("data-testid", "map-svg");
    el.svg = svg;
    await el.updateComplete;

    el.svg = null;
    await el.updateComplete;

    expect(el.shadowRoot!.querySelector("[data-testid='map-svg']")).toBeNull();
  });

  // ── dismiss — click ─────────────────────────────────────────────────────────

  it("clicking the overlay emits 'dismiss' (bubbles + composed)", () => {
    let received: CustomEvent | null = null;
    const handler = (ev: Event) => {
      received = ev as CustomEvent;
    };
    document.addEventListener("dismiss", handler);
    el.shadowRoot!.querySelector<HTMLElement>(".map-overlay")!.click();
    document.removeEventListener("dismiss", handler);

    expect(received).not.toBeNull();
    expect((received as unknown as CustomEvent).bubbles).toBe(true);
    expect((received as unknown as CustomEvent).composed).toBe(true);
  });

  // ── dismiss — any key ───────────────────────────────────────────────────────

  it("any key press emits 'dismiss' (bubbles + composed)", () => {
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

  it("pressing any non-Escape key also emits 'dismiss'", async () => {
    // Re-mount to reset the one-shot listener that may have fired
    el.remove();
    const el2 = document.createElement("pnc-map-overlay");
    document.body.appendChild(el2);
    await el2.updateComplete;

    let received: CustomEvent | null = null;
    const handler = (ev: Event) => {
      received = ev as CustomEvent;
    };
    document.addEventListener("dismiss", handler);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    document.removeEventListener("dismiss", handler);
    el2.remove();

    expect(received).not.toBeNull();
  });

  // ── teardown — no leak ──────────────────────────────────────────────────────

  it("disconnectedCallback removes the capture keydown listener (no leak)", () => {
    const spy = vi.spyOn(window, "removeEventListener");
    el.remove();
    expect(spy).toHaveBeenCalledWith("keydown", expect.any(Function), true);
    spy.mockRestore();
  });

  it("a gutted disconnectedCallback would fail this test — spy MUST have been called", () => {
    // Confirm that simply calling remove() triggers window.removeEventListener with capture=true.
    // If disconnectedCallback is missing the cleanup, removeEventListener won't be called at all.
    const spy = vi.spyOn(window, "removeEventListener");
    el.remove();
    const calls = spy.mock.calls;
    const captureKeydownCalls = calls.filter(
      ([event, , capture]) => event === "keydown" && capture === true,
    );
    expect(captureKeydownCalls.length).toBeGreaterThan(0);
    spy.mockRestore();
  });
});
