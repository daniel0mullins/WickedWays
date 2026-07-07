//! Adapter ops: satisfy the existing Phase-1 traits by interpreting a stored AST.
use alloc::collections::BTreeMap;
use alloc::vec::Vec;
use serde_json::Value as Json;

use crate::script::ast::{ExitScript, ItemScript, MechanicScript, Stmt, VictoryScript};
use crate::script::eval::{eval_damage, eval_effects, eval_predicate, eval_script, Ctx, CtxState, RoomSource};
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
}
