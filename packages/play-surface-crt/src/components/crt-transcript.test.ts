// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "./crt-transcript.js";
import type { CrtTranscript } from "./crt-transcript.js";

describe("<crt-transcript>", () => {
  let el: CrtTranscript;

  beforeEach(() => {
    vi.useFakeTimers();
    el = document.createElement("crt-transcript");
    document.body.appendChild(el);
  });

  afterEach(() => {
    el.remove();
    vi.useRealTimers();
  });

  function getTranscript(): HTMLDivElement {
    return el.shadowRoot!.querySelector<HTMLDivElement>("#transcript")!;
  }

  // 1. print() appends a single block with correct lines and class
  it("print() appends a single .block with one .line per entry; class applied", async () => {
    await el.updateComplete;
    el.print(["a", "b"], "echo");
    const transcript = getTranscript();
    const blocks = transcript.querySelectorAll(".block");
    expect(blocks).toHaveLength(1);
    const lines = blocks[0]!.querySelectorAll(".line");
    expect(lines).toHaveLength(2);
    expect(lines[0]!.classList.contains("echo")).toBe(true);
    expect(lines[0]!.textContent).toBe("a");
    expect(lines[1]!.classList.contains("echo")).toBe(true);
    expect(lines[1]!.textContent).toBe("b");
  });

  // 2. printRoom() renders header instantly; description types in; body appears
  it("printRoom() renders .room-name instantly; description types in; body is immediate", async () => {
    await el.updateComplete;
    const desc = "A dim hall."; // 11 chars → 11 * 22ms = 242ms total for firstVisit
    el.printRoom({ header: "Foyer", description: desc, body: ["Exits."], firstVisit: true });

    const transcript = getTranscript();
    // Header is rendered immediately
    const roomName = transcript.querySelector(".room-name")!;
    expect(roomName.textContent).toBe("Foyer");

    // Body line is rendered immediately (last .line in the block)
    const block = transcript.querySelector(".block")!;
    const blockLines = block.querySelectorAll(".line");
    // blockLines[0] = room-name, blockLines[1] = description, blockLines[2] = body
    expect(blockLines[2]!.textContent).toBe("Exits.");

    // Description starts empty (no timer tick yet)
    const descLine = blockLines[1]!;
    expect(descLine.textContent.length).toBeLessThan(desc.length);

    // After 5 ticks (5 * 22ms = 110ms) → 5 chars
    vi.advanceTimersByTime(5 * 22);
    expect(descLine.textContent).toBe(desc.slice(0, 5));

    // After 6 more ticks + 1ms → all 11 ticks done → description complete
    vi.advanceTimersByTime(6 * 22 + 1);
    expect(descLine.textContent).toBe(desc);
  });

  // 3. flush() completes a mid-run typewriter immediately; no further growth
  it("flush() completes the typewriter immediately; advancing timers after flush does nothing", async () => {
    await el.updateComplete;
    const desc = "A long description that takes a while to type."; // 46 chars
    el.printRoom({ header: "Room", description: desc, body: [], firstVisit: true });

    // Advance 5 ticks
    vi.advanceTimersByTime(5 * 22);
    const block = getTranscript().querySelector(".block")!;
    const descLine = block.querySelectorAll(".line")[1]!;
    expect(descLine.textContent.length).toBeGreaterThan(0);
    expect(descLine.textContent.length).toBeLessThan(desc.length);

    // flush() → full text immediately
    el.flush();
    expect(descLine.textContent).toBe(desc);

    // No further change after advancing timers
    const textAfterFlush = descLine.textContent;
    vi.advanceTimersByTime(2000);
    expect(descLine.textContent).toBe(textAfterFlush);
  });

  // 4. Reduced motion → description rendered instantly, no interval
  it("printRoom() sets full description instantly when prefers-reduced-motion matches", async () => {
    const original = window.matchMedia;
    window.matchMedia = (() => ({ matches: true } as MediaQueryList));
    try {
      await el.updateComplete;
      const desc = "A bright sunlit room.";
      el.printRoom({ header: "Bright", description: desc, body: [], firstVisit: true });

      const block = getTranscript().querySelector(".block")!;
      const descLine = block.querySelectorAll(".line")[1]!;
      // No timer advance needed — must be instant
      expect(descLine.textContent).toBe(desc);
    } finally {
      window.matchMedia = original;
    }
  });

  // 5. Clicking a .noun emits fill-input with "examine <noun>"
  it("clicking a .noun span emits fill-input {value:'examine <noun>'} bubbles+composed", async () => {
    await el.updateComplete;
    el.clickableNouns = ["goblin"];
    el.print(["A goblin lurks here."], "");

    const nounSpan = getTranscript().querySelector(".noun")!;
    expect(nounSpan.textContent).toBe("goblin");

    let received: CustomEvent | null = null;
    el.addEventListener("fill-input", (ev) => {
      received = ev as CustomEvent;
    });

    nounSpan.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));

    expect(received).not.toBeNull();
    expect((received as unknown as CustomEvent).detail.value).toBe("examine goblin");
    expect((received as unknown as CustomEvent).bubbles).toBe(true);
    expect((received as unknown as CustomEvent).composed).toBe(true);
  });

  // 6. clear() empties the transcript
  it("clear() removes all blocks from the transcript container", async () => {
    await el.updateComplete;
    el.print(["line 1"], "");
    el.print(["line 2"], "");
    const transcript = getTranscript();
    expect(transcript.querySelectorAll(".block")).toHaveLength(2);

    el.clear();
    expect(transcript.childNodes).toHaveLength(0);
  });

  // 7. disconnectedCallback clears the interval; no dangling timer growth
  it("disconnectedCallback clears the typewriter interval so removed element has no dangling timers", async () => {
    await el.updateComplete;
    const desc = "A slow description.";
    el.printRoom({ header: "Room", description: desc, body: [], firstVisit: true });

    // Advance partway
    vi.advanceTimersByTime(5 * 22);
    const block = getTranscript().querySelector(".block")!;
    const descLine = block.querySelectorAll(".line")[1]!;
    const textBeforeRemove = descLine.textContent;
    expect(textBeforeRemove).not.toBe(""); // some chars typed

    // Remove the element → disconnectedCallback → clearInterval
    el.remove();

    // Advancing timers must not throw and must not change the description
    expect(() => vi.advanceTimersByTime(2000)).not.toThrow();
    expect(descLine.textContent).toBe(textBeforeRemove);
  });
});
