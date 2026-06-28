// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "./crt-game.js";
import type { CrtGame } from "./crt-game.js";
import type { CrtTranscript } from "./crt-transcript.js";
import type { CrtHud } from "./crt-hud.js";
import type { CrtStatus } from "./crt-status.js";
import type { CrtPrompt } from "./crt-prompt.js";
import type { ViewModel } from "@wickedways/play-runtime";
import type { StatusField } from "wickedways/lib/presentation";

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

describe("<crt-game>", () => {
  let el: CrtGame;
  let container: HTMLDivElement;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    el = document.createElement("crt-game");
    container.appendChild(el);
    await el.updateComplete;
    const sr = el.shadowRoot!;
    const transcript = sr.querySelector("crt-transcript");
    const hud = sr.querySelector("crt-hud");
    const status = sr.querySelector("crt-status");
    const prompt = sr.querySelector("crt-prompt");
    await Promise.all([
      transcript?.updateComplete,
      hud?.updateComplete,
      status?.updateComplete,
      prompt?.updateComplete,
    ]);
  });

  afterEach(() => {
    el.remove();
    container.remove();
  });

  function getTranscript(): CrtTranscript {
    return el.shadowRoot!.querySelector("crt-transcript")!;
  }

  function getHud(): CrtHud {
    return el.shadowRoot!.querySelector("crt-hud")!;
  }

  function getStatus(): CrtStatus {
    return el.shadowRoot!.querySelector("crt-status")!;
  }

  function getPrompt(): CrtPrompt {
    return el.shadowRoot!.querySelector("crt-prompt")!;
  }

  // 1. Composition
  describe("composition", () => {
    it("renders one each of the four leaf components in the shadow", () => {
      const sr = el.shadowRoot!;
      expect(sr.querySelector("crt-transcript")).not.toBeNull();
      expect(sr.querySelector("crt-hud")).not.toBeNull();
      expect(sr.querySelector("crt-status")).not.toBeNull();
      expect(sr.querySelector("crt-prompt")).not.toBeNull();
    });

    it("transcript getter returns the crt-transcript element", () => {
      const t = el.transcript;
      expect(t).not.toBeNull();
      expect(t.tagName.toLowerCase()).toBe("crt-transcript");
    });
  });

  // 2. API delegation
  describe("API delegation", () => {
    it("setHud(vm) sets the hud's vm property", async () => {
      const vm = makeVM({
        exits: [{ dir: "north", toName: "Hallway" }],
      });
      el.setHud(vm);
      const hud = getHud();
      await hud.updateComplete;
      expect(hud.vm).toBe(vm);
    });

    it("setStatus sets location and fields on crt-status", async () => {
      const fields: readonly StatusField[] = [{ label: "Sanity", value: "9" }];
      el.setStatus("Foyer", fields);
      const status = getStatus();
      await status.updateComplete;
      expect(status.location).toBe("Foyer");
      expect(status.fields).toBe(fields);
    });

    it("setClickableNouns sets clickableNouns on BOTH hud and transcript", () => {
      el.setClickableNouns(["key", "door"]);
      expect(getHud().clickableNouns).toEqual(["key", "door"]);
      expect(getTranscript().clickableNouns).toEqual(["key", "door"]);
    });

    it("setPromptDisabled(true) disables the inner prompt input", async () => {
      el.setPromptDisabled(true);
      const prompt = getPrompt();
      await prompt.updateComplete;
      expect(prompt.disabled).toBe(true);
    });

    it("clearTranscript() delegates to transcript.clear()", async () => {
      const transcript = getTranscript();
      await transcript.updateComplete;
      transcript.print(["hello"]);
      el.clearTranscript();
      const scroll = transcript.shadowRoot!.querySelector("#transcript")!;
      expect(scroll.children).toHaveLength(0);
    });
  });

  // 3. Overlay
  describe("overlay", () => {
    it("openMap(svg) inserts .overlay with the svg and map legend text", () => {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      el.openMap(svg);
      const overlay = el.shadowRoot!.querySelector(".overlay");
      expect(overlay).not.toBeNull();
      expect(overlay!.querySelector("svg")).not.toBeNull();
      const legend = overlay!.querySelector(".overlay-legend");
      expect(legend).not.toBeNull();
      expect(legend!.textContent).toContain("─ open");
      expect(legend!.textContent).toContain("any key to close");
    });

    it("openHelp(rows) renders one .help-row per row and 'any key to close' legend", () => {
      el.openHelp(["examine <noun>", "go <dir>"]);
      const overlay = el.shadowRoot!.querySelector(".overlay");
      expect(overlay).not.toBeNull();
      const rows = overlay!.querySelectorAll(".help-row");
      expect(rows).toHaveLength(2);
      expect(rows[0]!.textContent).toBe("examine <noun>");
      expect(rows[1]!.textContent).toBe("go <dir>");
      const legend = overlay!.querySelector(".overlay-legend");
      expect(legend!.textContent).toBe("any key to close");
    });

    it("pressing any key on window dismisses the overlay", () => {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      el.openMap(svg);
      expect(el.shadowRoot!.querySelector(".overlay")).not.toBeNull();
      window.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true }),
      );
      expect(el.shadowRoot!.querySelector(".overlay")).toBeNull();
    });

    it("openMap is idempotent — second call ignored while overlay is open", () => {
      const svg1 = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      const svg2 = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      el.openMap(svg1);
      el.openMap(svg2);
      const overlays = el.shadowRoot!.querySelectorAll(".overlay");
      expect(overlays).toHaveLength(1);
    });

    it("closeOverlay() removes the overlay", () => {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      el.openMap(svg);
      expect(el.shadowRoot!.querySelector(".overlay")).not.toBeNull();
      el.closeOverlay();
      expect(el.shadowRoot!.querySelector(".overlay")).toBeNull();
    });
  });

  // 4. fill-input wiring
  describe("fill-input wiring", () => {
    it("fill-input from transcript sets prompt value and stops propagation at crt-game boundary", async () => {
      const prompt = getPrompt();
      await prompt.updateComplete;

      let leakedToParent = false;
      container.addEventListener("fill-input", () => {
        leakedToParent = true;
      });

      // Dispatch from the transcript element inside the shadow with composed:true
      getTranscript().dispatchEvent(
        new CustomEvent("fill-input", {
          detail: { value: "examine key" },
          bubbles: true,
          composed: true,
        }),
      );

      expect(prompt.getValue()).toBe("examine key");
      expect(leakedToParent).toBe(false);
    });
  });

  // 5. command bubbles out
  describe("command event propagation", () => {
    it("command from the inner prompt crosses the crt-game boundary", async () => {
      const prompt = getPrompt();
      await prompt.updateComplete;

      let received: CustomEvent | null = null;
      el.addEventListener("command", (ev) => {
        received = ev as CustomEvent;
      });

      // Submit the prompt form inside crt-prompt's shadow
      const form = prompt.shadowRoot!.querySelector<HTMLFormElement>(
        "#prompt-form",
      )!;
      const input = prompt.shadowRoot!.querySelector<HTMLInputElement>("#cmd")!;
      input.value = "go north";
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );

      expect(received).not.toBeNull();
      expect((received as unknown as CustomEvent).detail.line).toBe("go north");
    });
  });

  // 6. disconnectedCallback — no window listener leak
  describe("window listener teardown on disconnect", () => {
    it("disconnectedCallback removes the overlay window keydown listener", () => {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      el.openMap(svg);

      // Disconnect the element — should remove the window keydown listener
      el.remove();

      // The overlay's listener calls ev.preventDefault(). If the listener was
      // removed, the event's defaultPrevented stays false.
      const ev = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
    });
  });
});
