// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { globalTokensCss, ensureGlobalTokens } from "./styles.js";

describe("styles", () => {
  beforeEach(() => {
    // Clean up any existing #crt-global-tokens from prior tests
    const existing = document.head.querySelector("#crt-global-tokens");
    if (existing) {
      existing.remove();
    }
  });

  it("should export globalTokensCss as a string containing key tokens", () => {
    expect(typeof globalTokensCss).toBe("string");
    expect(globalTokensCss).toContain("--crt-bg: #0b0e0a");
    expect(globalTokensCss).toContain("--color-text: var(--crt-fg)");
    expect(globalTokensCss).toContain("--font-body: var(--crt-font-body)");
    expect(globalTokensCss).toContain("--plastic: #cdbb97");
    expect(globalTokensCss).toContain("box-sizing: border-box");
    expect(globalTokensCss).toContain("body { margin: 0; background: #0a0a0c; }");
  });

  it("should inject exactly one <style id=\"crt-global-tokens\"> into document.head with globalTokensCss", () => {
    ensureGlobalTokens(document);

    const styleElement = document.head.querySelector<HTMLStyleElement>("#crt-global-tokens");
    expect(styleElement).toBeTruthy();
    expect(styleElement?.textContent).toBe(globalTokensCss);
  });

  it("should be idempotent: calling ensureGlobalTokens twice leaves exactly one #crt-global-tokens", () => {
    ensureGlobalTokens(document);
    ensureGlobalTokens(document);

    const count = document.head.querySelectorAll("#crt-global-tokens").length;
    expect(count).toBe(1);

    // Also verify the content is correct
    const styleElement = document.head.querySelector<HTMLStyleElement>("#crt-global-tokens");
    expect(styleElement?.textContent).toBe(globalTokensCss);
  });

  it("should default doc parameter to globalThis document", () => {
    // Call without argument - should default to document
    ensureGlobalTokens();

    const styleElement = document.head.querySelector<HTMLStyleElement>("#crt-global-tokens");
    expect(styleElement).toBeTruthy();
    expect(styleElement?.textContent).toBe(globalTokensCss);
  });
});
