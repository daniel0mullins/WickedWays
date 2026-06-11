// src/lib/character/afflictions.test.ts
import { describe, expect, it } from "vitest";
import { Status } from "../status";
import { StatType, type Stats } from "./stats";
import { Afflictions } from "./afflictions";

const NONE = new Set<Status>();
// effective-stat snapshot helper (keys are StatType values)
const stats = (health: number, sanity: number, energy: number): Stats => ({
  [StatType.Health]: health,
  [StatType.Sanity]: sanity,
  [StatType.Energy]: energy,
});

describe("Afflictions.applyFromStats", () => {
  it("starts normal", () => {
    const a = new Afflictions(() => 0.5);
    expect(a.isNormal).toBe(true);
    expect(a.list).toEqual([]);
  });

  it("latches Panic at sanity <= 0 and Fear in (0, 5)", () => {
    const a = new Afflictions(() => 0.5);
    a.applyFromStats(stats(10, 0, 10), NONE);
    expect(a.list).toEqual([Status.Panic]);

    a.applyFromStats(stats(10, 3, 10), NONE);
    expect(a.list).toEqual([Status.Fear]);

    a.applyFromStats(stats(10, 5, 10), NONE);
    expect(a.isNormal).toBe(true);
  });

  it("sets Confused at energy <= 0 with a (0, 1] hold band", () => {
    const a = new Afflictions(() => 0.5);
    a.applyFromStats(stats(10, 10, 0), NONE);
    expect(a.list).toEqual([Status.Confused]);
    // hold band: stays Confused
    a.applyFromStats(stats(10, 10, 1), NONE);
    expect(a.list).toEqual([Status.Confused]);
    // above the band: clears
    a.applyFromStats(stats(10, 10, 2), NONE);
    expect(a.isNormal).toBe(true);
  });

  it("KO wipes the other statuses", () => {
    const a = new Afflictions(() => 0.5);
    a.applyFromStats(stats(10, 0, 0), NONE); // Panic + Confused
    a.applyFromStats(stats(0, 0, 0), NONE); // KO
    expect(a.list).toEqual([Status.KO]);
  });

  it("passive immunity suppresses a status and resets its episode", () => {
    const a = new Afflictions(() => 0.5);
    a.applyFromStats(stats(10, 0, 10), new Set([Status.Panic]));
    expect(a.isNormal).toBe(true);
    // immunity lifts, stat still depleted -> applies fresh
    a.applyFromStats(stats(10, 0, 10), NONE);
    expect(a.list).toEqual([Status.Panic]);
  });
});
