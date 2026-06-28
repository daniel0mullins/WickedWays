// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { ScopeEntity } from "@wickedways/play-runtime";
import "./pnc-inventory.js";
import type { PncInventory } from "./pnc-inventory.js";

const item = (overrides: Partial<ScopeEntity> = {}): ScopeEntity => ({
  id: "i-1",
  name: "Rusty Key",
  aliases: ["key"],
  kind: "item",
  ...overrides,
});

describe("<pnc-inventory>", () => {
  let el: PncInventory;

  beforeEach(() => {
    el = document.createElement("pnc-inventory");
    document.body.appendChild(el);
  });

  afterEach(() => {
    el.remove();
  });

  // ── defaults ────────────────────────────────────────────────────────────────

  it("renders an empty list with no crash when all props are default", async () => {
    await el.updateComplete;
    const sr = el.shadowRoot!;
    expect(sr.querySelectorAll(".inventory-entry")).toHaveLength(0);
  });

  // ── items ───────────────────────────────────────────────────────────────────

  it("renders one entry per item", async () => {
    el.items = [item({ id: "i-1", name: "Lantern" }), item({ id: "i-2", name: "Map" })];
    await el.updateComplete;
    const entries = el.shadowRoot!.querySelectorAll(".inventory-entry");
    expect(entries).toHaveLength(2);
    expect(entries[0]!.textContent).toContain("Lantern");
    expect(entries[1]!.textContent).toContain("Map");
  });

  // ── keys ────────────────────────────────────────────────────────────────────

  it("renders one entry per key", async () => {
    el.keys = [item({ id: "k-1", name: "Bronze Key", kind: "item" })];
    await el.updateComplete;
    const entries = el.shadowRoot!.querySelectorAll(".inventory-entry");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.textContent).toContain("Bronze Key");
  });

  it("renders items and keys together", async () => {
    el.items = [item({ id: "i-1", name: "Torch" })];
    el.keys = [item({ id: "k-1", name: "Iron Key", kind: "item" })];
    await el.updateComplete;
    expect(el.shadowRoot!.querySelectorAll(".inventory-entry")).toHaveLength(2);
  });

  // ── equipped tag ─────────────────────────────────────────────────────────────

  it("shows an (equipped) tag when item name is in equippedNames", async () => {
    el.items = [item({ id: "i-1", name: "Short Sword" })];
    el.equippedNames = ["Short Sword"];
    await el.updateComplete;
    const entry = el.shadowRoot!.querySelector(".inventory-entry")!;
    expect(entry.querySelector(".equipped-tag")).not.toBeNull();
    expect(entry.textContent).toContain("equipped");
  });

  it("does NOT show an (equipped) tag when item name is NOT in equippedNames", async () => {
    el.items = [item({ id: "i-1", name: "Short Sword" })];
    el.equippedNames = ["Dagger"];
    await el.updateComplete;
    expect(el.shadowRoot!.querySelector(".equipped-tag")).toBeNull();
  });

  // ── image ────────────────────────────────────────────────────────────────────

  it("renders an <img> when the entity has an image", async () => {
    el.items = [item({ id: "i-1", name: "Flask", image: "/assets/flask.png" })];
    await el.updateComplete;
    const img = el.shadowRoot!.querySelector<HTMLImageElement>("img");
    expect(img).not.toBeNull();
    expect(img!.src).toContain("flask.png");
  });

  it("does NOT render an <img> when there is no image", async () => {
    el.items = [item({ id: "i-1", name: "Pebble" })];
    await el.updateComplete;
    expect(el.shadowRoot!.querySelector("img")).toBeNull();
  });

  // ── inventory-activate event ─────────────────────────────────────────────────

  it("clicking an entry emits inventory-activate with the entity id (bubbles + composed)", async () => {
    el.items = [item({ id: "i-99", name: "Vial" })];
    await el.updateComplete;

    let received: CustomEvent | null = null;
    const vialHandler = (ev: Event) => { received = ev as CustomEvent; };
    document.addEventListener("inventory-activate", vialHandler);

    const entry = el.shadowRoot!.querySelector<HTMLElement>(".inventory-entry")!;
    entry.click();

    document.removeEventListener("inventory-activate", vialHandler);

    expect(received).not.toBeNull();
    expect((received as unknown as CustomEvent).detail.id).toBe("i-99");
    expect((received as unknown as CustomEvent).bubbles).toBe(true);
    expect((received as unknown as CustomEvent).composed).toBe(true);
  });

  it("emits the correct id when clicking a key entry", async () => {
    el.keys = [item({ id: "k-42", name: "Silver Key", kind: "item" })];
    await el.updateComplete;

    let received: CustomEvent | null = null;
    const keyHandler = (ev: Event) => { received = ev as CustomEvent; };
    document.addEventListener("inventory-activate", keyHandler);

    const entry = el.shadowRoot!.querySelector<HTMLElement>(".inventory-entry")!;
    entry.click();

    document.removeEventListener("inventory-activate", keyHandler);

    expect(received).not.toBeNull();
    expect((received as unknown as CustomEvent).detail.id).toBe("k-42");
  });

  // ── reactivity ───────────────────────────────────────────────────────────────

  it("re-renders when items property is updated", async () => {
    el.items = [item({ id: "i-1", name: "Lantern" })];
    await el.updateComplete;
    expect(el.shadowRoot!.querySelectorAll(".inventory-entry")).toHaveLength(1);

    el.items = [item({ id: "i-1", name: "Lantern" }), item({ id: "i-2", name: "Map" })];
    await el.updateComplete;
    expect(el.shadowRoot!.querySelectorAll(".inventory-entry")).toHaveLength(2);
  });
});
