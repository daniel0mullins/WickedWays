// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "./pnc-log.js";
import type { PncLog } from "./pnc-log.js";

describe("<pnc-log>", () => {
  let el: PncLog;

  beforeEach(async () => {
    el = document.createElement("pnc-log");
    document.body.appendChild(el);
    await el.updateComplete;
  });

  afterEach(() => {
    el.remove();
  });

  function getLog(): HTMLDivElement {
    return el.shadowRoot!.querySelector<HTMLDivElement>("#pnc-log")!;
  }

  it("renders a stable .log#pnc-log container", () => {
    const log = getLog();
    expect(log).not.toBeNull();
    expect(log.classList.contains("log")).toBe(true);
  });

  it("print() appends one .line per entry with correct class", () => {
    el.print(["a", "b"], "echo");
    const log = getLog();
    const lines = log.querySelectorAll(".line");
    expect(lines).toHaveLength(2);
    expect(lines[0]!.classList.contains("echo")).toBe(true);
    expect(lines[0]!.textContent).toBe("a");
    expect(lines[1]!.classList.contains("echo")).toBe(true);
    expect(lines[1]!.textContent).toBe("b");
  });

  it("print() with no cls produces lines with only 'line' class", () => {
    el.print(["hello"]);
    const log = getLog();
    const line = log.querySelector(".line")!;
    expect(line.textContent).toBe("hello");
    // Should not have echo/error/end added by default
    expect(line.className.trim()).toBe("line");
  });

  it("print() appends to existing lines (does not replace)", () => {
    el.print(["first"]);
    el.print(["second"], "echo");
    const log = getLog();
    const lines = log.querySelectorAll(".line");
    expect(lines).toHaveLength(2);
    expect(lines[0]!.textContent).toBe("first");
    expect(lines[1]!.textContent).toBe("second");
  });

  it("clear() removes all lines from the log container", () => {
    el.print(["line 1"]);
    el.print(["line 2"]);
    const log = getLog();
    expect(log.querySelectorAll(".line")).toHaveLength(2);

    el.clear();
    expect(log.childNodes).toHaveLength(0);
  });

  it("the log container reference is stable across multiple print() calls", () => {
    const logBefore = getLog();
    el.print(["a"]);
    el.print(["b"]);
    const logAfter = getLog();
    expect(logBefore).toBe(logAfter);
  });

  it("applies .error class correctly", () => {
    el.print(["Something went wrong"], "error");
    const line = getLog().querySelector(".line")!;
    expect(line.classList.contains("error")).toBe(true);
  });

  it("applies .end class correctly", () => {
    el.print(["The End."], "end");
    const line = getLog().querySelector(".line")!;
    expect(line.classList.contains("end")).toBe(true);
  });
});
