import { describe, expect, it } from "vitest";

import type { LootId } from "./loot";
import { clamp, ContainerFullException, ProceduralViolation } from "./util";

describe("clamp", () => {
  it("returns the value when within range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });
  it("clamps to the lower bound", () => {
    expect(clamp(-3, 0, 10)).toBe(0);
  });
  it("clamps to the upper bound", () => {
    expect(clamp(42, 0, 10)).toBe(10);
  });
});

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
