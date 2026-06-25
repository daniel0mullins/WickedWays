import { describe, it, expect } from "vitest";
import { linkNouns } from "./link-nouns.js";
import type { Segment } from "./link-nouns.js";

/** Reconstruct the original line from segments — must always be exact. */
const join = (segs: Segment[]) => segs.map((s) => s.text).join("");

describe("linkNouns", () => {
  it("splits a line with one known noun into [plain, noun, plain]", () => {
    const segs = linkNouns("You see a Lantern on the shelf.", ["Lantern"]);
    expect(segs).toHaveLength(3);
    expect(segs[0]).toEqual({ text: "You see a " });
    expect(segs[1]).toEqual({ text: "Lantern", noun: "Lantern" });
    expect(segs[2]).toEqual({ text: " on the shelf." });
  });

  it("concatenating all .text reproduces the original line", () => {
    const line = "An Iron Fire-Poker rests by the hearth.";
    const segs = linkNouns(line, ["Iron Fire-Poker", "iron", "hearth"]);
    expect(join(segs)).toBe(line);
  });

  it("longest-first wins: 'Iron Fire-Poker' wins over 'iron'", () => {
    const segs = linkNouns("An Iron Fire-Poker rests nearby.", [
      "iron",
      "Iron Fire-Poker",
    ]);
    const nounSegs = segs.filter((s) => s.noun !== undefined);
    expect(nounSegs).toHaveLength(1);
    expect(nounSegs[0]?.noun).toBe("Iron Fire-Poker");
  });

  it("does not match 'iron' inside 'environment'", () => {
    const segs = linkNouns("The environment is cold.", ["iron"]);
    expect(segs.every((s) => s.noun === undefined)).toBe(true);
  });

  it("does not match 'on' inside 'iron' (mid-word guard)", () => {
    const segs = linkNouns("Iron bars block the way.", ["on"]);
    // 'on' is < 3 chars and should be filtered out entirely
    expect(segs.every((s) => s.noun === undefined)).toBe(true);
  });

  it("does not match 'iron' inside 'ironic'", () => {
    const segs = linkNouns("That would be ironic.", ["iron"]);
    expect(segs.every((s) => s.noun === undefined)).toBe(true);
  });

  it("a line with no known noun returns a single plain segment", () => {
    const segs = linkNouns("The room is dark and quiet.", ["Lantern"]);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toEqual({ text: "The room is dark and quiet." });
  });

  it("nouns shorter than 3 characters are ignored", () => {
    const segs = linkNouns("A is here. Go north.", ["A", "is", "Go"]);
    expect(segs.every((s) => s.noun === undefined)).toBe(true);
  });

  it("matches noun case-insensitively, preserving original surface text", () => {
    const segs = linkNouns("A LANTERN glows softly.", ["lantern"]);
    const noun = segs.find((s) => s.noun !== undefined);
    expect(noun).toBeDefined();
    expect(noun?.text).toBe("LANTERN"); // original casing preserved
    expect(noun?.noun).toBe("LANTERN");
  });

  it("handles multiple nouns in one line without overlap", () => {
    const line = "The Skeleton guards the Iron Gate.";
    const segs = linkNouns(line, ["Skeleton", "Iron Gate"]);
    const nouns = segs.filter((s) => s.noun !== undefined);
    expect(nouns).toHaveLength(2);
    expect(nouns.map((s) => s.text)).toEqual(["Skeleton", "Iron Gate"]);
    expect(join(segs)).toBe(line);
  });

  it("an empty line returns a single plain segment", () => {
    const segs = linkNouns("", ["Lantern"]);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toEqual({ text: "" });
  });

  it("preserves exact text when noun appears at start of line", () => {
    const segs = linkNouns("Lantern sits on the table.", ["Lantern"]);
    expect(segs[0]).toEqual({ text: "Lantern", noun: "Lantern" });
    expect(join(segs)).toBe("Lantern sits on the table.");
  });

  it("preserves exact text when noun appears at end of line", () => {
    const line = "You pick up the Lantern";
    const segs = linkNouns(line, ["Lantern"]);
    const last = segs[segs.length - 1];
    expect(last).toEqual({ text: "Lantern", noun: "Lantern" });
    expect(join(segs)).toBe(line);
  });
});
