import { describe, expect, it } from "vitest";
import { dreadScript, hollowHouseBehaviors, storytellerScript } from "./scripted.ts";
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

  it("registers all three mechanic keys", () => {
    expect(Object.keys(hollowHouseBehaviors()).sort())
      .toEqual(["dread", "status-bar", "storyteller"]);
  });
});
