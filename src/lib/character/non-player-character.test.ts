import { describe, expect, it, vi } from "vitest";

import { Character } from "./character";
import { NonPlayerCharacter } from "./non-player-character";

import { makeCampaign, makeStats } from "../../test-utils";

// `IDialogue` is not exported, so we lean on the constructor's parameter type
// to structurally check these literals.
function makeNpc(
  dialogueBlocks: ConstructorParameters<typeof NonPlayerCharacter>[4] = [],
  initialDialogue = "Hello, traveller.",
) {
  return new NonPlayerCharacter(
    makeCampaign(),
    "Innkeeper",
    makeStats(),
    initialDialogue,
    dialogueBlocks,
  );
}

describe("NonPlayerCharacter", () => {
  describe("constructor", () => {
    it("is a Character", () => {
      expect(makeNpc()).toBeInstanceOf(Character);
    });

    it("stores the initial dialogue and dialogue blocks", () => {
      const blocks: ConstructorParameters<typeof NonPlayerCharacter>[4] = [
        { type: "exact", trigger: "hi", response: ["Hi there."] },
      ];
      const npc = makeNpc(blocks, "Welcome!");

      expect(npc.initialDialogue).toBe("Welcome!");
      expect(npc.dialogueBlocks).toBe(blocks);
    });
  });

  describe("dialogue() without a prompt", () => {
    it("returns the initial dialogue", () => {
      const npc = makeNpc([], "Greetings.");

      expect(npc.dialogue()).toEqual(["Greetings."]);
    });

    it("returns the initial dialogue for an empty-string prompt", () => {
      // An empty string is falsy, so it is treated as no prompt.
      const npc = makeNpc([], "Greetings.");

      expect(npc.dialogue("")).toEqual(["Greetings."]);
    });
  });

  describe("dialogue() exact matching", () => {
    it("returns the response when the prompt matches the trigger exactly", () => {
      const npc = makeNpc([
        { type: "exact", trigger: "open sesame", response: ["The door opens."] },
      ]);

      expect(npc.dialogue("open sesame")).toEqual(["The door opens."]);
    });

    it("does not match when the prompt only contains the trigger", () => {
      const npc = makeNpc([
        { type: "exact", trigger: "hello", response: ["Hi."] },
      ]);

      expect(npc.dialogue("well hello there")).toEqual([]);
    });

    it("is case insensitive", () => {
      const npc = makeNpc([
        { type: "exact", trigger: "Open Sesame", response: ["The door opens."] },
      ]);

      expect(npc.dialogue("open SESAME")).toEqual(["The door opens."]);
    });
  });

  describe("dialogue() fuzzy matching", () => {
    it("matches when every trigger word is present in the prompt", () => {
      const npc = makeNpc([
        {
          type: "fuzzy",
          trigger: new Set(["open", "door"]),
          response: ["It creaks open."],
        },
      ]);

      expect(npc.dialogue("could you please open the door")).toEqual([
        "It creaks open.",
      ]);
    });

    it("is case insensitive and ignores extra whitespace", () => {
      const npc = makeNpc([
        {
          type: "fuzzy",
          trigger: new Set(["open", "door"]),
          response: ["It creaks open."],
        },
      ]);

      expect(npc.dialogue("  OPEN   the    DOOR  ")).toEqual(["It creaks open."]);
    });

    it("matches regardless of the casing of the trigger words", () => {
      const npc = makeNpc([
        {
          type: "fuzzy",
          trigger: new Set(["Open", "DOOR"]),
          response: ["It creaks open."],
        },
      ]);

      expect(npc.dialogue("open the door")).toEqual(["It creaks open."]);
    });

    it("does not match when a trigger word is missing", () => {
      const npc = makeNpc([
        {
          type: "fuzzy",
          trigger: new Set(["open", "sesame"]),
          response: ["The door opens."],
        },
      ]);

      expect(npc.dialogue("open the gate")).toEqual([]);
    });
  });

  describe("dialogue() preconditions", () => {
    it("includes the response when the precondition passes", () => {
      const precondition = vi.fn(() => true);
      const npc = makeNpc([
        { type: "exact", trigger: "secret", response: ["Here it is."], precondition },
      ]);

      expect(npc.dialogue("secret")).toEqual(["Here it is."]);
      expect(precondition).toHaveBeenCalledWith(npc);
    });

    it("omits the response when the precondition fails", () => {
      const npc = makeNpc([
        {
          type: "exact",
          trigger: "secret",
          response: ["Here it is."],
          precondition: () => false,
        },
      ]);

      expect(npc.dialogue("secret")).toEqual([]);
    });

    it("applies preconditions to fuzzy blocks too", () => {
      const npc = makeNpc([
        {
          type: "fuzzy",
          trigger: new Set(["tell", "secret"]),
          response: ["A secret."],
          precondition: () => false,
        },
      ]);

      expect(npc.dialogue("tell me the secret")).toEqual([]);
    });
  });

  describe("dialogue() accumulation", () => {
    it("returns an empty array when nothing matches", () => {
      const npc = makeNpc([
        { type: "exact", trigger: "hi", response: ["Hi."] },
      ]);

      expect(npc.dialogue("goodbye")).toEqual([]);
    });

    it("concatenates responses from every matching block in order", () => {
      const npc = makeNpc([
        { type: "exact", trigger: "hello there", response: ["General Kenobi."] },
        {
          type: "fuzzy",
          trigger: new Set(["hello"]),
          response: ["Oh, hello."],
        },
      ]);

      expect(npc.dialogue("hello there")).toEqual([
        "General Kenobi.",
        "Oh, hello.",
      ]);
    });
  });
});
