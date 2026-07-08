import { describe, it, expect } from "vitest";
import { applyEffect } from "./apply.js";
import { Campaign } from "../campaign.js";
import { PlayerCharacter } from "../character/player-character.js";
import { StatType } from "../character/stats.js";
import { Status } from "../status.js";
import { assignNeutralArchetype } from "../../test-utils.js";
import { defineRegistry } from "../authoring/registry.js";
import { authorTemplate } from "../authoring/template-builder.js";
import { assemble } from "../authoring/assembler.js";
import { EffectKind } from "./mechanic.js";
import { Item, createKey, HELD_BY, type ItemId } from "../inventory.js";
import { ProceduralViolation } from "../util.js";
import type { PresentationCue } from "../presentation.js";

/** Build a started one-PC campaign containing a real PlayerCharacter. */
function makeStartedCampaign() {
  const campaign = new Campaign({ title: "Test" });
  const player = new PlayerCharacter({ campaign, name: "Hero" });
  player.joinCampaign();
  assignNeutralArchetype(campaign, player);
  campaign.gm = player;
  campaign.beginCampaign();
  return { campaign, player };
}

/** Build a started two-PC campaign (a giver and a taker), both in the party. */
function makeTwoPCCampaign() {
  const campaign = new Campaign({ title: "Test" });
  const giver = new PlayerCharacter({ campaign, name: "Giver" });
  const taker = new PlayerCharacter({ campaign, name: "Taker" });
  giver.joinCampaign();
  taker.joinCampaign();
  assignNeutralArchetype(campaign, giver);
  assignNeutralArchetype(campaign, taker);
  campaign.gm = giver;
  campaign.beginCampaign();
  return { campaign, giver, taker };
}

/** A minimal non-key item (occupies an inventory slot, unlike a key). */
function makeSword() {
  return new Item({
    descriptor: { type: "weapon", recipe: { metal: 1 }, modifier: 2, stat: StatType.Health, name: "Sword" },
    properties: { equippable: true, equipped: false, destroyable: true, usable: true },
    actions: {
      pickUp: () => {}, equip: () => {}, unequip: () => {},
      transfer: () => {}, use: () => {}, destroy: () => null,
    },
    events: { onPickUp: () => {} },
  });
}

describe("applyEffect", () => {
  it("damage floors the target's health at 0 and never goes negative", () => {
    const { campaign, player } = makeStartedCampaign();
    applyEffect(campaign, { kind: "damage", target: player.id, amount: 9999 });
    expect(player.effectiveStat(StatType.Health)).toBe(0);
  });

  it("rejects negative amounts by clamping to 0 (no healing via damage)", () => {
    const { campaign, player } = makeStartedCampaign();
    const before = player.effectiveStat(StatType.Health);
    applyEffect(campaign, { kind: "damage", target: player.id, amount: -5 });
    expect(player.effectiveStat(StatType.Health)).toBe(before);
  });

  it("emits a mechanic cue", () => {
    const { campaign } = makeStartedCampaign();
    const cues: unknown[] = [];
    campaign.onCue((c) => cues.push(c));
    applyEffect(campaign, { kind: "cue", cue: { text: "tick" } });
    expect(cues).toContainEqual({ kind: "mechanic", cue: { text: "tick" } });
  });

  it("adjustStat sanity routes to StatType.Sanity and floors at 0", () => {
    const { campaign, player } = makeStartedCampaign();
    applyEffect(campaign, { kind: "adjustStat", target: player.id, stat: "sanity", delta: -9999 });
    expect(player.effectiveStat(StatType.Sanity)).toBe(0);
  });

  it("adjustStat energy routes to StatType.Energy and floors at 0", () => {
    const { campaign, player } = makeStartedCampaign();
    applyEffect(campaign, { kind: "adjustStat", target: player.id, stat: "energy", delta: -9999 });
    expect(player.effectiveStat(StatType.Energy)).toBe(0);
  });

  it("heal increases health after prior damage", () => {
    const { campaign, player } = makeStartedCampaign();
    applyEffect(campaign, { kind: "damage", target: player.id, amount: 5 });
    const afterDamage = player.effectiveStat(StatType.Health);
    applyEffect(campaign, { kind: "heal", target: player.id, amount: 3 });
    expect(player.effectiveStat(StatType.Health)).toBe(afterDamage + 3);
  });

  it("grantImmunity suppresses active statuses on the next reconcile (isNormal via endTurn)", () => {
    // Deplete sanity fully to trigger Panic, then grant immunity and confirm it
    // clears via the character's public `isNormal` accessor (which reflects
    // `afflictions.isNormal`). endTurn() drives the reconcile while immunity is active.
    const { campaign, player } = makeStartedCampaign();
    applyEffect(campaign, { kind: "adjustStat", target: player.id, stat: "sanity", delta: -9999 });
    // Force affliction reconcile so Panic latches before immunity is applied.
    player.takeDamage(0, StatType.Sanity);
    expect(player.status).toContain(Status.Panic);

    applyEffect(campaign, { kind: "grantImmunity", target: player.id, turns: 2 });
    // endTurn reconciles afflictions while timed immunity is active — Panic must clear.
    player.endTurn();
    expect(player.isNormal).toBe(true);
  });
});

describe("applyEffect — giveItem", () => {
  it("routes by the source list (key→keyring, non-key→inventory) and re-homes the item object", () => {
    const { campaign, giver, taker } = makeTwoPCCampaign();
    const sword = makeSword();
    const key = createKey({ name: "Brass Key", keyCode: "door", consumeOnUse: false });
    giver.receiveItem(sword); // non-key → giver.inventory.items
    giver.receiveItem(key); // key → giver.inventory.keys

    applyEffect(campaign, { kind: EffectKind.GiveItem, from: giver.id, to: taker.id, item: sword.id });
    applyEffect(campaign, { kind: EffectKind.GiveItem, from: giver.id, to: taker.id, item: key.id });

    // Both leave the giver, each lands in the taker's type-matching list.
    expect(giver.inventory.items).not.toContain(sword);
    expect(giver.inventory.keys).not.toContain(key);
    expect(taker.inventory.items).toContain(sword);
    expect(taker.inventory.keys).toContain(key);
    // No cross-routing: a non-key never lands in the keyring, a key never in items.
    expect(taker.inventory.keys).not.toContain(sword);
    expect(taker.inventory.items).not.toContain(key);
    // The same item OBJECTS move (no re-creation); reachability follows the new
    // holder — the heldBy back-reference now points at the taker (via CLAIM).
    expect(sword[HELD_BY]).toBe(taker);
    expect(key[HELD_BY]).toBe(taker);
  });

  it("throws when the giver does not hold the item (carrying guard)", () => {
    const { campaign, giver, taker } = makeTwoPCCampaign();
    expect(() =>
      applyEffect(campaign, {
        kind: EffectKind.GiveItem, from: giver.id, to: taker.id, item: "ghost" as ItemId,
      }),
    ).toThrow(ProceduralViolation);
  });
});

describe("applyEffect — setVisible", () => {
  it("flips the target's visible flag reversibly", () => {
    const { campaign, taker } = makeTwoPCCampaign();
    expect(taker.visible).toBe(true); // characters start visible
    applyEffect(campaign, { kind: EffectKind.SetVisible, target: taker.id, visible: false });
    expect(taker.visible).toBe(false);
    applyEffect(campaign, { kind: EffectKind.SetVisible, target: taker.id, visible: true });
    expect(taker.visible).toBe(true);
  });
});

describe("applyEffect — status", () => {
  it("emits a status PresentationCue carrying the fields", () => {
    const registry = defineRegistry({ items: {} });
    const builder = authorTemplate("t", registry).room("R", { description: "r" }).startRoom("R");
    const { campaign } = assemble(builder.description, builder.registry);
    const cues: PresentationCue[] = [];
    campaign.onCue((c) => cues.push(c));

    applyEffect(campaign, {
      kind: EffectKind.Status,
      fields: [{ label: "Sanity", value: "12", emphasis: "warn" }],
    });

    expect(cues).toEqual([
      { kind: "status", fields: [{ label: "Sanity", value: "12", emphasis: "warn" }] },
    ]);
  });
});
