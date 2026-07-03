/**
 * Mechanics custom-action golden generator — run once to write the committed
 * fixture files.
 *
 * Proves the 6a-3 custom mechanic action end-to-end: a PC invoking
 * `useMechanicAction("conformance:dread", "brace")` produces, from ONE command:
 *   1. mechanic  "You brace against the dread."   (brace's Cue effect, applied
 *      inside INVOKE_MECHANIC_ACTION before the action is recorded)
 *      + AdjustStat sanity +1 on the bracing actor (Ada 10 → 11)
 *   2. action    mechanicAction (actor player:Ada) (recordAction cue; budgeted —
 *      actionsThisRound 1 → 2 (the setup `move` ticked once, and this
 *      single-command stream issues no startTurn reset), below the cap of 3,
 *      so no auto endTurn)
 *   3. mechanic  "The dread notices."              (onAction dispatch)
 *
 * The TS shadow mechanic (shared `dreadShadow`, see dread-shadow.ts) reproduces
 * the Rust `conformance::DREAD` op byte-for-byte, including the `brace` action
 * (crates/wickedways-core/src/world/mechanics/conformance.rs `brace_effects`:
 * Cue BEFORE AdjustStat). The Rust op is compiled under `--features
 * conformance`, which the wasm build used by `pnpm run test:conformance`
 * enables.
 *
 * Seeded RNG is CRITICAL: a SINGLE shared `mulberry32(SEED)` instance —
 * mirroring the Rust World's single `pub rng: Rng` seeded once via
 * `replay_commands(.., seed)`. (No draws actually occur in this stream: the PC
 * is healthy — no status gate rolls — and baseEncounterChance is 0.)
 *
 * The start snapshot is serialized AFTER setup but BEFORE the command, and
 * carries `mechanics: [{ key: "conformance:dread", state: { ticks: 0 } }]`.
 * `beginCampaign` fires onRoundStart pre-snapshot (cue uncaptured, no state
 * change) — the Rust replay boots from the snapshot, so both sides agree.
 *
 * Writes:
 *   - mechanics-action.start.snapshot.json  (serialized genesis state, pre-command)
 *   - mechanics-action.catalog.json         (empty { items, aliases } — no items)
 *   - mechanics-action.golden.json          ({ seed, commands, steps:[{command,cues,snapshot,view}] })
 *
 * Run via:
 *   pnpm run fixtures:gen
 *
 * Interface contract with the Rust replay: each object in `golden.commands`
 * deserializes into the Rust `Command` enum (#[serde(tag="kind",
 * rename_all="camelCase")]):
 *   { "kind": "mechanicAction", "mechanicKey": "<key>", "actionKey": "<key>" }
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { mulberry32 } from "../seeded-rng.ts";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { assemble } from "wickedways/lib/authoring/assembler";
import { PlayerCharacter } from "wickedways/lib/character/player-character";
import type { CharacterId } from "wickedways/lib/character/character";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { StatType } from "wickedways/lib/character/stats";
import type { PresentationCue } from "wickedways/lib/presentation";
import type { Campaign } from "wickedways/lib/campaign";
import { DREAD_KEY, dreadShadow } from "./dread-shadow.ts";
import { view } from "../../packages/play-runtime/src/viewmodel.ts";

const here = dirname(fileURLToPath(import.meta.url));

// ─── Catalog (this campaign has no items) ────────────────────────────────────

const ALIASES: Record<string, string[]> = {};
const EMPTY_CATALOG = { items: {}, aliases: ALIASES };

// ─── TS shadow of the Rust `conformance:dread` op ─────────────────────────────
//
// Shared across all mechanics fixtures — see dread-shadow.ts. MUST match
// crates/wickedways-core/src/world/mechanics/conformance.rs byte-for-byte,
// including the `brace` custom action (Cue BEFORE AdjustStat sanity +1).

// ─── Registry ─────────────────────────────────────────────────────────────────

function buildFixtureRegistry() {
  return defineRegistry({
    items: {},
    mechanics: {
      [DREAD_KEY]: dreadShadow,
    },
  });
}

// ─── ViewModel projection helper (verbatim from mechanics.gen.test.ts) ────────

function viewProjected(
  campaign: Campaign,
  aliases: Record<string, string[]>,
  opened: ReadonlySet<string>,
) {
  const full = view(campaign, aliases, opened);

  const { image: _roomImage, ...roomRest } = full.room as { image?: unknown; [k: string]: unknown };
  const { locationName: _locName, ...statusRest } = full.status as { locationName?: unknown; [k: string]: unknown };

  return {
    room: roomRest,
    occupants: full.occupants,
    loot: full.loot,
    inventory: full.inventory,
    scope: full.scope,
    status: statusRest,
    outcome: full.outcome,
    finished: full.finished,
  };
}

// ─── Bespoke campaign builder ─────────────────────────────────────────────────
//
// Hall (start, lit), no mobs, no items. Player: Ada (health=10, sanity=10,
// energy=10). `.useMechanic("conformance:dread")` opts the campaign into the
// mechanic, so the serialized snapshot carries
// mechanics: [{ key, state: { ticks: 0 } }].
function buildActionCampaign(rng: () => number) {
  const registry = buildFixtureRegistry();

  const template = authorTemplate("Mechanics Action (conformance)", registry, {
    rng,
    maxRounds: 20,
    baseEncounterChance: 0,
  })
    .archetype({
      id: "fighter",
      name: "Fighter",
      baseStats: {
        [StatType.Health]: 10,
        [StatType.Sanity]: 10,
        [StatType.Energy]: 10,
      },
    })
    .room("Hall", { description: "A stone hall." })
    .startRoom("Hall")
    .useMechanic(DREAD_KEY);

  const { campaign, rooms } = assemble(template.description, template.registry);
  const hall = rooms.get("Hall")!;

  const ada = new PlayerCharacter({ campaign, name: "Ada", rng });
  ada.id = "player:Ada" as CharacterId;
  ada.joinCampaign();
  ada.selectArchetype("fighter" as never);
  ada.move(hall);

  campaign.gm = ada;
  campaign.beginCampaign();

  return { campaign, ada };
}

// ─── Command types ─────────────────────────────────────────────────────────────

type Command = { kind: "mechanicAction"; mechanicKey: string; actionKey: string };

// ─── Generator test ───────────────────────────────────────────────────────────

describe("generate mechanics-action golden", () => {
  it("writes the mechanics-action snapshot, catalog, and golden", () => {
    // Fixed seed: this stream draws NO rng (healthy PC, lit room, no encounter
    // rolls), so any seed yields the same golden. Coverage is asserted below
    // with hard throws instead of a seed search.
    const SEED = 1;
    const rng = mulberry32(SEED);
    const { campaign } = buildActionCampaign(rng);

    // ── Genesis snapshot (pre-command) ───────────────────────────────────────
    const start = serializeCampaign(campaign);

    // The snapshot must carry the mechanic's initial state.
    const startMechanics = start.campaign.mechanics;
    if (
      startMechanics.length !== 1 ||
      startMechanics[0]!.key !== DREAD_KEY ||
      JSON.stringify(startMechanics[0]!.state) !== JSON.stringify({ ticks: 0 })
    ) {
      throw new Error(
        `Start snapshot mechanics mismatch: ${JSON.stringify(startMechanics)}`,
      );
    }

    // ── Cue capture ──────────────────────────────────────────────────────────
    let buf: PresentationCue[] = [];
    campaign.onCue((c: PresentationCue) => buf.push(c));
    const drain = () => {
      const out = buf;
      buf = [];
      return out;
    };

    // ── `opened` set (no loot boxes in this campaign) ────────────────────────
    const opened = new Set<string>();

    // ── The command stream ───────────────────────────────────────────────────
    //
    // Round 0, Ada's turn (actionsPerRound=3 — one budgeted custom action stays
    // below cap, so no auto endTurn):
    //   mechanicAction(conformance:dread, brace)
    //     → brace effects applied: mechanic cue "You brace against the dread."
    //       + AdjustStat Ada sanity 10 → 11
    //     → recordAction: action cue mechanicAction (actor player:Ada),
    //       actionsThisRound 1 → 2 (setup `move` ticked once; no startTurn
    //       reset in this stream)
    //     → onAction dispatch: mechanic cue "The dread notices."
    const commands: Command[] = [
      { kind: "mechanicAction", mechanicKey: DREAD_KEY, actionKey: "brace" },
    ];

    // ── Drive the engine directly, capturing per-step state ──────────────────
    const pcNow = () => campaign.activeCharacter;

    const steps = commands.map((cmd) => {
      switch (cmd.kind) {
        case "mechanicAction":
          pcNow().useMechanicAction(cmd.mechanicKey, cmd.actionKey);
          break;
      }
      return {
        command: cmd,
        cues: drain(),
        snapshot: serializeCampaign(campaign),
        view: viewProjected(campaign, ALIASES, opened),
      };
    });

    // ── Self-validation (hard throws — the stream is deterministic) ──────────

    // (a) The step's mechanic cues, exactly and in order: the brace effect cue,
    //     then the onAction cue.
    const mechanicTexts = steps[0]!.cues
      .filter((c): c is Extract<PresentationCue, { kind: "mechanic" }> => c.kind === "mechanic")
      .map((c) => c.cue.text ?? "");
    const wantMechanic = ["You brace against the dread.", "The dread notices."];
    if (JSON.stringify(mechanicTexts) !== JSON.stringify(wantMechanic)) {
      throw new Error(
        `Step 0 mechanic cues mismatch: got ${JSON.stringify(mechanicTexts)}, want ${JSON.stringify(wantMechanic)}`,
      );
    }

    // (b) Full cue ORDER inside the step: brace cue → mechanicAction action cue
    //     (actor player:Ada) → onAction cue.
    const cues = steps[0]!.cues;
    const idxOf = (pred: (c: PresentationCue) => boolean, label: string): number => {
      const i = cues.findIndex(pred);
      if (i === -1) throw new Error(`Step 0 is missing expected cue: ${label}`);
      return i;
    };
    const iBrace = idxOf(
      (c) => c.kind === "mechanic" && c.cue.text === "You brace against the dread.",
      '"You brace against the dread." mechanic cue',
    );
    const iAction = idxOf(
      (c) => c.kind === "action" && c.action === "mechanicAction" && c.actor.id === "player:Ada",
      "mechanicAction action cue (actor player:Ada)",
    );
    const iNotices = idxOf(
      (c) => c.kind === "mechanic" && c.cue.text === "The dread notices.",
      '"The dread notices." mechanic cue',
    );
    if (!(iBrace < iAction && iAction < iNotices)) {
      throw new Error(
        `Step 0 cue order wrong: brace@${iBrace} < mechanicAction@${iAction} < notices@${iNotices} must hold.`,
      );
    }

    type CharSnap = { name: string; stats: Record<string, number>; actionsThisRound: number };
    const adaAfter = (steps[0]!.snapshot.characters as CharSnap[]).find((x) => x.name === "Ada");
    if (!adaAfter) throw new Error("Ada missing from step 0 snapshot.");
    const adaStart = (start.characters as CharSnap[]).find((x) => x.name === "Ada");
    if (!adaStart) throw new Error("Ada missing from the start snapshot.");

    // (c) The brace AdjustStat landed: sanity INCREASED by exactly +1 (10 → 11).
    const sanityBefore = adaStart.stats[StatType.Sanity]!;
    const sanityAfter = adaAfter.stats[StatType.Sanity]!;
    if (!(sanityAfter > sanityBefore) || sanityAfter !== sanityBefore + 1) {
      throw new Error(
        `Ada sanity should increase by 1 (${sanityBefore} → ${sanityBefore + 1}), got ${sanityAfter}`,
      );
    }

    // (d) The custom action is BUDGETED: exactly one action ticked relative to
    //     the genesis snapshot (the setup `move` already ticked once — no
    //     startTurn reset in this single-command stream), staying below the cap
    //     of 3, so the step carries no auto-endTurn "The dread recedes.".
    if (adaAfter.actionsThisRound !== adaStart.actionsThisRound + 1) {
      throw new Error(
        `Ada should tick exactly one budgeted action for brace (${adaStart.actionsThisRound} → ${adaStart.actionsThisRound + 1}), got ${adaAfter.actionsThisRound}`,
      );
    }
    if (adaAfter.actionsThisRound >= 3) {
      throw new Error(
        `Ada must stay below the action cap (3) so no auto endTurn fires, got ${adaAfter.actionsThisRound}`,
      );
    }

    // (e) No round end occurred: the mechanic's persistent state is untouched.
    const finalMechanics = steps[0]!.snapshot.campaign.mechanics;
    if (JSON.stringify(finalMechanics[0]!.state) !== JSON.stringify({ ticks: 0 })) {
      throw new Error(
        `Mechanic state should be untouched {ticks:0}, got ${JSON.stringify(finalMechanics[0]!.state)}`,
      );
    }

    // ── Write files ───────────────────────────────────────────────────────────
    writeFileSync(
      join(here, "mechanics-action.start.snapshot.json"),
      JSON.stringify(start, null, 2) + "\n",
    );
    writeFileSync(
      join(here, "mechanics-action.catalog.json"),
      JSON.stringify(EMPTY_CATALOG, null, 2) + "\n",
    );
    writeFileSync(
      join(here, "mechanics-action.golden.json"),
      JSON.stringify({ seed: SEED, commands, steps }, null, 2) + "\n",
    );

    // ── Debug summary ─────────────────────────────────────────────────────────
    console.log(`[mechanics-action] SEED=${SEED} steps=${steps.length}`);
  });
});
