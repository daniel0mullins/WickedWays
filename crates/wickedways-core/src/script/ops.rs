//! Adapter ops: satisfy the existing Phase-1 traits by interpreting a stored AST.
use alloc::vec::Vec;
use serde_json::Value as Json;

use crate::script::ast::{MechanicScript, Stmt};
use crate::script::eval::{eval_damage, eval_effects, Ctx, CtxState, RoomSource};
use crate::world::mechanics::{
    ActionCtx, DamageView, Effect, HookCtx, MechanicOp, TransformResult, TurnCtx,
};

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
