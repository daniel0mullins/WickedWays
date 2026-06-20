import { describe, it, expect } from "vitest";
import { resolveOutcome, type VictoryCondition } from "./victory";
import type { ICampaign } from "./campaign";

const campaign = {} as unknown as ICampaign;
const always = (key: string): VictoryCondition => ({ key, test: () => true });
const never = (key: string): VictoryCondition => ({ key, test: () => false });

describe("resolveOutcome", () => {
  it("returns ongoing when no condition fires and the ceiling is not reached", () => {
    const r = resolveOutcome({ round: 3, maxRounds: 10, winConditions: [never("w")], loseConditions: [never("l")], campaign });
    expect(r).toEqual({ status: "ongoing" });
  });

  it("resolves won when a win condition fires, carrying the firing condition", () => {
    const win = always("all-bosses-down");
    const r = resolveOutcome({ round: 3, maxRounds: 10, winConditions: [win], loseConditions: [never("l")], campaign });
    expect(r.status).toBe("won");
    expect(r.condition).toBe(win);
  });

  it("resolves lost and evaluates loss before win when both fire", () => {
    const lose = always("party-wiped");
    const r = resolveOutcome({ round: 3, maxRounds: 10, winConditions: [always("w")], loseConditions: [lose], campaign });
    expect(r.status).toBe("lost");
    expect(r.condition).toBe(lose);
  });

  it("resolves timed-out at the ceiling only when no condition fires", () => {
    const r = resolveOutcome({ round: 10, maxRounds: 10, winConditions: [never("w")], loseConditions: [never("l")], campaign });
    expect(r).toEqual({ status: "timed-out" });
  });

  it("prefers a win on the final round over the timeout", () => {
    const win = always("escape");
    const r = resolveOutcome({ round: 10, maxRounds: 10, winConditions: [win], loseConditions: [never("l")], campaign });
    expect(r.status).toBe("won");
    expect(r.condition).toBe(win);
  });

  it("returns the first firing condition in list order", () => {
    const first = always("a");
    const second = always("b");
    const r = resolveOutcome({ round: 1, maxRounds: 10, winConditions: [first, second], loseConditions: [], campaign });
    expect(r.condition).toBe(first);
  });
});
