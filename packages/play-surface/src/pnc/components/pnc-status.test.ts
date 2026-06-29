// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { StatusField } from "wickedways/lib/presentation";
import "./pnc-status.js";
import type { PncStatus } from "./pnc-status.js";

describe("<pnc-status>", () => {
  let el: PncStatus;

  beforeEach(() => {
    el = document.createElement("pnc-status");
    document.body.appendChild(el);
  });

  afterEach(() => {
    el.remove();
  });

  it("renders with no fields by default (empty)", async () => {
    await el.updateComplete;
    const status = el.shadowRoot!.querySelector(".status")!;
    expect(status).not.toBeNull();
    expect(status.querySelectorAll(".field")).toHaveLength(0);
  });

  it("renders label and value for each field", async () => {
    el.fields = [
      { label: "Sanity", value: "9" },
      { label: "Round", value: "3" },
    ] satisfies StatusField[];
    await el.updateComplete;

    const fields = el.shadowRoot!.querySelectorAll(".field");
    expect(fields).toHaveLength(2);
    expect(fields[0]!.textContent).toContain("Sanity");
    expect(fields[0]!.textContent).toContain("9");
    expect(fields[1]!.textContent).toContain("Round");
    expect(fields[1]!.textContent).toContain("3");
  });

  it("applies pnc-critical class for emphasis=critical", async () => {
    el.fields = [{ label: "Health", value: "1", emphasis: "critical" }];
    await el.updateComplete;

    const field = el.shadowRoot!.querySelector(".field")!;
    expect(field.classList.contains("pnc-critical")).toBe(true);
    expect(field.classList.contains("pnc-warn")).toBe(false);
  });

  it("applies pnc-warn class for emphasis=warn", async () => {
    el.fields = [{ label: "Sanity", value: "3", emphasis: "warn" }];
    await el.updateComplete;

    const field = el.shadowRoot!.querySelector(".field")!;
    expect(field.classList.contains("pnc-warn")).toBe(true);
    expect(field.classList.contains("pnc-critical")).toBe(false);
  });

  it("applies no emphasis class for emphasis=normal", async () => {
    el.fields = [{ label: "Mood", value: "ok", emphasis: "normal" }];
    await el.updateComplete;

    const field = el.shadowRoot!.querySelector(".field")!;
    expect(field.classList.contains("pnc-warn")).toBe(false);
    expect(field.classList.contains("pnc-critical")).toBe(false);
  });

  it("applies no emphasis class when emphasis is undefined", async () => {
    el.fields = [{ label: "Round", value: "5" }];
    await el.updateComplete;

    const field = el.shadowRoot!.querySelector(".field")!;
    expect(field.classList.contains("pnc-warn")).toBe(false);
    expect(field.classList.contains("pnc-critical")).toBe(false);
  });

  it("renders a proportional bar for fraction values (e.g. '9/20')", async () => {
    el.fields = [{ label: "Health", value: "9/20" }];
    await el.updateComplete;

    const bar = el.shadowRoot!.querySelector(".bar")!;
    expect(bar).not.toBeNull();
    const fill = bar.querySelector<HTMLElement>(".bar-fill");
    expect(fill).not.toBeNull();
    // 9/20 = 45%
    expect(fill!.style.width).toBe("45%");
  });

  it("renders a proportional bar for fraction values with spaces (e.g. '9 / 20')", async () => {
    el.fields = [{ label: "Health", value: "9 / 20" }];
    await el.updateComplete;

    const bar = el.shadowRoot!.querySelector(".bar")!;
    expect(bar).not.toBeNull();
    const fill = bar.querySelector<HTMLElement>(".bar-fill");
    expect(fill!.style.width).toBe("45%");
  });

  it("does NOT render a bar for plain (non-fraction) values", async () => {
    el.fields = [{ label: "Sanity", value: "7" }];
    await el.updateComplete;

    const bar = el.shadowRoot!.querySelector(".bar");
    expect(bar).toBeNull();
  });

  it("re-renders when fields property is updated", async () => {
    el.fields = [{ label: "Sanity", value: "7", emphasis: "warn" }];
    await el.updateComplete;

    expect(el.shadowRoot!.querySelector(".field")!.textContent).toContain("Sanity 7");
    expect(el.shadowRoot!.querySelector(".field")!.classList.contains("pnc-warn")).toBe(true);

    el.fields = [{ label: "Sanity", value: "3", emphasis: "critical" }];
    await el.updateComplete;

    expect(el.shadowRoot!.querySelector(".field")!.textContent).toContain("Sanity 3");
    expect(el.shadowRoot!.querySelector(".field")!.classList.contains("pnc-critical")).toBe(true);
    expect(el.shadowRoot!.querySelector(".field")!.classList.contains("pnc-warn")).toBe(false);
  });

  it("clamps bar to 100% if numerator > denominator", async () => {
    el.fields = [{ label: "Overheal", value: "25/20" }];
    await el.updateComplete;

    const fill = el.shadowRoot!.querySelector<HTMLElement>(".bar-fill");
    expect(fill).not.toBeNull();
    expect(fill!.style.width).toBe("100%");
  });
});
