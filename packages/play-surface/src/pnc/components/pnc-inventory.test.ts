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

const tab = (el: PncInventory, name: "Inventory" | "Key Items"): HTMLButtonElement =>
  Array.from(el.shadowRoot!.querySelectorAll<HTMLButtonElement>(".tab")).find(
    (b) => b.textContent?.trim() === name,
  )!;

describe("<pnc-inventory>", () => {
  let el: PncInventory;

  beforeEach(() => {
    el = document.createElement("pnc-inventory");
    document.body.appendChild(el);
  });

  afterEach(() => {
    el.remove();
  });

  // ── tabs ──────────────────────────────────────────────────────────────────────

  it("renders an Inventory tab and a Key Items tab, defaulting to Inventory", async () => {
    await el.updateComplete;
    expect(tab(el, "Inventory")).toBeTruthy();
    expect(tab(el, "Key Items")).toBeTruthy();
    // Inventory tab active by default → the slot list is shown, key list is not.
    expect(el.shadowRoot!.querySelector(".slot-list")).not.toBeNull();
    expect(el.shadowRoot!.querySelector(".key-list")).toBeNull();
  });

  it("switches to the Key Items tab on click", async () => {
    el.keys = [item({ id: "k-1", name: "Iron Key" })];
    await el.updateComplete;
    tab(el, "Key Items").click();
    await el.updateComplete;
    expect(el.shadowRoot!.querySelector(".key-list")).not.toBeNull();
    expect(el.shadowRoot!.querySelector(".slot-list")).toBeNull();
  });

  // ── inventory tab: numbered slots ───────────────────────────────────────────────

  it("renders one numbered slot per inventory slot in an ordered list", async () => {
    el.slots = 4;
    el.items = [item({ id: "i-1", name: "Lantern" })];
    await el.updateComplete;
    const list = el.shadowRoot!.querySelector("ol.slot-list")!;
    expect(list).not.toBeNull();
    expect(list.querySelectorAll(".slot")).toHaveLength(4);
  });

  it("shows item names in filled slots and --empty-- in empty ones", async () => {
    el.slots = 3;
    el.items = [item({ id: "i-1", name: "Lantern" })];
    await el.updateComplete;
    const slots = el.shadowRoot!.querySelectorAll(".slot");
    expect(slots[0]!.textContent).toContain("Lantern");
    expect(slots[1]!.textContent).toContain("--empty--");
    expect(slots[2]!.textContent).toContain("--empty--");
  });

  it("marks an empty slot with .slot-empty (not a clickable entry)", async () => {
    el.slots = 2;
    el.items = [];
    await el.updateComplete;
    expect(el.shadowRoot!.querySelectorAll(".slot-empty")).toHaveLength(2);
    expect(el.shadowRoot!.querySelectorAll(".inventory-entry")).toHaveLength(0);
  });

  it("shows an (equipped) tag on a filled slot whose item is equipped", async () => {
    el.slots = 2;
    el.items = [item({ id: "i-1", name: "Short Sword" })];
    el.equippedNames = ["Short Sword"];
    await el.updateComplete;
    const entry = el.shadowRoot!.querySelector(".inventory-entry")!;
    expect(entry.querySelector(".equipped-tag")).not.toBeNull();
    expect(entry.textContent).toContain("equipped");
  });

  it("renders an <img> in a filled slot when the item has an image", async () => {
    el.slots = 1;
    el.items = [item({ id: "i-1", name: "Flask", image: "/assets/flask.png" })];
    await el.updateComplete;
    const img = el.shadowRoot!.querySelector<HTMLImageElement>(".slot img");
    expect(img).not.toBeNull();
    expect(img!.src).toContain("flask.png");
  });

  // ── key items tab: bulleted list ────────────────────────────────────────────────

  it("renders keys as an unordered (bulleted) list", async () => {
    el.keys = [item({ id: "k-1", name: "Iron Key" }), item({ id: "k-2", name: "Brass Key" })];
    await el.updateComplete;
    tab(el, "Key Items").click();
    await el.updateComplete;
    const list = el.shadowRoot!.querySelector("ul.key-list")!;
    expect(list).not.toBeNull();
    const entries = list.querySelectorAll(".inventory-entry");
    expect(entries).toHaveLength(2);
    expect(entries[0]!.textContent).toContain("Iron Key");
    expect(entries[1]!.textContent).toContain("Brass Key");
  });

  // ── inventory-activate event ─────────────────────────────────────────────────

  it("clicking a filled slot emits inventory-activate with the item id (bubbles + composed)", async () => {
    el.slots = 2;
    el.items = [item({ id: "i-99", name: "Vial" })];
    await el.updateComplete;

    let received: CustomEvent | null = null;
    const handler = (ev: Event) => { received = ev as CustomEvent; };
    document.addEventListener("inventory-activate", handler);
    el.shadowRoot!.querySelector<HTMLElement>(".inventory-entry")!.click();
    document.removeEventListener("inventory-activate", handler);

    expect(received).not.toBeNull();
    expect((received as unknown as CustomEvent).detail.id).toBe("i-99");
    expect((received as unknown as CustomEvent).bubbles).toBe(true);
    expect((received as unknown as CustomEvent).composed).toBe(true);
  });

  it("emits the correct id when clicking a key entry", async () => {
    el.keys = [item({ id: "k-42", name: "Silver Key" })];
    await el.updateComplete;
    tab(el, "Key Items").click();
    await el.updateComplete;

    let received: CustomEvent | null = null;
    const handler = (ev: Event) => { received = ev as CustomEvent; };
    document.addEventListener("inventory-activate", handler);
    el.shadowRoot!.querySelector<HTMLElement>(".key-list .inventory-entry")!.click();
    document.removeEventListener("inventory-activate", handler);

    expect(received).not.toBeNull();
    expect((received as unknown as CustomEvent).detail.id).toBe("k-42");
  });

  // ── reactivity ───────────────────────────────────────────────────────────────

  it("re-renders slots when items property changes", async () => {
    el.slots = 3;
    el.items = [item({ id: "i-1", name: "Lantern" })];
    await el.updateComplete;
    expect(el.shadowRoot!.querySelectorAll(".inventory-entry")).toHaveLength(1);

    el.items = [item({ id: "i-1", name: "Lantern" }), item({ id: "i-2", name: "Map" })];
    await el.updateComplete;
    expect(el.shadowRoot!.querySelectorAll(".inventory-entry")).toHaveLength(2);
  });
});
