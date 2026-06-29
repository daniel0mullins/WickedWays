// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { StatusField } from "wickedways/lib/presentation";
import "./crt-status.js";

type CrtStatusElement = HTMLElement & {
  location: string;
  fields: readonly StatusField[];
  updateComplete: Promise<boolean>;
};

describe("<crt-status>", () => {
  let el: CrtStatusElement;

  beforeEach(() => {
    el = document.createElement("crt-status");
    document.body.appendChild(el);
  });

  afterEach(() => {
    el.remove();
  });

  it("renders only the location when fields is empty", async () => {
    el.location = "Hollow House";
    await el.updateComplete;

    const statusDiv = el.shadowRoot!.querySelector(".status")!;
    expect(statusDiv.textContent).toContain("Hollow House");
    expect(statusDiv.textContent).not.toContain("·");
  });

  it("renders location + fields with separators and emphasis classes", async () => {
    el.location = "Hollow House";
    el.fields = [
      { label: "Sanity", value: "9", emphasis: "warn" },
      { label: "Round", value: "37/150" },
      { label: "Health", value: "5", emphasis: "critical" },
      { label: "Mood", value: "ok", emphasis: "normal" },
    ];
    await el.updateComplete;

    const statusDiv = el.shadowRoot!.querySelector(".status")!;
    const text = statusDiv.textContent;

    // Text content order: location · field · field · ...
    expect(text).toContain("Hollow House");
    expect(text).toContain("  ·  Sanity 9");
    expect(text).toContain("  ·  Round 37/150");
    expect(text).toContain("  ·  Health 5");
    expect(text).toContain("  ·  Mood ok");

    const spans = statusDiv.querySelectorAll("span");
    expect(spans).toHaveLength(4);

    // warn emphasis → status-warn, NOT status-critical
    expect(spans[0]!.classList.contains("status-warn")).toBe(true);
    expect(spans[0]!.classList.contains("status-critical")).toBe(false);

    // undefined emphasis → no emphasis class
    expect(spans[1]!.classList.contains("status-warn")).toBe(false);
    expect(spans[1]!.classList.contains("status-critical")).toBe(false);

    // critical emphasis → status-critical, NOT status-warn
    expect(spans[2]!.classList.contains("status-critical")).toBe(true);
    expect(spans[2]!.classList.contains("status-warn")).toBe(false);

    // "normal" emphasis → no emphasis class
    expect(spans[3]!.classList.contains("status-warn")).toBe(false);
    expect(spans[3]!.classList.contains("status-critical")).toBe(false);
  });

  it("re-renders when fields property is updated (Lit reactivity)", async () => {
    el.location = "The Crypt";
    el.fields = [{ label: "Sanity", value: "7", emphasis: "warn" }];
    await el.updateComplete;

    const statusDiv = el.shadowRoot!.querySelector(".status")!;
    expect(statusDiv.textContent).toContain("Sanity 7");
    expect(statusDiv.querySelector("span")!.classList.contains("status-warn")).toBe(true);

    // Update fields — component must re-render
    el.fields = [{ label: "Sanity", value: "3", emphasis: "critical" }];
    await el.updateComplete;

    expect(el.shadowRoot!.querySelector(".status")!.textContent).toContain("Sanity 3");
    expect(el.shadowRoot!.querySelector(".status span")!.classList.contains("status-critical")).toBe(true);
    expect(el.shadowRoot!.querySelector(".status span")!.classList.contains("status-warn")).toBe(false);
  });
});
