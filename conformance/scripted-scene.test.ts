import { describe, it } from "vitest";
import { replayFacade } from "./facade-replay.ts";

describe("scripted-scene differential conformance", () => {
  it("Authority matches the seeded GameSession oracle per op (startup + scenes)", () => {
    replayFacade("scripted-scene");
  });
});
