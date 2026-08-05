//! The Villain & Wicked Ways Cards: a designated adversary character (the GM's
//! own character in multiplayer, a computer-driven character in single-player)
//! who plays one-time power cards against the heroes.
//!
//! Card economy: the Villain starts with `VILLAIN_HAND_SIZE` (5) cards; on
//! their turn they take at most ONE card action — play a card (resolve →
//! discard it → draw 1) OR mulligan (`MULLIGAN_SIZE` (3) cards discarded, 3
//! drawn, nothing played) — enforced by the per-turn `card_action_taken` latch.
//! An empty draw pile reshuffles the discard back in (via `World.rng`, so
//! replays stay deterministic); with both piles empty a draw yields nothing.
//!
//! Behavior follows the house registry idiom (the 7th family): a `CardBehavior`
//! trait, a native `key -> &'static dyn` registry (`card_behavior`), a
//! `ResolvedCardBehavior` falling back to `BehaviorScript::Card` catalog
//! scripts, and load-time validation in `validate_mechanics`.
//!
//! ## The card-effect layer is villain-privileged and open by default
//!
//! Unlike mechanics (a closed, party-restricted effect union), cards may reach
//! ANYTHING in the world except what is specifically prohibited. `CardEffect`
//! wraps the standard `Effect` vocabulary — applied WITHOUT the party-only
//! targeting restriction — and adds world-level powers (destroy an item,
//! teleport a character, supernatural darkness, exit-state patches). The
//! prohibition list is the explicit exception, in `card_protected`: quest
//! items (`droppable: false`) and keys cannot be destroyed. Integrity clamps
//! (stat floors, reconcile) still hold — privilege lifts targeting, never
//! state integrity.
use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec::Vec;
use serde_json::Value;

use crate::dice::roll;
use crate::error::ProceduralViolation;
use crate::presentation::{ActionKind, MechanicCue, PresentationCue};
use crate::stats::StatType;
use crate::world::descriptor::Catalog;
use crate::world::gate::GateVerdict;
use crate::world::history::ActionHistoryEntry;
use crate::world::ids::{CharacterId, ExitId, ItemId, RoomId};
use crate::world::mechanics::{Effect, HookCtx, MAX_EFFECTS_PER_EVENT};
use crate::world::rng::Rng;
use crate::world::World;

/// Opening hand size, dealt at `begin_campaign`.
pub const VILLAIN_HAND_SIZE: usize = 5;
/// Cards discarded AND drawn by the mulligan action.
pub const MULLIGAN_SIZE: usize = 3;

/// The villain-privileged effect union. `Std` reuses the standard `Effect`
/// vocabulary without the party-only targeting restriction; the other variants
/// are world-level powers only cards can reach. This union is MEANT to grow —
/// adding a variant here (plus its `apply_card_effect` arm) is the normal way
/// to give cards a new power.
#[derive(Clone, Debug, PartialEq)]
pub enum CardEffect {
    /// A standard effect, applied villain-privileged: `Damage`/`Heal`/
    /// `AdjustStat`/`GrantImmunity` may target ANY character (hero, mob, NPC,
    /// the villain itself), not just party members.
    Std(Effect),
    /// Remove `item` from `holder`'s inventory AND any equipment slot pointing
    /// at it, then from the item registry. Refused (`ProceduralViolation`) for
    /// protected items — see `card_protected`. No material deposit: villain
    /// destruction is loss, not scrapping.
    DestroyItem { holder: CharacterId, item: ItemId },
    /// Relocate ANY character to `room` through the shared `relocate` path:
    /// exit/enter scenes fire and the destination's visibility cue is emitted,
    /// but no budget tick, no move history, no spawn/encounter tail.
    Teleport { target: CharacterId, room: RoomId },
    /// Supernatural darkness: `campaign.lights_out_rounds = max(current,
    /// rounds)` — every room is unlit while active (see `is_lit`). Re-casting
    /// refreshes, never shortens.
    LightsOut { rounds: i64 },
    /// Merge a JSON object patch into an exit's persisted `state` (seal or
    /// unseal doors — the keyed-door `unlocked` flag is ordinary exit state).
    SetExitState { exit: ExitId, patch: Value },
}

/// Everything a card op needs beyond the world itself: who the villain is, the
/// card's catalog `config`, and the optional targets supplied by the command.
pub struct CardArgs {
    pub villain: CharacterId,
    /// The card's `CardDescriptor.config` (cloned; `Null` when the card has no
    /// descriptor or config).
    pub config: Value,
    pub room_target: Option<RoomId>,
    pub char_target: Option<CharacterId>,
}

/// A first-party Wicked Ways card. Stateless and one-shot: a card resolves to
/// effects exactly once, then moves to the discard pile.
pub trait CardBehavior: Sync {
    /// Pre-spend probe: can this card do anything right now (given the args)?
    /// Used by the solo villain policy to pick a card worth playing; the play
    /// path itself relies on `play`'s own errors (which abort before anything
    /// is spent). Defaults to `true`.
    fn playable(&self, _w: &World, _cat: &Catalog, _args: &CardArgs) -> bool {
        true
    }
    /// Resolve the card into effects. Draws randomness only from `rng`.
    fn play(
        &self,
        w: &World,
        cat: &Catalog,
        rng: &mut Rng,
        args: &CardArgs,
    ) -> Result<Vec<CardEffect>, ProceduralViolation>;
}

/// Resolve a first-party card by key. The compiled-in registry: the three
/// shipped Wicked Ways cards. Product features — NOT conformance-gated.
pub fn card_behavior(key: &str) -> Option<&'static dyn CardBehavior> {
    match key {
        "wicked:lights-out" => Some(&LIGHTS_OUT),
        "wicked:ruin" => Some(&RUIN),
        "wicked:shadow-step" => Some(&SHADOW_STEP),
        _ => None,
    }
}

/// A key resolved to a card behavior: compiled-in native, or the borrowed
/// `CardScript` AST from `catalog.behaviors` (Card family only).
pub enum ResolvedCardBehavior<'a> {
    Native(&'static dyn CardBehavior),
    Scripted(&'a crate::script::ast::CardScript),
}

/// Native registry first; on `None`, look the key up in `catalog.behaviors`
/// (Card family only). `None` when both miss.
pub fn resolve_card_behavior<'a>(key: &str, cat: &'a Catalog) -> Option<ResolvedCardBehavior<'a>> {
    if let Some(op) = card_behavior(key) {
        return Some(ResolvedCardBehavior::Native(op));
    }
    match cat.behaviors.get(key) {
        Some(crate::script::ast::BehaviorScript::Card { script }) => {
            Some(ResolvedCardBehavior::Scripted(script))
        }
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// The three first-party cards
// ---------------------------------------------------------------------------

/// `wicked:lights-out` — every light source goes inert for `config.rounds`
/// (default 2) rounds of supernatural darkness.
struct LightsOutCard;
static LIGHTS_OUT: LightsOutCard = LightsOutCard;

impl CardBehavior for LightsOutCard {
    fn playable(&self, w: &World, _cat: &Catalog, _args: &CardArgs) -> bool {
        // Pointless while darkness is already active (the solo policy skips it;
        // a human villain may still stack to refresh the duration).
        w.campaign.lights_out_rounds == 0
    }
    fn play(
        &self,
        _w: &World,
        _cat: &Catalog,
        _rng: &mut Rng,
        args: &CardArgs,
    ) -> Result<Vec<CardEffect>, ProceduralViolation> {
        let rounds = args
            .config
            .get("rounds")
            .and_then(Value::as_i64)
            .unwrap_or(2)
            .max(1);
        Ok(alloc::vec![
            CardEffect::Std(Effect::Cue {
                cue: MechanicCue {
                    text: Some("Every flame gutters and dies. The dark is absolute.".into()),
                    sound: None,
                },
            }),
            CardEffect::LightsOut { rounds },
        ])
    }
}

/// `wicked:ruin` — destroy a random unprotected item a hero is carrying. An
/// explicit `char_target` narrows the pick to that hero's items.
struct RuinCard;
static RUIN: RuinCard = RuinCard;

/// Every (hero, carried item) pair the Ruin card may destroy: party members
/// other than the villain, items not on the prohibition list.
fn ruin_candidates(w: &World, cat: &Catalog, args: &CardArgs) -> Vec<(CharacterId, ItemId)> {
    let mut out = Vec::new();
    for pid in &w.campaign.party_ids {
        if *pid == args.villain {
            continue;
        }
        if let Some(t) = &args.char_target {
            if t != pid {
                continue;
            }
        }
        if let Some(c) = w.characters.get(pid) {
            for item in &c.inventory.item_ids {
                if !w.card_protected(item, cat) {
                    out.push((pid.clone(), item.clone()));
                }
            }
        }
    }
    out
}

impl CardBehavior for RuinCard {
    fn playable(&self, w: &World, cat: &Catalog, args: &CardArgs) -> bool {
        !ruin_candidates(w, cat, args).is_empty()
    }
    fn play(
        &self,
        w: &World,
        cat: &Catalog,
        rng: &mut Rng,
        args: &CardArgs,
    ) -> Result<Vec<CardEffect>, ProceduralViolation> {
        let candidates = ruin_candidates(w, cat, args);
        if candidates.is_empty() {
            return Err(ProceduralViolation(
                "Ruin finds nothing to destroy: no hero carries an unprotected item.".into(),
            ));
        }
        let idx = (i64::from(roll(candidates.len() as u32, rng.next_f64())) - 1) as usize;
        let (holder, item) = candidates[idx].clone();
        let item_name = w.item_display_name(&item, cat);
        let holder_name = w
            .characters
            .get(&holder)
            .map(|c| c.name.clone())
            .unwrap_or_default();
        Ok(alloc::vec![
            CardEffect::Std(Effect::Cue {
                cue: MechanicCue {
                    text: Some(format!(
                        "The {item_name} crumbles to ruin in {holder_name}'s hands."
                    )),
                    sound: None,
                },
            }),
            CardEffect::DestroyItem { holder, item },
        ])
    }
}

/// `wicked:shadow-step` — teleport a character (default: the villain itself)
/// to any room. Requires a `room_target`.
struct ShadowStepCard;
static SHADOW_STEP: ShadowStepCard = ShadowStepCard;

impl CardBehavior for ShadowStepCard {
    fn playable(&self, w: &World, _cat: &Catalog, args: &CardArgs) -> bool {
        // Playable when the target room exists and differs from the subject's
        // current room.
        let subject = args.char_target.as_ref().unwrap_or(&args.villain);
        match &args.room_target {
            Some(room) => {
                w.rooms.contains_key(room)
                    && w.characters
                        .get(subject)
                        .is_some_and(|c| c.current_room_id.as_ref() != Some(room))
            }
            None => false,
        }
    }
    fn play(
        &self,
        w: &World,
        _cat: &Catalog,
        _rng: &mut Rng,
        args: &CardArgs,
    ) -> Result<Vec<CardEffect>, ProceduralViolation> {
        let Some(room) = args.room_target.clone() else {
            return Err(ProceduralViolation(
                "Shadow Step needs a target room.".into(),
            ));
        };
        if !w.rooms.contains_key(&room) {
            return Err(ProceduralViolation(format!(
                "Shadow Step target room '{}' does not exist.",
                room.0
            )));
        }
        let target = args
            .char_target
            .clone()
            .unwrap_or_else(|| args.villain.clone());
        if !w.characters.contains_key(&target) {
            return Err(ProceduralViolation(format!(
                "Shadow Step target '{}' does not exist.",
                target.0
            )));
        }
        let name = w
            .characters
            .get(&target)
            .map(|c| c.name.clone())
            .unwrap_or_default();
        Ok(alloc::vec![
            CardEffect::Std(Effect::Cue {
                cue: MechanicCue {
                    text: Some(format!("{name} steps into the shadows and is gone.")),
                    sound: None,
                },
            }),
            CardEffect::Teleport { target, room },
        ])
    }
}

// ---------------------------------------------------------------------------
// World integration
// ---------------------------------------------------------------------------

impl World {
    /// The card prohibition list — the explicit exception to the cards-reach-
    /// anything rule. Protected: keys (progression-critical, structurally
    /// undestroyable everywhere else in the engine) and quest items
    /// (`droppable: false`). A missing item is trivially protected.
    pub fn card_protected(&self, item: &ItemId, cat: &Catalog) -> bool {
        match self.items.get(item) {
            None | Some(crate::world::snapshot::ItemSnapshot::Key { .. }) => true,
            Some(crate::world::snapshot::ItemSnapshot::Item { behavior_key, .. }) => cat
                .items
                .get(behavior_key)
                .is_some_and(|d| d.properties.droppable == Some(false)),
        }
    }

    /// Display name for an item instance: descriptor name for catalog items,
    /// the key's own name field for keys, the raw id as a last resort.
    pub(crate) fn item_display_name(&self, item: &ItemId, cat: &Catalog) -> String {
        match self.items.get(item) {
            Some(crate::world::snapshot::ItemSnapshot::Item { behavior_key, .. }) => cat
                .items
                .get(behavior_key)
                .map_or_else(|| behavior_key.clone(), |d| d.name.clone()),
            Some(crate::world::snapshot::ItemSnapshot::Key { name, .. }) => name.clone(),
            None => item.0.clone(),
        }
    }

    /// Apply one villain-privileged card effect. `Std` effects route through
    /// the standard appliers minus the party-only targeting restriction; the
    /// card-specific variants mutate through the same seams the engine already
    /// uses (relocate, reconcile, exit state).
    pub fn apply_card_effect(
        &mut self,
        e: CardEffect,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
        match e {
            CardEffect::Std(Effect::Damage { target, amount }) => {
                self.adjust_stat_any(&target, StatType::Health, -amount.max(0.0), cat, cues)
            }
            CardEffect::Std(Effect::Heal { target, amount }) => {
                self.adjust_stat_any(&target, StatType::Health, amount.max(0.0), cat, cues)
            }
            CardEffect::Std(Effect::AdjustStat {
                target,
                stat,
                delta,
            }) => self.adjust_stat_any(&target, stat, delta, cat, cues),
            CardEffect::Std(Effect::GrantImmunity { target, turns }) => {
                // Same clamp as the party-restricted applier (`Math.max(0,
                // Math.trunc(turns))`), targeting unrestricted.
                let t = turns.max(0.0) as i64;
                if let Some(c) = self.characters.get_mut(&target) {
                    c.afflictions
                        .grant_immunity(&crate::world::mechanics::ALL_STATUSES, t);
                }
                Ok(())
            }
            // Cue/Status/GiveItem/SetVisible were never party-restricted —
            // delegate to the standard applier.
            CardEffect::Std(e) => self.apply_effect(e, cat, cues),
            CardEffect::DestroyItem { holder, item } => {
                if self.card_protected(&item, cat) {
                    return Err(ProceduralViolation(format!(
                        "Card cannot destroy protected item '{}'.",
                        item.0
                    )));
                }
                let held = self
                    .characters
                    .get(&holder)
                    .is_some_and(|c| c.inventory.item_ids.iter().any(|i| i == &item));
                if !held {
                    return Err(ProceduralViolation(format!(
                        "Cannot destroy item '{}': the character does not hold it.",
                        item.0
                    )));
                }
                if let Some(c) = self.characters.get_mut(&holder) {
                    c.inventory.item_ids.retain(|i| i != &item);
                    // Clear any equipment slot pointing at the item — unlike the
                    // free `destroy` verb, a card destroy leaves no dangling id.
                    c.equipment.retain(|_, id| id != &item);
                }
                self.items.remove(&item);
                Ok(())
            }
            CardEffect::Teleport { target, room } => {
                if !self.characters.contains_key(&target) {
                    return Err(ProceduralViolation(format!(
                        "Teleport target '{}' not found.",
                        target.0
                    )));
                }
                if !self.rooms.contains_key(&room) {
                    return Err(ProceduralViolation(format!(
                        "Teleport destination '{}' not found.",
                        room.0
                    )));
                }
                self.relocate(&target, &room, cat, cues)
            }
            CardEffect::LightsOut { rounds } => {
                let rounds = rounds.max(0);
                self.campaign.lights_out_rounds = self.campaign.lights_out_rounds.max(rounds);
                Ok(())
            }
            CardEffect::SetExitState { exit, patch } => {
                let Some(ex) = self.exits.get_mut(&exit) else {
                    return Err(ProceduralViolation(format!("Exit '{}' not found.", exit.0)));
                };
                let Some(patch_obj) = patch.as_object() else {
                    return Err(ProceduralViolation(
                        "SetExitState patch must be a JSON object.".into(),
                    ));
                };
                if !ex.state.is_object() {
                    ex.state = Value::Object(serde_json::Map::new());
                }
                if let Some(state) = ex.state.as_object_mut() {
                    for (k, v) in patch_obj {
                        state.insert(k.clone(), v.clone());
                    }
                }
                Ok(())
            }
        }
    }

    /// `adjust_stat` without the party-membership check — the villain-privileged
    /// stat mutator. Same floor-at-0 clamp and reconcile as the standard seam;
    /// a missing target is an error (cards name their targets explicitly).
    fn adjust_stat_any(
        &mut self,
        target: &CharacterId,
        stat: StatType,
        delta: f64,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
        if !self.characters.contains_key(target) {
            return Err(ProceduralViolation(format!(
                "Card effect target '{}' not found.",
                target.0
            )));
        }
        if let Some(c) = self.characters.get_mut(target) {
            let cur = c.stats.get_mut(stat);
            *cur = (*cur + delta).max(0.0);
        }
        self.reconcile(target, cat, cues);
        Ok(())
    }

    // -- deck economy -------------------------------------------------------

    /// Fisher-Yates over `World.rng` — the one shuffle primitive, so deck
    /// order is a pure function of the seed and draw history.
    fn shuffle_card_keys(&mut self, mut keys: Vec<String>) -> Vec<String> {
        let n = keys.len();
        for i in (1..n).rev() {
            let unit = self.rng.next_f64();
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let j = (unit * ((i + 1) as f64)) as usize;
            keys.swap(i, j.min(i));
        }
        keys
    }

    /// Draw `n` cards into the villain's hand. An empty deck reshuffles the
    /// discard back in first; with both piles empty the draw yields nothing.
    pub(crate) fn villain_draw(&mut self, n: usize) {
        for _ in 0..n {
            let needs_reshuffle = self
                .campaign
                .villain
                .as_ref()
                .is_some_and(|v| v.deck.is_empty() && !v.discard.is_empty());
            if needs_reshuffle {
                let discard = self
                    .campaign
                    .villain
                    .as_mut()
                    .map(|v| core::mem::take(&mut v.discard))
                    .unwrap_or_default();
                let reshuffled = self.shuffle_card_keys(discard);
                if let Some(v) = self.campaign.villain.as_mut() {
                    v.deck = reshuffled;
                }
            }
            let Some(v) = self.campaign.villain.as_mut() else {
                return;
            };
            match v.deck.pop() {
                Some(card) => v.hand.push(card),
                None => return, // both piles empty — nothing to draw
            }
        }
    }

    /// `begin_campaign` hook: shuffle the authored deck and deal the opening
    /// hand. A no-op without a villain (zero rng draws — existing goldens are
    /// untouched).
    pub(crate) fn villain_deal_opening_hand(&mut self) {
        if self.campaign.villain.is_none() {
            return;
        }
        let deck = self
            .campaign
            .villain
            .as_mut()
            .map(|v| core::mem::take(&mut v.deck))
            .unwrap_or_default();
        let shuffled = self.shuffle_card_keys(deck);
        if let Some(v) = self.campaign.villain.as_mut() {
            v.deck = shuffled;
        }
        self.villain_draw(VILLAIN_HAND_SIZE);
    }

    /// Guards shared by both card actions: a villain is designated, `actor` IS
    /// the villain, and the per-turn card-action latch is clear.
    fn require_villain_card_action(&self, actor: &CharacterId) -> Result<(), ProceduralViolation> {
        let Some(v) = &self.campaign.villain else {
            return Err(ProceduralViolation("This campaign has no Villain.".into()));
        };
        if &v.character_id != actor {
            return Err(ProceduralViolation(format!(
                "'{}' is not the Villain.",
                actor.0
            )));
        }
        if v.card_action_taken {
            return Err(ProceduralViolation(
                "The Villain has already taken a card action this turn.".into(),
            ));
        }
        Ok(())
    }

    /// Resolve a card's effects (native or scripted), rng-safe. Native ops read
    /// the whole world; the rng is temporarily moved out so the op can hold
    /// `&World` and `&mut Rng` simultaneously (the placeholder never draws).
    fn resolve_card_effects(
        &mut self,
        key: &str,
        args: &CardArgs,
        cat: &Catalog,
    ) -> Result<Vec<CardEffect>, ProceduralViolation> {
        let resolved = resolve_card_behavior(key, cat)
            .ok_or_else(|| ProceduralViolation(format!("Card '{key}' is not registered.")))?;
        match resolved {
            ResolvedCardBehavior::Native(op) => {
                let mut rng = core::mem::replace(&mut self.rng, Rng::seeded(0));
                let out = op.play(self, cat, &mut rng, args);
                self.rng = rng;
                out
            }
            ResolvedCardBehavior::Scripted(script) => {
                let view = self.build_campaign_view(cat);
                let actor_view = self.character_view(&args.villain, cat).ok_or_else(|| {
                    ProceduralViolation(format!("Villain '{}' not found.", args.villain.0))
                })?;
                // Cards are one-shot: no persistent script state (throwaway).
                let mut state = Value::Null;
                let effects = {
                    let mut base = HookCtx {
                        state: &mut state,
                        view: &view,
                        rng: &mut self.rng,
                    };
                    crate::script::ops::ScriptedCard { script }.on_play(&mut base, &actor_view)
                };
                Ok(effects.into_iter().map(CardEffect::Std).collect())
            }
        }
    }

    /// Play a Wicked Ways card: guards → affliction gate → resolve → apply →
    /// hand→discard → draw 1 → latch → history + cue → budgeted record.
    /// Any error aborts BEFORE the card is spent (the sync authority also
    /// rolls the world back wholesale on a violation).
    pub fn play_card(
        &mut self,
        actor: &CharacterId,
        card_key: &str,
        room_target: Option<RoomId>,
        char_target: Option<CharacterId>,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
        self.require_villain_card_action(actor)?;
        let in_hand = self
            .campaign
            .villain
            .as_ref()
            .is_some_and(|v| v.hand.iter().any(|k| k == card_key));
        if !in_hand {
            return Err(ProceduralViolation(format!(
                "Card '{card_key}' is not in the Villain's hand."
            )));
        }

        // Affliction gate (budgeted; fizzle burns budget but keeps the card
        // and the latch, like any other fizzled action).
        match self.gate(actor, false) {
            GateVerdict::Block(r) => return Err(ProceduralViolation(r)),
            GateVerdict::Fizzle => {
                return self.record_fumble(actor, "playCard", true, cat, cues);
            }
            GateVerdict::Allow => {}
        }

        let args = CardArgs {
            villain: actor.clone(),
            config: cat
                .cards
                .get(card_key)
                .map_or(Value::Null, |d| d.config.clone()),
            room_target,
            char_target,
        };
        let effects = self.resolve_card_effects(card_key, &args, cat)?;
        if effects.len() > MAX_EFFECTS_PER_EVENT {
            return Err(ProceduralViolation(format!(
                "Card '{card_key}' emitted too many effects."
            )));
        }
        for e in effects {
            self.apply_card_effect(e, cat, cues)?;
        }

        // Spend: hand -> discard, draw a replacement, set the per-turn latch.
        if let Some(v) = self.campaign.villain.as_mut() {
            if let Some(pos) = v.hand.iter().position(|k| k == card_key) {
                v.hand.remove(pos);
            }
            v.discard.push(card_key.to_string());
            v.card_action_taken = true;
        }
        self.villain_draw(1);

        // History + action cue, then the budgeted record (tick + on_action +
        // cap-check -> end_turn), mirroring `use_mechanic_action`.
        let round = self.campaign.round;
        if let Some(c) = self.characters.get_mut(actor) {
            c.history.push(ActionHistoryEntry::PlayCard {
                round,
                card: card_key.to_string(),
            });
        }
        cues.push(PresentationCue::Action {
            action: ActionKind::PlayCard,
            actor: self.entity_ref_char(actor),
            sound: None,
        });
        self.record_action(
            actor,
            true,
            &crate::world::mechanics::ActionView::of("playCard"),
            cat,
            cues,
        )
    }

    /// The mulligan: discard exactly `MULLIGAN_SIZE` named cards from the hand
    /// and draw that many — the turn's card action, playing nothing.
    pub fn mulligan(
        &mut self,
        actor: &CharacterId,
        card_keys: &[String],
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
        self.require_villain_card_action(actor)?;
        if card_keys.len() != MULLIGAN_SIZE {
            return Err(ProceduralViolation(format!(
                "A mulligan discards exactly {MULLIGAN_SIZE} cards."
            )));
        }
        // Multiset check: every named card must be removable from the hand
        // (duplicates in the hand may be discarded together).
        {
            let Some(v) = &self.campaign.villain else {
                return Err(ProceduralViolation("This campaign has no Villain.".into()));
            };
            let mut remaining = v.hand.clone();
            for key in card_keys {
                let Some(pos) = remaining.iter().position(|k| k == key) else {
                    return Err(ProceduralViolation(format!(
                        "Card '{key}' is not in the Villain's hand."
                    )));
                };
                remaining.remove(pos);
            }
        }

        match self.gate(actor, false) {
            GateVerdict::Block(r) => return Err(ProceduralViolation(r)),
            GateVerdict::Fizzle => {
                return self.record_fumble(actor, "mulligan", true, cat, cues);
            }
            GateVerdict::Allow => {}
        }

        if let Some(v) = self.campaign.villain.as_mut() {
            for key in card_keys {
                if let Some(pos) = v.hand.iter().position(|k| k == key) {
                    v.hand.remove(pos);
                    v.discard.push(key.clone());
                }
            }
            v.card_action_taken = true;
        }
        self.villain_draw(MULLIGAN_SIZE);

        let round = self.campaign.round;
        if let Some(c) = self.characters.get_mut(actor) {
            c.history.push(ActionHistoryEntry::Mulligan {
                round,
                cards: card_keys.to_vec(),
            });
        }
        cues.push(PresentationCue::Action {
            action: ActionKind::Mulligan,
            actor: self.entity_ref_char(actor),
            sound: None,
        });
        self.record_action(
            actor,
            true,
            &crate::world::mechanics::ActionView::of("mulligan"),
            cat,
            cues,
        )
    }

    /// The computer-driven Villain reaction (single-player solo mode). Runs
    /// after the player's turn — alongside mob reactions, before `next_player`
    /// so a fatal card is caught by the round's outcome check. Fires only when
    /// a villain is designated AND is not a party member (a party-member
    /// villain — the multiplayer GM case — takes real turns instead). KO'd
    /// villains skip.
    ///
    /// Policy (deterministic; all randomness through `World.rng`): probe each
    /// distinct card in hand for playability (Shadow Step stalks the active
    /// hero's room), play one at random if any qualifies; otherwise mulligan
    /// the first `MULLIGAN_SIZE` cards when the hand allows; otherwise pass.
    pub fn run_villain_turn(
        &mut self,
        active: &CharacterId,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
        let Some(v) = &self.campaign.villain else {
            return Ok(());
        };
        let villain_id = v.character_id.clone();
        if self.campaign.party_ids.iter().any(|id| id == &villain_id) {
            return Ok(());
        }
        if !self.characters.contains_key(&villain_id) || self.is_ko(&villain_id) {
            return Ok(());
        }
        // The computer's turn boundary: fresh budget and card-action latch
        // (the villain is outside the party rotation, so `start_turn` — with
        // its party-oriented mechanic hooks — never runs for it).
        if let Some(c) = self.characters.get_mut(&villain_id) {
            c.actions_this_round = 0;
        }
        if let Some(v) = self.campaign.villain.as_mut() {
            v.card_action_taken = false;
        }

        // The hero's room, for cards that stalk (Shadow Step).
        let hero_room = self
            .characters
            .get(active)
            .and_then(|c| c.current_room_id.clone());

        // Probe distinct hand keys for playability, in hand order.
        let hand = self
            .campaign
            .villain
            .as_ref()
            .map(|v| v.hand.clone())
            .unwrap_or_default();
        let mut distinct: Vec<String> = Vec::new();
        for k in &hand {
            if !distinct.iter().any(|d| d == k) {
                distinct.push(k.clone());
            }
        }
        let mut playable: Vec<(String, Option<RoomId>, Option<CharacterId>)> = Vec::new();
        for key in &distinct {
            // Policy targets: Shadow Step chases the active hero; other cards
            // target nothing (Ruin picks its own victim).
            let (room_target, char_target) = if key == "wicked:shadow-step" {
                (hero_room.clone(), None)
            } else {
                (None, None)
            };
            let args = CardArgs {
                villain: villain_id.clone(),
                config: cat.cards.get(key).map_or(Value::Null, |d| d.config.clone()),
                room_target: room_target.clone(),
                char_target: char_target.clone(),
            };
            let ok = match resolve_card_behavior(key, cat) {
                Some(ResolvedCardBehavior::Native(op)) => op.playable(self, cat, &args),
                Some(ResolvedCardBehavior::Scripted(_)) => true,
                None => false,
            };
            if ok {
                playable.push((key.clone(), room_target, char_target));
            }
        }

        if !playable.is_empty() {
            let idx = if playable.len() == 1 {
                0
            } else {
                (i64::from(roll(playable.len() as u32, self.rng.next_f64())) - 1) as usize
            };
            let (key, room_target, char_target) = playable[idx].clone();
            return self.play_card(&villain_id, &key, room_target, char_target, cat, cues);
        }
        if hand.len() >= MULLIGAN_SIZE {
            let discards: Vec<String> = hand[..MULLIGAN_SIZE].to_vec();
            return self.mulligan(&villain_id, &discards, cat, cues);
        }
        Ok(()) // nothing worth doing — the villain bides its time
    }

    /// Round-end tick for supernatural darkness. Emits the lift cue on the
    /// 1 -> 0 transition. Called from `end_round` before the round increments.
    pub(crate) fn tick_lights_out(&mut self, cues: &mut Vec<PresentationCue>) {
        if self.campaign.lights_out_rounds == 0 {
            return;
        }
        self.campaign.lights_out_rounds -= 1;
        if self.campaign.lights_out_rounds == 0 {
            cues.push(PresentationCue::Mechanic {
                cue: MechanicCue {
                    text: Some("The unnatural darkness lifts.".into()),
                    sound: None,
                },
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stats::StatType;
    use crate::world::descriptor::{CardDescriptor, ItemDescriptor, ItemType};
    use crate::world::ids::ItemId;
    use crate::world::snapshot::{ItemSnapshot, VillainSnapshot};
    use crate::world::test_support::{
        cid, item_desc, props, rid, world_two_rooms, world_with_party,
    };
    use crate::world::World;
    use alloc::string::ToString;
    use alloc::vec;

    fn designate_villain(w: &mut World, id: &str, deck: &[&str]) {
        w.campaign.villain = Some(VillainSnapshot {
            character_id: cid(id),
            deck: deck.iter().map(ToString::to_string).collect(),
            hand: vec![],
            discard: vec![],
            card_action_taken: false,
        });
    }

    fn deal(w: &mut World) {
        w.villain_deal_opening_hand();
    }

    fn total_cards(w: &World) -> usize {
        w.campaign
            .villain
            .as_ref()
            .map_or(0, |v| v.deck.len() + v.hand.len() + v.discard.len())
    }

    #[test]
    fn opening_hand_deals_five_and_preserves_the_card_pool() {
        let mut w = world_with_party(&["hero", "vill"], 10);
        designate_villain(
            &mut w,
            "vill",
            &[
                "wicked:lights-out",
                "wicked:ruin",
                "wicked:shadow-step",
                "wicked:lights-out",
                "wicked:ruin",
                "wicked:shadow-step",
                "wicked:lights-out",
            ],
        );
        deal(&mut w);
        let v = w.campaign.villain.as_ref().unwrap();
        assert_eq!(v.hand.len(), VILLAIN_HAND_SIZE);
        assert_eq!(v.deck.len(), 2);
        assert!(v.discard.is_empty());
        assert_eq!(total_cards(&w), 7);
    }

    #[test]
    fn opening_hand_is_deterministic_by_seed() {
        let build = |seed: u32| {
            let mut w = world_with_party(&["hero", "vill"], 10);
            w.rng = crate::world::rng::Rng::seeded(seed);
            designate_villain(
                &mut w,
                "vill",
                &["a-card", "b-card", "c-card", "d-card", "e-card", "f-card"],
            );
            // Register the fake keys so nothing rejects them (deal doesn't
            // validate, but keep the fixture honest about intent).
            deal(&mut w);
            w.campaign.villain.unwrap().hand
        };
        assert_eq!(build(7), build(7), "same seed must deal the same hand");
        // A different seed deals a different order for a 6-card deck (not a
        // hard guarantee in general, but stable for these fixed seeds).
        assert_ne!(build(7), build(8));
    }

    #[test]
    fn without_a_villain_deal_is_a_noop_and_draws_no_rng() {
        let mut w = world_with_party(&["hero"], 10);
        let before = w.rng.clone();
        deal(&mut w);
        assert_eq!(w.rng, before, "villain-less deal must not draw rng");
    }

    #[test]
    fn play_card_spends_discards_draws_and_latches() {
        let mut w = world_with_party(&["hero", "vill"], 10);
        designate_villain(
            &mut w,
            "vill",
            &[
                "wicked:lights-out",
                "wicked:lights-out",
                "wicked:lights-out",
                "wicked:lights-out",
                "wicked:lights-out",
                "wicked:lights-out",
            ],
        );
        deal(&mut w);
        let cat = Catalog::default();
        let mut cues = Vec::new();
        w.play_card(
            &cid("vill"),
            "wicked:lights-out",
            None,
            None,
            &cat,
            &mut cues,
        )
        .expect("play succeeds");
        let v = w.campaign.villain.as_ref().unwrap();
        assert_eq!(v.hand.len(), VILLAIN_HAND_SIZE, "played 1, drew 1");
        assert_eq!(v.discard.len(), 1);
        assert!(v.card_action_taken, "latch set");
        assert_eq!(w.campaign.lights_out_rounds, 2, "default duration");
        assert_eq!(
            w.characters.get(&cid("vill")).unwrap().actions_this_round,
            1,
            "budgeted"
        );
        // The exclusivity latch: a second card action this turn is refused.
        let second = w.play_card(
            &cid("vill"),
            "wicked:lights-out",
            None,
            None,
            &cat,
            &mut cues,
        );
        assert!(second.is_err(), "latch must refuse a second card action");
        let hand: Vec<String> = w.campaign.villain.as_ref().unwrap().hand.clone();
        let discards: Vec<String> = hand[..MULLIGAN_SIZE].to_vec();
        assert!(
            w.mulligan(&cid("vill"), &discards, &cat, &mut cues)
                .is_err(),
            "mulligan after playing must also be refused"
        );
    }

    #[test]
    fn mulligan_swaps_three_and_latches() {
        let mut w = world_with_party(&["hero", "vill"], 10);
        // 9 cards: deal 5, leaving a 4-card deck so the 3-card redraw needs no
        // reshuffle and the discards stay observable.
        designate_villain(
            &mut w,
            "vill",
            &[
                "wicked:ruin",
                "wicked:ruin",
                "wicked:ruin",
                "wicked:ruin",
                "wicked:ruin",
                "wicked:shadow-step",
                "wicked:shadow-step",
                "wicked:shadow-step",
                "wicked:lights-out",
            ],
        );
        deal(&mut w);
        let cat = Catalog::default();
        let mut cues = Vec::new();
        let hand = w.campaign.villain.as_ref().unwrap().hand.clone();
        let discards: Vec<String> = hand[..MULLIGAN_SIZE].to_vec();
        w.mulligan(&cid("vill"), &discards, &cat, &mut cues)
            .expect("mulligan succeeds");
        let v = w.campaign.villain.as_ref().unwrap();
        assert_eq!(v.hand.len(), VILLAIN_HAND_SIZE, "discarded 3, drew 3");
        assert_eq!(v.discard.len(), MULLIGAN_SIZE);
        assert!(v.card_action_taken);
        assert_eq!(total_cards(&w), 9, "no card leaves the pool");
        // And play is now refused this turn.
        let key = v.hand[0].clone();
        assert!(w
            .play_card(&cid("vill"), &key, None, None, &cat, &mut cues)
            .is_err());
    }

    #[test]
    fn mulligan_rejects_wrong_count_and_unheld_cards() {
        let mut w = world_with_party(&["hero", "vill"], 10);
        designate_villain(
            &mut w,
            "vill",
            &["wicked:ruin", "wicked:ruin", "wicked:ruin"],
        );
        deal(&mut w);
        let cat = Catalog::default();
        let mut cues = Vec::new();
        assert!(w
            .mulligan(&cid("vill"), &["wicked:ruin".into()], &cat, &mut cues)
            .is_err());
        assert!(w
            .mulligan(
                &cid("vill"),
                &["wicked:ruin".into(), "wicked:ruin".into(), "nope".into()],
                &cat,
                &mut cues,
            )
            .is_err());
    }

    #[test]
    fn only_the_villain_may_take_card_actions() {
        let mut w = world_with_party(&["hero", "vill"], 10);
        designate_villain(&mut w, "vill", &["wicked:lights-out"]);
        deal(&mut w);
        let cat = Catalog::default();
        let mut cues = Vec::new();
        assert!(w
            .play_card(
                &cid("hero"),
                "wicked:lights-out",
                None,
                None,
                &cat,
                &mut cues
            )
            .is_err());
        // And with no villain at all, everyone is refused.
        let mut w2 = world_with_party(&["hero"], 10);
        assert!(w2
            .play_card(
                &cid("hero"),
                "wicked:lights-out",
                None,
                None,
                &cat,
                &mut cues
            )
            .is_err());
    }

    #[test]
    fn latch_resets_on_the_villains_turn_start() {
        let mut w = world_with_party(&["hero", "vill"], 10);
        designate_villain(&mut w, "vill", &["wicked:lights-out", "wicked:ruin"]);
        deal(&mut w);
        if let Some(v) = w.campaign.villain.as_mut() {
            v.card_action_taken = true;
        }
        let cat = Catalog::default();
        let mut cues = Vec::new();
        w.start_turn(&cid("vill"), &cat, &mut cues).unwrap();
        assert!(!w.campaign.villain.as_ref().unwrap().card_action_taken);
        // A hero's turn start must NOT reset the villain's latch.
        if let Some(v) = w.campaign.villain.as_mut() {
            v.card_action_taken = true;
        }
        w.start_turn(&cid("hero"), &cat, &mut cues).unwrap();
        assert!(w.campaign.villain.as_ref().unwrap().card_action_taken);
    }

    #[test]
    fn empty_deck_reshuffles_the_discard() {
        let mut w = world_with_party(&["hero", "vill"], 10);
        designate_villain(&mut w, "vill", &[]);
        if let Some(v) = w.campaign.villain.as_mut() {
            v.discard = vec!["a".into(), "b".into(), "c".into()];
        }
        w.villain_draw(2);
        let v = w.campaign.villain.as_ref().unwrap();
        assert_eq!(v.hand.len(), 2, "drew through the reshuffle");
        assert_eq!(v.deck.len(), 1);
        assert!(v.discard.is_empty());
        // Both piles empty: the draw yields nothing, silently.
        w.villain_draw(5);
        let v = w.campaign.villain.as_ref().unwrap();
        assert_eq!(v.hand.len(), 3);
        assert!(v.deck.is_empty());
    }

    #[test]
    fn lights_out_darkens_every_room_and_ticks_back_off() {
        // world_two_rooms(false): both rooms non-dark, so normally always lit.
        let mut w = world_two_rooms(false);
        let cat = Catalog::default();
        assert!(w.is_lit(&rid("start"), &cat));
        w.campaign.lights_out_rounds = 2;
        assert!(!w.is_lit(&rid("start"), &cat), "supernatural darkness wins");
        assert!(!w.is_lit(&rid("next"), &cat));
        let mut cues = Vec::new();
        w.tick_lights_out(&mut cues);
        assert_eq!(w.campaign.lights_out_rounds, 1);
        assert!(cues.is_empty(), "no cue until the darkness lifts");
        w.tick_lights_out(&mut cues);
        assert_eq!(w.campaign.lights_out_rounds, 0);
        assert_eq!(cues.len(), 1, "the lift cue fires on the 1->0 transition");
        assert!(w.is_lit(&rid("start"), &cat), "light returns");
        // Ticking while inactive is a silent no-op.
        w.tick_lights_out(&mut cues);
        assert_eq!(w.campaign.lights_out_rounds, 0);
        assert_eq!(cues.len(), 1);
    }

    /// Catalog with three hero-carriable items: an ordinary sword, a quest item
    /// (`droppable: false`), and card faces for the three shipped cards.
    fn ruin_fixture() -> (World, Catalog) {
        let mut w = world_with_party(&["hero", "vill"], 10);
        designate_villain(
            &mut w,
            "vill",
            &[
                "wicked:ruin",
                "wicked:ruin",
                "wicked:ruin",
                "wicked:ruin",
                "wicked:ruin",
            ],
        );
        deal(&mut w);
        let mut cat = Catalog::default();
        cat.items.insert(
            "sword".into(),
            item_desc("Iron Sword", ItemType::Weapon, StatType::Health, 3),
        );
        let quest = ItemDescriptor {
            properties: crate::world::descriptor::ItemProperties {
                droppable: Some(false),
                ..props(false, false, false)
            },
            ..item_desc("Sacred Idol", ItemType::Accessory, StatType::Sanity, 0)
        };
        cat.items.insert("idol".into(), quest);
        cat.cards.insert(
            "wicked:ruin".into(),
            CardDescriptor {
                name: "Ruin".into(),
                text: None,
                config: serde_json::Value::Null,
            },
        );
        // Hero carries both items; the sword is also equipped (slot cleanup path).
        let sword_id = ItemId("i-sword".into());
        let idol_id = ItemId("i-idol".into());
        w.items.insert(
            sword_id.clone(),
            ItemSnapshot::Item {
                id: sword_id.clone(),
                behavior_key: "sword".into(),
                durability: None,
                modifier: 3,
            },
        );
        w.items.insert(
            idol_id.clone(),
            ItemSnapshot::Item {
                id: idol_id.clone(),
                behavior_key: "idol".into(),
                durability: None,
                modifier: 0,
            },
        );
        if let Some(hero) = w.characters.get_mut(&cid("hero")) {
            hero.inventory.item_ids = vec![sword_id.clone(), idol_id];
            hero.equipment.insert("leftHand".into(), sword_id);
        }
        (w, cat)
    }

    #[test]
    fn ruin_destroys_only_unprotected_items_and_cleans_equipment() {
        let (mut w, cat) = ruin_fixture();
        let mut cues = Vec::new();
        w.play_card(&cid("vill"), "wicked:ruin", None, None, &cat, &mut cues)
            .expect("ruin plays");
        let hero = w.characters.get(&cid("hero")).unwrap();
        // The only legal candidate was the sword — the idol is quest-protected.
        assert_eq!(hero.inventory.item_ids.len(), 1);
        assert_eq!(hero.inventory.item_ids[0].0, "i-idol");
        assert!(
            hero.equipment.is_empty(),
            "no dangling equipment id after a card destroy"
        );
        assert!(!w.items.contains_key(&ItemId("i-sword".into())));
    }

    #[test]
    fn ruin_is_unplayable_when_heroes_carry_nothing_unprotected() {
        let (mut w, cat) = ruin_fixture();
        // Strip the sword; only the protected idol remains.
        if let Some(hero) = w.characters.get_mut(&cid("hero")) {
            hero.inventory.item_ids.retain(|i| i.0 != "i-sword");
            hero.equipment.clear();
        }
        w.items.remove(&ItemId("i-sword".into()));
        let args = CardArgs {
            villain: cid("vill"),
            config: serde_json::Value::Null,
            room_target: None,
            char_target: None,
        };
        assert!(!RUIN.playable(&w, &cat, &args));
        let mut cues = Vec::new();
        let res = w.play_card(&cid("vill"), "wicked:ruin", None, None, &cat, &mut cues);
        assert!(
            res.is_err(),
            "ruin with no candidates errors before spending"
        );
        let v = w.campaign.villain.as_ref().unwrap();
        assert_eq!(v.hand.len(), VILLAIN_HAND_SIZE, "nothing spent");
        assert!(!v.card_action_taken);
    }

    #[test]
    fn card_protection_covers_keys_and_quest_items() {
        let (mut w, cat) = ruin_fixture();
        let key_id = ItemId("k-cellar".into());
        w.items.insert(
            key_id.clone(),
            ItemSnapshot::Key {
                id: key_id.clone(),
                name: "Cellar Key".into(),
                key_code: "cellar".into(),
                consume_on_use: false,
            },
        );
        assert!(w.card_protected(&key_id, &cat), "keys are protected");
        assert!(
            w.card_protected(&ItemId("i-idol".into()), &cat),
            "droppable:false quest items are protected"
        );
        assert!(
            !w.card_protected(&ItemId("i-sword".into()), &cat),
            "ordinary items are fair game"
        );
        assert!(
            w.card_protected(&ItemId("missing".into()), &cat),
            "a missing item is trivially protected"
        );
    }

    #[test]
    fn shadow_step_relocates_through_the_scene_pipeline() {
        // world_two_rooms: pc in "start"; make pc the villain and step to "next".
        let mut w = world_two_rooms(false);
        designate_villain(
            &mut w,
            "pc",
            &[
                "wicked:shadow-step",
                "wicked:shadow-step",
                "wicked:shadow-step",
                "wicked:shadow-step",
                "wicked:shadow-step",
            ],
        );
        deal(&mut w);
        let cat = Catalog::default();
        let mut cues = Vec::new();
        w.play_card(
            &cid("pc"),
            "wicked:shadow-step",
            Some(rid("next")),
            None,
            &cat,
            &mut cues,
        )
        .expect("shadow step plays");
        let pc = w.characters.get(&cid("pc")).unwrap();
        assert_eq!(pc.current_room_id.as_ref().unwrap().0, "next");
        assert!(w
            .rooms
            .get(&rid("next"))
            .unwrap()
            .occupant_ids
            .contains(&cid("pc")));
        assert!(!w
            .rooms
            .get(&rid("start"))
            .unwrap()
            .occupant_ids
            .contains(&cid("pc")));
        assert_eq!(
            pc.actions_this_round, 1,
            "one budget tick for the card play — the teleport itself is free"
        );
        // No target room → a clean error, nothing spent.
        let res = w.play_card(
            &cid("pc"),
            "wicked:shadow-step",
            None,
            None,
            &cat,
            &mut cues,
        );
        assert!(res.is_err());
    }

    #[test]
    fn solo_villain_policy_acts_after_a_player_turn() {
        // Non-party villain (computer-driven): seated as a mob-kind character
        // would be in a real campaign; here a bare character outside the party.
        let mut w = world_with_party(&["hero"], 10);
        let vill_id = cid("warden");
        let mut vill_snap = w.characters.get(&cid("hero")).unwrap().clone();
        vill_snap.id = vill_id.clone();
        vill_snap.name = "Warden".into();
        w.characters.insert(vill_id.clone(), vill_snap);
        w.campaign.villain = Some(VillainSnapshot {
            character_id: vill_id.clone(),
            // A card left in the deck so the replacement draw needs no
            // reshuffle and the played card stays observable in the discard.
            deck: vec!["wicked:ruin".into()],
            hand: vec!["wicked:lights-out".into()],
            discard: vec![],
            card_action_taken: false,
        });
        let cat = Catalog::default();
        let mut cues = Vec::new();
        w.run_villain_turn(&cid("hero"), &cat, &mut cues).unwrap();
        assert_eq!(
            w.campaign.lights_out_rounds, 2,
            "the computer villain played Lights Out"
        );
        assert_eq!(
            w.campaign.villain.as_ref().unwrap().discard.len(),
            1,
            "the played card hit the discard"
        );
        // A party-member villain is skipped (takes real turns instead).
        let mut w2 = world_with_party(&["hero", "vill"], 10);
        designate_villain(&mut w2, "vill", &[]);
        if let Some(v) = w2.campaign.villain.as_mut() {
            v.hand = vec!["wicked:lights-out".into()];
        }
        let mut cues2 = Vec::new();
        w2.run_villain_turn(&cid("hero"), &cat, &mut cues2).unwrap();
        assert_eq!(
            w2.campaign.lights_out_rounds, 0,
            "a party villain is not computer-driven"
        );
    }

    #[test]
    fn solo_villain_mulligans_when_nothing_is_playable() {
        let mut w = world_with_party(&["hero"], 10);
        let vill_id = cid("warden");
        let mut vill_snap = w.characters.get(&cid("hero")).unwrap().clone();
        vill_snap.id = vill_id.clone();
        vill_snap.name = "Warden".into();
        w.characters.insert(vill_id.clone(), vill_snap);
        // Hand of Ruins with no hero items -> unplayable; expect a mulligan.
        w.campaign.villain = Some(VillainSnapshot {
            character_id: vill_id,
            deck: vec!["wicked:lights-out".into()],
            hand: vec![
                "wicked:ruin".into(),
                "wicked:ruin".into(),
                "wicked:ruin".into(),
            ],
            discard: vec![],
            card_action_taken: false,
        });
        let cat = Catalog::default();
        let mut cues = Vec::new();
        w.run_villain_turn(&cid("hero"), &cat, &mut cues).unwrap();
        let v = w.campaign.villain.as_ref().unwrap();
        // The 3 Ruins were discarded; the redraw took the 1 deck card and then
        // reshuffled the discard for the other 2, so the hand is full again
        // and the pool is intact.
        assert_eq!(v.hand.len(), MULLIGAN_SIZE, "drew 3 back");
        assert!(v.card_action_taken);
        assert_eq!(total_cards(&w), 4);
    }
}
