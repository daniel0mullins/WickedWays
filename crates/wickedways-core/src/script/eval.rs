//! The interpreter. Pure and TOTAL: no panics, no clock, no io; missing/ill-typed
//! reads resolve to `Null`/defaults. `alloc`-only.
use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec::Vec;

use super::ast::{BinOp, DamageBody, EffectTemplate, Expr, FieldTemplate, Stmt};
use super::value::coerce_str;
use super::value::json_to_value;
use super::value::value_to_json;
use super::value::Value;

use crate::presentation::{MechanicCue, StatusField};
use crate::world::descriptor::Catalog;
use crate::world::history::RoomRef;
use crate::world::ids::{CharacterId, ItemId};
use crate::world::mechanics::{
    ActionView, CampaignView, CharacterView, DamageView, Effect, RoomView, TransformResult,
};
use crate::world::World;

/// Runtime evaluation result: plain values, plus the read-model SUBJECTS
/// (characters/rooms/action/damage) which flow through expressions but are
/// never first-class serialized values (spec: read model).
#[derive(Clone, Debug)]
pub enum Ev {
    Val(Value),
    Char(CharacterView),
    Room(RoomView),
    RoomRef(RoomRef),
    Chars(Vec<CharacterView>),
    Action(ActionView),
    Damage(DamageView),
}

impl Ev {
    /// JS truthiness: subjects are objects, hence truthy.
    pub fn truthy(&self) -> bool {
        match self {
            Ev::Val(v) => v.truthy(),
            _ => true,
        }
    }
    /// Collapse to a plain `Value` (subjects have no value form -> Null).
    pub fn into_value(self) -> Value {
        match self {
            Ev::Val(v) => v,
            _ => Value::Null,
        }
    }
}

/// The mechanic/exit/victory state a script may read (and, for statement
/// bodies, write). `Read` supports predicate contexts (`can_pass` borrows
/// `&exit.state`); `Write` supports hook/script bodies.
pub enum CtxState<'a> {
    None,
    Read(&'a serde_json::Value),
    Write(&'a mut serde_json::Value),
}

/// Lazy, memoizing `character.room` resolver. `None` in mechanic/exit contexts
/// (the TS oracle cannot see rooms there); `World` in victory contexts.
pub enum RoomSource<'a> {
    None,
    World {
        world: &'a World,
        cat: &'a Catalog,
        cache: BTreeMap<String, Option<RoomView>>,
    },
}

impl RoomSource<'_> {
    fn resolve(&mut self, room_id: &str) -> Option<RoomView> {
        match self {
            RoomSource::None => None,
            RoomSource::World { world, cat, cache } => {
                if !cache.contains_key(room_id) {
                    let v = world.room_view(&crate::world::ids::RoomId(room_id.into()), cat);
                    cache.insert(String::from(room_id), v);
                }
                cache.get(room_id).cloned().flatten()
            }
        }
    }
}

pub struct Ctx<'a> {
    pub view: Option<&'a CampaignView>,
    pub state: CtxState<'a>,
    pub actor: Option<&'a CharacterView>,
    pub action: Option<&'a ActionView>,
    pub damage: Option<&'a DamageView>,
    /// The bound quantifier element (Task 6). The language's ONLY binding.
    pub element: Option<Ev>,
    /// Injected rng stream. No v1 node draws from it; plumbed so a future
    /// `Roll` node keeps the determinism contract without a signature change.
    pub rng: Option<&'a mut crate::world::rng::Rng>,
    pub rooms: RoomSource<'a>,
}

impl<'a> Ctx<'a> {
    pub fn empty() -> Ctx<'a> {
        Ctx {
            view: None,
            state: CtxState::None,
            actor: None,
            action: None,
            damage: None,
            element: None,
            rng: None,
            rooms: RoomSource::None,
        }
    }
}

pub fn eval_expr(e: &Expr, cx: &mut Ctx) -> Ev {
    match e {
        Expr::Lit { value } => Ev::Val(value.clone()),
        // A bare MapLit is only legal under Lookup/Has (load-time check, Task 9).
        Expr::MapLit { .. } => Ev::Val(Value::Null),
        Expr::Not { expr } => Ev::Val(Value::Bool(!eval_expr(expr, cx).truthy())),
        Expr::IfElse { cond, then, r#else } => {
            if eval_expr(cond, cx).truthy() {
                eval_expr(then, cx)
            } else {
                eval_expr(r#else, cx)
            }
        }
        Expr::Defined { expr } => {
            let d = !matches!(eval_expr(expr, cx), Ev::Val(Value::Null));
            Ev::Val(Value::Bool(d))
        }
        Expr::Str { num } => Ev::Val(Value::Str(coerce_str(&eval_expr(num, cx).into_value()))),
        Expr::Concat { parts } => {
            let mut out = String::new();
            for p in parts {
                out.push_str(&coerce_str(&eval_expr(p, cx).into_value()));
            }
            Ev::Val(Value::Str(out))
        }
        Expr::Bin { op, left, right } => {
            let l = eval_expr(left, cx).into_value();
            let r = eval_expr(right, cx).into_value();
            Ev::Val(eval_bin(*op, &l, &r))
        }

        Expr::Round => match cx.view {
            Some(v) => Ev::Val(Value::Number(v.round as f64)),
            None => Ev::Val(Value::Null),
        },
        Expr::MaxRounds => match cx.view {
            Some(v) => Ev::Val(Value::Number(v.max_rounds as f64)),
            None => Ev::Val(Value::Null),
        },
        Expr::Party => Ev::Chars(cx.view.map(|v| v.party.clone()).unwrap_or_default()),
        Expr::Actor => match cx.actor {
            Some(a) => Ev::Char(a.clone()),
            None => Ev::Val(Value::Null),
        },
        Expr::Action => match cx.action {
            Some(a) => Ev::Action(a.clone()),
            None => Ev::Val(Value::Null),
        },
        Expr::Damage => match cx.damage {
            Some(d) => Ev::Damage(d.clone()),
            None => Ev::Val(Value::Null),
        },
        Expr::Element => cx.element.clone().unwrap_or(Ev::Val(Value::Null)),

        Expr::Length { list } => match eval_expr(list, cx) {
            Ev::Chars(cs) => Ev::Val(Value::Number(cs.len() as f64)),
            Ev::Val(Value::List(vs)) => Ev::Val(Value::Number(vs.len() as f64)),
            _ => Ev::Val(Value::Null),
        },
        Expr::First { list } => index_list(eval_expr(list, cx), 0),
        Expr::Index { list, index } => {
            let l = eval_expr(list, cx);
            match eval_expr(index, cx).into_value() {
                Value::Number(i) if i >= 0.0 => index_list(l, i as usize),
                _ => Ev::Val(Value::Null),
            }
        }
        Expr::Includes { list, value } => {
            let v = eval_expr(value, cx).into_value();
            match eval_expr(list, cx) {
                Ev::Val(Value::List(items)) => {
                    Ev::Val(Value::Bool(items.iter().any(|it| vals_eq(it, &v))))
                }
                _ => Ev::Val(Value::Bool(false)),
            }
        }

        Expr::Some { list, pred } => {
            Ev::Val(Value::Bool(quantify(list, pred, cx, /*every=*/ false)))
        }
        Expr::Every { list, pred } => {
            Ev::Val(Value::Bool(quantify(list, pred, cx, /*every=*/ true)))
        }

        Expr::Get { of, field } => {
            let subject = eval_expr(of, cx);
            get_field(subject, field, cx)
        }
        Expr::HasEquipped { of, item_key } => Ev::Val(Value::Bool(
            matches!(eval_expr(of, cx), Ev::Char(c) if c.has_equipped(item_key)),
        )),
        Expr::HasItem { of, item_key } => Ev::Val(Value::Bool(
            matches!(eval_expr(of, cx), Ev::Char(c) if c.has_item(item_key)),
        )),
        Expr::HasKey { of, key_code } => Ev::Val(Value::Bool(
            matches!(eval_expr(of, cx), Ev::Char(c) if c.has_key(key_code)),
        )),

        Expr::StateGet { field, default } => {
            let read = match &cx.state {
                CtxState::Read(s) => s.get(field).cloned(),
                CtxState::Write(s) => s.get(field).cloned(),
                CtxState::None => None,
            };
            match read {
                Some(j) if !j.is_null() => Ev::Val(json_to_value(&j)),
                _ => Ev::Val(default.clone()),
            }
        }
        Expr::StateGetIn {
            map_field,
            key,
            default,
        } => {
            let k = coerce_str(&eval_expr(key, cx).into_value());
            let read = match &cx.state {
                CtxState::Read(s) => s.get(map_field).and_then(|m| m.get(&k)).cloned(),
                CtxState::Write(s) => s.get(map_field).and_then(|m| m.get(&k)).cloned(),
                CtxState::None => None,
            };
            match read {
                Some(j) if !j.is_null() => Ev::Val(json_to_value(&j)),
                _ => Ev::Val(default.clone()),
            }
        }
        Expr::Lookup { map, key } => {
            let k = coerce_str(&eval_expr(key, cx).into_value());
            match map.as_ref() {
                Expr::MapLit { entries } => match entries.get(&k) {
                    Some(v) => Ev::Val(v.clone()),
                    None => Ev::Val(Value::Null),
                },
                _ => Ev::Val(Value::Null), // load-time-rejected shape; total anyway
            }
        }
        Expr::Has { map, key } => {
            let k = coerce_str(&eval_expr(key, cx).into_value());
            match map.as_ref() {
                Expr::MapLit { entries } => Ev::Val(Value::Bool(entries.contains_key(&k))),
                _ => Ev::Val(Value::Bool(false)),
            }
        }
    }
}

/// Truthiness of a predicate body's single result (predicate contexts).
pub fn eval_predicate(e: &Expr, cx: &mut Ctx) -> bool {
    eval_expr(e, cx).truthy()
}

/// Control flow through a statement body: a falsy `Guard` halts.
enum Flow {
    Continue,
    Halt,
}

/// Evaluate an effect body (mechanic hooks / actions) into an ordered effect list.
pub fn eval_effects(body: &[Stmt], cx: &mut Ctx) -> Vec<Effect> {
    let mut effects = Vec::new();
    let mut pass = None;
    let _ = exec_stmts(body, cx, &mut effects, &mut pass);
    effects
}

/// Build a plain effect list from a bare template list (NPC dialogue `effects`).
/// Unlike `eval_effects` there is no `Stmt` control flow: every template is built
/// unconditionally, in order, and an unresolvable target drops just that one
/// (mirroring `build_effect`'s `if (target !== undefined)` guard).
pub fn eval_effect_templates(templates: &[EffectTemplate], cx: &mut Ctx) -> Vec<Effect> {
    templates
        .iter()
        .filter_map(|t| build_effect(t, cx))
        .collect()
}

/// Evaluate a `run_script` exit body into its optional narration (last `Pass` wins).
pub fn eval_script(body: &[Stmt], cx: &mut Ctx) -> Option<String> {
    let mut effects = Vec::new();
    let mut pass = None;
    let _ = exec_stmts(body, cx, &mut effects, &mut pass);
    pass
}

fn exec_stmts(
    stmts: &[Stmt],
    cx: &mut Ctx,
    effects: &mut Vec<Effect>,
    pass: &mut Option<String>,
) -> Flow {
    for s in stmts {
        match s {
            Stmt::Guard { cond } => {
                if !eval_expr(cond, cx).truthy() {
                    return Flow::Halt;
                }
            }
            Stmt::When { cond, then } => {
                if eval_expr(cond, cx).truthy() {
                    if let Flow::Halt = exec_stmts(then, cx, effects, pass) {
                        return Flow::Halt; // a nested Guard is an early return
                    }
                }
            }
            Stmt::SetState { field, value } => {
                let v = value_to_json(&eval_expr(value, cx).into_value());
                if let CtxState::Write(state) = &mut cx.state {
                    state_set(state, field, v);
                }
            }
            Stmt::SetStateIn {
                map_field,
                key,
                value,
            } => {
                let k = coerce_str(&eval_expr(key, cx).into_value());
                let v = value_to_json(&eval_expr(value, cx).into_value());
                if let CtxState::Write(state) = &mut cx.state {
                    state_set_in(state, map_field, &k, v);
                }
            }
            Stmt::Pass { value } => {
                *pass = Some(coerce_str(&eval_expr(value, cx).into_value()));
            }
            Stmt::Emit { effect } => {
                if let Some(e) = build_effect(effect, cx) {
                    effects.push(e);
                }
            }
        }
    }
    Flow::Continue
}

/// Resolve an effect-target expr to a `CharacterId` (a character subject or a
/// string id). `None` skips the emit — the dread-shadow `if (target !== undefined)` shape.
fn as_character_id(ev: Ev) -> Option<CharacterId> {
    match ev {
        Ev::Char(c) => Some(c.id),
        Ev::Val(Value::Str(s)) => Some(CharacterId(s)),
        _ => None,
    }
}

/// Resolve an effect item-target expr to an `ItemId` (a string id). `None` skips
/// the emit — mirrors `as_character_id`'s undefined-guard for item-carrying effects.
fn as_item_id(ev: Ev) -> Option<ItemId> {
    match ev.into_value() {
        Value::Str(s) => Some(ItemId(s)),
        _ => None,
    }
}

/// Coerce an evaluated expr to a number, else `None` (skips the emit).
fn as_number(ev: Ev) -> Option<f64> {
    match ev.into_value() {
        Value::Number(n) => Some(n),
        _ => None,
    }
}

/// Build one closed `Effect` from a template; `None` when target/amount are
/// unresolvable (skips that emit, mirroring the TS `if (target !== undefined)` guard).
fn build_effect(t: &EffectTemplate, cx: &mut Ctx) -> Option<Effect> {
    match t {
        EffectTemplate::Damage { target, amount } => Some(Effect::Damage {
            target: as_character_id(eval_expr(target, cx))?,
            amount: as_number(eval_expr(amount, cx))?,
        }),
        EffectTemplate::Heal { target, amount } => Some(Effect::Heal {
            target: as_character_id(eval_expr(target, cx))?,
            amount: as_number(eval_expr(amount, cx))?,
        }),
        EffectTemplate::AdjustStat {
            target,
            stat,
            delta,
        } => Some(Effect::AdjustStat {
            target: as_character_id(eval_expr(target, cx))?,
            stat: *stat,
            delta: as_number(eval_expr(delta, cx))?,
        }),
        EffectTemplate::GrantImmunity { target, turns } => Some(Effect::GrantImmunity {
            target: as_character_id(eval_expr(target, cx))?,
            turns: as_number(eval_expr(turns, cx))?,
        }),
        EffectTemplate::Cue { text } => Some(Effect::Cue {
            cue: MechanicCue {
                text: Some(coerce_str(&eval_expr(text, cx).into_value())),
                sound: None,
            },
        }),
        EffectTemplate::Status { fields } => Some(Effect::Status {
            fields: fields
                .iter()
                .map(|f: &FieldTemplate| StatusField {
                    label: f.label.clone(),
                    value: coerce_str(&eval_expr(&f.value, cx).into_value()),
                    emphasis: f
                        .emphasis
                        .as_ref()
                        .map(|e| coerce_str(&eval_expr(e, cx).into_value())),
                })
                .collect(),
        }),
        EffectTemplate::GiveItem { from, to, item } => Some(Effect::GiveItem {
            from: as_character_id(eval_expr(from, cx))?,
            to: as_character_id(eval_expr(to, cx))?,
            item: as_item_id(eval_expr(item, cx))?,
        }),
        EffectTemplate::SetVisible { target, visible } => Some(Effect::SetVisible {
            target: as_character_id(eval_expr(target, cx))?,
            visible: eval_expr(visible, cx).truthy(),
        }),
    }
}

/// Evaluate a `modify_damage` body into a `TransformResult`. A non-number result
/// falls back to `Value(d.amount)` (identity, total).
pub fn eval_damage(body: &DamageBody, d: &DamageView, cx: &mut Ctx) -> TransformResult {
    match body {
        DamageBody::Value { expr } => match as_number(eval_expr(expr, cx)) {
            Some(n) => TransformResult::Value(n),
            None => TransformResult::Value(d.amount), // total: identity
        },
        DamageBody::Final { expr } => match as_number(eval_expr(expr, cx)) {
            Some(n) => TransformResult::Final(n),
            None => TransformResult::Value(d.amount),
        },
        DamageBody::IfElse { cond, then, r#else } => {
            if eval_expr(cond, cx).truthy() {
                eval_damage(then, d, cx)
            } else {
                eval_damage(r#else, d, cx)
            }
        }
    }
}

/// `state[field] = v`, converting a non-object state to `{}` first (total).
pub(crate) fn state_set(state: &mut serde_json::Value, field: &str, v: serde_json::Value) {
    if !state.is_object() {
        *state = serde_json::json!({});
    }
    state[field] = v;
}

/// `state[map_field][key] = v`, auto-vivifying the map (TS `??=`).
pub(crate) fn state_set_in(
    state: &mut serde_json::Value,
    map_field: &str,
    key: &str,
    v: serde_json::Value,
) {
    if !state.is_object() {
        *state = serde_json::json!({});
    }
    if !state.get(map_field).map(|m| m.is_object()).unwrap_or(false) {
        state[map_field] = serde_json::json!({});
    }
    state[map_field][key] = v;
}

/// Bounded quantification. Binds `Ctx.element` per iteration (saving/restoring
/// any outer binding, so nesting shadows correctly). `every([])` is vacuously
/// true, `some([])` false — JS Array semantics.
fn quantify(list: &Expr, pred: &Expr, cx: &mut Ctx, every: bool) -> bool {
    let items: Vec<Ev> = match eval_expr(list, cx) {
        Ev::Chars(cs) => cs.into_iter().map(Ev::Char).collect(),
        Ev::Val(Value::List(vs)) => vs.into_iter().map(Ev::Val).collect(),
        _ => Vec::new(),
    };
    let saved = cx.element.take();
    let mut result = every;
    for item in items {
        cx.element = Some(item);
        let hit = eval_expr(pred, cx).truthy();
        if every && !hit {
            result = false;
            break;
        }
        if !every && hit {
            result = true;
            break;
        }
    }
    cx.element = saved;
    result
}

fn index_list(l: Ev, i: usize) -> Ev {
    match l {
        Ev::Chars(cs) => cs
            .get(i)
            .cloned()
            .map(Ev::Char)
            .unwrap_or(Ev::Val(Value::Null)),
        Ev::Val(Value::List(vs)) => vs
            .get(i)
            .cloned()
            .map(Ev::Val)
            .unwrap_or(Ev::Val(Value::Null)),
        _ => Ev::Val(Value::Null),
    }
}

fn status_name(s: crate::world::afflictions::Status) -> &'static str {
    use crate::world::afflictions::Status;
    match s {
        Status::Confused => "confused",
        Status::Fear => "fear",
        Status::Ko => "ko",
        Status::Panic => "panic",
    }
}

/// Field access on a subject. Total: unknown field / non-subject -> Null.
/// `char.room` resolves lazily in Task 4; `Action` fields widen in Task 8.
fn get_field(subject: Ev, field: &str, cx: &mut Ctx) -> Ev {
    match subject {
        Ev::Char(c) => match field {
            "sanity" => Ev::Val(Value::Number(c.sanity)),
            "energy" => Ev::Val(Value::Number(c.energy)),
            "health" => Ev::Val(Value::Number(c.health)),
            "name" => Ev::Val(Value::Str(c.name.clone())),
            "id" => Ev::Val(Value::Str(c.id.0.clone())),
            "roomId" => match &c.room_id {
                Some(r) => Ev::Val(Value::Str(r.clone())),
                None => Ev::Val(Value::Null),
            },
            "status" => Ev::Val(Value::List(
                c.status
                    .iter()
                    .map(|s| Value::Str(status_name(*s).into()))
                    .collect(),
            )),
            "room" => match &c.room_id {
                Some(rid) => match cx.rooms.resolve(rid) {
                    Some(rv) => Ev::Room(rv),
                    None => Ev::Val(Value::Null),
                },
                None => Ev::Val(Value::Null),
            },
            _ => Ev::Val(Value::Null),
        },
        Ev::Damage(d) => match field {
            "amount" => Ev::Val(Value::Number(d.amount)),
            "target" => Ev::Val(Value::Str(d.target.0.clone())),
            "stat" => Ev::Val(Value::Str(d.stat.as_str().into())),
            "source" => match &d.source {
                Some(s) => Ev::Val(Value::Str(s.0.clone())),
                None => Ev::Val(Value::Null),
            },
            _ => Ev::Val(Value::Null),
        },
        Ev::Room(r) => match field {
            "name" => Ev::Val(Value::Str(r.name.clone())),
            "id" => Ev::Val(Value::Str(r.id.clone())),
            "lit" => Ev::Val(Value::Bool(r.lit)),
            "occupants" => Ev::Chars(r.occupants.clone()),
            _ => Ev::Val(Value::Null),
        },
        Ev::Action(a) => match field {
            "kind" => Ev::Val(Value::Str(a.kind.clone())),
            "room" => match &a.room {
                Some(r) => Ev::RoomRef(r.clone()),
                None => Ev::Val(Value::Null),
            },
            _ => Ev::Val(Value::Null),
        },
        Ev::RoomRef(r) => match field {
            "id" => Ev::Val(Value::Str(r.id.0.clone())),
            "name" => Ev::Val(Value::Str(r.name.clone())),
            _ => Ev::Val(Value::Null),
        },
        _ => Ev::Val(Value::Null),
    }
}

fn eval_bin(op: BinOp, l: &Value, r: &Value) -> Value {
    use BinOp::*;
    match op {
        And => Value::Bool(l.truthy() && r.truthy()),
        Or => Value::Bool(l.truthy() || r.truthy()),
        Eq => Value::Bool(vals_eq(l, r)),
        Ne => Value::Bool(!vals_eq(l, r)),
        Add | Sub | Mul | Div => match (l, r) {
            (Value::Number(a), Value::Number(b)) => Value::Number(match op {
                Add => a + b,
                Sub => a - b,
                Mul => a * b,
                Div => a / b,
                _ => unreachable!(),
            }),
            _ => Value::Null, // non-numeric arithmetic: total, defined
        },
        Lt | Lte | Gt | Gte => match (l, r) {
            (Value::Number(a), Value::Number(b)) => Value::Bool(match op {
                Lt => a < b,
                Lte => a <= b,
                Gt => a > b,
                Gte => a >= b,
                _ => unreachable!(),
            }),
            _ => Value::Bool(false),
        },
    }
}

/// Strict same-type equality (mirrors the oracle's `===` uses). Mixed types are
/// never equal; `Null == Null` is true.
fn vals_eq(l: &Value, r: &Value) -> bool {
    match (l, r) {
        (Value::Number(a), Value::Number(b)) => a == b,
        (Value::Str(a), Value::Str(b)) => a == b,
        (Value::Bool(a), Value::Bool(b)) => a == b,
        (Value::Null, Value::Null) => true,
        (Value::List(a), Value::List(b)) => a == b,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::script::ast::{BinOp, Expr};
    use crate::script::value::Value;
    use alloc::collections::BTreeMap;

    use crate::presentation::StatusField;
    use crate::world::descriptor::Catalog;
    use crate::world::ids::{CharacterId, ItemId};
    use crate::world::mechanics::{Effect, TransformResult};
    use crate::world::snapshot::ItemSnapshot;
    use crate::world::test_support::world_with_party;

    fn cid(s: &str) -> CharacterId {
        CharacterId(s.into())
    }

    fn s_lit(v: Value) -> Expr {
        Expr::Lit { value: v }
    }

    #[test]
    fn effect_body_guard_when_setstate_emit_preserves_order() {
        let w = world_with_party(&["pc"], 10);
        let view = w.build_campaign_view(&Catalog::default());
        let actor = view.party[0].clone();
        let mut state = serde_json::json!({});
        // The dread-HH shape: guard(!hasEquipped) then emit adjustStat(actor)
        let body = alloc::vec![
            Stmt::Guard {
                cond: Expr::Not {
                    expr: Box::new(Expr::HasEquipped {
                        of: Box::new(Expr::Actor),
                        item_key: "lantern".into()
                    })
                }
            },
            Stmt::SetState {
                field: "fired".into(),
                value: s_lit(Value::Bool(true))
            },
            Stmt::Emit {
                effect: EffectTemplate::AdjustStat {
                    target: Expr::Actor,
                    stat: crate::stats::StatType::Sanity,
                    delta: s_lit(Value::Number(-1.0))
                }
            },
            Stmt::Emit {
                effect: EffectTemplate::Cue {
                    text: s_lit(Value::Str("after".into()))
                }
            },
        ];
        let mut cx = Ctx {
            view: Some(&view),
            actor: Some(&actor),
            state: CtxState::Write(&mut state),
            ..Ctx::empty()
        };
        let fx = eval_effects(&body, &mut cx);
        assert_eq!(fx.len(), 2, "guard passed; both emits ran, in order");
        assert!(
            matches!(&fx[0], Effect::AdjustStat { target, stat: crate::stats::StatType::Sanity, delta }
            if target == &cid("pc") && *delta == -1.0)
        );
        assert!(matches!(&fx[1], Effect::Cue { cue } if cue.text.as_deref() == Some("after")));
        assert_eq!(state, serde_json::json!({ "fired": true }));
    }

    #[test]
    fn give_item_and_set_visible_templates_build_effects() {
        // GiveItem: from/to resolve via string ids (as_character_id), item via
        // string id (as_item_id).
        let body = alloc::vec![Stmt::Emit {
            effect: EffectTemplate::GiveItem {
                from: s_lit(Value::Str("npc".into())),
                to: s_lit(Value::Str("pc".into())),
                item: s_lit(Value::Str("key-1".into())),
            }
        }];
        assert_eq!(
            eval_effects(&body, &mut Ctx::empty()),
            alloc::vec![Effect::GiveItem {
                from: cid("npc"),
                to: cid("pc"),
                item: ItemId("key-1".into()),
            }]
        );
        // SetVisible: target string + a bool-eval'd `visible` (truthy).
        let body2 = alloc::vec![Stmt::Emit {
            effect: EffectTemplate::SetVisible {
                target: s_lit(Value::Str("npc".into())),
                visible: s_lit(Value::Bool(false)),
            }
        }];
        assert_eq!(
            eval_effects(&body2, &mut Ctx::empty()),
            alloc::vec![Effect::SetVisible {
                target: cid("npc"),
                visible: false
            }]
        );
    }

    #[test]
    fn give_item_template_skips_when_item_id_unresolvable() {
        // A non-string `item` (Null here) fails as_item_id → the emit is skipped,
        // mirroring the target-undefined guard on the other templates.
        let body = alloc::vec![Stmt::Emit {
            effect: EffectTemplate::GiveItem {
                from: s_lit(Value::Str("npc".into())),
                to: s_lit(Value::Str("pc".into())),
                item: s_lit(Value::Null),
            }
        }];
        assert!(eval_effects(&body, &mut Ctx::empty()).is_empty());
    }

    #[test]
    fn guard_false_stops_and_keeps_accumulated_effects() {
        let body = alloc::vec![
            Stmt::Emit {
                effect: EffectTemplate::Cue {
                    text: s_lit(Value::Str("kept".into()))
                }
            },
            Stmt::Guard {
                cond: s_lit(Value::Bool(false))
            },
            Stmt::Emit {
                effect: EffectTemplate::Cue {
                    text: s_lit(Value::Str("dropped".into()))
                }
            },
        ];
        let fx = eval_effects(&body, &mut Ctx::empty());
        assert_eq!(fx.len(), 1);
        assert!(matches!(&fx[0], Effect::Cue { cue } if cue.text.as_deref() == Some("kept")));
        // a Guard nested in When also halts the WHOLE body (early return)
        let body2 = alloc::vec![
            Stmt::When {
                cond: s_lit(Value::Bool(true)),
                then: alloc::vec![Stmt::Guard {
                    cond: s_lit(Value::Bool(false))
                }]
            },
            Stmt::Emit {
                effect: EffectTemplate::Cue {
                    text: s_lit(Value::Str("late".into()))
                }
            },
        ];
        assert!(eval_effects(&body2, &mut Ctx::empty()).is_empty());
    }

    #[test]
    fn status_effect_template_builds_fields_with_optional_emphasis() {
        let body = alloc::vec![Stmt::Emit {
            effect: EffectTemplate::Status {
                fields: alloc::vec![
                    FieldTemplate {
                        label: "Sanity".into(),
                        value: Expr::Str {
                            num: Box::new(s_lit(Value::Number(7.0)))
                        },
                        emphasis: Some(s_lit(Value::Str("normal".into())))
                    },
                    FieldTemplate {
                        label: "Round".into(),
                        value: Expr::Concat {
                            parts: alloc::vec![
                                Expr::Str {
                                    num: Box::new(s_lit(Value::Number(3.0)))
                                },
                                s_lit(Value::Str("/".into())),
                                Expr::Str {
                                    num: Box::new(s_lit(Value::Number(150.0)))
                                },
                            ]
                        },
                        emphasis: None
                    },
                ]
            }
        }];
        let fx = eval_effects(&body, &mut Ctx::empty());
        assert_eq!(
            fx,
            alloc::vec![Effect::Status {
                fields: alloc::vec![
                    StatusField {
                        label: "Sanity".into(),
                        value: "7".into(),
                        emphasis: Some("normal".into())
                    },
                    StatusField {
                        label: "Round".into(),
                        value: "3/150".into(),
                        emphasis: None
                    },
                ]
            }]
        );
    }

    #[test]
    fn script_body_pass_and_state_write() {
        let mut state = serde_json::json!({ "unlocked": false });
        // the door shape: when(!unlocked) { unlocked = true; pass(opened) }
        let body = alloc::vec![Stmt::When {
            cond: Expr::Not {
                expr: Box::new(Expr::StateGet {
                    field: "unlocked".into(),
                    default: Value::Bool(false)
                })
            },
            then: alloc::vec![
                Stmt::SetState {
                    field: "unlocked".into(),
                    value: s_lit(Value::Bool(true))
                },
                Stmt::Pass {
                    value: s_lit(Value::Str("The door opens.".into()))
                },
            ],
        }];
        let mut cx = Ctx {
            state: CtxState::Write(&mut state),
            ..Ctx::empty()
        };
        assert_eq!(
            eval_script(&body, &mut cx),
            Some(alloc::string::String::from("The door opens."))
        );
        assert_eq!(state["unlocked"], serde_json::json!(true));
        // second run: unlocked -> no Pass -> None (the silent re-pass)
        let mut cx2 = Ctx {
            state: CtxState::Write(&mut state),
            ..Ctx::empty()
        };
        assert_eq!(eval_script(&body, &mut cx2), None);
    }

    #[test]
    fn damage_body_value_and_final() {
        let dv = crate::world::mechanics::DamageView {
            amount: 3.5,
            target: cid("pc"),
            stat: crate::stats::StatType::Health,
            source: None,
        };
        // the conformance-dread cap shape: amount > 3 ? Final(3) : Value(amount)
        let body = DamageBody::IfElse {
            cond: Expr::Bin {
                op: BinOp::Gt,
                left: Box::new(Expr::Get {
                    of: Box::new(Expr::Damage),
                    field: "amount".into(),
                }),
                right: Box::new(s_lit(Value::Number(3.0))),
            },
            then: Box::new(DamageBody::Final {
                expr: s_lit(Value::Number(3.0)),
            }),
            r#else: Box::new(DamageBody::Value {
                expr: Expr::Get {
                    of: Box::new(Expr::Damage),
                    field: "amount".into(),
                },
            }),
        };
        let mut cx = Ctx {
            damage: Some(&dv),
            ..Ctx::empty()
        };
        assert_eq!(
            eval_damage(&body, &dv, &mut cx),
            TransformResult::Final(3.0)
        );
        let dv2 = crate::world::mechanics::DamageView {
            amount: 2.0,
            ..dv.clone()
        };
        let mut cx2 = Ctx {
            damage: Some(&dv2),
            ..Ctx::empty()
        };
        assert_eq!(
            eval_damage(&body, &dv2, &mut cx2),
            TransformResult::Value(2.0)
        );
    }

    /// Seed a catalog-backed Item snapshot into the world (mirrors the
    /// items_actions.rs test helpers).
    fn seed_item(w: &mut crate::world::World, id: &str, behavior_key: &str) {
        w.items.insert(
            ItemId(id.into()),
            ItemSnapshot::Item {
                id: ItemId(id.into()),
                behavior_key: behavior_key.into(),
                durability: None,
                modifier: 0,
            },
        );
    }

    fn lit(v: Value) -> Box<Expr> {
        Box::new(Expr::Lit { value: v })
    }
    fn n(x: f64) -> Box<Expr> {
        lit(Value::Number(x))
    }
    fn ev(e: &Expr) -> Value {
        eval_expr(e, &mut Ctx::empty()).into_value()
    }

    #[test]
    fn arithmetic_is_ieee_f64() {
        assert_eq!(
            ev(&Expr::Bin {
                op: BinOp::Add,
                left: n(0.1),
                right: n(0.2)
            }),
            Value::Number(0.1 + 0.2)
        ); // bit-identical to JS 0.1+0.2
        assert_eq!(
            ev(&Expr::Bin {
                op: BinOp::Mul,
                left: n(3.0),
                right: n(1.2)
            }),
            Value::Number(3.0 * 1.2)
        );
        assert_eq!(
            ev(&Expr::Bin {
                op: BinOp::Div,
                left: n(1.0),
                right: n(0.0)
            }),
            Value::Number(f64::INFINITY)
        ); // JS 1/0
           // non-number operand -> Null (total, defined)
        assert_eq!(
            ev(&Expr::Bin {
                op: BinOp::Add,
                left: n(1.0),
                right: lit(Value::Null)
            }),
            Value::Null
        );
    }

    #[test]
    fn comparisons_and_equality() {
        assert_eq!(
            ev(&Expr::Bin {
                op: BinOp::Lt,
                left: n(2.0),
                right: n(3.0)
            }),
            Value::Bool(true)
        );
        assert_eq!(
            ev(&Expr::Bin {
                op: BinOp::Lte,
                left: n(3.0),
                right: n(3.0)
            }),
            Value::Bool(true)
        );
        assert_eq!(
            ev(&Expr::Bin {
                op: BinOp::Gt,
                left: n(2.0),
                right: n(3.0)
            }),
            Value::Bool(false)
        );
        assert_eq!(
            ev(&Expr::Bin {
                op: BinOp::Gte,
                left: n(3.0),
                right: n(3.0)
            }),
            Value::Bool(true)
        );
        assert_eq!(
            ev(&Expr::Bin {
                op: BinOp::Eq,
                left: lit(Value::Str("move".into())),
                right: lit(Value::Str("move".into()))
            }),
            Value::Bool(true)
        );
        assert_eq!(
            ev(&Expr::Bin {
                op: BinOp::Ne,
                left: lit(Value::Str("move".into())),
                right: lit(Value::Str("take".into()))
            }),
            Value::Bool(true)
        );
        // mixed types are never equal; Null == Null is true (JS null === null)
        assert_eq!(
            ev(&Expr::Bin {
                op: BinOp::Eq,
                left: n(1.0),
                right: lit(Value::Str("1".into()))
            }),
            Value::Bool(false)
        );
        assert_eq!(
            ev(&Expr::Bin {
                op: BinOp::Eq,
                left: lit(Value::Null),
                right: lit(Value::Null)
            }),
            Value::Bool(true)
        );
    }

    #[test]
    fn boolean_logic_uses_js_truthiness() {
        assert_eq!(
            ev(&Expr::Bin {
                op: BinOp::And,
                left: lit(Value::Bool(true)),
                right: lit(Value::Bool(false))
            }),
            Value::Bool(false)
        );
        assert_eq!(
            ev(&Expr::Bin {
                op: BinOp::Or,
                left: lit(Value::Bool(false)),
                right: n(5.0)
            }),
            Value::Bool(true)
        ); // 5 is truthy
        assert_eq!(
            ev(&Expr::Not {
                expr: lit(Value::Str(String::new()))
            }),
            Value::Bool(true)
        ); // "" falsy
        assert_eq!(
            ev(&Expr::Not {
                expr: lit(Value::Null)
            }),
            Value::Bool(true)
        );
    }

    #[test]
    fn str_and_concat_build_js_strings() {
        assert_eq!(ev(&Expr::Str { num: n(16.0) }), Value::Str("16".into()));
        assert_eq!(
            ev(&Expr::Str {
                num: lit(Value::Str("x".into()))
            }),
            Value::Str("x".into())
        );
        // `${round}/${maxRounds}` shape:
        assert_eq!(
            ev(&Expr::Concat {
                parts: alloc::vec![
                    Expr::Str { num: n(3.0) },
                    Expr::Lit {
                        value: Value::Str("/".into())
                    },
                    Expr::Str { num: n(150.0) },
                ]
            }),
            Value::Str("3/150".into())
        );
    }

    #[test]
    fn if_else_and_defined() {
        assert_eq!(
            ev(&Expr::IfElse {
                cond: lit(Value::Bool(true)),
                then: n(1.0),
                r#else: n(2.0)
            }),
            Value::Number(1.0)
        );
        assert_eq!(
            ev(&Expr::IfElse {
                cond: lit(Value::Null),
                then: n(1.0),
                r#else: n(2.0)
            }),
            Value::Number(2.0)
        );
        assert_eq!(ev(&Expr::Defined { expr: n(0.0) }), Value::Bool(true)); // 0 is defined
        assert_eq!(
            ev(&Expr::Defined {
                expr: lit(Value::Null)
            }),
            Value::Bool(false)
        );
    }

    #[test]
    fn campaign_and_character_reads() {
        let mut w = world_with_party(&["pc", "npc"], 10); // stats 5/5/5 each
        seed_item(&mut w, "lamp1", "lantern");
        // equip the lantern on pc; hold a journal item
        w.characters
            .get_mut(&cid("pc"))
            .unwrap()
            .equipment
            .insert("hand".into(), ItemId("lamp1".into()));
        seed_item(&mut w, "j1", "journal");
        w.characters
            .get_mut(&cid("pc"))
            .unwrap()
            .inventory
            .item_ids
            .push(ItemId("j1".into()));
        let view = w.build_campaign_view(&Catalog::default());

        let mut cx = Ctx {
            view: Some(&view),
            ..Ctx::empty()
        };
        let val = |e: &Expr, cx: &mut Ctx| eval_expr(e, cx).into_value();

        assert_eq!(val(&Expr::Round, &mut cx), Value::Number(0.0));
        assert_eq!(val(&Expr::MaxRounds, &mut cx), Value::Number(10.0));
        assert_eq!(
            val(
                &Expr::Length {
                    list: Box::new(Expr::Party)
                },
                &mut cx
            ),
            Value::Number(2.0)
        );

        let first = Expr::First {
            list: Box::new(Expr::Party),
        };
        assert_eq!(
            val(
                &Expr::Get {
                    of: Box::new(first.clone()),
                    field: "sanity".into()
                },
                &mut cx
            ),
            Value::Number(5.0)
        );
        assert_eq!(
            val(
                &Expr::Get {
                    of: Box::new(first.clone()),
                    field: "name".into()
                },
                &mut cx
            ),
            Value::Str("pc".into())
        );
        assert_eq!(
            val(
                &Expr::HasEquipped {
                    of: Box::new(first.clone()),
                    item_key: "lantern".into()
                },
                &mut cx
            ),
            Value::Bool(true)
        );
        assert_eq!(
            val(
                &Expr::HasItem {
                    of: Box::new(first.clone()),
                    item_key: "journal".into()
                },
                &mut cx
            ),
            Value::Bool(true)
        );
        assert_eq!(
            val(
                &Expr::HasItem {
                    of: Box::new(first.clone()),
                    item_key: "poker".into()
                },
                &mut cx
            ),
            Value::Bool(false)
        );
        // status list is empty (healthy) — Includes over it is false
        assert_eq!(
            val(
                &Expr::Includes {
                    list: Box::new(Expr::Get {
                        of: Box::new(first.clone()),
                        field: "status".into()
                    }),
                    value: Box::new(Expr::Lit {
                        value: Value::Str("ko".into())
                    }),
                },
                &mut cx
            ),
            Value::Bool(false)
        );
        // Index OOB -> Null; Get on Null -> Null (total)
        assert_eq!(
            val(
                &Expr::Get {
                    of: Box::new(Expr::Index {
                        list: Box::new(Expr::Party),
                        index: Box::new(Expr::Lit {
                            value: Value::Number(9.0)
                        })
                    }),
                    field: "sanity".into(),
                },
                &mut cx
            ),
            Value::Null
        );
    }

    #[test]
    fn actor_and_missing_view_reads_are_total() {
        let w = world_with_party(&["pc"], 10);
        let view = w.build_campaign_view(&Catalog::default());
        let actor = view.party[0].clone();
        let mut cx = Ctx {
            view: Some(&view),
            actor: Some(&actor),
            ..Ctx::empty()
        };
        assert_eq!(
            eval_expr(
                &Expr::Get {
                    of: Box::new(Expr::Actor),
                    field: "energy".into()
                },
                &mut cx
            )
            .into_value(),
            Value::Number(5.0)
        );
        // no view at all (exit-context shape): Round -> Null, Party -> empty list
        let mut bare = Ctx {
            actor: Some(&actor),
            ..Ctx::empty()
        };
        assert_eq!(eval_expr(&Expr::Round, &mut bare).into_value(), Value::Null);
        assert_eq!(
            eval_expr(
                &Expr::Length {
                    list: Box::new(Expr::Party)
                },
                &mut bare
            )
            .into_value(),
            Value::Number(0.0)
        );
    }

    #[test]
    fn character_room_resolves_lazily_with_room_reads() {
        // world_two_rooms seats "pc" in "start" (lit); "next" is dark.
        let w = crate::world::test_support::world_two_rooms(/*next_dark=*/ true);
        let cat = Catalog::default();
        let view = w.build_campaign_view(&cat);
        let actor = view.party[0].clone();
        let mut cx = Ctx {
            view: Some(&view),
            actor: Some(&actor),
            rooms: RoomSource::World {
                world: &w,
                cat: &cat,
                cache: BTreeMap::new(),
            },
            ..Ctx::empty()
        };
        let room = Expr::Get {
            of: Box::new(Expr::Actor),
            field: "room".into(),
        };
        let val = |e: &Expr, cx: &mut Ctx| eval_expr(e, cx).into_value();

        assert_eq!(
            val(
                &Expr::Get {
                    of: Box::new(room.clone()),
                    field: "name".into()
                },
                &mut cx
            ),
            Value::Str("Start".into())
        );
        assert_eq!(
            val(
                &Expr::Get {
                    of: Box::new(room.clone()),
                    field: "id".into()
                },
                &mut cx
            ),
            Value::Str("start".into())
        );
        assert_eq!(
            val(
                &Expr::Get {
                    of: Box::new(room.clone()),
                    field: "lit".into()
                },
                &mut cx
            ),
            Value::Bool(true)
        );
        // occupants -> Chars; nested occupant.room resolves again by id —
        // ID-indirection means NO cyclic data and NO infinite recursion.
        let nested = Expr::Get {
            of: Box::new(Expr::Get {
                of: Box::new(Expr::First {
                    list: Box::new(Expr::Get {
                        of: Box::new(room.clone()),
                        field: "occupants".into(),
                    }),
                }),
                field: "room".into(),
            }),
            field: "name".into(),
        };
        assert_eq!(val(&nested, &mut cx), Value::Str("Start".into()));
        // memoization: the cache now holds "start" exactly once
        match &cx.rooms {
            RoomSource::World { cache, .. } => assert_eq!(cache.len(), 1),
            _ => panic!("expected World room source"),
        }
    }

    #[test]
    fn state_reads_default_and_read_write_roundtrip() {
        let mut state = serde_json::json!({ "unlocked": false, "seen": { "Parlor": true } });
        {
            let mut cx = Ctx {
                state: CtxState::Read(&state),
                ..Ctx::empty()
            };
            let val = |e: &Expr, cx: &mut Ctx| eval_expr(e, cx).into_value();
            assert_eq!(
                val(
                    &Expr::StateGet {
                        field: "unlocked".into(),
                        default: Value::Bool(true)
                    },
                    &mut cx
                ),
                Value::Bool(false)
            ); // present value wins over default
            assert_eq!(
                val(
                    &Expr::StateGet {
                        field: "missing".into(),
                        default: Value::Number(7.0)
                    },
                    &mut cx
                ),
                Value::Number(7.0)
            ); // missing -> default
            let key = |s: &str| {
                Box::new(Expr::Lit {
                    value: Value::Str(s.into()),
                })
            };
            assert_eq!(
                val(
                    &Expr::StateGetIn {
                        map_field: "seen".into(),
                        key: key("Parlor"),
                        default: Value::Bool(false)
                    },
                    &mut cx
                ),
                Value::Bool(true)
            );
            assert_eq!(
                val(
                    &Expr::StateGetIn {
                        map_field: "seen".into(),
                        key: key("Attic"),
                        default: Value::Bool(false)
                    },
                    &mut cx
                ),
                Value::Bool(false)
            );
            // no-state ctx -> default (total)
            let mut none = Ctx::empty();
            assert_eq!(
                eval_expr(
                    &Expr::StateGet {
                        field: "x".into(),
                        default: Value::Null
                    },
                    &mut none
                )
                .into_value(),
                Value::Null
            );
        }
        // write helpers: set + auto-vivify (the storyteller `??=` shape)
        state_set(&mut state, "unlocked", serde_json::json!(true));
        assert_eq!(state["unlocked"], serde_json::json!(true));
        let mut fresh = serde_json::json!({});
        state_set_in(&mut fresh, "seen", "Nursery", serde_json::json!(true));
        assert_eq!(fresh, serde_json::json!({ "seen": { "Nursery": true } }));
    }

    #[test]
    fn static_map_lookup_and_has() {
        let mut entries = BTreeMap::new();
        entries.insert(String::from("Parlor"), Value::Str("lilies".into()));
        entries.insert(String::from("Study"), Value::Str("iron key".into()));
        let lore = Box::new(Expr::MapLit { entries });
        let key = |s: &str| {
            Box::new(Expr::Lit {
                value: Value::Str(s.into()),
            })
        };
        let mut cx = Ctx::empty();
        assert_eq!(
            eval_expr(
                &Expr::Lookup {
                    map: lore.clone(),
                    key: key("Parlor")
                },
                &mut cx
            )
            .into_value(),
            Value::Str("lilies".into())
        );
        assert_eq!(
            eval_expr(
                &Expr::Lookup {
                    map: lore.clone(),
                    key: key("Foyer")
                },
                &mut cx
            )
            .into_value(),
            Value::Null
        );
        assert_eq!(
            eval_expr(
                &Expr::Has {
                    map: lore.clone(),
                    key: key("Study")
                },
                &mut cx
            )
            .into_value(),
            Value::Bool(true)
        );
        assert_eq!(
            eval_expr(
                &Expr::Has {
                    map: lore.clone(),
                    key: key("Foyer")
                },
                &mut cx
            )
            .into_value(),
            Value::Bool(false)
        );
        // key coerces via JS String(): Has(map, Null) looks up "null" -> false
        assert_eq!(
            eval_expr(
                &Expr::Has {
                    map: lore,
                    key: Box::new(Expr::Lit { value: Value::Null })
                },
                &mut cx
            )
            .into_value(),
            Value::Bool(false)
        );
    }

    #[test]
    fn some_and_every_bind_element_over_party() {
        let mut w = world_with_party(&["a", "b"], 10); // sanity 5 each
        w.characters.get_mut(&cid("b")).unwrap().stats.sanity = 0.0;
        let view = w.build_campaign_view(&Catalog::default());
        let mut cx = Ctx {
            view: Some(&view),
            ..Ctx::empty()
        };
        let sanity_lte0 = Box::new(Expr::Bin {
            op: BinOp::Lte,
            left: Box::new(Expr::Get {
                of: Box::new(Expr::Element),
                field: "sanity".into(),
            }),
            right: Box::new(Expr::Lit {
                value: Value::Number(0.0),
            }),
        });
        // some(party, sanity <= 0): b qualifies -> true
        assert_eq!(
            eval_expr(
                &Expr::Some {
                    list: Box::new(Expr::Party),
                    pred: sanity_lte0.clone()
                },
                &mut cx
            )
            .into_value(),
            Value::Bool(true)
        );
        // every(party, sanity <= 0): a does not -> false
        assert_eq!(
            eval_expr(
                &Expr::Every {
                    list: Box::new(Expr::Party),
                    pred: sanity_lte0.clone()
                },
                &mut cx
            )
            .into_value(),
            Value::Bool(false)
        );
        // JS vacuous truth: every([]) -> true, some([]) -> false
        let empty = Box::new(Expr::Lit {
            value: Value::List(alloc::vec![]),
        });
        assert_eq!(
            eval_expr(
                &Expr::Every {
                    list: empty.clone(),
                    pred: sanity_lte0.clone()
                },
                &mut cx
            )
            .into_value(),
            Value::Bool(true)
        );
        assert_eq!(
            eval_expr(
                &Expr::Some {
                    list: empty,
                    pred: sanity_lte0
                },
                &mut cx
            )
            .into_value(),
            Value::Bool(false)
        );
        // the binding is restored after the quantifier
        assert!(cx.element.is_none());
    }

    #[test]
    fn quantifiers_over_value_lists_and_status_includes() {
        let mut w = world_with_party(&["a", "b"], 10);
        // KO both: health 0 + reconcile latches KO via afflictions.set_active
        for id in ["a", "b"] {
            let c = w.characters.get_mut(&cid(id)).unwrap();
            c.stats.health = 0.0;
            c.afflictions
                .set_active(crate::world::afflictions::Status::Ko, true);
        }
        let view = w.build_campaign_view(&Catalog::default());
        let mut cx = Ctx {
            view: Some(&view),
            ..Ctx::empty()
        };
        // the party-down oracle shape: every(party, status.includes("ko"))
        let pred = Box::new(Expr::Includes {
            list: Box::new(Expr::Get {
                of: Box::new(Expr::Element),
                field: "status".into(),
            }),
            value: Box::new(Expr::Lit {
                value: Value::Str("ko".into()),
            }),
        });
        assert_eq!(
            eval_expr(
                &Expr::Every {
                    list: Box::new(Expr::Party),
                    pred
                },
                &mut cx
            )
            .into_value(),
            Value::Bool(true)
        );
    }

    #[test]
    fn action_reads_expose_kind_and_move_room_payload() {
        use crate::world::history::RoomRef;
        use crate::world::ids::RoomId;
        let mv = crate::world::mechanics::ActionView {
            kind: "move".into(),
            room: Some(RoomRef {
                id: RoomId("parlor".into()),
                name: "Parlor".into(),
            }),
        };
        let mut cx = Ctx {
            action: Some(&mv),
            ..Ctx::empty()
        };
        let val = |e: &Expr, cx: &mut Ctx| eval_expr(e, cx).into_value();
        assert_eq!(
            val(
                &Expr::Get {
                    of: Box::new(Expr::Action),
                    field: "kind".into()
                },
                &mut cx
            ),
            Value::Str("move".into())
        );
        // the storyteller read: action.room.name
        assert_eq!(
            val(
                &Expr::Get {
                    of: Box::new(Expr::Get {
                        of: Box::new(Expr::Action),
                        field: "room".into()
                    }),
                    field: "name".into()
                },
                &mut cx
            ),
            Value::Str("Parlor".into())
        );
        // non-move: room -> Null, nested read stays total
        let other = crate::world::mechanics::ActionView::of("pickUp");
        let mut cx2 = Ctx {
            action: Some(&other),
            ..Ctx::empty()
        };
        assert_eq!(
            val(
                &Expr::Get {
                    of: Box::new(Expr::Get {
                        of: Box::new(Expr::Action),
                        field: "room".into()
                    }),
                    field: "name".into()
                },
                &mut cx2
            ),
            Value::Null
        );
    }

    #[test]
    fn room_reads_without_a_source_are_null() {
        let w = world_with_party(&["pc"], 10);
        let view = w.build_campaign_view(&Catalog::default());
        let actor = view.party[0].clone();
        let mut cx = Ctx {
            view: Some(&view),
            actor: Some(&actor),
            ..Ctx::empty()
        };
        let e = Expr::Get {
            of: Box::new(Expr::Get {
                of: Box::new(Expr::Actor),
                field: "room".into(),
            }),
            field: "name".into(),
        };
        assert_eq!(eval_expr(&e, &mut cx).into_value(), Value::Null);
    }
}
