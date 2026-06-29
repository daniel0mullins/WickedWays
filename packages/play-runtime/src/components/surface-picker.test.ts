// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "./surface-picker.js";
import type { SurfacePicker } from "./surface-picker.js";

type Surface = { id: string; label: string; description?: string };

const mkSurface = (id: string, label: string, description?: string): Surface => ({
  id,
  label,
  description,
});

const SURFACES: Surface[] = [
  mkSurface("crt-terminal", "CRT Terminal", "Retro green-phosphor terminal feel."),
  mkSurface("point-and-click", "Point & Click", "Classic adventure game interface."),
];

describe("<surface-picker>", () => {
  let el: SurfacePicker;

  beforeEach(() => {
    el = document.createElement("surface-picker");
    document.body.appendChild(el);
  });

  afterEach(() => {
    el.remove();
  });

  it("renders one .surface-entry per surface", async () => {
    el.surfaces = SURFACES;
    await el.updateComplete;

    const entries = el.shadowRoot!.querySelectorAll(".surface-entry");
    expect(entries).toHaveLength(2);
  });

  it("renders label and description in each entry", async () => {
    el.surfaces = SURFACES;
    await el.updateComplete;

    const entries = el.shadowRoot!.querySelectorAll(".surface-entry");
    const first = entries[0]!;
    expect(first.querySelector(".surface-label")!.textContent).toBe("CRT Terminal");
    expect(first.querySelector(".surface-desc")!.textContent).toBe(
      "Retro green-phosphor terminal feel.",
    );

    const second = entries[1]!;
    expect(second.querySelector(".surface-label")!.textContent).toBe("Point & Click");
    expect(second.querySelector(".surface-desc")!.textContent).toBe(
      "Classic adventure game interface.",
    );
  });

  it("falls back to label when description is absent", async () => {
    el.surfaces = [mkSurface("bare", "Bare Surface")];
    await el.updateComplete;

    const entry = el.shadowRoot!.querySelector(".surface-entry")!;
    expect(entry.querySelector(".surface-desc")!.textContent).toBe("Bare Surface");
  });

  it("clicking an entry emits 'select' with the id (bubbles+composed)", async () => {
    el.surfaces = SURFACES;
    await el.updateComplete;

    const events: CustomEvent<{ id: string }>[] = [];
    el.addEventListener("select", (e) => events.push(e as CustomEvent<{ id: string }>));

    const entries = el.shadowRoot!.querySelectorAll<HTMLButtonElement>(".surface-entry");
    entries[1]!.click();

    expect(events).toHaveLength(1);
    expect(events[0]!.detail.id).toBe("point-and-click");
    expect(events[0]!.bubbles).toBe(true);
    expect(events[0]!.composed).toBe(true);
  });

  it("pressing Enter on a focused entry emits 'select' (native button behavior)", async () => {
    el.surfaces = SURFACES;
    await el.updateComplete;

    const events: CustomEvent<{ id: string }>[] = [];
    el.addEventListener("select", (e) => events.push(e as CustomEvent<{ id: string }>));

    const btn = el.shadowRoot!.querySelector<HTMLButtonElement>(".surface-entry")!;
    btn.click();

    expect(events).toHaveLength(1);
    expect(events[0]!.detail.id).toBe("crt-terminal");
  });

  it("ArrowDown moves focus to the next entry", async () => {
    el.surfaces = SURFACES;
    await el.updateComplete;

    const entries = el.shadowRoot!.querySelectorAll<HTMLButtonElement>(".surface-entry");
    entries[0]!.focus();

    el.shadowRoot!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );

    expect(el.shadowRoot!.activeElement).toBe(entries[1]);
  });

  it("ArrowUp moves focus to the previous entry", async () => {
    el.surfaces = SURFACES;
    await el.updateComplete;

    const entries = el.shadowRoot!.querySelectorAll<HTMLButtonElement>(".surface-entry");
    entries[1]!.focus();

    el.shadowRoot!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
    );

    expect(el.shadowRoot!.activeElement).toBe(entries[0]);
  });

  it("ArrowDown at the last entry does not wrap (clamp)", async () => {
    el.surfaces = SURFACES;
    await el.updateComplete;

    const entries = el.shadowRoot!.querySelectorAll<HTMLButtonElement>(".surface-entry");
    entries[1]!.focus();

    el.shadowRoot!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );

    expect(el.shadowRoot!.activeElement).toBe(entries[1]);
  });

  it("ArrowUp at the first entry does not wrap (clamp)", async () => {
    el.surfaces = SURFACES;
    await el.updateComplete;

    const entries = el.shadowRoot!.querySelectorAll<HTMLButtonElement>(".surface-entry");
    entries[0]!.focus();

    el.shadowRoot!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
    );

    expect(el.shadowRoot!.activeElement).toBe(entries[0]);
  });

  it("back control emits 'back' (bubbles+composed)", async () => {
    el.surfaces = SURFACES;
    await el.updateComplete;

    const events: CustomEvent[] = [];
    el.addEventListener("back", (e) => events.push(e as CustomEvent));

    const backBtn = el.shadowRoot!.querySelector<HTMLButtonElement>(".surface-back")!;
    expect(backBtn).toBeTruthy();
    backBtn.click();

    expect(events).toHaveLength(1);
    expect(events[0]!.bubbles).toBe(true);
    expect(events[0]!.composed).toBe(true);
  });

  it("renders empty container when surfaces is empty", async () => {
    el.surfaces = [];
    await el.updateComplete;

    const entries = el.shadowRoot!.querySelectorAll(".surface-entry");
    expect(entries).toHaveLength(0);
  });
});
