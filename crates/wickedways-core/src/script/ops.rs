//! Adapter ops: satisfy the existing Phase-1 traits by interpreting a stored AST.
use alloc::collections::{BTreeMap, BTreeSet};
use alloc::string::{String, ToString};
use alloc::vec::Vec;
use serde_json::Value as Json;

use crate::presentation::MechanicCue;
use crate::script::ast::{
    DialogueEntry, DialogueMatch, ExitScript, ItemScript, MechanicScript, NpcScript, Stmt,
    VictoryScript,
};
use crate::script::eval::{
    eval_damage, eval_effect_templates, eval_effects, eval_expr, eval_predicate, eval_script,
    state_set_in, Ctx, CtxState, RoomSource,
};
use crate::script::value::coerce_str;
use crate::world::descriptor::Catalog;
use crate::world::exits::ExitBehavior;
use crate::world::mechanics::{
    ActionCtx, CampaignView, CharacterView, DamageView, Effect, HookCtx, MechanicOp,
    TransformResult, TurnCtx,
};
use crate::world::World;

/// A `MechanicOp` bound to a borrowed script (built per fire-point by
/// `resolve_mechanic_op` — no cloning of the AST).
pub struct ScriptedMechanic<'a> {
    pub script: &'a MechanicScript,
}

impl ScriptedMechanic<'_> {
    fn run_body(
        &self,
        body: Option<&Vec<Stmt>>,
        base: &mut HookCtx,
        actor: Option<&crate::world::mechanics::CharacterView>,
        action: Option<&crate::world::mechanics::ActionView>,
    ) -> Vec<Effect> {
        let Some(body) = body else { return Vec::new() }; // missing hook = no-op
        let mut cx = Ctx {
            view: Some(base.view),
            state: CtxState::Write(base.state),
            actor,
            action,
            damage: None,
            element: None,
            rng: Some(base.rng),
            rooms: RoomSource::None, // mechanics cannot see rooms (oracle parity)
        };
        eval_effects(body, &mut cx)
    }
}

impl MechanicOp for ScriptedMechanic<'_> {
    fn init_state(&self, _config: &Json) -> Json {
        self.script.init.clone()
    }
    fn on_round_start(&self, cx: &mut HookCtx) -> Vec<Effect> {
        self.run_body(self.script.hooks.on_round_start.as_ref(), cx, None, None)
    }
    fn on_round_end(&self, cx: &mut HookCtx) -> Vec<Effect> {
        self.run_body(self.script.hooks.on_round_end.as_ref(), cx, None, None)
    }
    fn on_turn_start(&self, cx: &mut TurnCtx) -> Vec<Effect> {
        let actor = cx.actor.clone();
        self.run_body(self.script.hooks.on_turn_start.as_ref(), &mut cx.base, Some(&actor), None)
    }
    fn on_turn_end(&self, cx: &mut TurnCtx) -> Vec<Effect> {
        let actor = cx.actor.clone();
        self.run_body(self.script.hooks.on_turn_end.as_ref(), &mut cx.base, Some(&actor), None)
    }
    fn on_action(&self, cx: &mut ActionCtx) -> Vec<Effect> {
        let actor = cx.actor.clone();
        let action = cx.action.clone();
        self.run_body(self.script.hooks.on_action.as_ref(), &mut cx.base, Some(&actor), Some(&action))
    }
    fn modify_damage(&self, d: &DamageView, cx: &mut HookCtx) -> TransformResult {
        match &self.script.hooks.modify_damage {
            None => TransformResult::Value(d.amount),
            Some(body) => {
                let mut ecx = Ctx {
                    view: Some(cx.view),
                    state: CtxState::Write(cx.state),
                    actor: None,
                    action: None,
                    damage: Some(d),
                    element: None,
                    rng: Some(cx.rng),
                    rooms: RoomSource::None,
                };
                eval_damage(body, d, &mut ecx)
            }
        }
    }
    fn run_action(&self, action_key: &str, cx: &mut ActionCtx) -> Option<Vec<Effect>> {
        let body = self.script.actions.get(action_key)?;
        let actor = cx.actor.clone();
        let action = cx.action.clone();
        Some(self.run_body(Some(body), &mut cx.base, Some(&actor), Some(&action)))
    }
}

/// An item's `on_use` / `on_read` hooks, bound to a borrowed `ItemScript`.
/// Built per fire-point in `use_item` / `read_item`. Item hooks see the actor
/// (holder), the campaign view, and the injected rng — the same power as a
/// mechanic `on_action` hook, minus per-item script state (v1 has none, so the
/// `Ctx` state is a throwaway) and rooms (`RoomSource::None`).
pub struct ScriptedItem<'a> {
    pub script: &'a ItemScript,
}

impl ScriptedItem<'_> {
    fn run_body(
        &self,
        body: Option<&Vec<Stmt>>,
        base: &mut HookCtx,
        actor: &CharacterView,
    ) -> Vec<Effect> {
        let Some(body) = body else { return Vec::new() };
        let mut cx = Ctx {
            view: Some(base.view),
            state: CtxState::Write(base.state),
            actor: Some(actor),
            action: None,
            damage: None,
            element: None,
            rng: Some(base.rng),
            rooms: RoomSource::None,
        };
        eval_effects(body, &mut cx)
    }

    pub fn run_use(&self, base: &mut HookCtx, actor: &CharacterView) -> Vec<Effect> {
        self.run_body(self.script.on_use.as_ref(), base, actor)
    }

    pub fn run_read(&self, base: &mut HookCtx, actor: &CharacterView) -> Vec<Effect> {
        self.run_body(self.script.on_read.as_ref(), base, actor)
    }
}

/// An `ExitBehavior` bound to a borrowed script (built per fire-point by
/// `resolve_exit_behavior` — no cloning of the AST). Exit contexts have no
/// campaign view and no room resolver — matching the TS `ExitPrecondition(
/// character, state)` contract (src/lib/exit.ts:12-14).
pub struct ScriptedExit<'a> {
    pub script: &'a ExitScript,
}

impl ExitBehavior for ScriptedExit<'_> {
    fn can_pass(&self, actor: &CharacterView, state: &Json) -> bool {
        let mut cx = Ctx {
            view: None,
            state: CtxState::Read(state),
            actor: Some(actor),
            action: None,
            damage: None,
            element: None,
            rng: None,
            rooms: RoomSource::None,
        };
        eval_predicate(&self.script.can_pass, &mut cx)
    }
    fn run_script(&self, actor: &CharacterView, state: &mut Json) -> Option<alloc::string::String> {
        let mut cx = Ctx {
            view: None,
            state: CtxState::Write(state),
            actor: Some(actor),
            action: None,
            damage: None,
            element: None,
            rng: None,
            rooms: RoomSource::None,
        };
        eval_script(&self.script.run_script, &mut cx)
    }
    fn pass_message(&self) -> Option<&str> { self.script.pass_message.as_deref() }
    fn fail_message(&self) -> Option<&str> { self.script.fail_message.as_deref() }
}

/// Victory adapter (see plan deviation note 2). NOT a `VictoryConditionBehavior`
/// impl — the trait's `test(&CampaignView)` cannot carry the World access the
/// lazy `character.room` resolver needs; the `resolve_outcome` seam calls this
/// directly for the Scripted arm. Victory is the ONE context the TS oracle
/// evaluates against the LIVE campaign (`pc.currentRoom`), so it gets the lazy,
/// memoizing World-backed room resolver (mechanic/exit contexts stay `None`).
pub struct ScriptedVictory<'a> {
    pub script: &'a VictoryScript,
}

impl ScriptedVictory<'_> {
    pub fn test(&self, view: &CampaignView, world: &World, cat: &Catalog) -> bool {
        let mut cx = Ctx {
            view: Some(view),
            state: CtxState::None,
            actor: None,
            action: None,
            damage: None,
            element: None,
            rng: None,
            rooms: RoomSource::World { world, cat, cache: BTreeMap::new() },
        };
        eval_predicate(&self.script.test, &mut cx)
    }
}

// ─── NPC dialogue matcher (NPC sub-plan 2) ──────────────────────────────────
//
// THE MATCHER ALGORITHM — this is the single source of truth. Task 3's TS oracle
// and Task 4's fixture MUST mirror it byte-for-byte. It is a deliberate
// improvement over the legacy TS `IDialogue` (which is OFF the conformance-gate
// path and is NOT the reference); implement THIS, not the legacy code.
//
// NORMALIZE + TOKENIZE a prompt string (`tokenize`):
//   1. Lowercase (`str::to_lowercase`).
//   2. Split on whitespace (`split_whitespace`).
//   3. For each piece, strip ASCII-punctuation from BOTH EDGES ONLY — repeatedly
//      trim leading/trailing chars where `char::is_ascii_punctuation()` is true.
//      That set is EXACTLY  ! " # $ % & ' ( ) * + , - . / : ; < = > ? @ [ \ ] ^ _ ` { | } ~
//      Internal punctuation is KEPT: `don't` stays `don't`; `cellar?` -> `cellar`;
//      `...hi...` -> `hi`.
//   4. Drop pieces that became empty.
//   5. The ORDERED result (`Vec<String>`, order preserved, NOT deduped) is used
//      for Exact; its deduped form (`BTreeSet<String>`) is used for Fuzzy.
//
// PER-ENTRY MATCH TEST:
//   * Exact { text }: normalize `text` with the SAME `tokenize` procedure into an
//     ordered `Vec<String>`; matches IFF the prompt's ordered token Vec EQUALS the
//     trigger's ordered token Vec (whitespace- & edge-punct-insensitive, but
//     full-phrase and order-exact).
//   * Fuzzy { tokens }: normalize each trigger token atomically (lowercase +
//     edge-punct-strip via `normalize_token`; NO whitespace split), drop any that
//     become empty, and dedup; matches IFF EVERY normalized trigger token is in the
//     prompt's token SET (subset; order-independent; extra prompt tokens are fine).
//     `[].every(_)` is vacuously TRUE, so an all-punctuation trigger matches with
//     SCORE 0. SCORE = the count of normalized-DEDUPED trigger tokens.
//
// SELECTION (choose EXACTLY ONE entry, or `default`):
//   1. BARE prompt — `None`, OR it tokenizes to an EMPTY set — selects `default`.
//   2. Else scan `dialogue` in AUTHORED order:
//        a. If ANY Exact entry matches -> the FIRST-authored matching Exact
//           (Exact always beats Fuzzy).
//        b. Else if any Fuzzy matches -> the HIGHEST-score Fuzzy; on a score tie,
//           the FIRST-authored among them.
//        c. Else -> `default`.
//   3. Only the SINGLE selected entry (or `default`) contributes response + effects.
//
// EMIT (`run_talk`):
//   * The selected entry's `response` Expr is evaluated to a cue and ALWAYS emitted.
//   * The selected entry's `effects` are returned HONORING `once`: a `once` entry
//     yields effects only while its per-behavior latch is UNSET, and firing SETS the
//     latch (a second talk re-emits the response but NO effects). A non-`once` entry
//     yields its effects every time. Latch state lives in the NPC's per-behavior JSON
//     state under `state["onceFired"][key]` (see `LATCH_FIELD`), keyed by the selected
//     entry's identity (`"default"` for the default entry, else its decimal index in
//     `dialogue`) — written through the same `SetState` seam mechanics use
//     (`state_set_in`), so Task 3/4 must key the latch identically for byte-parity.

/// State object field holding the per-entry `once` latch (`{ key: true }`).
const LATCH_FIELD: &str = "onceFired";

/// Full normalize+tokenize: lowercase, split on whitespace, strip ASCII-punctuation
/// from both edges of each piece, drop emptied pieces. Order-preserving, NOT deduped.
fn tokenize(s: &str) -> Vec<String> {
    s.to_lowercase()
        .split_whitespace()
        .filter_map(|piece| {
            let t = piece.trim_matches(|c: char| c.is_ascii_punctuation());
            if t.is_empty() { None } else { Some(t.to_string()) }
        })
        .collect()
}

/// Atomic single-token normalize for a Fuzzy trigger token: lowercase + edge
/// ASCII-punctuation strip only (NO whitespace split). May return empty.
fn normalize_token(t: &str) -> String {
    t.to_lowercase()
        .trim_matches(|c: char| c.is_ascii_punctuation())
        .to_string()
}

/// The single entry chosen by the matcher, paired with its latch key.
struct Selection<'a> {
    entry: &'a DialogueEntry,
    /// Latch key: `"default"` for the default entry, else the decimal index.
    key: String,
}

/// Run the selection algorithm (see module comment above). Pure: depends only on
/// the script and the prompt.
fn select_entry<'a>(script: &'a NpcScript, prompt: Option<&str>) -> Selection<'a> {
    let default_sel = || Selection { entry: &script.default, key: "default".to_string() };

    // 1. Bare prompt (None or empties to nothing) -> default.
    let ordered = match prompt {
        None => return default_sel(),
        Some(p) => tokenize(p),
    };
    if ordered.is_empty() {
        return default_sel();
    }
    let prompt_set: BTreeSet<String> = ordered.iter().cloned().collect();

    // 2a. First-authored matching Exact wins outright.
    for (i, entry) in script.dialogue.iter().enumerate() {
        if let DialogueMatch::Exact { text } = &entry.match_ {
            if tokenize(text) == ordered {
                return Selection { entry, key: i.to_string() };
            }
        }
    }

    // 2b. Highest-score matching Fuzzy; first-authored breaks a score tie.
    let mut best: Option<(usize, &DialogueEntry, usize)> = None; // (score, entry, index)
    for (i, entry) in script.dialogue.iter().enumerate() {
        if let DialogueMatch::Fuzzy { tokens } = &entry.match_ {
            let trigger: BTreeSet<String> = tokens
                .iter()
                .map(|t| normalize_token(t))
                .filter(|t| !t.is_empty())
                .collect();
            // `[].every()` is vacuously true, so an emptied trigger still matches
            // (score 0) — mirror this in the oracle.
            if trigger.is_subset(&prompt_set) {
                let score = trigger.len();
                // Strict `>` keeps the earlier-authored entry on a tie.
                if best.is_none_or(|(bs, _, _)| score > bs) {
                    best = Some((score, entry, i));
                }
            }
        }
    }
    match best {
        Some((_, entry, i)) => Selection { entry, key: i.to_string() },
        // 2c. Nothing matched -> default.
        None => default_sel(),
    }
}

/// A data-driven NPC dialogue behavior bound to a borrowed `NpcScript` (mirrors
/// `ScriptedMechanic`/`ScriptedItem` — no cloning of the AST). Talk context sees
/// the actor, the campaign view, and the injected rng (like an item hook), plus
/// the NPC's per-behavior JSON state (for the `once` latch); rooms are `None`.
pub struct ScriptedNpc<'a> {
    pub script: &'a NpcScript,
}

impl ScriptedNpc<'_> {
    /// The NPC's `examine` blurb (TS `Npc.description`).
    pub fn description(&self) -> &str {
        &self.script.description
    }

    /// Match `prompt` to exactly one dialogue entry (or the default), evaluate its
    /// `response` to a cue (ALWAYS emitted), and return its `effects` honoring
    /// `once` against the per-behavior `state`. See the module comment for the full
    /// algorithm. `prompt == None` is a bare `talk`.
    pub fn run_talk(
        &self,
        prompt: Option<&str>,
        base: &mut HookCtx,
        actor: &CharacterView,
    ) -> (Vec<MechanicCue>, Vec<Effect>) {
        let sel = select_entry(self.script, prompt);

        // Read the latch BEFORE the mutable state reborrow.
        let already = base
            .state
            .get(LATCH_FIELD)
            .and_then(|m| m.get(&sel.key))
            .and_then(Json::as_bool)
            .unwrap_or(false);
        let once = sel.entry.once;

        let mut cx = Ctx {
            view: Some(base.view),
            state: CtxState::Write(base.state),
            actor: Some(actor),
            action: None,
            damage: None,
            element: None,
            rng: Some(base.rng),
            rooms: RoomSource::None,
        };
        // Response is always emitted (same cue-build path as EffectTemplate::Cue).
        let cue = MechanicCue {
            text: Some(coerce_str(&eval_expr(&sel.entry.response, &mut cx).into_value())),
            sound: None,
        };
        let effects = if once && already {
            Vec::new()
        } else {
            eval_effect_templates(&sel.entry.effects, &mut cx)
        };
        drop(cx);

        // A `once` entry sets its latch the first time it fires.
        if once && !already {
            state_set_in(base.state, LATCH_FIELD, &sel.key, Json::Bool(true));
        }

        (alloc::vec![cue], effects)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scripted_item_on_use_emits_adjust_stat_for_actor() {
        use crate::script::ast::{EffectTemplate, Expr, ItemScript, Stmt};
        use crate::script::value::Value;
        use crate::stats::StatType;
        use crate::world::descriptor::Catalog;
        use crate::world::mechanics::{Effect, HookCtx};
        use crate::world::test_support::world_with_party;

        let w = world_with_party(&["pc"], 10);
        let cat = Catalog::default();
        let view = w.build_campaign_view(&cat);
        let actor = w
            .character_view(&crate::world::ids::CharacterId("pc".into()), &cat)
            .unwrap();

        let script = ItemScript {
            on_use: Some(alloc::vec![Stmt::Emit {
                effect: EffectTemplate::AdjustStat {
                    target: Expr::Actor,
                    stat: StatType::Sanity,
                    delta: Expr::Lit { value: Value::Number(6.0) },
                },
            }]),
            on_read: None,
        };

        let mut rng = crate::world::rng::Rng::seeded(0);
        let mut state = serde_json::Value::Null;
        let mut base = HookCtx { state: &mut state, view: &view, rng: &mut rng };
        let effects = ScriptedItem { script: &script }.run_use(&mut base, &actor);

        assert_eq!(effects.len(), 1);
        match &effects[0] {
            Effect::AdjustStat { target, stat, delta } => {
                assert_eq!(target.0, "pc");
                assert_eq!(*stat, StatType::Sanity);
                assert!((*delta - 6.0).abs() < 1e-9);
            }
            other => panic!("expected AdjustStat, got {other:?}"),
        }
    }

    #[test]
    fn scripted_item_on_read_emits_adjust_stat_for_actor() {
        use crate::script::ast::{EffectTemplate, Expr, ItemScript, Stmt};
        use crate::script::value::Value;
        use crate::stats::StatType;
        use crate::world::descriptor::Catalog;
        use crate::world::mechanics::{Effect, HookCtx};
        use crate::world::test_support::world_with_party;

        let w = world_with_party(&["pc"], 10);
        let cat = Catalog::default();
        let view = w.build_campaign_view(&cat);
        let actor = w
            .character_view(&crate::world::ids::CharacterId("pc".into()), &cat)
            .unwrap();

        let script = ItemScript {
            on_use: None,
            on_read: Some(alloc::vec![Stmt::Emit {
                effect: EffectTemplate::AdjustStat {
                    target: Expr::Actor,
                    stat: StatType::Energy,
                    delta: Expr::Lit { value: Value::Number(-2.0) },
                },
            }]),
        };

        let mut rng = crate::world::rng::Rng::seeded(0);
        let mut state = serde_json::Value::Null;
        let mut base = HookCtx { state: &mut state, view: &view, rng: &mut rng };
        let effects = ScriptedItem { script: &script }.run_read(&mut base, &actor);

        assert_eq!(effects.len(), 1);
        match &effects[0] {
            Effect::AdjustStat { target, stat, delta } => {
                assert_eq!(target.0, "pc");
                assert_eq!(*stat, StatType::Energy);
                assert!((*delta + 2.0).abs() < 1e-9);
            }
            other => panic!("expected AdjustStat, got {other:?}"),
        }
    }

    #[test]
    fn scripted_item_absent_hook_is_noop() {
        use crate::script::ast::ItemScript;
        use crate::world::descriptor::Catalog;
        use crate::world::mechanics::HookCtx;
        use crate::world::test_support::world_with_party;

        let w = world_with_party(&["pc"], 10);
        let cat = Catalog::default();
        let view = w.build_campaign_view(&cat);
        let actor = w
            .character_view(&crate::world::ids::CharacterId("pc".into()), &cat)
            .unwrap();
        let script = ItemScript { on_use: None, on_read: None };
        let mut rng = crate::world::rng::Rng::seeded(0);
        let mut state = serde_json::Value::Null;
        let mut base = HookCtx { state: &mut state, view: &view, rng: &mut rng };
        assert!(ScriptedItem { script: &script }
            .run_read(&mut base, &actor)
            .is_empty());
    }

    // ─── NPC dialogue matcher + ScriptedNpc (NPC sub-plan 2) ─────────────────

    fn lit(s: &str) -> crate::script::ast::Expr {
        crate::script::ast::Expr::Lit { value: crate::script::value::Value::Str(s.into()) }
    }

    fn entry(m: DialogueMatch, resp: &str) -> DialogueEntry {
        DialogueEntry { match_: m, response: lit(resp), effects: Vec::new(), once: false }
    }

    fn exact(text: &str, resp: &str) -> DialogueEntry {
        entry(DialogueMatch::Exact { text: text.into() }, resp)
    }

    fn fuzzy(tokens: &[&str], resp: &str) -> DialogueEntry {
        entry(
            DialogueMatch::Fuzzy { tokens: tokens.iter().map(|t| t.to_string()).collect() },
            resp,
        )
    }

    fn npc(dialogue: Vec<DialogueEntry>) -> NpcScript {
        NpcScript {
            description: "an npc".into(),
            default: exact("", "DEFAULT"),
            dialogue,
        }
    }

    /// Run `talk` against a fresh world/actor, threading the caller's `state`.
    fn talk(
        script: &NpcScript,
        prompt: Option<&str>,
        state: &mut Json,
    ) -> (Vec<MechanicCue>, Vec<Effect>) {
        use crate::world::test_support::world_with_party;
        let w = world_with_party(&["pc"], 10);
        let cat = Catalog::default();
        let view = w.build_campaign_view(&cat);
        let actor = w
            .character_view(&crate::world::ids::CharacterId("pc".into()), &cat)
            .unwrap();
        let mut rng = crate::world::rng::Rng::seeded(0);
        let mut base = HookCtx { state, view: &view, rng: &mut rng };
        ScriptedNpc { script }.run_talk(prompt, &mut base, &actor)
    }

    fn cue(cues: &[MechanicCue]) -> String {
        cues[0].text.clone().expect("response cue has text")
    }

    #[test]
    fn npc_description_returns_script_description() {
        let script = npc(Vec::new());
        assert_eq!(ScriptedNpc { script: &script }.description(), "an npc");
    }

    #[test]
    fn exact_match_is_case_punct_and_edge_ws_insensitive() {
        let script = npc(alloc::vec![exact("hello there", "GREET")]);
        let mut state = Json::Null;
        // Case, trailing/leading punctuation, and extra whitespace all normalize away.
        let (cues, _) = talk(&script, Some("  Hello,   there!  "), &mut state);
        assert_eq!(cue(&cues), "GREET");
    }

    #[test]
    fn exact_requires_full_phrase_extra_token_is_no_match() {
        let script = npc(alloc::vec![exact("hello there", "GREET")]);
        let mut state = Json::Null;
        let (cues, _) = talk(&script, Some("hello there friend"), &mut state);
        assert_eq!(cue(&cues), "DEFAULT");
    }

    #[test]
    fn exact_beats_fuzzy_even_when_authored_later() {
        // Fuzzy["hello"] also subsets the prompt, but Exact wins outright.
        let script = npc(alloc::vec![fuzzy(&["hello"], "FUZZY"), exact("hello there", "EXACT")]);
        let mut state = Json::Null;
        let (cues, _) = talk(&script, Some("hello there"), &mut state);
        assert_eq!(cue(&cues), "EXACT");
    }

    #[test]
    fn fuzzy_subset_matches_reordered_with_extra_tokens_and_trailing_punct() {
        let script = npc(alloc::vec![fuzzy(&["open", "door"], "FZ")]);
        let mut state = Json::Null;
        let (cues, _) = talk(&script, Some("please Door, OPEN now?"), &mut state);
        assert_eq!(cue(&cues), "FZ");
    }

    #[test]
    fn fuzzy_missing_trigger_token_is_no_match() {
        let script = npc(alloc::vec![fuzzy(&["open", "door"], "FZ")]);
        let mut state = Json::Null;
        let (cues, _) = talk(&script, Some("open the window"), &mut state);
        assert_eq!(cue(&cues), "DEFAULT");
    }

    #[test]
    fn fuzzy_highest_score_wins() {
        let script = npc(alloc::vec![
            fuzzy(&["cellar"], "ONE"),
            fuzzy(&["cellar", "key"], "TWO"),
        ]);
        let mut state = Json::Null;
        let (cues, _) = talk(&script, Some("the cellar key"), &mut state);
        assert_eq!(cue(&cues), "TWO");
    }

    #[test]
    fn fuzzy_score_tie_selects_first_authored() {
        let script = npc(alloc::vec![fuzzy(&["cellar"], "FIRST"), fuzzy(&["key"], "SECOND")]);
        let mut state = Json::Null;
        let (cues, _) = talk(&script, Some("cellar key"), &mut state);
        assert_eq!(cue(&cues), "FIRST");
    }

    #[test]
    fn bare_none_prompt_selects_default() {
        let script = npc(alloc::vec![fuzzy(&["hello"], "FZ")]);
        let mut state = Json::Null;
        let (cues, _) = talk(&script, None, &mut state);
        assert_eq!(cue(&cues), "DEFAULT");
    }

    #[test]
    fn all_punctuation_prompt_tokenizes_empty_and_selects_default() {
        let script = npc(alloc::vec![fuzzy(&["hello"], "FZ")]);
        let mut state = Json::Null;
        // "!!!" strips to empty -> empty token set -> bare -> default.
        let (cues, _) = talk(&script, Some("!!! ???"), &mut state);
        assert_eq!(cue(&cues), "DEFAULT");
    }

    #[test]
    fn unmatched_prompt_selects_default() {
        let script = npc(alloc::vec![fuzzy(&["xyz"], "FZ")]);
        let mut state = Json::Null;
        let (cues, _) = talk(&script, Some("hello world"), &mut state);
        assert_eq!(cue(&cues), "DEFAULT");
    }

    #[test]
    fn fuzzy_trailing_question_mark_matches_and_internal_apostrophe_kept() {
        // "cellar?" -> "cellar" (edge strip); "don't" keeps its internal apostrophe.
        let script = npc(alloc::vec![fuzzy(&["cellar"], "C"), fuzzy(&["don't"], "D")]);
        let mut s1 = Json::Null;
        let (c1, _) = talk(&script, Some("cellar?"), &mut s1);
        assert_eq!(cue(&c1), "C");
        let mut s2 = Json::Null;
        let (c2, _) = talk(&script, Some("Don't go"), &mut s2);
        assert_eq!(cue(&c2), "D");
    }

    #[test]
    fn once_entry_repeats_response_but_gates_effects() {
        use crate::script::ast::EffectTemplate;
        use crate::stats::StatType;

        let give = DialogueEntry {
            match_: DialogueMatch::Fuzzy { tokens: alloc::vec!["give".into()] },
            response: lit("HERE"),
            effects: alloc::vec![EffectTemplate::AdjustStat {
                target: crate::script::ast::Expr::Actor,
                stat: StatType::Sanity,
                delta: lit_num(3.0),
            }],
            once: true,
        };
        let script = npc(alloc::vec![give]);

        let mut state = Json::Null;
        let (c1, fx1) = talk(&script, Some("give"), &mut state);
        assert_eq!(cue(&c1), "HERE");
        assert_eq!(fx1.len(), 1, "first talk fires effects");
        // Latch is now set in the shared state.
        assert_eq!(state["onceFired"]["0"], serde_json::json!(true));

        let (c2, fx2) = talk(&script, Some("give"), &mut state);
        assert_eq!(cue(&c2), "HERE", "response still emitted");
        assert!(fx2.is_empty(), "effects suppressed on second talk");
    }

    #[test]
    fn non_once_entry_re_returns_effects_every_call() {
        use crate::script::ast::EffectTemplate;
        use crate::stats::StatType;

        let give = DialogueEntry {
            match_: DialogueMatch::Fuzzy { tokens: alloc::vec!["give".into()] },
            response: lit("HERE"),
            effects: alloc::vec![EffectTemplate::AdjustStat {
                target: crate::script::ast::Expr::Actor,
                stat: StatType::Sanity,
                delta: lit_num(3.0),
            }],
            once: false,
        };
        let script = npc(alloc::vec![give]);

        let mut state = Json::Null;
        let (_, fx1) = talk(&script, Some("give"), &mut state);
        assert_eq!(fx1.len(), 1);
        let (_, fx2) = talk(&script, Some("give"), &mut state);
        assert_eq!(fx2.len(), 1, "non-once re-emits effects");
    }

    fn lit_num(n: f64) -> crate::script::ast::Expr {
        crate::script::ast::Expr::Lit { value: crate::script::value::Value::Number(n) }
    }
}
