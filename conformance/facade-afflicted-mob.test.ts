import { describe, it } from "vitest";
import { replayFacade } from "./facade-replay.ts";

describe("facade-afflicted-mob differential conformance", () => {
  it("Authority matches the seeded GameSession oracle per op", () => {
    replayFacade("facade-afflicted-mob");
  });
});
