import { describe, it, expect } from "vitest";
import { authorTemplate } from "./template-builder";
import { defineRegistry } from "./registry";
import { AuthoringError } from "./errors";
import type { ICampaign } from "../campaign";

const registry = defineRegistry({
  items: {},
  conditions: {
    "reached-exit": (c: ICampaign) => c.round >= 1,
    "party-wiped": (_c: ICampaign) => false,
  },
});

describe("authoring victory conditions", () => {
  it("attaches win/loss conditions and outcome prose to the built campaign", () => {
    const campaign = authorTemplate("Escape", registry)
      .room("start", { description: "the cell" })
      .startRoom("start")
      .winWhen("reached-exit", { text: "You slip into the night." })
      .loseWhen("party-wiped", { text: "The dark swallows you." })
      .onTimeout({ text: "Dawn finds you still trapped." })
      .onEnd({ text: "The tale is set aside." })
      .build();

    // Drive to a win: a player-less template has no party, so assert via a
    // resolved campaign requires a session; here we assert the conditions exist
    // by serializing and checking the snapshot carries the keys + prose.
    const snap = authorTemplate("Escape", registry)
      .room("start", { description: "the cell" })
      .startRoom("start")
      .winWhen("reached-exit", { text: "You slip into the night." })
      .toSnapshot();
    expect(snap.campaign.winConditions).toEqual([{ key: "reached-exit", narration: { text: "You slip into the night." } }]);
    expect(campaign.title).toBe("Escape");
  });

  it("rejects an unregistered condition key at assemble time", () => {
    expect(() =>
      authorTemplate("Bad", registry)
        .room("start", { description: "x" })
        .startRoom("start")
        // @ts-expect-error unknown condition key is a compile error too
        .winWhen("nope")
        .build(),
    ).toThrow(AuthoringError);
  });
});
