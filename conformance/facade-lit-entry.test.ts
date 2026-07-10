import { describe, it } from "vitest";
import { replayFacade } from "./facade-replay.ts";

describe("facade-lit-entry differential conformance", () => {
  it("Authority matches the seeded GameSession oracle per op (no ambush on lit entry)", () => {
    replayFacade("facade-lit-entry");
  });
});
