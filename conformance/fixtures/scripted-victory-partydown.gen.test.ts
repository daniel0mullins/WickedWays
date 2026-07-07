/**
 * scripted-victory-partydown golden generator.
 *
 * TS side: the REAL Hollow House `party-down` closure (via the shared shadow) is
 * the oracle. Rust side: the same key resolves to the scripted `VictoryScript`
 * (`length(party) > 0 && every(party, status.includes("ko"))`). A bespoke
 * "Cursed Band" accessory (Health −99) is equipped on both PCs pre-snapshot, so
 * effective health = max(0, 12 − 99) = 0 and KO latches at each PC's first
 * startTurn. When both are down, the round resolves LOST.
 *
 * Writes scripted-victory-partydown.{start.snapshot,catalog,golden}.json.
 * Run via: pnpm run fixtures:gen
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { mulberry32 } from "../seeded-rng.ts";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { startSession } from "wickedways/lib/authoring/orchestration";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { Item, ItemType } from "wickedways/lib/inventory";
import type { ItemId } from "wickedways/lib/inventory";
import { StatType } from "wickedways/lib/character/stats";
import { SlotKind, EquipmentSlot } from "wickedways/lib/equipment";
import { Status } from "wickedways/lib/status";
import type { PresentationCue } from "wickedways/lib/presentation";
import { viewProjected } from "./gen-helpers.ts";
import { buildCatalog } from "./scripted-helpers.ts";
import { Conditions, Rooms } from "../../packages/campaigns/src/hollow-house/ids.ts";
import { hollowHouseBehaviors } from "../../packages/campaigns/src/hollow-house/scripted.ts";
import { partyDown } from "./hollow-victory-shadow.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0x51c3;
const BAND_KEY = "items/cursed-band";
const noop = () => {};

/** Cursed Band: an Accessory targeting Health with a −99 modifier (no durability). */
function makeCursedBand(): Item {
  return new Item({
    descriptor: {
      behaviorKey: BAND_KEY,
      name: "Cursed Band",
      type: ItemType.Accessory,
      recipe: { item: 1 },
      modifier: -99,
      stat: StatType.Health,
      slot: SlotKind.Finger,
    },
    properties: { equippable: true, equipped: false, destroyable: true, usable: false },
    actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    events: { onPickUp: noop },
  });
}

type Command = { kind: "startTurn" } | { kind: "endTurn" } | { kind: "nextPlayer" };

describe("generate scripted-victory-partydown golden", () => {
  it("writes the booted snapshot + per-step golden (lost when the whole party is KO)", () => {
    const registry = defineRegistry({
      items: { [BAND_KEY]: makeCursedBand },
    });
    registry.registerCondition(Conditions.PartyDown, partyDown);

    const template = authorTemplate("Scripted Victory Party Down (conformance)", registry, {
      rng: mulberry32(SEED), maxRounds: 10, baseEncounterChance: 0,
    })
      .archetype({ id: "heir", name: "Heir",
        baseStats: { [StatType.Health]: 12, [StatType.Sanity]: 16, [StatType.Energy]: 5 } })
      .room(Rooms.Foyer, { description: "The entrance hall." })
      .startRoom(Rooms.Foyer)
      .loseWhen(Conditions.PartyDown, { text: "You fall, and do not rise. The house is patient. It has all the time there is." });

    const campaign = startSession(template, {
      players: [
        { name: "Ada", archetype: "heir" },
        { name: "Ben", archetype: "heir" },
      ],
      gm: 0,
    });

    // ── pre-snapshot: give each PC a cursed band and equip it ─────────────────
    campaign.party.forEach((pc, i) => {
      const band = makeCursedBand();
      band.id = `${BAND_KEY}#${i}` as ItemId;
      pc.addToInventory(band);
      pc.equip(band, EquipmentSlot.LeftIndexFinger);
    });

    const start = serializeCampaign(campaign);
    writeFileSync(join(here, "scripted-victory-partydown.start.snapshot.json"),
      JSON.stringify(start, null, 2) + "\n");

    let buf: PresentationCue[] = [];
    campaign.onCue((c: PresentationCue) => buf.push(c));
    const drain = () => { const out = buf; buf = []; return out; };

    const commands: Command[] = [
      { kind: "startTurn" }, // Ada KO latches
      { kind: "nextPlayer" },
      { kind: "startTurn" }, // Ben KO latches
      { kind: "nextPlayer" }, // round end → party.length > 0 && every KO → LOST
    ];

    const pcNow = () => campaign.activeCharacter;
    const steps = commands.map((cmd) => {
      switch (cmd.kind) {
        case "startTurn": pcNow().startTurn(); break;
        case "endTurn": pcNow().endTurn(); break;
        case "nextPlayer": campaign.nextPlayer(); break;
      }
      return {
        command: cmd,
        cues: drain(),
        snapshot: serializeCampaign(campaign),
        view: viewProjected(campaign),
      };
    });

    // ── self-checks ──────────────────────────────────────────────────────────
    // both party members are KO before the final resolution
    for (const pc of campaign.party) {
      if (!pc.status.includes(Status.KO)) {
        throw new Error(`expected ${pc.name} to be KO before resolution, status=${JSON.stringify(pc.status)}`);
      }
    }
    const last = steps[steps.length - 1]!;
    const res = last.cues.find((c) => c.kind === "resolution");
    if (!res) throw new Error(`expected a resolution cue on the final step, got ${JSON.stringify(last.cues)}`);
    if (res.kind === "resolution" && res.outcome !== "lost")
      throw new Error(`expected outcome "lost", got "${res.outcome}"`);
    if (res.kind === "resolution" &&
      res.narration?.text !== "You fall, and do not rise. The house is patient. It has all the time there is.")
      throw new Error(`expected the party-down narration, got ${JSON.stringify(res.narration)}`);
    if (campaign.outcome !== "lost") throw new Error(`expected campaign.outcome "lost", got "${campaign.outcome}"`);

    const behaviors = hollowHouseBehaviors();
    const catalog = buildCatalog(
      { [BAND_KEY]: makeCursedBand },
      [BAND_KEY],
      {},
      { [Conditions.PartyDown]: behaviors[Conditions.PartyDown]! },
    );
    writeFileSync(join(here, "scripted-victory-partydown.catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
    writeFileSync(join(here, "scripted-victory-partydown.golden.json"),
      JSON.stringify({ seed: SEED, commands, steps }, null, 2) + "\n");
  });
});
