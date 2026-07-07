/**
 * The Hollow House ops re-authored in the scripted-ops DSL. Each script MUST
 * reproduce its hand-written closure (mechanics.ts / status.ts / content.ts /
 * index.ts) exactly — those closures are the differential-gate oracle.
 */
import * as s from "../scripted/builders.ts";
import type { BehaviorScript, Expr, EffectTemplate } from "../scripted/builders.ts";
import { LORE } from "./content.js";
import { Conditions, ExitBehaviors, Items, Mechanics, Rooms } from "./ids.js";

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

// ── laudanum (oracle: items.ts:44) ───────────────────────────────────────────
// use(holder) { holder[ADJUST_STAT](this.stat, this.modifier); }
// The descriptor is stat: Sanity, modifier: 6 -> +6 Sanity on use. The closure
// stays the gate oracle; this script reproduces it.
export const laudanumScript: BehaviorScript = s.item({
  onUse: [s.emit(s.adjust(s.actor, "sanity", s.lit(6)))],
});

// ── keyed doors (oracle: content.ts doorBehavior, content.ts:23-39) ──────────
// canPass: state.unlocked || hasKey(keyCode); script: first pass sets unlocked
// and returns the opened line; no passMessage -> silent re-pass.
export function doorScript(keyCode: string, name: string, opened: string): BehaviorScript {
  return s.exit({
    canPass: s.or(s.stateGet("unlocked", false), s.hasKey(s.actor, keyCode)),
    runScript: [
      s.when(s.not(s.stateGet("unlocked", false)), [
        s.setState("unlocked", s.lit(true)),
        s.pass(s.lit(opened)),
      ]),
    ],
    failMessage: `The ${name} won't budge — it's locked.`,
  });
}

// ── victory conditions (oracle: index.ts:23-28) ──────────────────────────────
// reached-attic-with-journal: pc?.currentRoom?.name === Attic && pc holds the journal.
// party[0] missing / no room -> Null propagates -> false (mirrors `pc?.`).
export const reachedAtticWithJournalScript: BehaviorScript = s.victory(
  s.and(
    s.eq(s.get(s.get(s.first(s.party), "room"), "name"), s.lit(Rooms.Attic)),
    s.hasItem(s.first(s.party), Items.Journal),
  ),
);

// sanity-zero: party.some(p => p.effectiveStat(Sanity) <= 0)
export const sanityZeroScript: BehaviorScript = s.victory(
  s.some(s.party, s.lte(s.get(s.element, "sanity"), s.lit(0))),
);

// party-down: party.length > 0 && party.every(p => p.status.includes(KO))
export const partyDownScript: BehaviorScript = s.victory(
  s.and(
    s.gt(s.length(s.party), s.lit(0)),
    s.every(s.party, s.includes(s.get(s.element, "status"), s.lit("ko"))),
  ),
);

/** Every Hollow House behavior, keyed exactly as the engine resolves them. */
export function hollowHouseBehaviors(): Record<string, BehaviorScript> {
  return {
    [Mechanics.Dread]: dreadScript,
    [Mechanics.Storyteller]: storytellerScript(LORE),
    [Mechanics.StatusBar]: statusBarScript,
    [ExitBehaviors.StudyDoor]: doorScript("brass", "study door",
      "The brass key turns; the study door swings open."),
    [ExitBehaviors.AtticDoor]: doorScript("iron", "attic door",
      "The iron key grinds in the lock; the attic stairs open above you."),
    [Items.Laudanum]: laudanumScript,
    [Conditions.ReachedAtticWithJournal]: reachedAtticWithJournalScript,
    [Conditions.SanityZero]: sanityZeroScript,
    [Conditions.PartyDown]: partyDownScript,
  };
}
