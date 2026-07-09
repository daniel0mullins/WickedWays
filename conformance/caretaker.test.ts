import { describe, it } from "vitest";
import { replayFacade } from "./facade-replay.ts";

describe("caretaker differential conformance", () => {
  it("Authority matches the seeded GameSession oracle per op (composed caretaker beat)", () => {
    replayFacade("caretaker");
  });
});
