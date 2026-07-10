/**
 * The Hollow House ops re-authored in the scripted-ops DSL. Each script MUST
 * reproduce its hand-written closure (mechanics.ts / status.ts / content.ts /
 * index.ts) exactly — those closures are the differential-gate oracle.
 */
import * as s from "../scripted/builders.ts";
import type { BehaviorScript, Expr, EffectTemplate } from "../scripted/builders.ts";
import { LORE } from "./content.js";
import { Conditions, ExitBehaviors, Items, Mechanics, Npcs, Rooms, Scenes } from "./ids.js";

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

/**
 * Laudanum — the first dogfooded `item`-family script (oracle: `items.ts:44`).
 *
 * Hand-written closure: `use(holder) { holder[ADJUST_STAT](this.stat, this.modifier); }`
 * with descriptor `stat: Sanity, modifier: 6` — i.e. `+6 Sanity` when used. The
 * `onUse` hook fires after the usable/KO guards and before `grantsImmunity` +
 * consume, so emitting the adjust here reproduces the closure exactly. That
 * closure remains the differential-gate oracle; this script must match it
 * byte-for-byte.
 */
export const laudanumScript: BehaviorScript = s.item({
  onUse: [s.emit(s.adjust(s.actor, "sanity", s.lit(6)))],
});

/**
 * Rat-tail — a roving-Rat drop, usable for +1 Sanity (oracle: `items.ts` ratTail
 * `use(holder) { holder[ADJUST_STAT](this.stat, this.modifier); }` with
 * descriptor `stat: Sanity, modifier: 1`). Mirrors {@link laudanumScript}; the
 * hand-written closure remains the differential-gate oracle and this must match it.
 */
export const ratTailScript: BehaviorScript = s.item({
  onUse: [s.emit(s.adjust(s.actor, "sanity", s.lit(1)))],
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

// ── the caretaker NPC + the foyer intro scene (NPC sub-plan 4) ────────────────
// These three strings appear in BOTH the DSL twins below (interpreted by the Rust
// core from `catalog.behaviors`) and the native TS twins in index.ts (fired by the
// TS oracle when building genesis / at begin_campaign). They MUST be byte-identical
// across both twins or the differential gate diverges — so each is defined ONCE
// here (a leaf module: scripted.ts imports only from ./ids.js and ./content.js, so
// index.ts→scripted.ts stays one-way, no barrel cycle) and imported into index.ts.
export const CARETAKER_DESCRIPTION =
  "A stooped caretaker in a moth-eaten coat, a ring of iron keys trembling at his belt. He will not meet your eyes.";
export const CARETAKER_HANDOFF =
  "Take the cellar key. I have no more use for it, nor for this house. I am leaving now, and I will not come back.";
export const CARETAKER_INTRO_CUE =
  "The front door thuds shut behind you and will not open again. In the gloom of the foyer, a stooped figure waits, a ring of keys shaking in his hand.";

// The caretaker's own char id (assembler mints `npc:<name>`) and the id of his
// first held item (`npc:<name>:item#0` -> the seeded cellar key). Pinned literals,
// not runtime resolution, so neither engine can drift.
const CARETAKER_ID = "npc:Caretaker";
const CARETAKER_KEY_ITEM_ID = "npc:Caretaker:item#0";

// The default entry catches BOTH a bare `talk` AND any prompt (there are no lore
// `dialogue` entries to match first) -> every talk falls to the hand-off. `once`
// gates the EFFECTS only (the response cue always emits); after `setVisible(false)`
// the caretaker is unreachable, so a re-talk is a no-op anyway.
export const caretakerScript: BehaviorScript = s.npc({
  description: CARETAKER_DESCRIPTION,
  default: s.entry({
    match: s.exact(""),
    response: s.lit(CARETAKER_HANDOFF),
    effects: [
      s.giveItem(s.lit(CARETAKER_ID), s.actor, s.lit(CARETAKER_KEY_ITEM_ID)),
      s.setVisible(s.lit(CARETAKER_ID), s.lit(false)),
    ],
    once: true,
  }),
  dialogue: [],
});

// Foyer enter-scene: cue-only, no canPlay (always plays), no effects. Fires at
// begin_campaign via the start-room enter-scene surfacing (NPC sub-plan 3).
export const caretakerIntroScene: BehaviorScript = s.scene({
  onEnter: [s.emit(s.cue(s.lit(CARETAKER_INTRO_CUE)))],
});

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
    [ExitBehaviors.CellarDoor]: doorScript("cellar", "cellar door",
      "The cellar key turns; the cellar door swings open."),
    [Items.Laudanum]: laudanumScript,
    [Items.RatTail]: ratTailScript,
    [Conditions.ReachedAtticWithJournal]: reachedAtticWithJournalScript,
    [Conditions.SanityZero]: sanityZeroScript,
    [Conditions.PartyDown]: partyDownScript,
    [Npcs.Caretaker]: caretakerScript,
    [Scenes.CaretakerIntro]: caretakerIntroScene,
  };
}
