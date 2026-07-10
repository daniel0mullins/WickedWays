import { describe, it } from "vitest";
import { replayFacade } from "./facade-replay.ts";

describe("facade-open-fail differential conformance", () => {
  it("Authority matches the seeded GameSession oracle per op", () => {
    replayFacade("facade-open-fail");
  });
});
