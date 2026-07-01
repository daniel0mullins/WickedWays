//! Combat damage — byte-exact port of `combatant.ts` `attack` (:49-93) and
//! `character.ts` `takeDamage` (:930-971), `#reconcile` (:330-340),
//! `#floorAndSnapshot` (:308-317), and `onKnockOut` (:342-347).
//!
//! `take_damage` is internal-only (never a Command — TS only calls it from `attack`).
//! The sole rng draw in the combat path is the 4a Confused fizzle in `gate`.
use alloc::collections::BTreeSet;
use alloc::vec::Vec;

use crate::damage::{compute_mitigated_damage, DamageInput};
use crate::presentation::{ActionKind, PresentationCue};
use crate::stats::StatType;
use crate::world::descriptor::{Catalog, ItemType};
use crate::world::history::ActionHistoryEntry;
use crate::world::ids::{CharacterId, ItemId};
use crate::world::resolve::{resolve_item, ResolvedItem};
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

    /// Resolve a character's equipped items (de-duplicating two-handed items that
    /// occupy two slots), mirroring `effective_stat`'s equipped-set derivation.
    fn equipped_resolved(&self, actor: &CharacterId, cat: &Catalog) -> Vec<ResolvedItem> {
        let Some(ch) = self.characters.get(actor) else { return Vec::new() };
        let equipped_ids: BTreeSet<&ItemId> = ch.equipment.values().collect();
        equipped_ids
            .into_iter()
            .filter_map(|id| self.items.get(id))
            .filter_map(|snap| resolve_item(snap, cat).ok())
            .collect()
    }

    /// Apply an incoming hit to `target`'s `attack_stat` after armor + mitigation,
    /// wear contributing armor, reconcile, and record a NON-budgeted `takeDamage`.
    /// Byte-exact port of `character.ts` `takeDamage` (:930-971). Internal only.
    pub fn take_damage(
        &mut self,
        target: &CharacterId,
        attack_strength: f64,
        attack_stat: StatType,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) {
        // Equipped, non-broken armor defending this stat soaks raw strength first.
        let equipped = self.equipped_resolved(target, cat);
        let armor: Vec<&ResolvedItem> = equipped
            .iter()
            .filter(|r| r.r#type == ItemType::Armor && !r.is_broken && r.stat == attack_stat)
            .collect();
        let armor_sum: i64 = armor.iter().map(|r| r.modifier).sum();
        // Snapshot the wear list (owned) NOW so the immutable borrow of `equipped`
        // ends before the mutable stat write below.
        let worn: Vec<(ItemId, i64)> = armor
            .iter()
            .filter(|r| r.max_durability.is_some())
            .map(|r| (ItemId(r.id.clone()), r.durability.unwrap_or(0) - 1))
            .collect();

        let mitigator = self.effective_stat(target, attack_stat.mitigator(), cat);
        let light_averse = self
            .characters
            .get(target)
            .and_then(|c| c.light_averse)
            .unwrap_or(false);
        let room_lit = self
            .characters
            .get(target)
            .and_then(|c| c.current_room_id.clone())
            .map(|rid| self.is_lit(&rid))
            .unwrap_or(false);

        let final_strength = compute_mitigated_damage(DamageInput {
            attack_strength,
            armor_sum: armor_sum as f64,
            mitigator,
            light_averse,
            room_lit,
        });
        let dealt = self.transform_damage(final_strength, target, attack_stat);

        // Subtract from the base stat (no clamp here — reconcile floors it).
        if let Some(c) = self.characters.get_mut(target) {
            match attack_stat {
                StatType::Health => c.stats.health -= dealt,
                StatType::Sanity => c.stats.sanity -= dealt,
                StatType::Energy => c.stats.energy -= dealt,
            }
        }

        // Each contributing armor piece wears one point.
        for (id, val) in worn {
            self.set_durability(&id, val);
        }

        self.reconcile(target, cat, cues);

        // Record takeDamage — NOT budgeted (takeDamage is absent from isActionMap).
        let round = self.campaign.round;
        if let Some(c) = self.characters.get_mut(target) {
            c.history.push(ActionHistoryEntry::TakeDamage {
                round,
                amount: dealt,
                stat: attack_stat,
            });
        }
        cues.push(PresentationCue::Action {
            action: ActionKind::TakeDamage,
            actor: self.entity_ref_char(target),
            sound: None,
        });
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

    use crate::world::descriptor::{ItemDescriptor, ItemProperties, ItemType, SlotKind};
    use alloc::collections::BTreeMap;
    use serde_json::json;

    fn armor_desc(stat: StatType, modifier: i64, max_dur: Option<i64>) -> ItemDescriptor {
        ItemDescriptor {
            name: "Test Armor".into(), r#type: ItemType::Armor, stat, modifier,
            properties: ItemProperties { equippable: true, equipped: false, destroyable: true, usable: false, droppable: None },
            slot: Some(SlotKind::Torso), two_handed: None, emits_light: None,
            max_durability: max_dur, lore: None, presentation: None, key_code: None,
            consume_on_use: None, recipe: json!({}), teaches: json!(null),
            immunities: json!([]), grants_immunity: json!(null),
        }
    }

    #[test]
    fn take_damage_no_armor_subtracts_mitigated_amount() {
        // attack_strength=5, no armor, mitigator = effective(Sanity) for Health damage.
        // world_with_party: health/sanity/energy = 5. mitigator(Health)=Sanity=5.
        // dealt = max(0,5-0) * max(0,10-5)*0.2 * 1 = 5 * 1.0 = 5.0 → health 5-5 = 0 → KO.
        let mut w = world_with_party(&["pc"], 10);
        let mut cues = Vec::new();
        w.take_damage(&cid("pc"), 5.0, StatType::Health, &Catalog::default(), &mut cues);
        let ch = w.characters.get(&cid("pc")).unwrap();
        assert_eq!(ch.stats.health, 0.0);
        assert!(ch.afflictions.is_active(Status::Ko));
        // history: takeDamage with fractional-capable amount, NOT budgeted.
        assert_eq!(ch.actions_this_round, 0, "takeDamage never ticks budget");
        match ch.history.last().unwrap() {
            ActionHistoryEntry::TakeDamage { amount, stat, .. } => {
                assert_eq!(*amount, 5.0);
                assert_eq!(*stat, StatType::Health);
            }
            other => panic!("expected TakeDamage, got {:?}", other),
        }
        // cue: takeDamage on the TARGET.
        match cues.last().unwrap() {
            PresentationCue::Action { action: ActionKind::TakeDamage, actor, sound: None } => {
                assert_eq!(actor.id, "pc");
            }
            other => panic!("expected takeDamage cue, got {:?}", other),
        }
    }

    #[test]
    fn take_damage_armor_reduces_and_wears() {
        // Equip armor(modifier=3, max_dur=2) defending Health. attack_strength=5.
        // armorSum=3 → mitigated_strength=max(0,5-3)=2; mult=(10-5)*0.2=1.0 → dealt=2.0.
        // health 5-2 = 3.0; armor durability 2 -> 1.
        let mut w = world_with_party(&["pc"], 10);
        let mut cues = Vec::new();
        let armor_id = ItemId("armor".into());
        let mut items = BTreeMap::new();
        items.insert("items/armor".to_string(), armor_desc(StatType::Health, 3, Some(2)));
        let cat = Catalog { items, aliases: BTreeMap::new() };
        w.items.insert(armor_id.clone(), ItemSnapshot::Item {
            id: armor_id.clone(), behavior_key: "items/armor".into(),
            durability: Some(2), modifier: 3,
        });
        w.characters.get_mut(&cid("pc")).unwrap().equipment.insert("torso".into(), armor_id.clone());

        w.take_damage(&cid("pc"), 5.0, StatType::Health, &cat, &mut cues);

        assert_eq!(w.characters[&cid("pc")].stats.health, 3.0);
        match &w.items[&armor_id] {
            ItemSnapshot::Item { durability, .. } => assert_eq!(*durability, Some(1), "armor wore 1"),
            _ => panic!(),
        }
    }

    #[test]
    fn take_damage_broken_armor_does_not_mitigate_or_wear() {
        // Armor at durability 0 is broken → excluded from armorSum AND from wear.
        let mut w = world_with_party(&["pc"], 10);
        let mut cues = Vec::new();
        let armor_id = ItemId("armor".into());
        let mut items = BTreeMap::new();
        items.insert("items/armor".to_string(), armor_desc(StatType::Health, 3, Some(2)));
        let cat = Catalog { items, aliases: BTreeMap::new() };
        w.items.insert(armor_id.clone(), ItemSnapshot::Item {
            id: armor_id.clone(), behavior_key: "items/armor".into(),
            durability: Some(0), modifier: 3,
        });
        w.characters.get_mut(&cid("pc")).unwrap().equipment.insert("torso".into(), armor_id.clone());

        w.take_damage(&cid("pc"), 5.0, StatType::Health, &cat, &mut cues);

        // No mitigation: dealt = 5 * (10-5)*0.2 = 5.0 → health 0.
        assert_eq!(w.characters[&cid("pc")].stats.health, 0.0);
        // Broken armor stays at 0 (no wear below 0).
        match &w.items[&armor_id] {
            ItemSnapshot::Item { durability, .. } => assert_eq!(*durability, Some(0)),
            _ => panic!(),
        }
    }
}
