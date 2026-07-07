import { describe, expect, it } from "vitest";
import { doorScript, dreadScript, hollowHouseBehaviors, storytellerScript } from "./scripted.ts";
import { LORE } from "./content.js";
import { Rooms } from "./ids.js";

describe("hollow-house scripted behaviors", () => {
  it("dread guards on the equipped lantern and drains sanity by 1", () => {
    expect(dreadScript).toEqual({
      family: "mechanic",
      script: {
        init: {},
        hooks: {
          onTurnStart: [
            { kind: "guard", cond: { kind: "not", expr:
              { kind: "hasEquipped", of: { kind: "actor" }, itemKey: "lantern" } } },
            { kind: "emit", effect: { kind: "adjustStat", target: { kind: "actor" },
              stat: "sanity", delta: { kind: "lit", value: -1 } } },
          ],
        },
        actions: {},
      },
    });
  });

  it("storyteller embeds the lore table and dedupes through state.seen", () => {
    const st = storytellerScript(LORE);
    if (st.family !== "mechanic") throw new Error("expected mechanic");
    expect(st.script.init).toEqual({ seen: {} });
    const body = st.script.hooks.onAction!;
    expect(body).toHaveLength(6);
    // the embedded MapLit carries the exact LORE fragments
    const hasGuard = body[1] as { kind: string; cond: { kind: string; map: { entries: Record<string, string> } } };
    expect(hasGuard.cond.map.entries[Rooms.Parlor]).toBe(LORE[Rooms.Parlor]);
  });

  it("door scripts mirror doorBehavior", () => {
    const door = doorScript("brass", "study door", "It opens.");
    expect(door).toEqual({
      family: "exit",
      script: {
        canPass: { kind: "bin", op: "or",
          left: { kind: "stateGet", field: "unlocked", default: false },
          right: { kind: "hasKey", of: { kind: "actor" }, keyCode: "brass" } },
        runScript: [{ kind: "when",
          cond: { kind: "not", expr: { kind: "stateGet", field: "unlocked", default: false } },
          then: [
            { kind: "setState", field: "unlocked", value: { kind: "lit", value: true } },
            { kind: "pass", value: { kind: "lit", value: "It opens." } },
          ] }],
        failMessage: "The study door won't budge — it's locked.",
      },
    });
    expect(Object.keys(hollowHouseBehaviors())).toContain("study-door");
    expect(Object.keys(hollowHouseBehaviors())).toContain("attic-door");
  });

  it("registers all ten behavior keys", () => {
    expect(Object.keys(hollowHouseBehaviors()).sort())
      .toEqual(["attic-door", "dread", "laudanum", "party-down", "rat-tail",
        "reached-attic-with-journal", "sanity-zero", "status-bar", "storyteller",
        "study-door"]);
  });
});
