import { describe, expect, it } from "vitest";

import type { LootId } from "./loot";
import { ContainerFullException, ProceduralViolation } from "./util";

describe("ProceduralViolation", () => {
  it("is an Error subclass carrying the provided message", () => {
    const error = new ProceduralViolation("not allowed");

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("not allowed");
  });

  it("sets its name so it is distinguishable from a plain Error", () => {
    expect(new ProceduralViolation("x").name).toBe("ProceduralViolation");
  });
});

describe("ContainerFullException", () => {
  it("is an Error subclass that names the full container in its message", () => {
    const error = new ContainerFullException("chest-7" as LootId);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Container chest-7 is full");
  });

  it("sets its name so it is distinguishable from a plain Error", () => {
    expect(new ContainerFullException("x" as LootId).name).toBe(
      "ContainerFullException",
    );
  });
});
