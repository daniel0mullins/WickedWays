//! Combat damage — byte-exact port of `combatant.ts` `attack` (:49-93) and
//! `character.ts` `takeDamage` (:930-971), `#reconcile` (:330-340),
//! `#floorAndSnapshot` (:308-317), and `onKnockOut` (:342-347).
//!
//! `take_damage` is internal-only (never a Command — TS only calls it from `attack`).
//! The sole rng draw in the combat path is the 4a Confused fizzle in `gate`.
use alloc::collections::BTreeSet;
use alloc::format;
use alloc::vec::Vec;
use serde_json::{json, Value};

use crate::damage::{compute_mitigated_damage, DamageInput};
use crate::error::ProceduralViolation;
use crate::presentation::{ActionKind, PresentationCue};
use crate::stats::StatType;
use crate::world::descriptor::{Catalog, ItemType};
use crate::world::gate::GateVerdict;
use crate::world::history::{ActionHistoryEntry, TargetRef};
use crate::world::ids::{CharacterId, ItemId, LootId};
use crate::world::resolve::{resolve_item, ResolvedItem};
use crate::world::snapshot::{CharacterKind, ItemSnapshot, LootSnapshot};
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

    /// Hook fired once when KO newly latches during `reconcile`. Players: no-op. Mobs:
    /// deposit materials + drop inventory into a `${mob.id}:remains` loot box. Byte-exact
    /// port of `Mob.onKnockOut` (`mob.ts:174-215`).
    fn on_knock_out(&mut self, actor: &CharacterId, _cat: &Catalog, _cues: &mut Vec<PresentationCue>) {
        let is_mob = self.characters.get(actor)
            .map(|c| matches!(c.kind, CharacterKind::Mob)).unwrap_or(false);
        if !is_mob { return; }

        // Snapshot drop-relevant fields.
        let (material_drops, room_id, is_room_origin, item_ids, key_ids, mob_name) = {
            let Some(c) = self.characters.get(actor) else { return };
            (
                c.material_drops.clone(),
                c.current_room_id.clone(),
                c.origin.as_ref().and_then(|v| v.as_str()) == Some("room"),
                c.inventory.item_ids.clone(),
                c.inventory.key_ids.clone(),
                c.name.clone(),
            )
        };

        // 1. Materials deposit + codex records (before the item drop).
        if let Some(md) = &material_drops {
            if md.as_object().map(|o| !o.is_empty()).unwrap_or(false) {
                let by = self.active_character_id().ok().map(|c| c.0);
                let room_str = room_id.as_ref().map(|r| r.0.clone());
                self.deposit_materials(md, by.as_deref(), room_str.as_deref());
            }
        }

        // 2. Item/key drop.
        let Some(room) = room_id else { return };
        let keys = if is_room_origin { key_ids } else { alloc::vec::Vec::new() };
        if item_ids.is_empty() && keys.is_empty() { return; }

        // Relinquish from the mob's inventory.
        if let Some(c) = self.characters.get_mut(actor) {
            c.inventory.item_ids.retain(|id| !item_ids.contains(id));
            if is_room_origin {
                c.inventory.key_ids.retain(|id| !keys.contains(id));
            }
        }

        // Create the remains box: id = ${mob.id}:remains, capacity = items.len()+2,
        // contents = items ++ stashed keys (keys pushed beyond capacity, per STASH_DROP).
        let box_id = LootId(alloc::format!("{}:remains", actor.0));
        let capacity = item_ids.len() as i64 + 2;
        let mut content_ids = item_ids;
        content_ids.extend(keys);
        self.loot.insert(box_id.clone(), LootSnapshot {
            id: box_id.clone(),
            description: alloc::format!("{}'s remains", mob_name),
            capacity,
            content_ids,
        });
        if let Some(r) = self.rooms.get_mut(&room) {
            r.loot_ids.push(box_id);
        }
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

    /// Throw if the actor cannot see (unlit room and not `sees_in_dark`).
    /// Mirrors `character.ts` `requireVisibleTarget` (:266-271): checks only the
    /// actor's own visibility, not the target's location.
    fn require_visible_target(&self, actor: &CharacterId, verb: &str) -> Result<(), ProceduralViolation> {
        if let Some(ch) = self.characters.get(actor) {
            if let Some(room_id) = &ch.current_room_id {
                if !self.is_lit(room_id) && !self.sees_in_dark(actor) {
                    return Err(ProceduralViolation(format!("Cannot {verb} in the dark")));
                }
            }
        }
        Ok(())
    }

    /// The actor's unarmed strike (stat + power). Default `{ Health, 1 }`, parsed
    /// from the `natural_attack` snapshot field. Mirrors `combatant.ts` `naturalAttack`
    /// (:37-39) / `DEFAULT_NATURAL_ATTACK` (:13). Mob overrides land in sub-plan 4c.
    fn natural_attack(&self, actor: &CharacterId) -> (StatType, f64) {
        #[derive(serde::Deserialize)]
        struct NaturalAttackJson { stat: StatType, power: f64 }
        let default = (StatType::Health, 1.0);
        let Some(ch) = self.characters.get(actor) else { return default };
        let Some(v) = &ch.natural_attack else { return default };
        match serde_json::from_value::<NaturalAttackJson>(v.clone()) {
            Ok(na) => (na.stat, na.power),
            Err(_) => default,
        }
    }

    /// Attack `target`. Gated (affliction) then dark-checked; each equipped
    /// non-broken weapon adds its modifier to its stat (else a natural strike);
    /// damage lands per stat in [Health, Energy, Sanity] order; weapons wear one
    /// point; a budgeted `attack` is recorded. Byte-exact port of `combatant.ts`
    /// `attack` (:49-93).
    pub fn attack(
        &mut self,
        actor: &CharacterId,
        target: &CharacterId,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
        // 1. Affliction gate (attack is a non-move, budgeted action).
        match self.gate(actor, false) {
            GateVerdict::Block(reason) => return Err(ProceduralViolation(reason)),
            GateVerdict::Fizzle => {
                self.record_fumble(actor, "attack", true, cat, cues);
                return Ok(());
            }
            GateVerdict::Allow => {}
        }
        // 2. Dark check (after the gate, matching TS order).
        self.require_visible_target(actor, "attack")?;

        // 3. Equipped, non-broken weapons.
        let equipped = self.equipped_resolved(actor, cat);
        let weapons: Vec<&ResolvedItem> = equipped
            .iter()
            .filter(|r| r.r#type == ItemType::Weapon && !r.is_broken)
            .collect();

        // 4. Attack matrix in fixed order [Health, Energy, Sanity].
        let mut matrix: [(StatType, f64); 3] = [
            (StatType::Health, 0.0),
            (StatType::Energy, 0.0),
            (StatType::Sanity, 0.0),
        ];
        if weapons.is_empty() {
            let (nstat, npow) = self.natural_attack(actor);
            for e in matrix.iter_mut() {
                if e.0 == nstat {
                    e.1 += npow;
                }
            }
        } else {
            for w in &weapons {
                for e in matrix.iter_mut() {
                    if e.0 == w.stat {
                        e.1 += w.modifier as f64;
                    }
                }
            }
        }

        // Snapshot the weapon wear list (owned) before the &mut self calls below.
        let worn: Vec<(ItemId, i64)> = weapons
            .iter()
            .filter(|r| r.max_durability.is_some())
            .map(|r| (ItemId(r.id.clone()), r.durability.unwrap_or(0) - 1))
            .collect();

        // 5. Inflict damage per stat with strength > 0, in matrix order.
        for (stat, strength) in matrix {
            if strength > 0.0 {
                self.take_damage(target, strength, stat, cat, cues);
            }
        }

        // 6. Each weapon that swung wears one point (after damage).
        for (id, val) in worn {
            self.set_durability(&id, val);
        }

        // 7. Record the budgeted attack on the attacker.
        let round = self.campaign.round;
        let target_name = self
            .characters
            .get(target)
            .map(|c| c.name.clone())
            .unwrap_or_default();
        if let Some(c) = self.characters.get_mut(actor) {
            c.history.push(ActionHistoryEntry::Attack {
                round,
                target: TargetRef { id: target.clone(), name: target_name },
            });
        }
        cues.push(PresentationCue::Action {
            action: ActionKind::Attack,
            actor: self.entity_ref_char(actor),
            sound: None,
        });
        self.record_action(actor, cat, cues);
        Ok(())
    }

    /// Append a codex entry, first-write-wins per `(kind, key)`. Mirrors `codex.ts`
    /// `record()` (:226-232) + `buildEntry`. `firstSeen.characterId`/`roomId` are
    /// omitted when `by`/`room` are `None` (matching TS `by?.id` / `where?.id`).
    pub(crate) fn record_codex(&mut self, kind: &str, key: &str, snapshot: Value, by: Option<&str>, room: Option<&str>) {
        let exists = self.codex.as_array().map(|a| a.iter().any(|e| {
            e.get("kind").and_then(|v| v.as_str()) == Some(kind)
                && e.get("key").and_then(|v| v.as_str()) == Some(key)
        })).unwrap_or(false);
        if exists { return; }
        let round = self.campaign.round;
        let mut first_seen = serde_json::Map::new();
        first_seen.insert("round".into(), json!(round));
        if let Some(b) = by { first_seen.insert("characterId".into(), json!(b)); }
        if let Some(r) = room { first_seen.insert("roomId".into(), json!(r)); }
        let entry = json!({ "kind": kind, "key": key, "snapshot": snapshot, "firstSeen": Value::Object(first_seen) });
        if let Some(arr) = self.codex.as_array_mut() { arr.push(entry); }
    }

    /// Merge a `MaterialMap` additively into `campaign.materials`, then record one
    /// `{kind:"material"}` codex entry per component. Port of `DEPOSIT_MATERIALS`
    /// (`campaign.ts:580-587`) + the material `RECORD_ENCOUNTER` in `Mob.onKnockOut`.
    pub fn deposit_materials(&mut self, materials: &Value, by: Option<&str>, room: Option<&str>) {
        let Some(obj) = materials.as_object() else { return };
        // Ensure the pool is an object.
        if !self.campaign.materials.is_object() {
            self.campaign.materials = json!({});
        }
        // 1. Additive merge.
        if let Some(pool) = self.campaign.materials.as_object_mut() {
            for (component, qty) in obj {
                let add = qty.as_i64().unwrap_or(0);
                let cur = pool.get(component).and_then(|v| v.as_i64()).unwrap_or(0);
                pool.insert(component.clone(), json!(cur + add));
            }
        }
        // 2. One codex record per component (deduped material::<component>).
        let components: Vec<alloc::string::String> = obj.keys().cloned().collect();
        for component in components {
            self.record_codex("material", &component, json!({ "type": component }), by, room);
        }
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
    use alloc::collections::{BTreeMap, BTreeSet};
    use serde_json::json;

    fn weapon_desc(stat: StatType, modifier: i64, max_dur: Option<i64>) -> ItemDescriptor {
        ItemDescriptor {
            name: "Test Weapon".into(), r#type: ItemType::Weapon, stat, modifier,
            properties: ItemProperties { equippable: true, equipped: false, destroyable: true, usable: false, droppable: None },
            slot: Some(SlotKind::Hand), two_handed: None, emits_light: None,
            max_durability: max_dur, lore: None, presentation: None, key_code: None,
            consume_on_use: None, recipe: json!({}), teaches: json!(null),
            immunities: json!([]), grants_immunity: json!(null),
        }
    }

    /// Two-PC world (ada attacks ben). Returns (world, empty catalog). Callers
    /// rebind `w` as mutable. require_visible_target passes here: is_lit returns
    /// true for a missing/None current room, so no dark block.
    fn duel_world() -> (World, Catalog) {
        let w = world_with_party(&["ada", "ben"], 10);
        (w, Catalog::default())
    }

    #[test]
    fn attack_with_weapon_deals_damage_wears_weapon_and_ticks_budget() {
        // ada equips weapon(Health, modifier=5, max_dur=3). ben health 5.
        // ben.takeDamage(5, Health): mitigator(Sanity)=5 → dealt=5*1.0=5 → ben health 0, KO.
        let (mut w, _c) = duel_world();
        let mut cues = Vec::new();
        let wpn = ItemId("axe".into());
        let mut items = BTreeMap::new();
        items.insert("items/axe".to_string(), weapon_desc(StatType::Health, 5, Some(3)));
        let cat = Catalog { items, aliases: BTreeMap::new() };
        w.items.insert(wpn.clone(), ItemSnapshot::Item {
            id: wpn.clone(), behavior_key: "items/axe".into(), durability: Some(3), modifier: 5,
        });
        w.characters.get_mut(&cid("ada")).unwrap().equipment.insert("hand".into(), wpn.clone());

        w.attack(&cid("ada"), &cid("ben"), &cat, &mut cues).unwrap();

        assert_eq!(w.characters[&cid("ben")].stats.health, 0.0);
        assert!(w.characters[&cid("ben")].afflictions.is_active(Status::Ko));
        // weapon wore 3 -> 2
        match &w.items[&wpn] {
            ItemSnapshot::Item { durability, .. } => assert_eq!(*durability, Some(2)),
            _ => panic!(),
        }
        // attacker budget ticked; target's did not.
        assert_eq!(w.characters[&cid("ada")].actions_this_round, 1);
        assert_eq!(w.characters[&cid("ben")].actions_this_round, 0);
        // attacker recorded an Attack; last cue is the attack cue on the attacker.
        assert!(matches!(w.characters[&cid("ada")].history.last().unwrap(),
            ActionHistoryEntry::Attack { .. }));
        match cues.last().unwrap() {
            PresentationCue::Action { action: ActionKind::Attack, actor, sound: None } =>
                assert_eq!(actor.id, "ada"),
            other => panic!("expected attack cue, got {:?}", other),
        }
    }

    #[test]
    fn attack_unarmed_uses_natural_attack_default_1_health() {
        // No weapon → natural attack (Health, 1). ben health 5 → dealt=1*1.0=1 → 4.0.
        let (mut w, cat) = duel_world();
        let mut cues = Vec::new();
        w.attack(&cid("ada"), &cid("ben"), &cat, &mut cues).unwrap();
        assert_eq!(w.characters[&cid("ben")].stats.health, 4.0);
    }

    #[test]
    fn attack_ko_actor_is_blocked() {
        let (mut w, cat) = duel_world();
        let mut cues = Vec::new();
        w.characters.get_mut(&cid("ada")).unwrap().afflictions.set_active(Status::Ko, true);
        let err = w.attack(&cid("ada"), &cid("ben"), &cat, &mut cues).unwrap_err();
        assert_eq!(err.0, "Cannot act while KO'd.");
        // blocked before any damage.
        assert_eq!(w.characters[&cid("ben")].stats.health, 5.0);
    }

    #[test]
    fn attack_command_dispatches() {
        use crate::world::command::{apply_command, Command};
        let (mut w, cat) = duel_world();
        let mut opened = BTreeSet::new();
        let mut cues = Vec::new();
        // active character is index 0 = "ada".
        apply_command(&mut w, Command::Attack { target_id: "ben".into() }, &cat, &mut opened, &mut cues).unwrap();
        assert_eq!(w.characters[&cid("ben")].stats.health, 4.0); // unarmed natural 1
    }

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
    fn deposit_materials_merges_additively_and_records_codex() {
        use serde_json::json;
        let mut w = world_with_party(&["pc"], 10);
        w.campaign.materials = json!({ "metal": 1 });
        w.deposit_materials(&json!({ "metal": 2, "bone": 1 }), Some("pc"), Some("hall"));
        // additive merge
        assert_eq!(w.campaign.materials, json!({ "metal": 3, "bone": 1 }));
        // one codex record per component, deduped by material::<component>
        let codex = w.codex.as_array().unwrap();
        let mats: Vec<_> = codex.iter().filter(|e| e["kind"] == json!("material")).collect();
        assert_eq!(mats.len(), 2);
        let metal = mats.iter().find(|e| e["key"] == json!("metal")).unwrap();
        assert_eq!(metal["snapshot"], json!({ "type": "metal" }));
        assert_eq!(metal["firstSeen"]["characterId"], json!("pc"));
        assert_eq!(metal["firstSeen"]["roomId"], json!("hall"));
        // re-deposit does not duplicate codex records (first-write-wins)
        w.deposit_materials(&json!({ "metal": 5 }), Some("pc"), Some("hall"));
        assert_eq!(w.campaign.materials["metal"], json!(8)); // pool still merges
        let mats2: Vec<_> = w.codex.as_array().unwrap().iter().filter(|e| e["kind"] == json!("material")).collect();
        assert_eq!(mats2.len(), 2); // no new material::metal record
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

    use crate::world::ids::{LootId, RoomId};
    use crate::world::snapshot::{RoomSnapshot, SceneSnapshot};

    fn test_room(id: &str) -> RoomSnapshot {
        RoomSnapshot {
            id: RoomId(id.into()),
            name: id.into(),
            description: String::new(),
            exits: BTreeMap::new(),
            dark: false,
            spawn_modifier: 0,
            occupant_ids: alloc::vec![],
            loot_ids: alloc::vec![],
            material_cache_ids: alloc::vec![],
            light_source_ids: alloc::vec![],
            scenes: alloc::vec![],
        }
    }

    #[test]
    fn mob_knockout_drops_materials_and_remains_box() {
        use serde_json::json;
        let mut w = world_with_party(&["hero", "goblin"], 10);
        // Make goblin a room-origin mob in "hall" with a material drop, one item, one key.
        let gid = CharacterId("goblin".into());
        {
            let c = w.characters.get_mut(&gid).unwrap();
            c.kind = CharacterKind::Mob;
            c.origin = Some(json!("room"));
            c.material_drops = Some(json!({ "bone": 2 }));
            c.current_room_id = Some(RoomId("hall".into()));
            c.inventory.item_ids = alloc::vec![ItemId("mob:goblin:drop#0".into())];
            c.inventory.key_ids = alloc::vec![ItemId("mob:goblin:key#0".into())];
        }
        w.items.insert(ItemId("mob:goblin:drop#0".into()), ItemSnapshot::Item {
            id: ItemId("mob:goblin:drop#0".into()), behavior_key: "items/coin".into(),
            durability: None, modifier: 0,
        });
        w.rooms.entry(RoomId("hall".into())).or_insert_with(|| test_room("hall"));
        let mut cues = Vec::new();
        // Directly fire the hook as reconcile would on the KO edge, with "hero" as the active attacker.
        w.campaign.active_character_index = 0; // hero
        w.on_knock_out(&gid, &Catalog::default(), &mut cues);

        // materials deposited + codex material record
        assert_eq!(w.campaign.materials["bone"], json!(2));
        // remains box: id = goblin:remains, capacity = items(1)+2 = 3, contents = [item, key]
        let box_id = LootId("goblin:remains".into());
        let b = w.loot.get(&box_id).expect("remains box created");
        assert_eq!(b.description, "goblin's remains");
        assert_eq!(b.capacity, 3);
        assert_eq!(b.content_ids, alloc::vec![
            ItemId("mob:goblin:drop#0".into()),
            ItemId("mob:goblin:key#0".into()),
        ]);
        // placed in the room; mob inventory emptied
        assert!(w.rooms[&RoomId("hall".into())].loot_ids.contains(&box_id));
        assert!(w.characters[&gid].inventory.item_ids.is_empty());
        assert!(w.characters[&gid].inventory.key_ids.is_empty());
    }

    #[test]
    fn player_knockout_drops_nothing() {
        let mut w = world_with_party(&["hero"], 10);
        let mut cues = Vec::new();
        w.on_knock_out(&CharacterId("hero".into()), &Catalog::default(), &mut cues);
        assert!(w.loot.is_empty());
    }

    #[test]
    fn mob_reknockout_does_not_refire() {
        // Firing on_knock_out twice on the same mob drops exactly one box (edge-trigger is in
        // reconcile; but on_knock_out itself must be idempotent w.r.t. the codex dedup).
        use serde_json::json;
        let mut w = world_with_party(&["hero", "goblin"], 10);
        let gid = CharacterId("goblin".into());
        {
            let c = w.characters.get_mut(&gid).unwrap();
            c.kind = CharacterKind::Mob;
            c.origin = Some(json!("room"));
            c.material_drops = Some(json!({ "bone": 2 }));
            c.current_room_id = Some(RoomId("hall".into()));
            // no items/keys — a materials-only mob keeps the second-fire check simple
        }
        w.rooms.entry(RoomId("hall".into())).or_insert_with(|| test_room("hall"));
        let mut cues = Vec::new();
        w.on_knock_out(&gid, &Catalog::default(), &mut cues);
        w.on_knock_out(&gid, &Catalog::default(), &mut cues);
        // bone deposited twice (deposit is not edge-guarded inside on_knock_out — reconcile is),
        // but the material CODEX record is deduped to one.
        let mats = w.codex.as_array().unwrap().iter()
            .filter(|e| e["kind"] == json!("material")).count();
        assert_eq!(mats, 1);
    }
}
