// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { pncGlobalTokensCss, ensurePncTokens } from "./styles.js";

describe("pnc styles", () => {
  beforeEach(() => {
    const existing = document.head.querySelector("#pnc-global-tokens");
    if (existing) {
      existing.remove();
    }
  });

  it("pncGlobalTokensCss is a string containing key --pnc-* tokens", () => {
    expect(typeof pncGlobalTokensCss).toBe("string");
    expect(pncGlobalTokensCss).toContain("--pnc-bg:");
    expect(pncGlobalTokensCss).toContain("--pnc-panel:");
    expect(pncGlobalTokensCss).toContain("--pnc-ink:");
    expect(pncGlobalTokensCss).toContain("--pnc-accent:");
    expect(pncGlobalTokensCss).toContain("--pnc-warn:");
    expect(pncGlobalTokensCss).toContain("--pnc-critical:");
    expect(pncGlobalTokensCss).toContain("--pnc-hotspot:");
    expect(pncGlobalTokensCss).toContain("--pnc-font-body:");
    expect(pncGlobalTokensCss).toContain("--pnc-font-display:");
    expect(pncGlobalTokensCss).toContain("--pnc-vignette:");
    expect(pncGlobalTokensCss).toContain("--pnc-grain:");
  });

  it("pncGlobalTokensCss contains derived --color-* and --font-* aliases", () => {
    expect(pncGlobalTokensCss).toContain("--color-bg: var(--pnc-bg)");
    expect(pncGlobalTokensCss).toContain("--color-text: var(--pnc-ink)");
    expect(pncGlobalTokensCss).toContain("--color-accent: var(--pnc-accent)");
    expect(pncGlobalTokensCss).toContain("--font-body: var(--pnc-font-body)");
    expect(pncGlobalTokensCss).toContain("--font-head: var(--pnc-font-display)");
  });

  it("ensurePncTokens injects exactly one <style id=\"pnc-global-tokens\"> into document.head", () => {
    ensurePncTokens(document);

    const styleEl = document.head.querySelector<HTMLStyleElement>("#pnc-global-tokens");
    expect(styleEl).toBeTruthy();
    expect(styleEl?.textContent).toBe(pncGlobalTokensCss);
  });

  it("ensurePncTokens is idempotent: calling twice leaves exactly one #pnc-global-tokens", () => {
    ensurePncTokens(document);
    ensurePncTokens(document);

    const count = document.head.querySelectorAll("#pnc-global-tokens").length;
    expect(count).toBe(1);

    const styleEl = document.head.querySelector<HTMLStyleElement>("#pnc-global-tokens");
    expect(styleEl?.textContent).toBe(pncGlobalTokensCss);
  });

  it("ensurePncTokens defaults doc parameter to globalThis.document", () => {
    ensurePncTokens();

    const styleEl = document.head.querySelector<HTMLStyleElement>("#pnc-global-tokens");
    expect(styleEl).toBeTruthy();
    expect(styleEl?.textContent).toBe(pncGlobalTokensCss);
  });
});
