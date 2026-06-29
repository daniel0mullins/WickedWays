// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "./pnc-topbar.js";
import type { PncTopbar } from "./pnc-topbar.js";

describe("<pnc-topbar>", () => {
  let el: PncTopbar;

  beforeEach(() => {
    el = document.createElement("pnc-topbar");
    document.body.appendChild(el);
  });

  afterEach(() => {
    el.remove();
  });

  // 1. Room name
  describe("room name", () => {
    it("renders roomName on the left", async () => {
      el.roomName = "The Cursed Library";
      await el.updateComplete;
      const nameEl = el.shadowRoot!.querySelector(".room-name")!;
      expect(nameEl).not.toBeNull();
      expect(nameEl.textContent).toContain("The Cursed Library");
    });

    it("defaults roomName to empty string", async () => {
      await el.updateComplete;
      const nameEl = el.shadowRoot!.querySelector(".room-name")!;
      expect(nameEl.textContent).toBe("");
    });
  });

  // 2. Audio button
  describe("audio button", () => {
    it("reflects audioEnabled=false with aria-pressed='false' and title 'Audio: off'", async () => {
      el.audioEnabled = false;
      await el.updateComplete;
      const btn = el.shadowRoot!.querySelector<HTMLButtonElement>(".topbar-btn[aria-pressed]")!;
      expect(btn.getAttribute("aria-pressed")).toBe("false");
      expect(btn.getAttribute("title")).toBe("Audio: off");
    });

    it("reflects audioEnabled=true with aria-pressed='true' and title 'Audio: on'", async () => {
      el.audioEnabled = true;
      await el.updateComplete;
      const btn = el.shadowRoot!.querySelector<HTMLButtonElement>(".topbar-btn[aria-pressed]")!;
      expect(btn.getAttribute("aria-pressed")).toBe("true");
      expect(btn.getAttribute("title")).toBe("Audio: on");
    });

    it("emits toggle-audio (bubbles+composed) on click but does NOT self-toggle", async () => {
      el.audioEnabled = false;
      await el.updateComplete;

      let received: CustomEvent | null = null;
      el.addEventListener("toggle-audio", (ev) => {
        received = ev as CustomEvent;
      });

      const btn = el.shadowRoot!.querySelector<HTMLButtonElement>(".topbar-btn[aria-pressed]")!;
      btn.click();
      await el.updateComplete;

      expect(received).not.toBeNull();
      expect((received as unknown as CustomEvent).bubbles).toBe(true);
      expect((received as unknown as CustomEvent).composed).toBe(true);
      // Must NOT self-toggle — controller is responsible for updating audioEnabled
      expect(btn.getAttribute("aria-pressed")).toBe("false");
    });
  });

  // 3. Select auto-hide
  describe("select auto-hide", () => {
    it("renders no selects when soundpacks and themes are empty", async () => {
      el.soundpacks = [];
      el.themes = [];
      await el.updateComplete;
      expect(el.shadowRoot!.querySelectorAll("select")).toHaveLength(0);
    });

    it("renders no selects when each list has exactly 1 item", async () => {
      el.soundpacks = [{ id: "sp1", label: "Pack 1" }];
      el.themes = [{ id: "t1", label: "Theme 1" }];
      await el.updateComplete;
      expect(el.shadowRoot!.querySelectorAll("select")).toHaveLength(0);
    });

    it("renders the soundpack select with correct options and active value when >= 2 packs", async () => {
      el.soundpacks = [
        { id: "sp1", label: "Pack 1" },
        { id: "sp2", label: "Pack 2" },
      ];
      el.activeSoundpack = "sp2";
      el.themes = [];
      await el.updateComplete;

      const selects = el.shadowRoot!.querySelectorAll("select");
      expect(selects).toHaveLength(1);
      const select = selects[0] as HTMLSelectElement;
      const options = select.querySelectorAll("option");
      expect(options).toHaveLength(2);
      expect(options[0]!.value).toBe("sp1");
      expect(options[0]!.textContent).toBe("Pack 1");
      expect(options[1]!.value).toBe("sp2");
      expect(options[1]!.textContent).toBe("Pack 2");
      expect(select.value).toBe("sp2");
    });

    it("renders the theme select with correct options and active value when >= 2 themes", async () => {
      el.soundpacks = [];
      el.themes = [
        { id: "t1", label: "Theme 1" },
        { id: "t2", label: "Theme 2" },
      ];
      el.activeTheme = "t1";
      await el.updateComplete;

      const selects = el.shadowRoot!.querySelectorAll("select");
      expect(selects).toHaveLength(1);
      const select = selects[0] as HTMLSelectElement;
      const options = select.querySelectorAll("option");
      expect(options).toHaveLength(2);
      expect(options[0]!.value).toBe("t1");
      expect(options[0]!.textContent).toBe("Theme 1");
      expect(options[1]!.value).toBe("t2");
      expect(options[1]!.textContent).toBe("Theme 2");
      expect(select.value).toBe("t1");
    });

    it("renders both selects when soundpacks.length >= 2 and themes.length >= 2", async () => {
      el.soundpacks = [
        { id: "sp1", label: "Pack 1" },
        { id: "sp2", label: "Pack 2" },
      ];
      el.activeSoundpack = "sp1";
      el.themes = [
        { id: "t1", label: "Theme 1" },
        { id: "t2", label: "Theme 2" },
      ];
      el.activeTheme = "t2";
      await el.updateComplete;

      expect(el.shadowRoot!.querySelectorAll("select")).toHaveLength(2);
    });
  });

  // 4. soundpack-change event
  describe("soundpack-change event", () => {
    it("emits soundpack-change with the new id on select change (bubbles+composed)", async () => {
      el.soundpacks = [
        { id: "sp1", label: "Pack 1" },
        { id: "sp2", label: "Pack 2" },
      ];
      el.activeSoundpack = "sp1";
      el.themes = [];
      await el.updateComplete;

      let received: CustomEvent | null = null;
      el.addEventListener("soundpack-change", (ev) => {
        received = ev as CustomEvent;
      });

      const select = el.shadowRoot!.querySelector<HTMLSelectElement>("select")!;
      select.value = "sp2";
      select.dispatchEvent(new Event("change", { bubbles: true }));

      expect(received).not.toBeNull();
      expect((received as unknown as CustomEvent).detail.id).toBe("sp2");
      expect((received as unknown as CustomEvent).bubbles).toBe(true);
      expect((received as unknown as CustomEvent).composed).toBe(true);
    });
  });

  // 5. theme-change event
  describe("theme-change event", () => {
    it("emits theme-change with the new id on select change (bubbles+composed)", async () => {
      el.soundpacks = [];
      el.themes = [
        { id: "t1", label: "Theme 1" },
        { id: "t2", label: "Theme 2" },
      ];
      el.activeTheme = "t1";
      await el.updateComplete;

      let received: CustomEvent | null = null;
      el.addEventListener("theme-change", (ev) => {
        received = ev as CustomEvent;
      });

      const select = el.shadowRoot!.querySelector<HTMLSelectElement>("select")!;
      select.value = "t2";
      select.dispatchEvent(new Event("change", { bubbles: true }));

      expect(received).not.toBeNull();
      expect((received as unknown as CustomEvent).detail.id).toBe("t2");
      expect((received as unknown as CustomEvent).bubbles).toBe(true);
      expect((received as unknown as CustomEvent).composed).toBe(true);
    });
  });

  // 6. Map button
  describe("map button", () => {
    it("emits open-map (bubbles+composed) when clicked", async () => {
      await el.updateComplete;

      let received: CustomEvent | null = null;
      el.addEventListener("open-map", (ev) => {
        received = ev as CustomEvent;
      });

      const btn = el.shadowRoot!.querySelector<HTMLButtonElement>(".topbar-btn-map")!;
      expect(btn).not.toBeNull();
      btn.click();

      expect(received).not.toBeNull();
      expect((received as unknown as CustomEvent).bubbles).toBe(true);
      expect((received as unknown as CustomEvent).composed).toBe(true);
    });
  });

  // 7. Menu button
  describe("menu button", () => {
    it("emits open-menu (bubbles+composed) when clicked", async () => {
      await el.updateComplete;

      let received: CustomEvent | null = null;
      el.addEventListener("open-menu", (ev) => {
        received = ev as CustomEvent;
      });

      const btn = el.shadowRoot!.querySelector<HTMLButtonElement>(".topbar-btn-menu")!;
      expect(btn).not.toBeNull();
      btn.click();

      expect(received).not.toBeNull();
      expect((received as unknown as CustomEvent).bubbles).toBe(true);
      expect((received as unknown as CustomEvent).composed).toBe(true);
    });

    it("shows a gear icon and a 'Menu' title", async () => {
      await el.updateComplete;
      const btn = el.shadowRoot!.querySelector<HTMLButtonElement>(".topbar-btn-menu")!;
      expect(btn.textContent).toContain("⚙"); // ⚙ gear
      expect(btn.getAttribute("title")).toBe("Menu");
    });
  });

  // 8. Layout structure
  describe("layout structure", () => {
    it("has a left section and a controls section", async () => {
      await el.updateComplete;
      expect(el.shadowRoot!.querySelector(".topbar-left")).not.toBeNull();
      expect(el.shadowRoot!.querySelector(".topbar-controls")).not.toBeNull();
    });
  });
});
