import { describe, it } from "vitest";
import { replayFacade } from "./facade-replay.ts";

describe("facade-legality differential conformance", () => {
  it("Authority matches the seeded GameSession oracle per op", () => {
    replayFacade("facade-legality");
  });
});
