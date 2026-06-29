// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "./crt-housing.js";
import type { CrtHousing } from "./crt-housing.js";

describe("<crt-housing>", () => {
  let el: CrtHousing;

  beforeEach(() => {
    el = document.createElement("crt-housing");
    document.body.appendChild(el);
  });

  afterEach(() => {
    el.remove();
  });

  // 1. DOM structure
  describe("shadow DOM structure", () => {
    it("renders .backdrop > .monitor > .monitor-screen > .screen", async () => {
      await el.updateComplete;
      const sr = el.shadowRoot!;
      const backdrop = sr.querySelector(".backdrop");
      expect(backdrop).not.toBeNull();
      const monitor = backdrop!.querySelector(".monitor");
      expect(monitor).not.toBeNull();
      const monitorScreen = monitor!.querySelector(".monitor-screen");
      expect(monitorScreen).not.toBeNull();
      const screen = monitorScreen!.querySelector(".screen");
      expect(screen).not.toBeNull();
    });

    it("renders .crt-overlay and .crt-sweep inside .monitor-screen", async () => {
      await el.updateComplete;
      const sr = el.shadowRoot!;
      const monitorScreen = sr.querySelector(".monitor-screen")!;
      expect(monitorScreen.querySelector(".crt-overlay")).not.toBeNull();
      expect(monitorScreen.querySelector(".crt-sweep")).not.toBeNull();
    });
  });

  // 2. Slot structure
  describe("slot structure", () => {
    it("has a <slot name='screen'> inside .screen", async () => {
      await el.updateComplete;
      const sr = el.shadowRoot!;
      const screen = sr.querySelector(".screen")!;
      const slot = screen.querySelector<HTMLSlotElement>("slot[name='screen']");
      expect(slot).not.toBeNull();
    });

    it("has a <slot name='bezel'> inside .monitor", async () => {
      await el.updateComplete;
      const sr = el.shadowRoot!;
      const monitor = sr.querySelector(".monitor")!;
      const slot = monitor.querySelector<HTMLSlotElement>("slot[name='bezel']");
      expect(slot).not.toBeNull();
    });
  });

  // 3. Slot assignment
  describe("slot assignment", () => {
    it("assigns a slot='screen' child to the screen slot", async () => {
      const child = document.createElement("div");
      child.slot = "screen";
      child.textContent = "welcome";
      el.appendChild(child);
      await el.updateComplete;

      const sr = el.shadowRoot!;
      const screenSlot = sr.querySelector<HTMLSlotElement>("slot[name='screen']")!;
      const assigned = screenSlot.assignedElements();
      expect(assigned).toContain(child);
    });

    it("assigns a slot='bezel' child to the bezel slot", async () => {
      const child = document.createElement("div");
      child.slot = "bezel";
      child.textContent = "controls";
      el.appendChild(child);
      await el.updateComplete;

      const sr = el.shadowRoot!;
      const bezelSlot = sr.querySelector<HTMLSlotElement>("slot[name='bezel']")!;
      const assigned = bezelSlot.assignedElements();
      expect(assigned).toContain(child);
    });

    it("assigns both slots independently when two children are added", async () => {
      const screenChild = document.createElement("div");
      screenChild.slot = "screen";
      const bezelChild = document.createElement("div");
      bezelChild.slot = "bezel";
      el.appendChild(screenChild);
      el.appendChild(bezelChild);
      await el.updateComplete;

      const sr = el.shadowRoot!;
      const screenSlot = sr.querySelector<HTMLSlotElement>("slot[name='screen']")!;
      const bezelSlot = sr.querySelector<HTMLSlotElement>("slot[name='bezel']")!;

      expect(screenSlot.assignedElements()).toContain(screenChild);
      expect(bezelSlot.assignedElements()).toContain(bezelChild);
      expect(screenSlot.assignedElements()).not.toContain(bezelChild);
      expect(bezelSlot.assignedElements()).not.toContain(screenChild);
    });
  });
});
