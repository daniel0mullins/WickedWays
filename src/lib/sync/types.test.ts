import { describe, it, expect } from "vitest";
import { commandActorId, isTurnAction, isGmCommand, isSetupCommand, isJoinCommand } from "./types";
import type { Command } from "./types";

describe("command classifiers", () => {
  it("classifies turn actions and exposes their actorId", () => {
    const move: Command = { kind: "move", actorId: "c1" as never, roomId: "r1" as never };
    expect(isTurnAction(move)).toBe(true);
    expect(commandActorId(move)).toBe("c1");
    expect(isGmCommand(move)).toBe(false);
  });

  it("classifies GM/lifecycle commands", () => {
    const next: Command = { kind: "nextPlayer" };
    expect(isGmCommand(next)).toBe(true);
    expect(isTurnAction(next)).toBe(false);
    expect(commandActorId(next)).toBeNull();
  });

  it("classifies setup commands", () => {
    const sel: Command = { kind: "selectArchetype", actorId: "c1" as never, archetypeId: "a1" as never };
    expect(isSetupCommand(sel)).toBe(true);
    expect(isTurnAction(sel)).toBe(false);
  });

  it("classifies a join command and exposes no actorId", () => {
    const join: Command = { kind: "joinCampaign", character: { kind: "player", id: "c9" } as never };
    expect(isJoinCommand(join)).toBe(true);
    expect(isTurnAction(join)).toBe(false);
    expect(isGmCommand(join)).toBe(false);
    expect(commandActorId(join)).toBeNull();
  });
});
