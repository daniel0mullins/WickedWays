import { describe, it } from "vitest";
import { replayFacade } from "./facade-replay.ts";

describe("facade-ko-piling differential conformance", () => {
  it("Authority matches the seeded GameSession oracle per op", () => {
    replayFacade("facade-ko-piling");
  });
});
