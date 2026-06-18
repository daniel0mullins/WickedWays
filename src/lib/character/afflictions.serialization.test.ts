import { describe, it, expect } from "vitest";
import { Afflictions } from "./afflictions";
import { Status } from "../status";
import { SERIALIZE, HYDRATE } from "../serialization/symbols";

describe("Afflictions serialization", () => {
  it("round-trips active, turnsActive, shakenOff, and immunity verbatim", () => {
    const a = new Afflictions(() => 0.99); // high roll: never auto-clears
    // drive Fear active for 2 turns
    a.applyFromStats({ health: 10, sanity: 3, energy: 10 }, new Set());
    a.onTurnStart({ health: 10, sanity: 3, energy: 10 }, new Set());
    a.onTurnStart({ health: 10, sanity: 3, energy: 10 }, new Set());
    a.grantImmunity([Status.Confused], 3);

    const snap = a[SERIALIZE]();
    const b = new Afflictions(() => 0.99);
    b[HYDRATE](snap);
    expect(b[SERIALIZE]()).toEqual(snap);
    expect(b.list).toEqual(a.list);
  });
});
