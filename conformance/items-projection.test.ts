import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { canonicalize } from "./canonical-json.ts";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const wasm = require("../crates/wickedways-wasm/pkg/wickedways_wasm.js") as {
  view_model: (
    snapshot_json: string,
    catalog_json: string,
    opened_loot_json: string,
  ) => string;
};

const snapshotStr = readFileSync(
  join(here, "fixtures/items-projection.start.snapshot.json"),
  "utf8",
);
const catalogStr = readFileSync(
  join(here, "fixtures/items-projection.catalog.json"),
  "utf8",
);
const golden = JSON.parse(
  readFileSync(join(here, "fixtures/items-projection.golden.json"), "utf8"),
) as { view: Record<string, unknown> };

describe("items-projection differential conformance (sub-plan 3a)", () => {
  it("Rust view_model matches the TS oracle golden byte-for-byte", () => {
    const rawOut = wasm.view_model(snapshotStr, catalogStr, "[]");
    const got = JSON.parse(rawOut) as Record<string, unknown>;

    // Full canonical deep-equality against the golden
    expect(canonicalize(got), "full view canonical mismatch").toEqual(
      canonicalize(golden.view),
    );
  });

  it("inventory.items is non-empty and contains the expected items", () => {
    const rawOut = wasm.view_model(snapshotStr, catalogStr, "[]");
    const got = JSON.parse(rawOut) as {
      inventory?: { items?: Array<{ name: string }> };
    };
    expect(got.inventory?.items?.length, "inventory.items should be non-empty").toBeGreaterThan(0);
    const names = got.inventory!.items!.map((i) => i.name);
    expect(names, "inventory.items should include Iron Sword").toContain("Iron Sword");
    expect(names, "inventory.items should include Healing Tonic").toContain("Healing Tonic");
  });

  it("equippedNames contains Silver Ring", () => {
    const rawOut = wasm.view_model(snapshotStr, catalogStr, "[]");
    const got = JSON.parse(rawOut) as {
      inventory?: { equippedNames?: string[] };
    };
    expect(
      got.inventory?.equippedNames,
      "equippedNames should contain 'Silver Ring'",
    ).toContain("Silver Ring");
  });

  it("occupants have health populated", () => {
    const rawOut = wasm.view_model(snapshotStr, catalogStr, "[]");
    const got = JSON.parse(rawOut) as {
      occupants?: Array<{ health?: number }>;
    };
    expect(got.occupants?.length, "occupants should be non-empty").toBeGreaterThan(0);
    for (const occ of got.occupants ?? []) {
      expect(occ.health, "occupant health should be a number").toBeTypeOf("number");
    }
  });

  it("status.health and status.sanity are correct (sanity +3 from equipped accessory)", () => {
    const rawOut = wasm.view_model(snapshotStr, catalogStr, "[]");
    const got = JSON.parse(rawOut) as {
      status?: { health?: number; sanity?: number };
    };
    // Silver Ring is an accessory that adds +3 sanity; base is 10, so effective = 13
    expect(got.status?.health, "status.health").toBe(12);
    expect(got.status?.sanity, "status.sanity (+3 from Silver Ring accessory)").toBe(13);
  });

  it("loot entry has contents array", () => {
    const rawOut = wasm.view_model(snapshotStr, catalogStr, "[]");
    const got = JSON.parse(rawOut) as {
      loot?: Array<{ contents?: Array<{ name: string }> }>;
    };
    expect(got.loot?.length, "loot should be non-empty").toBeGreaterThan(0);
    const chest = got.loot![0]!;
    expect(chest.contents?.length, "loot contents should be non-empty").toBeGreaterThan(0);
    const contentNames = chest.contents!.map((c) => c.name);
    expect(contentNames, "loot contents should include Old Coin").toContain("Old Coin");
  });

  it("scope is ordered: occupants first, then loot items, then inventory items, then loot containers", () => {
    const rawOut = wasm.view_model(snapshotStr, catalogStr, "[]");
    const got = JSON.parse(rawOut) as {
      scope?: Array<{ kind: string; name: string }>;
    };
    expect(got.scope?.length, "scope should be non-empty").toBeGreaterThan(0);

    // Golden scope order from the fixture:
    // occupant(Ben), item(Old Coin in loot), item(Iron Sword), item(Silver Ring),
    // item(Healing Tonic), item(Old Key), loot(chest)
    const goldenScope = golden.view.scope as Array<{ kind: string; name: string }>;
    expect(
      canonicalize(got.scope),
      "scope ordering should match golden",
    ).toEqual(canonicalize(goldenScope));
  });
});
