import { describe, expect, it } from "vitest";
import { describeAction, type ActionHistoryEntry } from "./history";
import { StatType } from "./stats";
import type { CharacterId } from "./character";
import type { RoomId } from "../room";
import type { ItemId } from "../inventory";

describe("describeAction", () => {
  it("describes an attack", () => {
    const entry: ActionHistoryEntry = {
      kind: "attack",
      round: 1,
      target: { id: "c1" as CharacterId, name: "Goblin" },
    };
    expect(describeAction(entry)).toBe("attacked Goblin");
  });

  it("describes a move", () => {
    const entry: ActionHistoryEntry = {
      kind: "move",
      round: 1,
      room: { id: "r1" as RoomId, name: "Library" },
    };
    expect(describeAction(entry)).toBe("moved to Library");
  });

  it("describes a pickUp", () => {
    const entry: ActionHistoryEntry = {
      kind: "pickUp",
      round: 1,
      items: [
        { id: "i1" as ItemId, name: "Sword" },
        { id: "i2" as ItemId, name: "Shield" },
      ],
    };
    expect(describeAction(entry)).toBe("picked up Sword, Shield");
  });

  it("describes a drop", () => {
    const entry: ActionHistoryEntry = {
      kind: "drop",
      round: 1,
      items: [{ id: "i1" as ItemId, name: "Sword" }],
    };
    expect(describeAction(entry)).toBe("dropped Sword");
  });

  it("describes a successful escape", () => {
    expect(describeAction({ kind: "escape", round: 0, success: true })).toBe("escaped");
  });

  it("describes a failed escape", () => {
    expect(describeAction({ kind: "escape", round: 0, success: false })).toBe(
      "failed to escape",
    );
  });

  it("describes damage taken", () => {
    const entry: ActionHistoryEntry = {
      kind: "takeDamage",
      round: 1,
      amount: 4,
      stat: StatType.Sanity,
    };
    expect(describeAction(entry)).toBe("took 4 sanity damage");
  });

  it("describes a fumble", () => {
    expect(
      describeAction({ kind: "fumble", round: 2, action: "attack" }),
    ).toBe("fumbled attack");
  });
});
