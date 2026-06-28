// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { defaultPncTheme, applyPncTheme } from "./theme.js";
import type { PncTheme } from "./theme.js";

describe("PncTheme / applyPncTheme", () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
  });

  it("defaultPncTheme has required shape", () => {
    const t = defaultPncTheme;
    // Base Theme fields
    expect(typeof t.id).toBe("string");
    expect(typeof t.label).toBe("string");
    // palette
    expect(typeof t.palette.bg).toBe("string");
    expect(typeof t.palette.panel).toBe("string");
    expect(typeof t.palette.ink).toBe("string");
    expect(typeof t.palette.accent).toBe("string");
    expect(typeof t.palette.warn).toBe("string");
    expect(typeof t.palette.critical).toBe("string");
    expect(typeof t.palette.hotspot).toBe("string");
    // fonts
    expect(typeof t.fonts.body).toBe("string");
    expect(typeof t.fonts.display).toBe("string");
    // scene
    expect(typeof t.scene.vignette).toBe("number");
    expect(typeof t.scene.grain).toBe("number");
    // fog is optional
  });

  it("applyPncTheme sets all --pnc-* palette properties", () => {
    applyPncTheme(root, defaultPncTheme);
    const s = root.style;
    expect(s.getPropertyValue("--pnc-bg")).toBe(defaultPncTheme.palette.bg);
    expect(s.getPropertyValue("--pnc-panel")).toBe(defaultPncTheme.palette.panel);
    expect(s.getPropertyValue("--pnc-ink")).toBe(defaultPncTheme.palette.ink);
    expect(s.getPropertyValue("--pnc-accent")).toBe(defaultPncTheme.palette.accent);
    expect(s.getPropertyValue("--pnc-warn")).toBe(defaultPncTheme.palette.warn);
    expect(s.getPropertyValue("--pnc-critical")).toBe(defaultPncTheme.palette.critical);
    expect(s.getPropertyValue("--pnc-hotspot")).toBe(defaultPncTheme.palette.hotspot);
  });

  it("applyPncTheme sets --pnc-font-body and --pnc-font-display", () => {
    applyPncTheme(root, defaultPncTheme);
    const s = root.style;
    expect(s.getPropertyValue("--pnc-font-body")).toBe(defaultPncTheme.fonts.body);
    expect(s.getPropertyValue("--pnc-font-display")).toBe(defaultPncTheme.fonts.display);
  });

  it("applyPncTheme sets --pnc-vignette and --pnc-grain", () => {
    applyPncTheme(root, defaultPncTheme);
    const s = root.style;
    expect(s.getPropertyValue("--pnc-vignette")).toBe(String(defaultPncTheme.scene.vignette));
    expect(s.getPropertyValue("--pnc-grain")).toBe(String(defaultPncTheme.scene.grain));
  });

  it("applyPncTheme sets --pnc-fog when fog is defined", () => {
    const withFog: PncTheme = {
      ...defaultPncTheme,
      scene: { ...defaultPncTheme.scene, fog: 0.4 },
    };
    applyPncTheme(root, withFog);
    expect(root.style.getPropertyValue("--pnc-fog")).toBe("0.4");
  });

  it("applyPncTheme clears --pnc-fog when fog is undefined", () => {
    // First set fog, then apply a theme without it
    root.style.setProperty("--pnc-fog", "0.5");
    const noFog: PncTheme = {
      ...defaultPncTheme,
      scene: { vignette: 0.1, grain: 0.0 },
    };
    applyPncTheme(root, noFog);
    expect(root.style.getPropertyValue("--pnc-fog")).toBe("");
  });
});
