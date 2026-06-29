// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Hotspot } from "../affordances.js";
import "./pnc-scene.js";
import type { PncScene } from "./pnc-scene.js";

describe("<pnc-scene>", () => {
  let el: PncScene;

  beforeEach(async () => {
    el = document.createElement("pnc-scene");
    document.body.appendChild(el);
    await el.updateComplete;
  });

  afterEach(() => {
    el.remove();
  });

  // ── defaults ──────────────────────────────────────────────────────────────────

  it("renders .scene container with no hotspots by default", () => {
    expect(el.shadowRoot!.querySelector(".scene")).not.toBeNull();
    expect(el.shadowRoot!.querySelectorAll(".hotspot")).toHaveLength(0);
  });

  // ── perimeter placement — all 8 compass directions ────────────────────────────

  const DIRS: { dir: Hotspot["dir"] & string; expectedLeft: string; expectedTop: string }[] = [
    { dir: "north",     expectedLeft: "50%", expectedTop: "5%"  },
    { dir: "south",     expectedLeft: "50%", expectedTop: "90%" },
    { dir: "east",      expectedLeft: "90%", expectedTop: "50%" },
    { dir: "west",      expectedLeft: "5%",  expectedTop: "50%" },
    { dir: "northeast", expectedLeft: "85%", expectedTop: "10%" },
    { dir: "northwest", expectedLeft: "10%", expectedTop: "10%" },
    { dir: "southeast", expectedLeft: "85%", expectedTop: "85%" },
    { dir: "southwest", expectedLeft: "10%", expectedTop: "85%" },
  ];

  for (const { dir, expectedLeft, expectedTop } of DIRS) {
    it(`exit at "${dir}" placed at left=${expectedLeft}, top=${expectedTop}`, async () => {
      const hotspot: Hotspot = {
        key: dir,
        label: dir.charAt(0).toUpperCase() + dir.slice(1),
        kind: "exit",
        dir,
        actions: [],
      };
      el.hotspots = [hotspot];
      await el.updateComplete;

      const marker = el.shadowRoot!.querySelector<HTMLElement>(`[data-key="${dir}"]`);
      expect(marker, `marker for ${dir} should exist`).not.toBeNull();
      expect(marker!.style.left).toBe(expectedLeft);
      expect(marker!.style.top).toBe(expectedTop);
    });
  }

  // ── locked door ───────────────────────────────────────────────────────────────

  it("locked door has .locked class (dim)", async () => {
    el.hotspots = [{
      key: "north",
      label: "Iron Door",
      kind: "locked",
      dir: "north",
      actions: [],
    }];
    await el.updateComplete;

    const marker = el.shadowRoot!.querySelector(".hotspot");
    expect(marker).not.toBeNull();
    expect(marker!.classList.contains("locked")).toBe(true);
  });

  it("locked door is placed at the correct perimeter position", async () => {
    el.hotspots = [{
      key: "east",
      label: "Iron Gate",
      kind: "locked",
      dir: "east",
      actions: [],
    }];
    await el.updateComplete;

    const marker = el.shadowRoot!.querySelector<HTMLElement>("[data-dir='east']");
    expect(marker).not.toBeNull();
    expect(marker!.style.left).toBe("90%");
    expect(marker!.style.top).toBe("50%");
  });

  it("clicking a locked door does NOT emit 'hotspot' event", async () => {
    el.hotspots = [{
      key: "north",
      label: "Iron Door",
      kind: "locked",
      dir: "north",
      actions: [],
    }];
    await el.updateComplete;

    let fired = false;
    const handler = () => { fired = true; };
    document.addEventListener("hotspot", handler);

    const marker = el.shadowRoot!.querySelector<HTMLElement>(".hotspot");
    marker!.click();

    document.removeEventListener("hotspot", handler);
    expect(fired).toBe(false);
  });

  // ── interactive hotspot click ─────────────────────────────────────────────────

  it("clicking an exit hotspot emits 'hotspot' event (bubbles + composed) with its key", async () => {
    el.hotspots = [{
      key: "east",
      label: "East",
      kind: "exit",
      dir: "east",
      actions: [],
    }];
    await el.updateComplete;

    let received: CustomEvent | null = null;
    const handler = (ev: Event) => { received = ev as CustomEvent; };
    document.addEventListener("hotspot", handler);

    el.shadowRoot!.querySelector<HTMLElement>(".hotspot")!.click();

    document.removeEventListener("hotspot", handler);

    expect(received).not.toBeNull();
    expect((received as unknown as CustomEvent).detail.key).toBe("east");
    // detail must include numeric x/y coordinates for action-menu positioning
    expect(typeof (received as unknown as CustomEvent).detail.x).toBe("number");
    expect(typeof (received as unknown as CustomEvent).detail.y).toBe("number");
    expect((received as unknown as CustomEvent).bubbles).toBe(true);
    expect((received as unknown as CustomEvent).composed).toBe(true);
  });

  // ── body hotspot placement (occupant / loot / item) ───────────────────────────

  it("single occupant is centered (left: 50%)", async () => {
    el.hotspots = [{
      key: "orc-1",
      label: "Orc",
      kind: "occupant",
      actions: [],
    }];
    await el.updateComplete;

    const marker = el.shadowRoot!.querySelector<HTMLElement>("[data-key='orc-1']");
    expect(marker).not.toBeNull();
    expect(marker!.style.left).toBe("50%");
  });

  it("two body hotspots get different deterministic positions (left: 20% and 80%)", async () => {
    el.hotspots = [
      { key: "orc-1",   label: "Orc",   kind: "occupant", actions: [] },
      { key: "chest-1", label: "Chest", kind: "loot",     actions: [] },
    ];
    await el.updateComplete;

    const m1 = el.shadowRoot!.querySelector<HTMLElement>("[data-key='orc-1']")!;
    const m2 = el.shadowRoot!.querySelector<HTMLElement>("[data-key='chest-1']")!;
    expect(m1).not.toBeNull();
    expect(m2).not.toBeNull();

    expect(m1.style.left).toBe("20%");
    expect(m2.style.left).toBe("80%");
    // Positions must differ (deterministic, not random)
    expect(m1.style.left).not.toBe(m2.style.left);
  });

  it("three body hotspots are spread deterministically (20%, 50%, 80%)", async () => {
    el.hotspots = [
      { key: "a", label: "A", kind: "occupant", actions: [] },
      { key: "b", label: "B", kind: "loot",     actions: [] },
      { key: "c", label: "C", kind: "item",     actions: [] },
    ];
    await el.updateComplete;

    const ma = el.shadowRoot!.querySelector<HTMLElement>("[data-key='a']")!;
    const mb = el.shadowRoot!.querySelector<HTMLElement>("[data-key='b']")!;
    const mc = el.shadowRoot!.querySelector<HTMLElement>("[data-key='c']")!;

    expect(ma.style.left).toBe("20%");
    expect(mb.style.left).toBe("50%");
    expect(mc.style.left).toBe("80%");
  });

  it("clicking an occupant hotspot emits 'hotspot' event with occupant key", async () => {
    el.hotspots = [{
      key: "revenant-123",
      label: "Revenant",
      kind: "occupant",
      actions: [],
    }];
    await el.updateComplete;

    let received: CustomEvent | null = null;
    const handler = (ev: Event) => { received = ev as CustomEvent; };
    document.addEventListener("hotspot", handler);

    el.shadowRoot!.querySelector<HTMLElement>(".hotspot")!.click();

    document.removeEventListener("hotspot", handler);

    expect(received).not.toBeNull();
    expect((received as unknown as CustomEvent).detail.key).toBe("revenant-123");
  });

  // ── image vs marker ────────────────────────────────────────────────────────────

  it("renders <img> when body hotspot has an image", async () => {
    el.hotspots = [{
      key: "revenant-1",
      label: "Revenant",
      kind: "occupant",
      image: "/images/revenant.png",
      actions: [],
    }];
    await el.updateComplete;

    const img = el.shadowRoot!.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("/images/revenant.png");
    // No body-marker when image is present
    expect(el.shadowRoot!.querySelector(".body-marker")).toBeNull();
  });

  it("renders kind-styled .body-marker when body hotspot has no image", async () => {
    el.hotspots = [{
      key: "orc-1",
      label: "Orc",
      kind: "occupant",
      actions: [],
    }];
    await el.updateComplete;

    const marker = el.shadowRoot!.querySelector(".body-marker");
    expect(marker).not.toBeNull();
    expect(marker!.classList.contains("occupant-marker")).toBe(true);
    expect(el.shadowRoot!.querySelector("img")).toBeNull();
  });

  it("loot hotspot uses .loot-marker class", async () => {
    el.hotspots = [{ key: "chest-1", label: "Chest", kind: "loot", actions: [] }];
    await el.updateComplete;

    const marker = el.shadowRoot!.querySelector(".body-marker");
    expect(marker).not.toBeNull();
    expect(marker!.classList.contains("loot-marker")).toBe(true);
  });

  it("item hotspot uses .item-marker class", async () => {
    el.hotspots = [{ key: "key-1", label: "Brass Key", kind: "item", actions: [] }];
    await el.updateComplete;

    const marker = el.shadowRoot!.querySelector(".body-marker");
    expect(marker).not.toBeNull();
    expect(marker!.classList.contains("item-marker")).toBe(true);
  });

  it("renders .door-marker for exit hotspot with no image", async () => {
    el.hotspots = [{
      key: "south",
      label: "South",
      kind: "exit",
      dir: "south",
      actions: [],
    }];
    await el.updateComplete;

    expect(el.shadowRoot!.querySelector(".door-marker")).not.toBeNull();
    expect(el.shadowRoot!.querySelector("img")).toBeNull();
  });

  it("renders <img> for exit hotspot with an image (no door-marker)", async () => {
    el.hotspots = [{
      key: "north",
      label: "North Gate",
      kind: "exit",
      dir: "north",
      image: "/images/gate.png",
      actions: [],
    }];
    await el.updateComplete;

    const img = el.shadowRoot!.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("/images/gate.png");
    expect(el.shadowRoot!.querySelector(".door-marker")).toBeNull();
  });

  // ── label text ─────────────────────────────────────────────────────────────────

  it("each hotspot renders its label text", async () => {
    el.hotspots = [{
      key: "north",
      label: "North",
      kind: "exit",
      dir: "north",
      actions: [],
    }];
    await el.updateComplete;

    const hotspot = el.shadowRoot!.querySelector(".hotspot");
    expect(hotspot!.textContent).toContain("North");
  });

  // ── roomImage background ────────────────────────────────────────────────────────

  it("sets background-image on .scene when roomImage is provided", async () => {
    el.roomImage = "/rooms/dungeon.jpg";
    await el.updateComplete;

    const scene = el.shadowRoot!.querySelector<HTMLElement>(".scene");
    expect(scene!.style.backgroundImage).toContain("dungeon.jpg");
  });

  it("no background-image on .scene when roomImage is not set", async () => {
    await el.updateComplete;

    const scene = el.shadowRoot!.querySelector<HTMLElement>(".scene");
    expect(scene!.style.backgroundImage).toBe("");
  });

  // ── reactivity ────────────────────────────────────────────────────────────────

  it("re-renders when hotspots property is updated", async () => {
    el.hotspots = [{ key: "north", label: "North", kind: "exit", dir: "north", actions: [] }];
    await el.updateComplete;
    expect(el.shadowRoot!.querySelectorAll(".hotspot")).toHaveLength(1);

    el.hotspots = [
      { key: "north", label: "North", kind: "exit", dir: "north", actions: [] },
      { key: "south", label: "South", kind: "exit", dir: "south", actions: [] },
    ];
    await el.updateComplete;
    expect(el.shadowRoot!.querySelectorAll(".hotspot")).toHaveLength(2);
  });
});
