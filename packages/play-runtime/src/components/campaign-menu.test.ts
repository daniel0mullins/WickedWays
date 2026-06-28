// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "./campaign-menu.js";
import type { CampaignMenu } from "./campaign-menu.js";

type Campaign = { slug: string; title: string; blurb: string };

const mkCampaign = (slug: string, title: string, blurb: string): Campaign => ({ slug, title, blurb });

const CAMPAIGNS: Campaign[] = [
  mkCampaign("hollow-house", "Hollow House", "A crumbling manor and its secrets."),
  mkCampaign("seed", "Seed", "A forest awakens."),
];

describe("<campaign-menu>", () => {
  let el: CampaignMenu;

  beforeEach(() => {
    el = document.createElement("campaign-menu");
    document.body.appendChild(el);
  });

  afterEach(() => {
    el.remove();
  });

  it("renders one .launcher-entry per campaign", async () => {
    el.campaigns = CAMPAIGNS;
    await el.updateComplete;

    const entries = el.shadowRoot!.querySelectorAll(".launcher-entry");
    expect(entries).toHaveLength(2);
  });

  it("renders the campaign title and blurb in each entry", async () => {
    el.campaigns = CAMPAIGNS;
    await el.updateComplete;

    const entries = el.shadowRoot!.querySelectorAll(".launcher-entry");
    const first = entries[0]!;
    expect(first.querySelector(".launcher-title")!.textContent).toBe("Hollow House");
    expect(first.querySelector(".launcher-blurb")!.textContent).toBe("A crumbling manor and its secrets.");

    const second = entries[1]!;
    expect(second.querySelector(".launcher-title")!.textContent).toBe("Seed");
    expect(second.querySelector(".launcher-blurb")!.textContent).toBe("A forest awakens.");
  });

  it("clicking an entry emits 'select' with the matching slug (bubbles+composed)", async () => {
    el.campaigns = CAMPAIGNS;
    await el.updateComplete;

    const events: CustomEvent<{ slug: string }>[] = [];
    el.addEventListener("select", (e) => events.push(e as CustomEvent<{ slug: string }>));

    const entries = el.shadowRoot!.querySelectorAll<HTMLButtonElement>(".launcher-entry");
    entries[1]!.click();

    expect(events).toHaveLength(1);
    expect(events[0]!.detail.slug).toBe("seed");
    expect(events[0]!.bubbles).toBe(true);
    expect(events[0]!.composed).toBe(true);
  });

  it("pressing Enter on a focused entry emits 'select' (native button behavior)", async () => {
    el.campaigns = CAMPAIGNS;
    await el.updateComplete;

    const events: CustomEvent<{ slug: string }>[] = [];
    el.addEventListener("select", (e) => events.push(e as CustomEvent<{ slug: string }>));

    // Native button: Enter dispatches a click event
    const btn = el.shadowRoot!.querySelector<HTMLButtonElement>(".launcher-entry")!;
    btn.click();

    expect(events).toHaveLength(1);
    expect(events[0]!.detail.slug).toBe("hollow-house");
  });

  it("ArrowDown moves focus to the next entry", async () => {
    el.campaigns = CAMPAIGNS;
    await el.updateComplete;

    const entries = el.shadowRoot!.querySelectorAll<HTMLButtonElement>(".launcher-entry");
    entries[0]!.focus();

    el.shadowRoot!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );

    // After ArrowDown, second entry should have focus
    expect(el.shadowRoot!.activeElement).toBe(entries[1]);
  });

  it("ArrowUp moves focus to the previous entry", async () => {
    el.campaigns = CAMPAIGNS;
    await el.updateComplete;

    const entries = el.shadowRoot!.querySelectorAll<HTMLButtonElement>(".launcher-entry");
    entries[1]!.focus();

    el.shadowRoot!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
    );

    expect(el.shadowRoot!.activeElement).toBe(entries[0]);
  });

  it("ArrowDown at the last entry does not wrap (clamp)", async () => {
    el.campaigns = CAMPAIGNS;
    await el.updateComplete;

    const entries = el.shadowRoot!.querySelectorAll<HTMLButtonElement>(".launcher-entry");
    entries[1]!.focus();

    el.shadowRoot!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );

    // Still on the last entry — no wrap
    expect(el.shadowRoot!.activeElement).toBe(entries[1]);
  });

  it("ArrowUp at the first entry does not wrap (clamp)", async () => {
    el.campaigns = CAMPAIGNS;
    await el.updateComplete;

    const entries = el.shadowRoot!.querySelectorAll<HTMLButtonElement>(".launcher-entry");
    entries[0]!.focus();

    el.shadowRoot!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
    );

    expect(el.shadowRoot!.activeElement).toBe(entries[0]);
  });

  it("renders empty container when campaigns is empty", async () => {
    el.campaigns = [];
    await el.updateComplete;

    const entries = el.shadowRoot!.querySelectorAll(".launcher-entry");
    expect(entries).toHaveLength(0);
  });
});
