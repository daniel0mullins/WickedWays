import { describe, it, expect } from "vitest";
import { Codex } from "./codex";
import { HYDRATE_CODEX } from "./serialization/symbols";

describe("Codex hydrate", () => {
  it("injects pre-built entries preserving firstSeen and order", () => {
    const codex = new Codex();
    const entry = { kind: "material", key: "metal", snapshot: { type: "metal" },
      firstSeen: { round: 2, characterId: undefined, roomId: undefined } } as never;
    codex[HYDRATE_CODEX]([entry]);
    expect(codex.size).toBe(1);
    expect(codex.all[0]).toBe(entry);
  });
});
