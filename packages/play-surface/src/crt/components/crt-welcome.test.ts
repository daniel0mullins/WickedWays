// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "./crt-welcome.js";
import type { CrtWelcome } from "./crt-welcome.js";

describe("<crt-welcome>", () => {
  let el: CrtWelcome;

  beforeEach(() => {
    el = document.createElement("crt-welcome");
    document.body.appendChild(el);
  });

  afterEach(() => {
    el.remove();
  });

  it("renders title in .welcome-title and intro in .welcome-intro", async () => {
    el.title = "Hollow House";
    el.intro = "A dark and stormy night.";
    await el.updateComplete;

    const titleEl = el.shadowRoot!.querySelector(".welcome-title")!;
    const introEl = el.shadowRoot!.querySelector(".welcome-intro")!;
    expect(titleEl.textContent).toBe("Hollow House");
    expect(introEl.textContent).toBe("A dark and stormy night.");
  });

  it("button text equals buttonText when provided", async () => {
    el.title = "Hollow House";
    el.intro = "Intro text";
    el.buttonText = "Begin Your Journey";
    await el.updateComplete;

    const btn = el.shadowRoot!.querySelector(".enter-btn")!;
    expect(btn.textContent?.trim()).toBe("Begin Your Journey");
  });

  it("button text defaults to `Enter ${title}` when buttonText is not set", async () => {
    el.title = "Hollow House";
    el.intro = "Intro text";
    await el.updateComplete;

    const btn = el.shadowRoot!.querySelector(".enter-btn")!;
    expect(btn.textContent?.trim()).toBe("Enter Hollow House");
  });

  it("clicking the button emits 'enter' event (bubbles+composed)", async () => {
    el.title = "Hollow House";
    el.intro = "Intro";
    await el.updateComplete;

    const events: CustomEvent[] = [];
    el.addEventListener("enter", (e) => events.push(e as CustomEvent));

    const btn = el.shadowRoot!.querySelector<HTMLButtonElement>(".enter-btn")!;
    btn.click();

    expect(events).toHaveLength(1);
    expect(events[0]!.bubbles).toBe(true);
    expect(events[0]!.composed).toBe(true);
  });

  it("reflects hidden attribute on host (controller hides via hidden=true)", async () => {
    el.title = "Hollow House";
    el.intro = "Intro";
    await el.updateComplete;

    expect(el.hasAttribute("hidden")).toBe(false);

    el.hidden = true;
    expect(el.hasAttribute("hidden")).toBe(true);
  });

  it("auto-focuses the enter button on first render", async () => {
    el.title = "Hollow House";
    el.intro = "Intro";
    await el.updateComplete;
    const btn = el.shadowRoot!.querySelector<HTMLButtonElement>(".enter-btn")!;
    expect(el.shadowRoot!.activeElement).toBe(btn);
  });
});
