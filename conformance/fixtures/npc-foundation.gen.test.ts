/**
 * npc-foundation golden — the NPC-foundation (Sub-plan 1, Tasks 1-4) end-to-end
 * differential fixture.
 *
 * A visible NPC ("Keeper") holds a Gate Key and shares the Hall with the player.
 * The op stream proves the whole foundation under the authoritative gate:
 *
 *   op 0  talk(Keeper)  — FREE (non-advancing): the co-located VISIBLE NPC
 *                         resolves (placeholder no-op, no error) and the round
 *                         does NOT tick. Step-0 state == the boot state, so its
 *                         view also witnesses the START invariants: Keeper is IN
 *                         view.occupants and the player holds NO key.
 *   op 1  wait          — advancing: the PC's startTurn fires the dual-encoded
 *                         `conformance:npc-handoff` mechanic (onTurnStart), which
 *                         emits GiveItem(Keeper → player, key) then
 *                         SetVisible(Keeper, false). After the step the key is in
 *                         the player's KEY list and gone from the NPC, and Keeper
 *                         (now invisible) is ABSENT from view.occupants / scope.
 *
 * DUAL ENCODING (the whole point): the handoff mechanic is authored twice —
 *   • a REAL TS closure (the oracle) returning the two Effects, and
 *   • the matching Rust DSL catalog entry (EffectTemplate GiveItem + SetVisible)
 *     carried in catalog.behaviors,
 * two encodings of ONE behavior; the gate proves they produce identical results.
 * Both sides key off the SAME deterministic ids (player:Ada / npc:Keeper /
 * npc:Keeper:item#0), so no runtime id resolution can drift between them.
 */
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { describe, it } from "vitest";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { createKey } from "wickedways/lib/inventory";
import { StatType } from "wickedways/lib/character/stats";
import { EffectKind, type Effect, type Mechanic } from "wickedways/lib/mechanics/mechanic";
import type { CharacterId } from "wickedways/lib/character/character";
import type { ItemId } from "wickedways/lib/inventory";
import { mulberry32 } from "../seeded-rng.ts";
import { OracleSession } from "./oracle-session.ts";
import { writeFacadeFixture, type FacadeOp } from "./facade-gen.ts";
import { mechanic, emit, lit } from "../../packages/campaigns/src/scripted/builders.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0xfacade7;

// The deterministic ids both encodings pin to (oracle pins pc.id = player:<name>;
// the assembler seats an NPC as npc:<name> and its i-th held item as
// npc:<name>:item#<i>).
const PLAYER_ID = "player:Ada";
const NPC_ID = "npc:Keeper";
const KEY_ID = "npc:Keeper:item#0";

const KEY_ITEM_KEY = "items/gate-key";
const HANDOFF_KEY = "conformance:npc-handoff";
const NPC_KEY = "npc/keeper";

// ── the handoff mechanic, encoding #1: the TS closure (the oracle) ──────────────
// onTurnStart hands the key from the Keeper to the player and hides the Keeper.
// One advancing op fires it exactly once (a second fire would violate the
// GiveItem carrying guard); the fixture uses a single `wait` to that end.
const handoffMechanic: Mechanic<Record<string, never>, void, never> = {
  initialState: () => ({}),
  onTurnStart: (): Effect[] => [
    { kind: EffectKind.GiveItem, from: NPC_ID as CharacterId, to: PLAYER_ID as CharacterId, item: KEY_ID as ItemId },
    { kind: EffectKind.SetVisible, target: NPC_ID as CharacterId, visible: false },
  ],
};

// ── the handoff mechanic, encoding #2: the Rust DSL (catalog.behaviors) ─────────
// The same two effects, authored as EffectTemplate GiveItem + SetVisible over the
// SAME literal ids. The Rust core interprets this; the oracle runs the closure.
const handoffBehavior = mechanic({
  init: {},
  hooks: {
    onTurnStart: [
      emit({ kind: "giveItem", from: lit(NPC_ID), to: lit(PLAYER_ID), item: lit(KEY_ID) }),
      emit({ kind: "setVisible", target: lit(NPC_ID), visible: lit(false) }),
    ],
  },
});

const makeGateKey = () => createKey({ name: "Gate Key", keyCode: "gate", consumeOnUse: false });

describe("generate npc-foundation golden", () => {
  it("writes genesis + catalog + per-op golden", () => {
    const rng = mulberry32(SEED);
    const registry = defineRegistry({
      items: { [KEY_ITEM_KEY]: makeGateKey },
      npcs: { [NPC_KEY]: { initialDialogue: "The gate is yours to open.", dialogue: [] } },
      mechanics: { [HANDOFF_KEY]: handoffMechanic },
    });

    const template = authorTemplate("NPC Foundation (conformance)", registry, {
      rng, maxRounds: 20, baseEncounterChance: 0,
    })
      .archetype({
        id: "delver", name: "Delver",
        baseStats: { [StatType.Health]: 10, [StatType.Sanity]: 8, [StatType.Energy]: 8 },
      })
      .room("Hall", { description: "A stone hall." })
      .startRoom("Hall")
      .npc("Keeper", {
        stats: { [StatType.Health]: 3, [StatType.Sanity]: 3, [StatType.Energy]: 3 },
        room: "Hall",
        behavior: NPC_KEY,
        holds: [KEY_ITEM_KEY],
      })
      .useMechanic(HANDOFF_KEY);

    const oracle = new OracleSession({
      builder: template, registry, aliases: {}, playerName: "Ada", archetype: "delver", rng,
    });

    // START invariants (pre-op): the VISIBLE Keeper is a co-located occupant, and
    // the player is not yet carrying the key.
    const startVm = oracle.view();
    const keeper = startVm.occupants.find((o) => o.id === NPC_ID);
    if (keeper === undefined) throw new Error("expected the visible Keeper in view.occupants at start");
    if (startVm.inventory.keys.some((k) => k.id === KEY_ID)) {
      throw new Error("player must NOT hold the key at start");
    }

    const ops: FacadeOp[] = [
      { kind: "submit", intent: { kind: "talk", npcId: NPC_ID } }, // FREE: resolves, round stays 0
      { kind: "submit", intent: { kind: "wait" } },                 // advancing: fires the handoff mechanic
    ];
    const catalog = { items: {}, aliases: {}, behaviors: { [HANDOFF_KEY]: handoffBehavior } };
    const steps = writeFacadeFixture(here, "npc-foundation", SEED, oracle, catalog, ops);

    type Vm = {
      occupants: { id: string }[];
      scope: { id: string }[];
      inventory: { keys: { id: string }[] };
    };
    type Snap = { campaign: { round: number } };

    // (a)+(b) talk is FREE: resolves without error and does NOT advance the round.
    const talkResult = steps[0]!.result as { error?: string };
    if (talkResult.error !== undefined) throw new Error(`talk must resolve, got error ${talkResult.error}`);
    const s0 = steps[0]!.snapshot as Snap;
    if (s0.campaign.round !== 0) throw new Error(`step 0 round expected 0, got ${s0.campaign.round}`);
    // Step-0 view still shows the visible Keeper and no held key (state unchanged).
    const v0 = steps[0]!.view as Vm;
    if (!v0.occupants.some((o) => o.id === NPC_ID)) throw new Error("step 0: Keeper must still be visible");
    if (v0.inventory.keys.some((k) => k.id === KEY_ID)) throw new Error("step 0: player must not yet hold the key");

    // (c) after the mechanic fired: the key moved to the player's KEY list, the
    // Keeper is invisible → absent from occupants AND scope, and the round ticked.
    const s1 = steps[1]!.snapshot as Snap;
    if (s1.campaign.round !== 1) throw new Error(`step 1 round expected 1, got ${s1.campaign.round}`);
    const v1 = steps[1]!.view as Vm;
    if (!v1.inventory.keys.some((k) => k.id === KEY_ID)) throw new Error("step 1: key must be in the player's key list");
    if (v1.occupants.some((o) => o.id === NPC_ID)) throw new Error("step 1: hidden Keeper must be absent from occupants");
    if (v1.scope.some((e) => e.id === NPC_ID)) throw new Error("step 1: hidden Keeper must be absent from scope");
  });
});
