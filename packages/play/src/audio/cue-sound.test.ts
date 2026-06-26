import { describe, it, expect } from "vitest";
import type { PresentationCue } from "wickedways/lib/presentation";
import { soundForCue, soundForMobAttack, errorSound, detuneFactor } from "./cue-sound.js";

const actor = { id: "p1", name: "Heir" };

describe("soundForCue", () => {
  it("voices an attack action as a square hit", () => {
    const spec = soundForCue({ kind: "action", action: "attack", actor });
    expect(spec).not.toBeNull();
    expect(spec!.source).toBe("square");
    expect(spec!.duration).toBeGreaterThan(0);
    expect(spec!.gain).toBeGreaterThan(0);
  });

  it("voices takeDamage as a noise thud", () => {
    expect(soundForCue({ kind: "action", action: "takeDamage", actor })!.source).toBe("noise");
  });

  it("voices pickUp and drop as triangle blips with opposite glide", () => {
    const up = soundForCue({ kind: "action", action: "pickUp", actor })!;
    const down = soundForCue({ kind: "action", action: "drop", actor })!;
    expect(up.source).toBe("triangle");
    expect(down.source).toBe("triangle");
    expect(up.endFreq!).toBeGreaterThan(up.freq);
    expect(down.endFreq!).toBeLessThan(down.freq);
  });

  it("voices move as a noise whoosh", () => {
    expect(soundForCue({ kind: "action", action: "move", actor })!.source).toBe("noise");
  });

  it("returns null for escape, fumble, mechanicAction, and mechanic cues", () => {
    for (const action of ["escape", "fumble", "mechanicAction"] as const) {
      expect(soundForCue({ kind: "action", action, actor })).toBeNull();
    }
    expect(soundForCue({ kind: "mechanic", cue: { text: "x" } })).toBeNull();
  });

  it("voices an encounter as a rising sawtooth sting", () => {
    const spec = soundForCue({ kind: "encounter", mob: actor, room: { id: "r", name: "R" } })!;
    expect(spec.source).toBe("sawtooth");
    expect(spec.endFreq!).toBeGreaterThan(spec.freq);
  });

  it("voices visibility as a short click", () => {
    const spec = soundForCue({ kind: "visibility", room: { id: "r", name: "R" }, lit: true })!;
    expect(spec.duration).toBeLessThan(0.1);
  });

  it("voices resolution win as a rise and loss as a fall", () => {
    const win = soundForCue({ kind: "resolution", outcome: "won" })!;
    const lose = soundForCue({ kind: "resolution", outcome: "lost" })!;
    expect(win.endFreq!).toBeGreaterThan(win.freq);
    expect(lose.endFreq!).toBeLessThan(lose.freq);
  });

  it("jitters attack pitch deterministically by actor id", () => {
    const a = soundForCue({ kind: "action", action: "attack", actor: { id: "a", name: "A" } })!;
    const b = soundForCue({ kind: "action", action: "attack", actor: { id: "b", name: "B" } })!;
    const a2 = soundForCue({ kind: "action", action: "attack", actor: { id: "a", name: "A" } })!;
    expect(a.freq).toBe(a2.freq);   // deterministic
    expect(a.freq).not.toBe(b.freq); // varies by id
  });
});

describe("detuneFactor", () => {
  it("is deterministic and within a small band", () => {
    expect(detuneFactor("p1")).toBe(detuneFactor("p1"));
    expect(detuneFactor("p1")).toBeGreaterThan(0.9);
    expect(detuneFactor("p1")).toBeLessThan(1.1);
  });
});

describe("soundForMobAttack / errorSound", () => {
  it("voices a mob attack as a hit", () => {
    const spec = soundForMobAttack({ name: "Wraith", stat: 0 as unknown as never, amount: 3 });
    expect(spec.gain).toBeGreaterThan(0);
    expect(spec.duration).toBeGreaterThan(0);
  });
  it("produces a low error buzz", () => {
    expect(errorSound().freq).toBeLessThan(200);
  });
});
