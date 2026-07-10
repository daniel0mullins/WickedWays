import { describe, it } from "vitest";
import { replayFacade } from "./facade-replay.ts";

describe("npc-foundation differential conformance", () => {
  it("Authority matches the seeded GameSession oracle per op", () => {
    replayFacade("npc-foundation");
  });
});
