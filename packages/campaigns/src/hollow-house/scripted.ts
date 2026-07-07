/**
 * The Hollow House ops re-authored in the scripted-ops DSL. Each script MUST
 * reproduce its hand-written closure (mechanics.ts / status.ts / content.ts /
 * index.ts) exactly — those closures are the differential-gate oracle.
 */
import * as s from "../scripted/builders.ts";
import type { BehaviorScript, Expr, EffectTemplate } from "../scripted/builders.ts";
import { LORE } from "./content.js";
import { Items, Mechanics } from "./ids.js";

// ── dread (oracle: mechanics.ts:5-11) ────────────────────────────────────────
// onTurnStart: hasEquipped(lantern) ? [] : [adjustStat(actor, sanity, -1)]
export const dreadScript: BehaviorScript = s.mechanic({
  init: {},
  hooks: {
    onTurnStart: [
      s.guard(s.not(s.hasEquipped(s.actor, Items.Lantern))),
      s.emit(s.adjust(s.actor, "sanity", s.lit(-1))),
    ],
  },
});

// ── storyteller (oracle: mechanics.ts:13-28) ─────────────────────────────────
// Guard order mirrors the closure: move? -> lore fragment? -> journal? -> unseen?
export function storytellerScript(lore: Record<string, string>): BehaviorScript {
  const roomName: Expr = s.get(s.get(s.action, "room"), "name");
  const loreMap: Expr = s.mapLit(lore);
  return s.mechanic({
    init: { seen: {} },
    hooks: {
      onAction: [
        s.guard(s.eq(s.get(s.action, "kind"), s.lit("move"))),
        s.guard(s.has(loreMap, roomName)),
        s.guard(s.hasItem(s.actor, Items.Journal)),
        s.guard(s.not(s.stateGetIn("seen", roomName, false))),
        s.setStateIn("seen", roomName, s.lit(true)),
        s.emit(s.cue(s.lookup(loreMap, roomName))),
      ],
    },
  });
}

// ── status-bar (oracle: status.ts:4-31) ──────────────────────────────────────
// emphasisFor: <=3 critical, <=6 warn, else normal. "Round" has NO emphasis.
const emphasisFor = (sanity: Expr): Expr =>
  s.ifElse(s.lte(sanity, s.lit(3)), s.lit("critical"),
    s.ifElse(s.lte(sanity, s.lit(6)), s.lit("warn"), s.lit("normal")));

const statusFields = (sanity: Expr): EffectTemplate =>
  s.status([
    s.field("Sanity", s.str(sanity), emphasisFor(sanity)),
    s.field("Round", s.concat(s.str(s.round), s.lit("/"), s.str(s.maxRounds))),
  ]);

export const statusBarScript: BehaviorScript = s.mechanic({
  init: {},
  hooks: {
    // Initial paint at round start (party may be empty pre-boot -> emit nothing).
    onRoundStart: [
      s.guard(s.gt(s.length(s.party), s.lit(0))),
      s.emit(statusFields(s.get(s.first(s.party), "sanity"))),
    ],
    // After each turn's effects (e.g. dread), so values are current.
    onTurnEnd: [s.emit(statusFields(s.get(s.actor, "sanity")))],
  },
});

/** Every Hollow House behavior, keyed exactly as the engine resolves them.
 *  (Doors join in plan Task 13; victory conditions in Task 14.) */
export function hollowHouseBehaviors(): Record<string, BehaviorScript> {
  return {
    [Mechanics.Dread]: dreadScript,
    [Mechanics.Storyteller]: storytellerScript(LORE),
    [Mechanics.StatusBar]: statusBarScript,
  };
}
