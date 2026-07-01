//! Combat damage — byte-exact port of `combatant.ts` `attack` (:49-93) and
//! `character.ts` `takeDamage` (:930-971), `#reconcile` (:330-340),
//! `#floorAndSnapshot` (:308-317), and `onKnockOut` (:342-347).
//!
//! `take_damage` is internal-only (never a Command — TS only calls it from `attack`).
//! The sole rng draw in the combat path is the 4a Confused fizzle in `gate`.
use alloc::vec::Vec;

use crate::presentation::PresentationCue;
use crate::stats::StatType;
use crate::world::descriptor::Catalog;
use crate::world::ids::{CharacterId, ItemId};
use crate::world::snapshot::ItemSnapshot;
use crate::world::World;

impl World {
    /// Durability write seam (mirrors TS `SET_DURABILITY`). The ONLY place
    /// `ItemSnapshot::Item.durability` is mutated. No clamp — callers pass
    /// `durability - 1`, and only non-broken items (durability >= 1) ever wear.
    pub fn set_durability(&mut self, item: &ItemId, value: i64) {
        if let Some(ItemSnapshot::Item { durability, .. }) = self.items.get_mut(item) {
            *durability = Some(value);
        }
    }

    /// Custom-mechanics damage transform (TS `campaign[TRANSFORM_DAMAGE]`).
    /// Phase 1 has no mechanics → identity passthrough. Sub-plan 6 wires the
    /// mechanic registry here.
    pub fn transform_damage(&self, amount: f64, _target: &CharacterId, _stat: StatType) -> f64 {
        amount
    }

    /// Floor base stats, recompute afflictions from effective stats, and fire
    /// `on_knock_out` exactly once on a false→true KO transition. Byte-exact port
    /// of `character.ts` `#reconcile` (:330-340) + `#floorAndSnapshot` (:308-317).
    pub fn reconcile(&mut self, actor: &CharacterId, cat: &Catalog, cues: &mut Vec<PresentationCue>) {
        let was_ko = self
            .characters
            .get(actor)
            .map(|c| c.afflictions.is_active(crate::world::afflictions::Status::Ko))
            .unwrap_or(false);

        // #floorAndSnapshot: persistently clamp base stats to max(0.0, x).
        if let Some(c) = self.characters.get_mut(actor) {
            c.stats.health = c.stats.health.max(0.0);
            c.stats.sanity = c.stats.sanity.max(0.0);
            c.stats.energy = c.stats.energy.max(0.0);
        }
        // Effective snapshot (base + equipped-accessory bonuses) + passive immunities.
        let health = self.effective_stat(actor, StatType::Health, cat);
        let sanity = self.effective_stat(actor, StatType::Sanity, cat);
        let energy = self.effective_stat(actor, StatType::Energy, cat);
        let passive = self.passive_immune(actor, cat);
        if let Some(c) = self.characters.get_mut(actor) {
            c.afflictions.apply_from_stats(health, sanity, energy, &passive);
        }

        let is_ko = self
            .characters
            .get(actor)
            .map(|c| c.afflictions.is_active(crate::world::afflictions::Status::Ko))
            .unwrap_or(false);
        if !was_ko && is_ko {
            self.on_knock_out(actor, cat, cues);
        }
    }

    /// Hook fired once when KO newly latches during `reconcile`. Base behavior:
    /// none (mirrors base `Character.onKnockOut`). Sub-plan 4c overrides for
    /// `CharacterKind::Mob` to drop loot / record the encounter — hence `cues`
    /// is plumbed now.
    fn on_knock_out(&mut self, _actor: &CharacterId, _cat: &Catalog, _cues: &mut Vec<PresentationCue>) {
        // no-op (sub-plan 4c: Mob loot-drop override)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::afflictions::Status;
    use crate::world::descriptor::Catalog;
    use crate::world::ids::{CharacterId, ItemId};
    use crate::world::snapshot::ItemSnapshot;
    use crate::world::test_support::world_with_party;

    fn cid(s: &str) -> CharacterId { CharacterId(s.into()) }

    #[test]
    fn set_durability_writes_the_item() {
        let mut w = world_with_party(&["pc"], 10);
        let id = ItemId("sword".into());
        w.items.insert(id.clone(), ItemSnapshot::Item {
            id: id.clone(), behavior_key: "items/sword".into(),
            durability: Some(3), modifier: 2,
        });
        w.set_durability(&id, 2);
        match &w.items[&id] {
            ItemSnapshot::Item { durability, .. } => assert_eq!(*durability, Some(2)),
            _ => panic!("expected Item"),
        }
    }

    #[test]
    fn reconcile_floors_negative_base_and_latches_ko() {
        // health driven negative → reconcile floors base to 0 AND latches KO.
        let mut w = world_with_party(&["pc"], 10);
        let mut cues = Vec::new();
        if let Some(c) = w.characters.get_mut(&cid("pc")) { c.stats.health = -2.5; }
        w.reconcile(&cid("pc"), &Catalog::default(), &mut cues);
        let ch = w.characters.get(&cid("pc")).unwrap();
        assert_eq!(ch.stats.health, 0.0, "base health floored to 0");
        assert!(ch.afflictions.is_active(Status::Ko), "health<=0 latches KO");
    }

    #[test]
    fn reconcile_no_ko_when_health_positive() {
        let mut w = world_with_party(&["pc"], 10);
        let mut cues = Vec::new();
        // world_with_party sets 5/5/5 — healthy.
        w.reconcile(&cid("pc"), &Catalog::default(), &mut cues);
        assert!(!w.characters[&cid("pc")].afflictions.is_active(Status::Ko));
        assert!(cues.is_empty(), "base on_knock_out emits no cues");
    }

    #[test]
    fn transform_damage_is_identity() {
        let w = world_with_party(&["pc"], 10);
        assert_eq!(w.transform_damage(7.5, &cid("pc"), StatType::Health), 7.5);
    }
}
