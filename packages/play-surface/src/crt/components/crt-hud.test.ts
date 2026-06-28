// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "./crt-hud.js";
import type { CrtHud } from "./crt-hud.js";
import type { ViewModel } from "@wickedways/play-runtime";

function makeVM(overrides: Partial<ViewModel> = {}): ViewModel {
  return {
    room: { id: "", name: "", description: "", isLit: true },
    exits: [],
    lockedDoors: [],
    occupants: [],
    loot: [],
    inventory: { items: [], keys: [], equippedNames: [] },
    scope: [],
    status: { locationName: "", turn: 0, maxTurns: 0, sanity: 0, health: 0 },
    outcome: "",
    finished: false,
    ...overrides,
  };
}

describe("<crt-hud>", () => {
  let el: CrtHud;

  beforeEach(() => {
    el = document.createElement("crt-hud");
    document.body.appendChild(el);
  });

  afterEach(() => {
    el.remove();
  });

  it("has id='hud' on the outer div", async () => {
    await el.updateComplete;
    expect(el.shadowRoot!.querySelector("#hud")).not.toBeNull();
  });

  // 1. Here: loot line
  describe("Here: loot line", () => {
    it("omits the 'Here:' line when there is no loot", async () => {
      el.vm = makeVM({ loot: [] });
      await el.updateComplete;
      const hud = el.shadowRoot!.querySelector("#hud")!;
      expect(hud.textContent).not.toContain("Here:");
    });

    it("shows 'Here:' with joined descriptions (trailing period stripped, re-added) when loot is present", async () => {
      el.vm = makeVM({
        loot: [
          { id: "a", description: "a wooden chest.", opened: false, contents: [] },
          { id: "b", description: "a silver coin.", opened: false, contents: [] },
        ],
      });
      await el.updateComplete;
      const hud = el.shadowRoot!.querySelector("#hud")!;
      expect(hud.textContent).toContain("Here:");
      expect(hud.textContent).toContain("a wooden chest, a silver coin.");
    });

    it("renders a loot noun present in clickableNouns as a .noun span", async () => {
      el.vm = makeVM({
        loot: [{ id: "c", description: "a drawer.", opened: false, contents: [] }],
      });
      el.clickableNouns = ["drawer"];
      await el.updateComplete;
      const hud = el.shadowRoot!.querySelector("#hud")!;
      const nounSpans = hud.querySelectorAll(".noun");
      expect(nounSpans.length).toBeGreaterThan(0);
      expect(nounSpans[0]!.textContent).toContain("drawer");
    });
  });

  // 2. Carrying line
  describe("Carrying: line", () => {
    it("shows 'nothing.' when inventory is empty", async () => {
      el.vm = makeVM();
      await el.updateComplete;
      const hud = el.shadowRoot!.querySelector("#hud")!;
      expect(hud.textContent).toContain("Carrying:");
      expect(hud.textContent).toContain("nothing.");
    });

    it("shows items with (equipped) tag for equipped items, unequipped without", async () => {
      el.vm = makeVM({
        inventory: {
          items: [
            { id: "1", name: "Iron Sword", aliases: [], kind: "item" },
            { id: "2", name: "Leather Armor", aliases: [], kind: "item" },
          ],
          keys: [],
          equippedNames: ["Iron Sword"],
        },
      });
      await el.updateComplete;
      const hud = el.shadowRoot!.querySelector("#hud")!;
      const text = hud.textContent;
      expect(text).toContain("Iron Sword (equipped)");
      expect(text).toContain("Leather Armor");
      // Leather Armor must NOT have (equipped)
      expect(text.indexOf("Leather Armor (equipped)")).toBe(-1);
    });

    it("includes keys in the carrying list", async () => {
      el.vm = makeVM({
        inventory: {
          items: [],
          keys: [{ id: "k1", name: "Brass Key", aliases: [], kind: "item" }],
          equippedNames: [],
        },
      });
      await el.updateComplete;
      const hud = el.shadowRoot!.querySelector("#hud")!;
      expect(hud.textContent).toContain("Brass Key");
    });

    it("shows an equippedName absent from items with (equipped) tag", async () => {
      // Equipped gear that has left the items list still appears on the readout.
      el.vm = makeVM({
        inventory: {
          items: [],
          keys: [],
          equippedNames: ["Ancient Robe"],
        },
      });
      await el.updateComplete;
      const hud = el.shadowRoot!.querySelector("#hud")!;
      expect(hud.textContent).toContain("Ancient Robe (equipped)");
    });
  });

  // 3. Exits line
  describe("Exits: line", () => {
    it("renders passable exits as .exit-link with capitalized direction", async () => {
      el.vm = makeVM({
        exits: [
          { dir: "north", toName: "The Hall" },
          { dir: "east", toName: "The Study" },
        ],
      });
      await el.updateComplete;
      const hud = el.shadowRoot!.querySelector("#hud")!;
      expect(hud.textContent).toContain("Exits:");
      const links = hud.querySelectorAll(".exit-link");
      expect(links).toHaveLength(2);
      expect(links[0]!.textContent).toBe("North");
      expect(links[1]!.textContent).toBe("East");
    });

    it("renders locked doors as .exit-locked with 'Dir (Name, locked)' text", async () => {
      el.vm = makeVM({
        exits: [],
        lockedDoors: [{ dir: "west", name: "Iron Gate" }],
      });
      await el.updateComplete;
      const hud = el.shadowRoot!.querySelector("#hud")!;
      const lockedSpans = hud.querySelectorAll(".exit-locked");
      expect(lockedSpans.length).toBeGreaterThan(0);
      expect(
        Array.from(lockedSpans).some((s) => s.textContent?.includes("West (Iron Gate, locked)")),
      ).toBe(true);
    });

    it("shows a single .exit-locked 'none' when no exits or locked doors", async () => {
      el.vm = makeVM({ exits: [], lockedDoors: [] });
      await el.updateComplete;
      const hud = el.shadowRoot!.querySelector("#hud")!;
      const locked = hud.querySelectorAll(".exit-locked");
      expect(locked).toHaveLength(1);
      expect(locked[0]!.textContent).toBe("none");
    });
  });

  // 4. Click events
  describe("click events", () => {
    it("clicking .exit-link emits fill-input with 'go <dir>' (bubbles+composed)", async () => {
      el.vm = makeVM({
        exits: [{ dir: "south", toName: "Cellar" }],
      });
      await el.updateComplete;

      let received: CustomEvent | null = null;
      el.addEventListener("fill-input", (ev) => {
        received = ev as CustomEvent;
      });

      const link = el.shadowRoot!.querySelector<HTMLElement>(".exit-link")!;
      link.click();

      expect(received).not.toBeNull();
      expect((received as unknown as CustomEvent).detail.value).toBe("go south");
      expect((received as unknown as CustomEvent).bubbles).toBe(true);
      expect((received as unknown as CustomEvent).composed).toBe(true);
    });

    it("clicking a .noun emits fill-input with 'examine <noun>' (bubbles+composed)", async () => {
      el.vm = makeVM({
        loot: [{ id: "x", description: "a lantern.", opened: false, contents: [] }],
      });
      el.clickableNouns = ["lantern"];
      await el.updateComplete;

      let received: CustomEvent | null = null;
      el.addEventListener("fill-input", (ev) => {
        received = ev as CustomEvent;
      });

      const noun = el.shadowRoot!.querySelector<HTMLElement>(".noun")!;
      noun.click();

      expect(received).not.toBeNull();
      expect((received as unknown as CustomEvent).detail.value).toBe("examine lantern");
      expect((received as unknown as CustomEvent).bubbles).toBe(true);
      expect((received as unknown as CustomEvent).composed).toBe(true);
    });
  });
});
