//! Item use/read behaviors: an `ItemBehavior` trait resolved by `behavior_key` —
//! the item counterpart of `MechanicOp`. An item hook sees the actor (holder),
//! the campaign view, and the injected rng; there is no per-item script state.
//!
//! Unlike every other behavior family, an unresolved key is NOT an error:
//! `ItemSnapshot::Item.behavior_key` doubles as the `cat.items` descriptor key,
//! and most items carry no behavior entry at all. Resolution failing silently
//! (no-op on use/read) is the load-bearing contract — `validate_mechanics` must
//! never reject a plain item.
use alloc::vec::Vec;

use crate::world::descriptor::Catalog;
use crate::world::mechanics::{CharacterView, Effect, HookCtx};

/// A first-party item behavior. `on_use` fires from `use_item` — after the
/// usable/KO guards, before `grantsImmunity` + consume; `on_read` fires from
/// `read_item` — before the lore cue. Both default to "no effects".
///
/// The method bodies below are trait *default implementations* — an implementor
/// overrides only the hooks it cares about, like optional methods on a JS
/// interface. Leading-underscore parameter names mark them deliberately unused.
pub trait ItemBehavior: Sync {
    fn on_use(&self, _base: &mut HookCtx<'_>, _actor: &CharacterView) -> Vec<Effect> {
        Vec::new()
    }
    fn on_read(&self, _base: &mut HookCtx<'_>, _actor: &CharacterView) -> Vec<Effect> {
        Vec::new()
    }
}

/// Resolve a first-party item behavior by key. The native registry is empty
/// today; it exists so compiled-in behaviors can land without touching the
/// `use_item`/`read_item` dispatch sites, which resolve through it first.
pub fn item_behavior(key: &str) -> Option<&'static dyn ItemBehavior> {
    let _ = key;
    None
}

/// The resolved item behavior for a key: a compiled-in native behavior, or the
/// scripted `on_use`/`on_read` interpreted from `catalog.behaviors`. The item
/// counterpart of `ResolvedMechanicOp`/`ResolvedExitBehavior`.
pub enum ResolvedItemBehavior<'a> {
    Native(&'static dyn ItemBehavior),
    Scripted(crate::script::ops::ScriptedItem<'a>),
}

impl ResolvedItemBehavior<'_> {
    pub fn as_behavior(&self) -> &dyn ItemBehavior {
        match self {
            ResolvedItemBehavior::Native(b) => *b,
            ResolvedItemBehavior::Scripted(s) => s,
        }
    }
}

/// Resolve an item behavior key: the native registry FIRST, then
/// `catalog.behaviors` (Item family only). `None` — a silent no-op at the call
/// sites — for a missing key or a foreign-family binding under the same key.
pub fn resolve_item_behavior<'a>(key: &str, cat: &'a Catalog) -> Option<ResolvedItemBehavior<'a>> {
    if let Some(native) = item_behavior(key) {
        return Some(ResolvedItemBehavior::Native(native));
    }
    match cat.behaviors.get(key) {
        Some(crate::script::ast::BehaviorScript::Item { script }) => Some(
            ResolvedItemBehavior::Scripted(crate::script::ops::ScriptedItem { script }),
        ),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::script::ast::{BehaviorScript, ExitScript, Expr, ItemScript};
    use crate::script::value::Value;
    use alloc::string::String;
    use alloc::vec;

    fn cat_with(key: &str, b: BehaviorScript) -> Catalog {
        let mut cat = Catalog::default();
        cat.behaviors.insert(String::from(key), b);
        cat
    }

    #[test]
    fn missing_key_resolves_none() {
        assert!(resolve_item_behavior("lantern", &Catalog::default()).is_none());
    }

    #[test]
    fn foreign_family_binding_resolves_none() {
        // An Exit-family script under the item's key must stay a silent no-op,
        // exactly like the pre-trait dispatch sites behaved.
        let cat = cat_with(
            "lantern",
            BehaviorScript::Exit {
                script: ExitScript {
                    can_pass: Expr::Lit {
                        value: Value::Bool(true),
                    },
                    run_script: vec![],
                    pass_message: None,
                    fail_message: None,
                },
            },
        );
        assert!(resolve_item_behavior("lantern", &cat).is_none());
    }

    #[test]
    fn item_family_binding_resolves_scripted() {
        let cat = cat_with(
            "lantern",
            BehaviorScript::Item {
                script: ItemScript {
                    on_use: None,
                    on_read: None,
                },
            },
        );
        assert!(matches!(
            resolve_item_behavior("lantern", &cat),
            Some(ResolvedItemBehavior::Scripted(_))
        ));
    }
}
