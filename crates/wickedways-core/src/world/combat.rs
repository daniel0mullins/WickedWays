//! Combat damage — byte-exact port of `attack` and
//! `takeDamage`, `#reconcile`,
//! `#floorAndSnapshot`, and `onKnockOut`.
//!
//! `take_damage` is internal-only (never a Command — TS only calls it from `attack`).
//! Two rng draws live in the combat path: the 4a Confused fizzle in `gate`, and **every** attacker's
//! d20 to-hit roll (`draw_die(20)` — a table-supplied die if one is queued, else the seeded rng): 20
//! crits (x1.5), 1 is a critical miss that makes the attacker stumble and self-damage, 2-5 miss, 6-19
//! hit. Players roll their own attacks; mobs default to the house roll.
use alloc::collections::BTreeSet;
use alloc::format;
use alloc::vec::Vec;
use serde_json::{json, Value};

use crate::damage::{compute_mitigated_damage, DamageInput};
use crate::error::ProceduralViolation;
use crate::presentation::{ActionKind, MechanicCue, PresentationCue};
use crate::stats::StatType;
use crate::world::descriptor::{Catalog, ItemType};
use crate::world::gate::GateVerdict;
use crate::world::history::{ActionHistoryEntry, TargetRef};
use crate::world::ids::{CharacterId, ItemId, LootId};
use crate::world::resolve::{resolve_item, ResolvedItem};
use crate::world::snapshot::{CharacterKind, ItemSnapshot, LootSnapshot};
use crate::world::World;

impl World {
    // ---- durability, reconcile & KO ----

    /// Durability write seam (mirrors `SET_DURABILITY`). The ONLY place
    /// `ItemSnapshot::Item.durability` is mutated. No clamp — callers pass
    /// `durability - 1`, and only non-broken items (durability >= 1) ever wear.
    pub fn set_durability(&mut self, item: &ItemId, value: i64) {
        if let Some(ItemSnapshot::Item { durability, .. }) = self.items.get_mut(item) {
            *durability = Some(value);
        }
    }

    /// Floor base stats, recompute afflictions from effective stats, and fire
    /// `on_knock_out` exactly once on a false→true KO transition. Byte-exact port
    /// of `#reconcile` + `#floorAndSnapshot`.
    pub fn reconcile(
        &mut self,
        actor: &CharacterId,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) {
        let was_ko = self.characters.get(actor).is_some_and(|c| {
            c.afflictions
                .is_active(crate::world::afflictions::Status::Ko)
        });

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
            c.afflictions
                .apply_from_stats(health, sanity, energy, &passive);
        }

        let is_ko = self.characters.get(actor).is_some_and(|c| {
            c.afflictions
                .is_active(crate::world::afflictions::Status::Ko)
        });
        if !was_ko && is_ko {
            self.on_knock_out(actor, cat, cues);
        }
    }

    /// Hook fired once when KO newly latches during `reconcile`. Players: no-op. Mobs:
    /// deposit materials + drop inventory into a `${mob.id}:remains` loot box. Byte-exact
    /// port of `Mob.onKnockOut`.
    fn on_knock_out(
        &mut self,
        actor: &CharacterId,
        _cat: &Catalog,
        _cues: &mut Vec<PresentationCue>,
    ) {
        let is_mob = self
            .characters
            .get(actor)
            .is_some_and(|c| matches!(c.kind, CharacterKind::Mob));
        if !is_mob {
            return;
        }

        // Snapshot drop-relevant fields. The `{ … }` block is an expression whose
        // value is this six-field tuple: cloning everything out at once ends the
        // borrow of `self.characters` before the mutations below need `&mut self`.
        let (material_drops, room_id, is_room_origin, item_ids, key_ids, mob_name) = {
            let Some(c) = self.characters.get(actor) else {
                return;
            };
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
            if md.as_object().is_some_and(|o| !o.is_empty()) {
                let by = self.active_character_id().ok().map(|c| c.0);
                let room_str = room_id.as_ref().map(|r| r.0.clone());
                self.deposit_materials(md, by.as_deref(), room_str.as_deref());
            }
        }

        // 2. Item/key drop.
        let Some(room) = room_id else { return };
        let keys = if is_room_origin {
            key_ids
        } else {
            alloc::vec::Vec::new()
        };
        if item_ids.is_empty() && keys.is_empty() {
            return;
        }

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
        self.loot.insert(
            box_id.clone(),
            LootSnapshot {
                id: box_id.clone(),
                description: alloc::format!("{}'s remains", mob_name),
                capacity,
                content_ids,
            },
        );
        if let Some(r) = self.rooms.get_mut(&room) {
            r.loot_ids.push(box_id);
        }
    }

    // ---- the attack action ----

    /// Resolve a character's equipped items (de-duplicating two-handed items that
    /// occupy two slots), mirroring `effective_stat`'s equipped-set derivation.
    fn equipped_resolved(&self, actor: &CharacterId, cat: &Catalog) -> Vec<ResolvedItem> {
        let Some(ch) = self.characters.get(actor) else {
            return Vec::new();
        };
        let equipped_ids: BTreeSet<&ItemId> = ch.equipment.values().collect();
        equipped_ids
            .into_iter()
            .filter_map(|id| self.items.get(id))
            .filter_map(|snap| resolve_item(snap, cat).ok())
            .collect()
    }

    /// Throw if the actor cannot see (unlit room and not `sees_in_dark`).
    /// Mirrors `requireVisibleTarget`: checks only the
    /// actor's own visibility, not the target's location.
    pub(crate) fn require_visible_target(
        &self,
        actor: &CharacterId,
        verb: &str,
        cat: &Catalog,
    ) -> Result<(), ProceduralViolation> {
        if let Some(ch) = self.characters.get(actor) {
            if let Some(room_id) = &ch.current_room_id {
                if !self.is_lit(room_id, cat) && !self.sees_in_dark(actor) {
                    return Err(ProceduralViolation(format!("Cannot {verb} in the dark")));
                }
            }
        }
        Ok(())
    }

    /// The actor's unarmed strike (stat + power). Default `{ Health, 1 }`, parsed
    /// from the `natural_attack` snapshot field.
    fn natural_attack(&self, actor: &CharacterId) -> (StatType, f64) {
        #[derive(serde::Deserialize)]
        struct NaturalAttackJson {
            stat: StatType,
            power: f64,
        }
        let default = (StatType::Health, 1.0);
        let Some(ch) = self.characters.get(actor) else {
            return default;
        };
        let Some(v) = &ch.natural_attack else {
            return default;
        };
        match serde_json::from_value::<NaturalAttackJson>(v.clone()) {
            Ok(na) => (na.stat, na.power),
            Err(_) => default,
        }
    }

    /// Attack `target`. Gated (affliction) then dark-checked; each equipped
    /// non-broken weapon adds its modifier to its stat (else a natural strike);
    /// damage lands per stat in [Health, Energy, Sanity] order; weapons wear one
    /// point; a budgeted `attack` is recorded. Behavior is pinned byte-exact by
    /// the conformance goldens.
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
                self.record_fumble(actor, "attack", true, cat, cues)?;
                return Ok(());
            }
            GateVerdict::Allow => {}
        }
        // 2. Dark check (after the gate, matching TS order).
        self.require_visible_target(actor, "attack", cat)?;

        // 2b. To-hit roll. Every attacker — player or mob — rolls a d20 through the dice-supply seam (a
        // table-supplied die if one is queued, else the seeded rng): 20 crits (x1.5 damage); 1 is a
        // critical miss where the attacker stumbles and takes 1 self-damage; 2-5 miss; 6-19 hit. Players
        // roll their own attacks; mobs default to the house roll. The outcome is a mechanic cue.
        let attacker_name = self
            .characters
            .get(actor)
            .map(|c| c.name.clone())
            .unwrap_or_default();
        let mut crit_mult = 1.0_f64;
        let mut landed = true;
        let d20 = self.draw_die(20);
        // `match` is an expression — the selected arm's value becomes `outcome`.
        // `2..=5` is an inclusive range pattern; `_` is the required catch-all.
        let outcome = match d20 {
            20 => {
                crit_mult = 1.5;
                "critical hit!"
            }
            1 => "critical miss - stumbles",
            2..=5 => "miss",
            _ => "hit",
        };
        cues.push(PresentationCue::Mechanic {
            cue: MechanicCue {
                text: Some(format!("{attacker_name} rolls d20 -> {d20}: {outcome}")),
                sound: None,
            },
        });
        if d20 == 1 {
            // Stumble: a flat 1-point self-hit (no mitigation) that may KO the attacker; the target
            // takes nothing.
            if let Some(c) = self.characters.get_mut(actor) {
                c.stats.health -= 1.0;
            }
            self.reconcile(actor, cat, cues);
            landed = false;
        } else if (2..=5).contains(&d20) {
            landed = false;
        }

        if landed {
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
                for e in &mut matrix {
                    if e.0 == nstat {
                        e.1 += npow;
                    }
                }
            } else {
                for w in &weapons {
                    for e in &mut matrix {
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

            // 5. Inflict damage per stat with strength > 0, in matrix order (a crit scales it x1.5;
            // the non-crit path multiplies by exactly 1.0, so player damage is bit-identical).
            for (stat, strength) in matrix {
                if strength > 0.0 {
                    self.take_damage_from(
                        target,
                        Some(actor),
                        strength * crit_mult,
                        stat,
                        cat,
                        cues,
                    )?;
                }
            }

            // 6. Each weapon that swung wears one point (after damage).
            for (id, val) in worn {
                self.set_durability(&id, val);
            }
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
                target: TargetRef {
                    id: target.clone(),
                    name: target_name,
                },
            });
        }
        cues.push(PresentationCue::Action {
            action: ActionKind::Attack,
            actor: self.entity_ref_char(actor),
            sound: None,
        });
        self.record_action(
            actor,
            true,
            &crate::world::mechanics::ActionView::of("attack"),
            cat,
            cues,
        )?;
        Ok(())
    }

    // ---- codex & materials ----

    /// Append a codex entry, first-write-wins per `(kind, key)`.
    /// `firstSeen.characterId`/`roomId` are omitted when `by`/`room` are `None`.
    pub(crate) fn record_codex(
        &mut self,
        kind: &str,
        key: &str,
        snapshot: &Value,
        by: Option<&str>,
        room: Option<&str>,
    ) {
        let exists = self.codex.as_array().is_some_and(|a| {
            a.iter().any(|e| {
                e.get("kind").and_then(|v| v.as_str()) == Some(kind)
                    && e.get("key").and_then(|v| v.as_str()) == Some(key)
            })
        });
        if exists {
            return;
        }
        let round = self.campaign.round;
        let mut first_seen = serde_json::Map::new();
        first_seen.insert("round".into(), json!(round));
        if let Some(b) = by {
            first_seen.insert("characterId".into(), json!(b));
        }
        if let Some(r) = room {
            first_seen.insert("roomId".into(), json!(r));
        }
        let entry = json!({ "kind": kind, "key": key, "snapshot": snapshot, "firstSeen": Value::Object(first_seen) });
        if let Some(arr) = self.codex.as_array_mut() {
            arr.push(entry);
        }
    }

    /// Merge a `MaterialMap` additively into `campaign.materials`, then record one
    /// `{kind:"material"}` codex entry per component. Port of `DEPOSIT_MATERIALS`
    /// + the material `RECORD_ENCOUNTER` in `Mob.onKnockOut`.
    pub fn deposit_materials(&mut self, materials: &Value, by: Option<&str>, room: Option<&str>) {
        let Some(obj) = materials.as_object() else {
            return;
        };
        // Ensure the pool is an object.
        if !self.campaign.materials.is_object() {
            self.campaign.materials = json!({});
        }
        // 1. Additive merge.
        if let Some(pool) = self.campaign.materials.as_object_mut() {
            for (component, qty) in obj {
                // `#materials[c] = (#materials[c] ?? 0) + qty` adds the raw number,
                // fractional or not — read both sides as f64 (matching MaterialMap's
                // `number` values). `as_i64` would silently drop a fractional qty to 0.
                let add = qty.as_f64().unwrap_or(0.0);
                let cur = pool
                    .get(component)
                    .and_then(serde_json::Value::as_f64)
                    .unwrap_or(0.0);
                pool.insert(component.clone(), json!(cur + add));
            }
        }
        // 2. One codex record per component (deduped material::<component>).
        let components: Vec<alloc::string::String> = obj.keys().cloned().collect();
        for component in components {
            self.record_codex(
                "material",
                &component,
                &json!({ "type": component }),
                by,
                room,
            );
        }
    }

    // ---- incoming damage ----

    /// Apply an incoming hit to `target`'s `attack_stat` after armor + mitigation,
    /// wear contributing armor, reconcile, and record a NON-budgeted `takeDamage`.
    /// Behavior is pinned byte-exact by the conformance goldens. Internal only.
    /// The attack path routes through [`take_damage_from`] so `modify_damage`
    /// transforms observe the attacker; this source-less form covers everything
    /// else (and pre-existing behavior is unchanged — `DamageView.source`/`room`
    /// are transform-only reads, never serialized).
    pub fn take_damage(
        &mut self,
        target: &CharacterId,
        attack_strength: f64,
        attack_stat: StatType,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
        self.take_damage_from(target, None, attack_strength, attack_stat, cat, cues)
    }

    /// [`take_damage`] with the attacking character wired into the transform
    /// view (`DamageView.source`), alongside the target's room (`DamageView.room`).
    pub fn take_damage_from(
        &mut self,
        target: &CharacterId,
        source: Option<&CharacterId>,
        attack_strength: f64,
        attack_stat: StatType,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
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
            .is_some_and(|rid| self.is_lit(&rid, cat));

        let final_strength = compute_mitigated_damage(DamageInput {
            attack_strength,
            armor_sum: armor_sum as f64,
            mitigator,
            light_averse,
            room_lit,
        });
        let dealt = self.run_damage_transformers(
            &crate::world::mechanics::DamageView {
                amount: final_strength,
                target: target.clone(),
                stat: attack_stat,
                source: source.cloned(),
                room: self
                    .characters
                    .get(target)
                    .and_then(|c| c.current_room_id.as_ref())
                    .map(|r| r.0.clone()),
            },
            cues,
            cat,
        );

        // Subtract from the base stat (no clamp here — reconcile floors it).
        if let Some(c) = self.characters.get_mut(target) {
            *c.stats.get_mut(attack_stat) -= dealt;
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

        // `take_damage` tail-routes through `record_action`, whose cap check runs
        // even for this non-budgeted action: an at-cap target's turn auto-ends
        // here. `budgeted=false` → no increment / no on_action, cap-check only
        // (the same free-action path as a free fumble).
        self.record_action(
            target,
            false,
            &crate::world::mechanics::ActionView::of("takeDamage"),
            cat,
            cues,
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::afflictions::Status;
    use crate::world::descriptor::Catalog;
    use crate::world::ids::{CharacterId, ItemId};
    use crate::world::snapshot::ItemSnapshot;
    use crate::world::test_support::cid;
    use crate::world::test_support::world_with_party;
    use crate::world::test_support::{item_desc, props};

    #[test]
    fn set_durability_writes_the_item() {
        let mut w = world_with_party(&["pc"], 10);
        let id = ItemId("sword".into());
        w.items.insert(
            id.clone(),
            ItemSnapshot::Item {
                id: id.clone(),
                behavior_key: "items/sword".into(),
                durability: Some(3),
                modifier: 2,
            },
        );
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
        if let Some(c) = w.characters.get_mut(&cid("pc")) {
            c.stats.health = -2.5;
        }
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
    fn damage_transform_is_identity_without_mechanics() {
        let mut w = world_with_party(&["pc"], 10);
        let mut cues = Vec::new();
        let dv = crate::world::mechanics::DamageView {
            amount: 7.5,
            target: cid("pc"),
            stat: StatType::Health,
            source: None,
            room: None,
        };
        assert_eq!(
            w.run_damage_transformers(&dv, &mut cues, &Catalog::default()),
            7.5
        );
        assert!(cues.is_empty());
    }

    use crate::world::descriptor::{ItemDescriptor, ItemProperties, ItemType, SlotKind};
    use alloc::collections::{BTreeMap, BTreeSet};
    use serde_json::json;

    fn weapon_desc(stat: StatType, modifier: i64, max_dur: Option<i64>) -> ItemDescriptor {
        ItemDescriptor {
            properties: props(true, true, false),
            slot: Some(SlotKind::Hand),
            max_durability: max_dur,
            ..item_desc("Test Weapon", ItemType::Weapon, stat, modifier)
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
        items.insert(
            "items/axe".to_string(),
            weapon_desc(StatType::Health, 5, Some(3)),
        );
        let cat = Catalog {
            items,
            aliases: BTreeMap::new(),
            behaviors: BTreeMap::default(),
            formations: BTreeMap::default(),
            recipes: BTreeMap::default(),
            cards: BTreeMap::default(),
        };
        w.items.insert(
            wpn.clone(),
            ItemSnapshot::Item {
                id: wpn.clone(),
                behavior_key: "items/axe".into(),
                durability: Some(3),
                modifier: 5,
            },
        );
        w.characters
            .get_mut(&cid("ada"))
            .unwrap()
            .equipment
            .insert("hand".into(), wpn.clone());

        supply_d20(&mut w, 14); // a plain hit so the pinned damage lands unscaled
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
        assert!(matches!(
            w.characters[&cid("ada")].history.last().unwrap(),
            ActionHistoryEntry::Attack { .. }
        ));
        match cues.last().unwrap() {
            PresentationCue::Action {
                action: ActionKind::Attack,
                actor,
                sound: None,
            } => assert_eq!(actor.id, "ada"),
            other => panic!("expected attack cue, got {:?}", other),
        }
    }

    #[test]
    fn attack_unarmed_uses_natural_attack_default_1_health() {
        // No weapon → natural attack (Health, 1). ben health 5 → dealt=1*1.0=1 → 4.0.
        let (mut w, cat) = duel_world();
        let mut cues = Vec::new();
        supply_d20(&mut w, 14); // a plain hit
        w.attack(&cid("ada"), &cid("ben"), &cat, &mut cues).unwrap();
        assert_eq!(w.characters[&cid("ben")].stats.health, 4.0);
    }

    #[test]
    fn attack_ko_actor_is_blocked() {
        let (mut w, cat) = duel_world();
        let mut cues = Vec::new();
        w.characters
            .get_mut(&cid("ada"))
            .unwrap()
            .afflictions
            .set_active(Status::Ko, true);
        let err = w
            .attack(&cid("ada"), &cid("ben"), &cat, &mut cues)
            .unwrap_err();
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
        supply_d20(&mut w, 14); // a plain hit
                                // active character is index 0 = "ada".
        apply_command(
            &mut w,
            Command::Attack {
                target_id: "ben".into(),
            },
            &cat,
            &mut opened,
            &mut cues,
        )
        .unwrap();
        assert_eq!(w.characters[&cid("ben")].stats.health, 4.0); // unarmed natural 1
    }

    fn armor_desc(stat: StatType, modifier: i64, max_dur: Option<i64>) -> ItemDescriptor {
        ItemDescriptor {
            name: "Test Armor".into(),
            r#type: ItemType::Armor,
            stat,
            modifier,
            properties: ItemProperties {
                equippable: true,
                equipped: false,
                destroyable: true,
                usable: false,
                droppable: None,
            },
            slot: Some(SlotKind::Torso),
            two_handed: None,
            emits_light: None,
            max_durability: max_dur,
            lore: None,
            presentation: None,
            key_code: None,
            consume_on_use: None,
            recipe: json!({}),
            teaches: json!(null),
            immunities: json!([]),
            grants_immunity: json!(null),
        }
    }

    #[test]
    fn take_damage_no_armor_subtracts_mitigated_amount() {
        // attack_strength=5, no armor, mitigator = effective(Sanity) for Health damage.
        // world_with_party: health/sanity/energy = 5. mitigator(Health)=Sanity=5.
        // dealt = max(0,5-0) * max(0,10-5)*0.2 * 1 = 5 * 1.0 = 5.0 → health 5-5 = 0 → KO.
        let mut w = world_with_party(&["pc"], 10);
        let mut cues = Vec::new();
        w.take_damage(
            &cid("pc"),
            5.0,
            StatType::Health,
            &Catalog::default(),
            &mut cues,
        )
        .unwrap();
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
            PresentationCue::Action {
                action: ActionKind::TakeDamage,
                actor,
                sound: None,
            } => {
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
        items.insert(
            "items/armor".to_string(),
            armor_desc(StatType::Health, 3, Some(2)),
        );
        let cat = Catalog {
            items,
            aliases: BTreeMap::new(),
            behaviors: BTreeMap::default(),
            formations: BTreeMap::default(),
            recipes: BTreeMap::default(),
            cards: BTreeMap::default(),
        };
        w.items.insert(
            armor_id.clone(),
            ItemSnapshot::Item {
                id: armor_id.clone(),
                behavior_key: "items/armor".into(),
                durability: Some(2),
                modifier: 3,
            },
        );
        w.characters
            .get_mut(&cid("pc"))
            .unwrap()
            .equipment
            .insert("torso".into(), armor_id.clone());

        w.take_damage(&cid("pc"), 5.0, StatType::Health, &cat, &mut cues)
            .unwrap();

        assert_eq!(w.characters[&cid("pc")].stats.health, 3.0);
        match &w.items[&armor_id] {
            ItemSnapshot::Item { durability, .. } => {
                assert_eq!(*durability, Some(1), "armor wore 1");
            }
            _ => panic!(),
        }
    }

    #[test]
    fn deposit_materials_accumulates_fractional_quantities() {
        use serde_json::json;
        let mut w = world_with_party(&["pc"], 10);
        // first deposit: a fractional qty
        w.deposit_materials(&json!({ "ectoplasm": 2.5 }), None, None);
        assert_eq!(w.campaign.materials["ectoplasm"], json!(2.5));
        // second deposit accumulates as a float
        w.deposit_materials(&json!({ "ectoplasm": 1.25 }), None, None);
        assert_eq!(w.campaign.materials["ectoplasm"], json!(3.75));
        // whole-number deposits still work (mixed pool)
        w.deposit_materials(&json!({ "bone": 2 }), None, None);
        assert_eq!(w.campaign.materials["bone"], json!(2.0));
    }

    #[test]
    fn deposit_materials_merges_additively_and_records_codex() {
        use serde_json::json;
        let mut w = world_with_party(&["pc"], 10);
        w.campaign.materials = json!({ "metal": 1.0 });
        w.deposit_materials(&json!({ "metal": 2, "bone": 1 }), Some("pc"), Some("hall"));
        // additive merge
        assert_eq!(w.campaign.materials, json!({ "metal": 3.0, "bone": 1.0 }));
        // one codex record per component, deduped by material::<component>
        let codex = w.codex.as_array().unwrap();
        let mats: Vec<_> = codex
            .iter()
            .filter(|e| e["kind"] == json!("material"))
            .collect();
        assert_eq!(mats.len(), 2);
        let metal = mats.iter().find(|e| e["key"] == json!("metal")).unwrap();
        assert_eq!(metal["snapshot"], json!({ "type": "metal" }));
        assert_eq!(metal["firstSeen"]["characterId"], json!("pc"));
        assert_eq!(metal["firstSeen"]["roomId"], json!("hall"));
        // re-deposit does not duplicate codex records (first-write-wins)
        w.deposit_materials(&json!({ "metal": 5 }), Some("pc"), Some("hall"));
        assert_eq!(w.campaign.materials["metal"], json!(8.0)); // pool still merges
        let mats2: Vec<_> = w
            .codex
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["kind"] == json!("material"))
            .collect();
        assert_eq!(mats2.len(), 2); // no new material::metal record
    }

    #[test]
    fn take_damage_broken_armor_does_not_mitigate_or_wear() {
        // Armor at durability 0 is broken → excluded from armorSum AND from wear.
        let mut w = world_with_party(&["pc"], 10);
        let mut cues = Vec::new();
        let armor_id = ItemId("armor".into());
        let mut items = BTreeMap::new();
        items.insert(
            "items/armor".to_string(),
            armor_desc(StatType::Health, 3, Some(2)),
        );
        let cat = Catalog {
            items,
            aliases: BTreeMap::new(),
            behaviors: BTreeMap::default(),
            formations: BTreeMap::default(),
            recipes: BTreeMap::default(),
            cards: BTreeMap::default(),
        };
        w.items.insert(
            armor_id.clone(),
            ItemSnapshot::Item {
                id: armor_id.clone(),
                behavior_key: "items/armor".into(),
                durability: Some(0),
                modifier: 3,
            },
        );
        w.characters
            .get_mut(&cid("pc"))
            .unwrap()
            .equipment
            .insert("torso".into(), armor_id.clone());

        w.take_damage(&cid("pc"), 5.0, StatType::Health, &cat, &mut cues)
            .unwrap();

        // No mitigation: dealt = 5 * (10-5)*0.2 = 5.0 → health 0.
        assert_eq!(w.characters[&cid("pc")].stats.health, 0.0);
        // Broken armor stays at 0 (no wear below 0).
        match &w.items[&armor_id] {
            ItemSnapshot::Item { durability, .. } => assert_eq!(*durability, Some(0)),
            _ => panic!(),
        }
    }

    #[test]
    fn take_damage_on_at_cap_target_fires_end_turn_reconcile() {
        use crate::world::descriptor::Catalog;
        let mut w = world_with_party(&["pc"], 10); // actions_per_round = 2
        let mut cues = Vec::new();
        // Put the target AT its action cap and drive base sanity negative WITHOUT
        // reconciling — the cap-triggered end_turn's reconcile must floor it + latch.
        if let Some(c) = w.characters.get_mut(&cid("pc")) {
            c.actions_this_round = c.actions_per_round; // at cap
            c.stats.sanity = -4.0;
        }
        // A Health hit that does not itself KO; the observable effect is the
        // cap-triggered end_turn reconcile flooring the negative sanity.
        w.take_damage(
            &cid("pc"),
            1.0,
            StatType::Health,
            &Catalog::default(),
            &mut cues,
        )
        .unwrap();
        let ch = w.characters.get(&cid("pc")).unwrap();
        assert_eq!(
            ch.stats.sanity, 0.0,
            "cap-triggered end_turn reconcile floored base sanity"
        );
    }

    #[test]
    fn take_damage_below_cap_does_not_fire_end_turn() {
        use crate::world::descriptor::Catalog;
        let mut w = world_with_party(&["pc"], 10);
        let mut cues = Vec::new();
        if let Some(c) = w.characters.get_mut(&cid("pc")) {
            c.actions_this_round = 0; // below cap (< 2)
            c.stats.sanity = -4.0; // stays negative if end_turn does NOT run
        }
        w.take_damage(
            &cid("pc"),
            1.0,
            StatType::Health,
            &Catalog::default(),
            &mut cues,
        )
        .unwrap();
        // take_damage's OWN reconcile floors base stats too — so sanity WILL be 0 here.
        // To isolate the cap-check, assert budget did not advance and no extra reconcile
        // side-effect beyond take_damage's own. The meaningful assertion is that no
        // end_turn-only effect occurred; with no mechanics, end_turn == reconcile == idempotent.
        let ch = w.characters.get(&cid("pc")).unwrap();
        assert_eq!(
            ch.actions_this_round, 0,
            "below-cap take_damage does not tick budget"
        );
    }

    /// Stronger observable proof (brief §Step 1 note): seed `conformance:dread`
    /// (its `on_turn_end` op emits the "The dread recedes." Mechanic cue — see
    /// `turn.rs`'s `end_turn_fires_on_turn_end_after_reconcile`) and assert the
    /// cue surfaces from `take_damage` alone when the target is at cap, proving
    /// the tail cap-check actually drives `end_turn` (not just `reconcile`).
    #[test]
    fn take_damage_on_at_cap_target_fires_dread_on_turn_end_mechanic() {
        use crate::world::descriptor::Catalog;
        use crate::world::snapshot::MechanicSnapshot;
        let mut w = world_with_party(&["pc"], 10);
        w.campaign.mechanics.push(MechanicSnapshot {
            key: "conformance:dread".into(),
            state: json!({ "ticks": 0 }),
        });
        let mut cues = Vec::new();
        if let Some(c) = w.characters.get_mut(&cid("pc")) {
            c.actions_this_round = c.actions_per_round; // at cap
        }
        w.take_damage(
            &cid("pc"),
            1.0,
            StatType::Health,
            &Catalog::default(),
            &mut cues,
        )
        .unwrap();
        let texts: Vec<Option<alloc::string::String>> = cues
            .iter()
            .filter_map(|c| match c {
                PresentationCue::Mechanic { cue } => Some(cue.text.clone()),
                _ => None,
            })
            .collect();
        assert!(
            texts.iter().any(|t| t.as_deref() == Some("The dread recedes.")),
            "expected the at-cap takeDamage to auto-end the turn and fire on_turn_end, got {texts:?}"
        );
    }

    use crate::world::ids::{LootId, RoomId};
    use crate::world::snapshot::RoomSnapshot;

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
        w.items.insert(
            ItemId("mob:goblin:drop#0".into()),
            ItemSnapshot::Item {
                id: ItemId("mob:goblin:drop#0".into()),
                behavior_key: "items/coin".into(),
                durability: None,
                modifier: 0,
            },
        );
        w.rooms
            .entry(RoomId("hall".into()))
            .or_insert_with(|| test_room("hall"));
        let mut cues = Vec::new();
        // Directly fire the hook as reconcile would on the KO edge, with "hero" as the active attacker.
        w.campaign.active_character_index = 0; // hero
        w.on_knock_out(&gid, &Catalog::default(), &mut cues);

        // materials deposited + codex material record
        assert_eq!(w.campaign.materials["bone"], json!(2.0));
        // remains box: id = goblin:remains, capacity = items(1)+2 = 3, contents = [item, key]
        let box_id = LootId("goblin:remains".into());
        let b = w.loot.get(&box_id).expect("remains box created");
        assert_eq!(b.description, "goblin's remains");
        assert_eq!(b.capacity, 3);
        assert_eq!(
            b.content_ids,
            alloc::vec![
                ItemId("mob:goblin:drop#0".into()),
                ItemId("mob:goblin:key#0".into()),
            ]
        );
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
        w.rooms
            .entry(RoomId("hall".into()))
            .or_insert_with(|| test_room("hall"));
        let mut cues = Vec::new();
        w.on_knock_out(&gid, &Catalog::default(), &mut cues);
        w.on_knock_out(&gid, &Catalog::default(), &mut cues);
        // bone deposited twice (deposit is not edge-guarded inside on_knock_out — reconcile is),
        // but the material CODEX record is deduped to one.
        let mats = w
            .codex
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["kind"] == json!("material"))
            .count();
        assert_eq!(mats, 1);
    }

    // ── mob to-hit roll ──

    fn mob_vs_pc() -> (World, Catalog) {
        let mut w = world_with_party(&["horror", "victim"], 10);
        w.characters.get_mut(&cid("horror")).unwrap().kind = CharacterKind::Mob;
        (w, Catalog::default())
    }

    fn supply_d20(w: &mut World, value: u32) {
        w.supplied_dice
            .push_back(crate::dice::SuppliedDie { sides: 20, value });
    }

    fn first_roll_cue(cues: &[PresentationCue]) -> Option<String> {
        cues.iter().find_map(|c| match c {
            PresentationCue::Mechanic { cue } => cue.text.clone(),
            _ => None,
        })
    }

    #[test]
    fn mob_hit_deals_normal_damage() {
        // Natural attack {Health,1}; mitigator sanity 5 → mult 1.0 → 1.0 dealt → 5.0-1.0 = 4.0.
        let (mut w, cat) = mob_vs_pc();
        let mut cues = Vec::new();
        supply_d20(&mut w, 14);
        w.attack(&cid("horror"), &cid("victim"), &cat, &mut cues)
            .unwrap();
        assert_eq!(w.characters[&cid("victim")].stats.health, 4.0);
        assert!(first_roll_cue(&cues).unwrap().contains("14: hit"));
    }

    #[test]
    fn mob_crit_scales_damage_by_one_and_a_half() {
        // A nat 20 scales the 1.0 strike to 1.5 → 5.0-1.5 = 3.5.
        let (mut w, cat) = mob_vs_pc();
        let mut cues = Vec::new();
        supply_d20(&mut w, 20);
        w.attack(&cid("horror"), &cid("victim"), &cat, &mut cues)
            .unwrap();
        assert_eq!(w.characters[&cid("victim")].stats.health, 3.5);
        assert!(first_roll_cue(&cues).unwrap().contains("critical hit"));
    }

    #[test]
    fn mob_miss_deals_no_damage() {
        let (mut w, cat) = mob_vs_pc();
        let mut cues = Vec::new();
        supply_d20(&mut w, 3);
        w.attack(&cid("horror"), &cid("victim"), &cat, &mut cues)
            .unwrap();
        assert_eq!(w.characters[&cid("victim")].stats.health, 5.0);
        assert!(first_roll_cue(&cues).unwrap().contains("3: miss"));
    }

    #[test]
    fn mob_critical_miss_stumbles_and_self_damages() {
        let (mut w, cat) = mob_vs_pc();
        let mut cues = Vec::new();
        supply_d20(&mut w, 1);
        w.attack(&cid("horror"), &cid("victim"), &cat, &mut cues)
            .unwrap();
        assert_eq!(
            w.characters[&cid("victim")].stats.health,
            5.0,
            "target untouched on a stumble"
        );
        assert_eq!(
            w.characters[&cid("horror")].stats.health,
            4.0,
            "the mob took 1 self-damage"
        );
        assert!(first_roll_cue(&cues).unwrap().contains("stumbles"));
    }

    #[test]
    fn player_attack_also_rolls_to_hit() {
        // Players roll their own attacks: a supplied miss (3) makes the player's strike whiff — no
        // damage — and emits the roll cue.
        let (mut w, cat) = duel_world();
        let mut cues = Vec::new();
        supply_d20(&mut w, 3);
        w.attack(&cid("ada"), &cid("ben"), &cat, &mut cues).unwrap();
        assert_eq!(
            w.characters[&cid("ben")].stats.health,
            5.0,
            "a missed player attack deals nothing"
        );
        assert!(first_roll_cue(&cues).unwrap().contains("3: miss"));
        assert!(w.supplied_dice.is_empty(), "player consumed the die");
    }

    #[test]
    fn draw_die_prefers_supplied_then_falls_back_to_rng() {
        let mut w = world_with_party(&["pc"], 10);
        w.supplied_dice.push_back(crate::dice::SuppliedDie {
            sides: 20,
            value: 17,
        });
        assert_eq!(w.draw_die(20), 17, "a supplied die is the literal outcome");
        // Empty queue → seeded rng, in range.
        assert!((1..=20).contains(&w.draw_die(20)));
        // A wrong-sized supplied die is skipped (stays queued for its own size).
        w.supplied_dice
            .push_back(crate::dice::SuppliedDie { sides: 6, value: 4 });
        assert!((1..=20).contains(&w.draw_die(20)));
        assert_eq!(w.supplied_dice.len(), 1, "the d6 waited for a d6 draw");
        assert_eq!(w.draw_die(6), 4);
    }

    #[test]
    fn supply_dice_rejects_out_of_range() {
        let mut w = world_with_party(&["pc"], 10);
        assert!(w
            .supply_dice(&[crate::dice::SuppliedDie {
                sides: 20,
                value: 0
            }])
            .is_err());
        assert!(w
            .supply_dice(&[crate::dice::SuppliedDie { sides: 6, value: 7 }])
            .is_err());
        assert!(w
            .supply_dice(&[crate::dice::SuppliedDie {
                sides: 20,
                value: 20
            }])
            .is_ok());
        assert_eq!(w.supplied_dice.len(), 1);
    }
}
