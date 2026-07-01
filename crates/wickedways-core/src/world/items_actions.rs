//! Equipment item actions: `equip` and `unequip` on `World`.
//! Also: `take` (loot container → inventory), mirrors `player-character.ts:216-235`
//! (takeFromLootBox) and `character.ts:547-573` (addToInventory).
//!
//! `equip` and `unequip` are **free** — no budget tick, no history entry.
//! `take` is **budgeted** — ticks `actions_this_round` and records a `pickUp` history entry.
//!
//! Visibility-flip note: we compute `is_lit` before/after and emit a
//! `{ kind: "visibility", room, lit }` cue if it changes. In sub-plan 3b
//! `is_lit = !dark || !light_source_ids.is_empty()` (sub-plan 3a definition)
//! does NOT yet depend on occupant-carried or equipped light, so equipping a
//! light-emitting item will NOT flip `is_lit` here.
//! TODO(sub-plan 4): widen `is_lit` to include equipped/carried light sources,
//! at which point the before/after check here will begin emitting cues when a
//! light item is equipped/unequipped.

use alloc::format;
use alloc::string::ToString;
use alloc::vec;
use alloc::vec::Vec;

use serde::Deserialize;

use crate::error::ProceduralViolation;
use crate::presentation::{ActionKind, EntityRef, PresentationCue};
use crate::world::afflictions::Status;
use crate::world::descriptor::{Catalog, ItemType};
use crate::world::equipment::{slot_kind_of, DEFAULT_EQUIPMENT_SLOTS, LEFT_HAND, RIGHT_HAND};
use crate::world::history::{ActionHistoryEntry, ItemRef};
use crate::world::ids::{CharacterId, ItemId, LootId};
use crate::world::resolve::resolve_item;
use crate::world::World;

/// Parsed shape of the `grants_immunity` descriptor field.
/// Mirrors TS `{ statuses: Status[], turns: number }` (inventory.ts:306).
#[derive(Deserialize)]
struct GrantsImmunity {
    statuses: Vec<Status>,
    turns: i64,
}

impl World {
    /// Take `target` from a loot container in the actor's current room into
    /// their inventory. **Budgeted** — ticks `actions_this_round` and records
    /// a `pickUp` history entry. Returns `Some(LootId)` of the container taken from
    /// (so `apply_command` can auto-add it to the `opened` set), or `None` when a
    /// Confused fizzle short-circuits the take (fumble recorded, no loot moved).
    ///
    /// Mirrors `player-character.ts:216-235` (takeFromLootBox) and
    /// `character.ts:547-573` (addToInventory / pickUp).
    ///
    /// # Errors
    /// - Actor has no `current_room_id` → `ProceduralViolation`.
    /// - No loot container in that room has `target` in its `content_ids` → `ProceduralViolation`.
    /// - Room is dark and actor cannot see in the dark → `ProceduralViolation`.
    /// - Non-key item but inventory is full → `ProceduralViolation`.
    pub fn take(
        &mut self,
        actor: &CharacterId,
        target: &ItemId,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<Option<LootId>, ProceduralViolation> {
        // 0. Affliction gate (is_move = false, NOT budgeted). Mirrors
        //    attemptAction(this.takeFromLootBox, false). `takeFromLootBox` is NOT
        //    registered in `isActionMap` (player-character.ts:93-96 only registers
        //    move/go; character.ts:501-503 addToInventory/removeFromInventory/
        //    useMechanicAction), so on a Confused fizzle recordAction finds
        //    `budgeted === false` and does NOT tick the budget (character.ts:530).
        //    The successful take ticks the budget separately below via the internal
        //    addToInventory/pickUp (which IS budgeted). Fizzle → fumble, no loot → Ok(None).
        match self.gate(actor, false) {
            crate::world::gate::GateVerdict::Block(r) => return Err(ProceduralViolation(r)),
            crate::world::gate::GateVerdict::Fizzle => {
                self.record_fumble(actor, "takeFromLootBox", false, cues);
                return Ok(None);
            }
            crate::world::gate::GateVerdict::Allow => {}
        }

        // 1. Resolve the actor's current room.
        let room_id = self
            .characters
            .get(actor)
            .and_then(|c| c.current_room_id.clone())
            .ok_or_else(|| ProceduralViolation("Cannot take: actor is not in any room.".into()))?;

        // 2. Find the loot container in this room whose content_ids contains target.
        let loot_id: LootId = {
            let room = self
                .rooms
                .get(&room_id)
                .ok_or_else(|| ProceduralViolation("Current room not found.".into()))?;
            room.loot_ids
                .iter()
                .find(|lid| {
                    self.loot
                        .get(*lid)
                        .map(|l| l.content_ids.contains(target))
                        .unwrap_or(false)
                })
                .cloned()
                .ok_or_else(|| {
                    ProceduralViolation("Item is not in any loot container in this room.".into())
                })?
        };

        // 3. Visibility gate: !is_lit && !sees_in_dark(actor) → Err.
        // Mob `lightAverse` override wired in sub-plan 4c; base always returns false.
        let sees_in_dark = self.sees_in_dark(actor);
        if !self.is_lit(&room_id) && !sees_in_dark {
            return Err(ProceduralViolation("Cannot loot in the dark".into()));
        }

        // 4. Resolve the item to determine if it is a key (keys bypass the slot check).
        let item_snap = self
            .items
            .get(target)
            .ok_or_else(|| ProceduralViolation("Item snapshot not found.".into()))?
            .clone();
        let resolved = resolve_item(&item_snap, cat)?;
        let is_key = resolved.r#type == ItemType::Key;

        // 5. Capacity check: non-key items require a free slot.
        if !is_key {
            let ch = self
                .characters
                .get(actor)
                .ok_or_else(|| ProceduralViolation("Actor not found.".into()))?;
            let slots = ch.inventory.slots;
            let used = ch.inventory.item_ids.len() as i64;
            if used >= slots {
                return Err(ProceduralViolation(
                    "Attempted to add to inventory, but character doesn't have enough slots!".into(),
                ));
            }
        }

        // 6. Move target: remove from loot content_ids, add to actor's inventory.
        if let Some(loot) = self.loot.get_mut(&loot_id) {
            loot.content_ids.retain(|id| id != target);
        }
        {
            let ch = self
                .characters
                .get_mut(actor)
                .ok_or_else(|| ProceduralViolation("Actor not found.".into()))?;
            if is_key {
                ch.inventory.key_ids.push(target.clone());
            } else {
                ch.inventory.item_ids.push(target.clone());
            }
        }

        // 6b. RECORD_ENCOUNTER({kind:"item", item}) — mirrors character.ts:567
        //     (addToInventory records every picked-up item into the codex) and the
        //     item/key entry construction in codex.ts buildEntry (:141-170).
        //     First-write-wins by `${kind}::${key}`. `type` and `slot` serialize
        //     lowercase (descriptor.rs enum rename); twoHanded/emitsLight/presentation
        //     are read from the catalog descriptor and included only when present,
        //     matching the TS `!== undefined` / truthy guards.
        {
            let round = self.campaign.round;
            let actor_id_str = actor.0.clone();
            let room_id_str = room_id.0.clone();
            let first_seen = serde_json::json!({
                "round": round,
                "characterId": actor_id_str,
                "roomId": room_id_str
            });
            // Pull the descriptor for twoHanded/emitsLight (not on ResolvedItem).
            let (two_handed, emits_light) = match &item_snap {
                crate::world::snapshot::ItemSnapshot::Item { behavior_key, .. } => cat
                    .items
                    .get(behavior_key)
                    .map(|d| (d.two_handed, d.emits_light))
                    .unwrap_or((None, None)),
                crate::world::snapshot::ItemSnapshot::Key { .. } => (None, None),
            };

            let (kind, key, mut snapshot) = if is_key {
                // codex.ts:143-154 — key entry.
                let key_code = resolved.key_code.clone().unwrap_or_default();
                let key = format!("{}:{}", key_code, resolved.name);
                let consume_on_use = match &item_snap {
                    crate::world::snapshot::ItemSnapshot::Key { consume_on_use, .. } => {
                        *consume_on_use
                    }
                    _ => false,
                };
                let snapshot = serde_json::json!({
                    "name": resolved.name.clone(),
                    "keyCode": key_code,
                    "consumeOnUse": consume_on_use,
                });
                ("key", key, snapshot)
            } else {
                // codex.ts:155-169 — item entry. `type` serializes lowercase.
                let type_str = serde_json::to_value(resolved.r#type)
                    .ok()
                    .and_then(|v| v.as_str().map(alloc::string::ToString::to_string))
                    .unwrap_or_default();
                let key = format!("{}:{}", type_str, resolved.name);
                let mut snapshot = serde_json::json!({
                    "name": resolved.name.clone(),
                    "type": type_str,
                });
                if let Some(slot) = resolved.slot {
                    if let Ok(v) = serde_json::to_value(slot) {
                        snapshot["slot"] = v;
                    }
                }
                if let Some(th) = two_handed {
                    snapshot["twoHanded"] = serde_json::Value::Bool(th);
                }
                if let Some(el) = emits_light {
                    snapshot["emitsLight"] = serde_json::Value::Bool(el);
                }
                ("item", key, snapshot)
            };
            // presentation (truthy guard in codex.ts) — applies to both item and key.
            if let Some(pres) = &resolved.presentation {
                if let Ok(v) = serde_json::to_value(pres) {
                    snapshot["presentation"] = v;
                }
            }

            let already_in_codex = if let Some(arr) = self.codex.as_array() {
                arr.iter().any(|e| {
                    e.get("kind").and_then(|v| v.as_str()) == Some(kind)
                        && e.get("key").and_then(|v| v.as_str()) == Some(key.as_str())
                })
            } else {
                false
            };
            if !already_in_codex {
                let entry = serde_json::json!({
                    "kind": kind,
                    "key": key,
                    "snapshot": snapshot,
                    "firstSeen": first_seen,
                });
                if let Some(arr) = self.codex.as_array_mut() {
                    arr.push(entry);
                }
            }
        }

        // 7. Tick budget and record pickUp history entry.
        let round = self.campaign.round;
        let actor_name = self
            .characters
            .get(actor)
            .map(|c| c.name.clone())
            .unwrap_or_default();
        {
            let ch = self
                .characters
                .get_mut(actor)
                .ok_or_else(|| ProceduralViolation("Actor not found.".into()))?;
            ch.actions_this_round += 1;
            ch.history.push(ActionHistoryEntry::PickUp {
                round,
                items: vec![ItemRef { id: target.clone(), name: resolved.name.clone() }],
            });
        }

        // 8. Emit action cue.
        cues.push(PresentationCue::Action {
            action: ActionKind::PickUp,
            actor: EntityRef { id: actor.0.clone(), name: actor_name },
            sound: None,
        });

        Ok(Some(loot_id))
    }

    /// Equip `item` on `actor`. Free — no budget tick, no history.
    ///
    /// Logic mirrors `character.ts:685-747` exactly:
    /// 1. Item must be in `inventory.item_ids` (else `ProceduralViolation`).
    /// 2. `resolved.properties.equippable` must be true (else throw).
    /// 3. `resolved.slot` must be `Some` (else throw).
    /// 4. If already equipped, unequip first (suppresses intermediate visibility cue).
    /// 5. Two-handed weapon: clear both hands, set both; emit one net visibility cue.
    /// 6. Else: pick first free eligible slot in canonical order, else displace
    ///    `eligible[0]`; auto-swap if occupied; emit one net visibility cue.
    pub fn equip(
        &mut self,
        actor: &CharacterId,
        item: &ItemId,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
        // 0. Affliction gate (is_move = false, NOT budgeted). Mirrors
        //    attemptAction(this.equip, false). Fizzle records a fumble but does
        //    NOT tick the budget (equip is a free action).
        match self.gate(actor, false) {
            crate::world::gate::GateVerdict::Block(r) => return Err(ProceduralViolation(r)),
            crate::world::gate::GateVerdict::Fizzle => {
                self.record_fumble(actor, "equip", false, cues);
                return Ok(());
            }
            crate::world::gate::GateVerdict::Allow => {}
        }

        // --- snapshot the actor's current room for visibility flip ---
        let actor_room = self.characters.get(actor).and_then(|c| c.current_room_id.clone());
        let was_lit = actor_room.as_ref().map(|r| self.is_lit(r)).unwrap_or(true);

        // 1. Item must be in actor's inventory.item_ids
        {
            let ch = self.characters.get(actor).ok_or_else(|| {
                ProceduralViolation("Actor not found.".into())
            })?;
            if !ch.inventory.item_ids.contains(item) {
                return Err(ProceduralViolation(
                    "Cannot equip an item the character is not holding.".into(),
                ));
            }
        }

        // Resolve the item to check equippability and slot
        let item_snap = self.items.get(item).ok_or_else(|| {
            ProceduralViolation("Item snapshot not found.".into())
        })?;
        let resolved = resolve_item(item_snap, cat)?;

        // 2. Must be equippable
        if !resolved.properties.equippable {
            return Err(ProceduralViolation("Item is not equippable.".into()));
        }

        // 3. Must have a slot kind
        let item_slot_kind = resolved.slot.ok_or_else(|| {
            ProceduralViolation("Item has no equipment slot.".into())
        })?;

        // Determine two-handed from descriptor (two_handed is not in ResolvedItem; read from catalog)
        let is_two_handed = {
            let snap = self.items.get(item).unwrap(); // safe: checked above
            if let crate::world::snapshot::ItemSnapshot::Item { behavior_key, .. } = snap {
                cat.items.get(behavior_key).and_then(|d| d.two_handed).unwrap_or(false)
            } else {
                false
            }
        };

        // 4. If already equipped, unequip first (suppress intermediate visibility cue)
        let already_equipped = {
            let ch = self.characters.get(actor).unwrap();
            ch.equipment.values().any(|v| v == item)
        };
        if already_equipped {
            self.unequip_inner(actor, item)?;
        }

        // 5. Two-handed weapon: clear both hands, set both
        if resolved.r#type == ItemType::Weapon && is_two_handed {
            // Collect current occupants of left/right hand (may be different items)
            let left_occ = self.characters.get(actor).and_then(|c| c.equipment.get(LEFT_HAND).cloned());
            let right_occ = self.characters.get(actor).and_then(|c| c.equipment.get(RIGHT_HAND).cloned());

            // Unequip each hand's occupant (suppress intermediate cues)
            if let Some(occ) = left_occ {
                if &occ != item {
                    self.unequip_inner(actor, &occ)?;
                }
            }
            if let Some(occ) = right_occ {
                if &occ != item {
                    self.unequip_inner(actor, &occ)?;
                }
            }

            // Set both hands to this item
            let ch = self.characters.get_mut(actor).unwrap();
            ch.equipment.insert(LEFT_HAND.into(), item.clone());
            ch.equipment.insert(RIGHT_HAND.into(), item.clone());
        } else {
            // 6. Normal slot assignment
            // eligible = DEFAULT_EQUIPMENT_SLOTS filtered by matching slot kind
            let eligible: Vec<&str> = DEFAULT_EQUIPMENT_SLOTS
                .iter()
                .copied()
                .filter(|s| slot_kind_of(s) == Some(item_slot_kind))
                .collect();

            if eligible.is_empty() {
                return Err(ProceduralViolation("Character has no slot for this item.".into()));
            }

            // First free eligible slot in canonical order, else displace eligible[0]
            let chosen_slot: &str = {
                let ch = self.characters.get(actor).unwrap();
                eligible.iter().find(|&&s| !ch.equipment.contains_key(s)).copied()
                    .unwrap_or(eligible[0])
            };
            let chosen_slot = chosen_slot.to_string(); // own the string before mutable borrow

            // Auto-swap: if chosen slot has a different occupant, unequip it first
            let current_occ = self.characters.get(actor)
                .and_then(|c| c.equipment.get(chosen_slot.as_str()).cloned());
            if let Some(occ) = current_occ {
                if &occ != item {
                    self.unequip_inner(actor, &occ)?;
                }
            }

            // Set the slot
            let ch = self.characters.get_mut(actor).unwrap();
            ch.equipment.insert(chosen_slot, item.clone());
        }

        // Emit one net visibility cue if lit state changed
        if let Some(ref room_id) = actor_room {
            let now_lit = self.is_lit(room_id);
            if now_lit != was_lit {
                let room_name = self.rooms.get(room_id).map(|r| r.name.clone()).unwrap_or_default();
                cues.push(PresentationCue::Visibility {
                    room: EntityRef { id: room_id.0.clone(), name: room_name },
                    lit: now_lit,
                });
            }
        }

        Ok(())
    }

    /// Unequip `item` from `actor`. Free — no budget tick, no history.
    ///
    /// Removes the item from every slot it occupies (a two-handed item occupies two).
    /// Mirrors `character.ts:756-773`.
    pub fn unequip(
        &mut self,
        actor: &CharacterId,
        item: &ItemId,
        _cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
        // 0. Affliction gate (is_move = false, NOT budgeted). Mirrors
        //    attemptAction(this.unequip, false). Fizzle records a fumble but does
        //    NOT tick the budget (unequip is a free action).
        match self.gate(actor, false) {
            crate::world::gate::GateVerdict::Block(r) => return Err(ProceduralViolation(r)),
            crate::world::gate::GateVerdict::Fizzle => {
                self.record_fumble(actor, "unequip", false, cues);
                return Ok(());
            }
            crate::world::gate::GateVerdict::Allow => {}
        }

        let actor_room = self.characters.get(actor).and_then(|c| c.current_room_id.clone());
        let was_lit = actor_room.as_ref().map(|r| self.is_lit(r)).unwrap_or(true);

        // Validate: item held AND equipped (mirrors character.ts:756-773 — no catalog lookup)
        {
            let ch = self.characters.get(actor).ok_or_else(|| {
                ProceduralViolation("Actor not found.".into())
            })?;
            if !ch.inventory.item_ids.contains(item) {
                return Err(ProceduralViolation(
                    "Cannot unequip an item the character is not holding.".into(),
                ));
            }
            if !ch.equipment.values().any(|v| v == item) {
                return Err(ProceduralViolation("Item is not equipped.".into()));
            }
        }

        self.unequip_inner(actor, item)?;

        // Emit visibility cue if lit state changed
        if let Some(ref room_id) = actor_room {
            let now_lit = self.is_lit(room_id);
            if now_lit != was_lit {
                let room_name = self.rooms.get(room_id).map(|r| r.name.clone()).unwrap_or_default();
                cues.push(PresentationCue::Visibility {
                    room: EntityRef { id: room_id.0.clone(), name: room_name },
                    lit: now_lit,
                });
            }
        }

        Ok(())
    }

    /// Internal unequip: removes `item` from every slot it occupies. No validation,
    /// no cue emission — callers wrap this with validation and emit one net cue.
    pub(super) fn unequip_inner(
        &mut self,
        actor: &CharacterId,
        item: &ItemId,
    ) -> Result<(), ProceduralViolation> {
        let ch = self.characters.get_mut(actor).ok_or_else(|| {
            ProceduralViolation("Actor not found.".into())
        })?;
        // Remove from every slot that holds this item (two-handed spans two slots).
        ch.equipment.retain(|_, v| v != item);
        Ok(())
    }

    /// Remove `target` from the actor's inventory (the item orphans in `World.items`
    /// — no room mutation), tick the action budget, record a `drop` history entry,
    /// and emit a `Drop` action cue.
    ///
    /// Shared tail used by both `drop_item` and `use_item` (which both produce a
    /// `drop` history entry, mirroring `CONSUME_VIA_USE → removeFromInventory`).
    fn consume_from_inventory(
        &mut self,
        actor: &CharacterId,
        target: &ItemId,
        item_name: &str,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
        let round = self.campaign.round;

        // Single borrow: retain item removal, tick budget, record history, clone name for cue.
        let actor_name = {
            let ch = self
                .characters
                .get_mut(actor)
                .ok_or_else(|| ProceduralViolation("Actor not found.".into()))?;
            ch.inventory.item_ids.retain(|id| id != target);
            ch.actions_this_round += 1;
            ch.history.push(ActionHistoryEntry::Drop {
                round,
                items: vec![ItemRef { id: target.clone(), name: item_name.to_string() }],
            });
            ch.name.clone()
        };

        // Emit Drop action cue.
        cues.push(PresentationCue::Action {
            action: ActionKind::Drop,
            actor: EntityRef { id: actor.0.clone(), name: actor_name },
            sound: None,
        });

        Ok(())
    }

    /// Drop `target` from the actor's inventory. **Budgeted** — ticks
    /// `actions_this_round` and records a `drop` history entry.
    ///
    /// Mirrors `character.ts:583-604` (`removeFromInventory`) exactly:
    /// the engine allows dropping any held non-key item regardless of `droppable`.
    /// Required-item drop rejection (`droppable == Some(false)`) is enforced at
    /// the session/authority layer (`session.ts:209`), not here.
    ///
    /// The item is **not** placed into a room pile — `relinquishItem` only removes
    /// it from the inventory (`character.ts:466`). It therefore becomes unreachable
    /// and drops out of the emitted snapshot's `items` array (see `to_snapshot`'s
    /// reachability filter, mirroring the TS serializer's reachable-graph walk).
    ///
    /// # Errors
    /// - `target` is not in `inventory.item_ids` → `ProceduralViolation`.
    /// - `target` resolves as a `Key` → `ProceduralViolation` (keys use `transferKey`).
    pub fn drop_item(
        &mut self,
        actor: &CharacterId,
        target: &ItemId,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
        // 0. Affliction gate (is_move = false, budgeted). Mirrors
        //    attemptAction(this.removeFromInventory, false).
        match self.gate(actor, false) {
            crate::world::gate::GateVerdict::Block(r) => return Err(ProceduralViolation(r)),
            crate::world::gate::GateVerdict::Fizzle => {
                self.record_fumble(actor, "removeFromInventory", true, cues);
                return Ok(());
            }
            crate::world::gate::GateVerdict::Allow => {}
        }

        // 1. Must be held in item_ids.
        {
            let ch = self
                .characters
                .get(actor)
                .ok_or_else(|| ProceduralViolation("Actor not found.".into()))?;
            if !ch.inventory.item_ids.contains(target) {
                return Err(ProceduralViolation(
                    "Attempted to remove an item from inventory, but the item was not in the character's inventory!".into(),
                ));
            }
        }

        // 2. Resolve and check for key type.
        // NOTE: droppable == Some(false) (required-item) is intentionally NOT checked here.
        // That guard belongs to the session/authority layer (session.ts:209), not the engine.
        let item_snap = self
            .items
            .get(target)
            .ok_or_else(|| ProceduralViolation("Item snapshot not found.".into()))?
            .clone();
        let resolved = resolve_item(&item_snap, cat)?;
        if resolved.r#type == ItemType::Key {
            return Err(ProceduralViolation(
                "Keys cannot be dropped; hand them over with transferKey instead.".into(),
            ));
        }

        // 3. Remove, tick budget, history, cue (shared tail).
        self.consume_from_inventory(actor, target, &resolved.name.clone(), cues)
    }

    /// Use (consume) `target` from the actor's inventory. **Budgeted** — ticks
    /// `actions_this_round` and records a `drop` history entry (mirroring
    /// `CONSUME_VIA_USE → removeFromInventory`).
    ///
    /// Mirrors `inventory.ts:607-631` (the `Use` action wrapper) and
    /// `character.ts:440-442` (`CONSUME_VIA_USE → removeFromInventory`).
    ///
    /// # Errors
    /// - `target` is not in `inventory.item_ids` → `ProceduralViolation`.
    /// - `resolved.properties.usable` is false → `ProceduralViolation`.
    pub fn use_item(
        &mut self,
        actor: &CharacterId,
        target: &ItemId,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
        // 1. Must be held in item_ids.
        {
            let ch = self
                .characters
                .get(actor)
                .ok_or_else(|| ProceduralViolation("Actor not found.".into()))?;
            if !ch.inventory.item_ids.contains(target) {
                return Err(ProceduralViolation(
                    "Attempted to use an item the character is not holding.".into(),
                ));
            }
        }

        // 2. Resolve and check usable.
        let item_snap = self
            .items
            .get(target)
            .ok_or_else(|| ProceduralViolation("Item snapshot not found.".into()))?
            .clone();
        let resolved = resolve_item(&item_snap, cat)?;
        if !resolved.properties.usable {
            return Err(ProceduralViolation(
                alloc::format!("The {} isn't something you can use.", resolved.name),
            ));
        }

        // 2b. Reject use while KO'd. `use` is the always-allowed escape hatch under
        //     Panic/Fear/Confused, but a KO'd character can do nothing at all.
        //     Mirrors inventory.ts:617-618 (after usable check, before grantsImmunity).
        //     This is the ONLY affliction guard on `use`; the consume itself stays
        //     gate-suppressed (no Panic/Fear/Confused fizzle gating on use).
        {
            let ch = self
                .characters
                .get(actor)
                .ok_or_else(|| ProceduralViolation("Actor not found.".into()))?;
            if ch.afflictions.is_active(Status::Ko) {
                return Err(ProceduralViolation("Cannot use items while KO'd.".into()));
            }
        }

        // 3. Grant immunity if the descriptor carries grantsImmunity (before consuming).
        // `grants_immunity` is json!(null) when absent — from_value fails cleanly → skip.
        // Mirrors inventory.ts:622-626: [GRANT_IMMUNITY](statuses, turns) before consume.
        if let Some(desc) = {
            if let crate::world::snapshot::ItemSnapshot::Item { behavior_key, .. } = &item_snap {
                cat.items.get(behavior_key)
            } else {
                None
            }
        } {
            if let Ok(gi) = serde_json::from_value::<GrantsImmunity>(desc.grants_immunity.clone()) {
                if let Some(ch) = self.characters.get_mut(actor) {
                    ch.afflictions.grant_immunity(&gi.statuses, gi.turns);
                }
            }
        }

        // 4. Consume: remove, tick budget, history, cue (shared tail).
        self.consume_from_inventory(actor, target, &resolved.name.clone(), cues)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::descriptor::{Catalog, ItemDescriptor, ItemProperties, ItemType, SlotKind};
    use crate::world::ids::ItemId;
    use crate::world::snapshot::ItemSnapshot;
    use crate::world::test_support::world_with_party;
    use alloc::collections::BTreeMap;
    use alloc::string::ToString;
    use serde_json::json;

    // ── helpers ────────────────────────────────────────────────────────────────

    fn iid(s: &str) -> ItemId { serde_json::from_value(json!(s)).unwrap() }
    fn cid(s: &str) -> CharacterId { CharacterId(s.into()) }

    fn weapon_desc(slot: SlotKind, two_handed: Option<bool>) -> ItemDescriptor {
        ItemDescriptor {
            name: "Test Weapon".into(),
            r#type: ItemType::Weapon,
            stat: crate::stats::StatType::Health,
            modifier: 2,
            properties: ItemProperties {
                equippable: true,
                equipped: false,
                destroyable: true,
                usable: false,
                droppable: None,
            },
            slot: Some(slot),
            two_handed,
            emits_light: None,
            max_durability: Some(5),
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

    fn accessory_desc(slot: SlotKind) -> ItemDescriptor {
        ItemDescriptor {
            name: "Test Ring".into(),
            r#type: ItemType::Accessory,
            stat: crate::stats::StatType::Energy,
            modifier: 1,
            properties: ItemProperties {
                equippable: true,
                equipped: false,
                destroyable: false,
                usable: false,
                droppable: None,
            },
            slot: Some(slot),
            two_handed: None,
            emits_light: None,
            max_durability: None,
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

    fn non_equippable_desc() -> ItemDescriptor {
        ItemDescriptor {
            name: "Gold Coin".into(),
            r#type: ItemType::Consumable,
            stat: crate::stats::StatType::Health,
            modifier: 0,
            properties: ItemProperties {
                equippable: false,
                equipped: false,
                destroyable: false,
                usable: true,
                droppable: None,
            },
            slot: None,
            two_handed: None,
            emits_light: None,
            max_durability: None,
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

    /// Build a world with one player character and given items in their inventory.
    fn world_with_items(items: &[(&str, &str)], cat: &Catalog) -> (World, CharacterId) {
        let mut world = world_with_party(&["pc"], 10);
        let char_id = cid("pc");

        for (item_id_str, behavior_key) in items {
            let id = iid(item_id_str);
            world.items.insert(
                id.clone(),
                ItemSnapshot::Item {
                    id: id.clone(),
                    behavior_key: behavior_key.to_string(),
                    durability: Some(5),
                    modifier: 0,
                },
            );
            world.characters.get_mut(&char_id).unwrap()
                .inventory.item_ids.push(id);
        }

        // Also insert catalog-only items that have no snapshot (edge case detection)
        let _ = cat; // catalog is owned by caller
        (world, char_id)
    }

    fn simple_cat_with(key: &str, desc: ItemDescriptor) -> Catalog {
        let mut items = BTreeMap::new();
        items.insert(key.to_string(), desc);
        Catalog { items, aliases: BTreeMap::new() }
    }

    // ── tests ──────────────────────────────────────────────────────────────────

    #[test]
    fn equip_weapon_lands_in_hand_slot_and_is_free() {
        let cat = simple_cat_with("items/sword", weapon_desc(SlotKind::Hand, None));
        let (mut world, char_id) = world_with_items(&[("sword-1", "items/sword")], &cat);

        let item = iid("sword-1");
        let mut cues = Vec::new();
        world.equip(&char_id, &item, &cat, &mut cues).unwrap();

        let ch = &world.characters[&char_id];
        // First eligible hand slot in canonical DEFAULT_EQUIPMENT_SLOTS order is leftHand
        assert_eq!(
            ch.equipment.get("leftHand"),
            Some(&item),
            "sword should land in leftHand (first eligible in canonical order); equipment = {:?}", ch.equipment
        );

        // Free: no budget tick, no history
        assert_eq!(ch.actions_this_round, 0, "equip should not tick budget");
        assert!(ch.history.is_empty(), "equip should not add history");

        // No visibility cue (room is not dark)
        assert!(cues.is_empty(), "no visibility cue for lit room");
    }

    #[test]
    fn equip_second_finger_ring_uses_second_eligible_slot() {
        let cat = simple_cat_with("items/ring", accessory_desc(SlotKind::Finger));
        let (mut world, char_id) = world_with_items(
            &[("ring-1", "items/ring"), ("ring-2", "items/ring")],
            &cat,
        );

        let ring1 = iid("ring-1");
        let ring2 = iid("ring-2");
        let mut cues = Vec::new();

        // Equip first ring
        world.equip(&char_id, &ring1, &cat, &mut cues).unwrap();
        // Equip second ring
        world.equip(&char_id, &ring2, &cat, &mut cues).unwrap();

        let ch = &world.characters[&char_id];
        // Canonical DEFAULT_EQUIPMENT_SLOTS finger order: leftIndexFinger before leftRingFinger
        assert_eq!(
            ch.equipment.get("leftIndexFinger"),
            Some(&ring1),
            "first ring should land in leftIndexFinger (canonical order); equipment = {:?}", ch.equipment
        );
        assert_eq!(
            ch.equipment.get("leftRingFinger"),
            Some(&ring2),
            "second ring should land in leftRingFinger (canonical order); equipment = {:?}", ch.equipment
        );
    }

    #[test]
    fn equip_non_equippable_item_returns_err() {
        let cat = simple_cat_with("items/coin", non_equippable_desc());
        let (mut world, char_id) = world_with_items(&[("coin-1", "items/coin")], &cat);

        let item = iid("coin-1");
        let mut cues = Vec::new();
        let result = world.equip(&char_id, &item, &cat, &mut cues);
        assert!(result.is_err(), "non-equippable item should return Err");
    }

    #[test]
    fn equip_unheld_item_returns_err() {
        let cat = simple_cat_with("items/sword", weapon_desc(SlotKind::Hand, None));
        let (mut world, char_id) = world_with_items(&[], &cat);

        // Item exists in world but NOT in character's inventory
        let item = iid("sword-ghost");
        world.items.insert(
            item.clone(),
            ItemSnapshot::Item {
                id: item.clone(),
                behavior_key: "items/sword".into(),
                durability: Some(5),
                modifier: 0,
            },
        );

        let mut cues = Vec::new();
        let result = world.equip(&char_id, &item, &cat, &mut cues);
        assert!(result.is_err(), "unheld item should return Err");
    }

    #[test]
    fn two_handed_weapon_occupies_both_hands() {
        let cat = simple_cat_with("items/greatsword", weapon_desc(SlotKind::Hand, Some(true)));
        let (mut world, char_id) = world_with_items(&[("gs-1", "items/greatsword")], &cat);

        let item = iid("gs-1");
        let mut cues = Vec::new();
        world.equip(&char_id, &item, &cat, &mut cues).unwrap();

        let ch = &world.characters[&char_id];
        let left = ch.equipment.get("leftHand");
        let right = ch.equipment.get("rightHand");
        assert_eq!(left, Some(&item), "two-handed should be in leftHand");
        assert_eq!(right, Some(&item), "two-handed should be in rightHand");
    }

    #[test]
    fn auto_swap_displaces_same_slot_occupant_and_occupant_stays_in_inventory() {
        let cat = simple_cat_with("items/sword", weapon_desc(SlotKind::Hand, None));
        let (mut world, char_id) = world_with_items(
            &[("sword-1", "items/sword"), ("sword-2", "items/sword")],
            &cat,
        );

        let sword1 = iid("sword-1");
        let sword2 = iid("sword-2");
        let mut cues = Vec::new();

        // Fill both hand slots
        world.equip(&char_id, &sword1, &cat, &mut cues).unwrap();
        world.equip(&char_id, &sword2, &cat, &mut cues).unwrap();

        // Now equip a third sword to force displacement
        let sword3 = iid("sword-3");
        world.items.insert(
            sword3.clone(),
            ItemSnapshot::Item {
                id: sword3.clone(),
                behavior_key: "items/sword".into(),
                durability: Some(5),
                modifier: 0,
            },
        );
        world.characters.get_mut(&char_id).unwrap().inventory.item_ids.push(sword3.clone());

        world.equip(&char_id, &sword3, &cat, &mut cues).unwrap();

        let ch = &world.characters[&char_id];
        // sword3 displaces eligible[0] = leftHand (canonical DEFAULT_EQUIPMENT_SLOTS order)
        assert_eq!(
            ch.equipment.get("leftHand"),
            Some(&sword3),
            "sword3 should be in leftHand (eligible[0]); equipment = {:?}", ch.equipment
        );
        // sword1 was in leftHand (first equipped), so it is the evicted item
        assert!(
            ch.inventory.item_ids.contains(&sword1),
            "sword1 (evicted from leftHand) should still be in inventory"
        );
    }

    #[test]
    fn unequip_removes_item_from_slot() {
        let cat = simple_cat_with("items/sword", weapon_desc(SlotKind::Hand, None));
        let (mut world, char_id) = world_with_items(&[("sword-1", "items/sword")], &cat);

        let item = iid("sword-1");
        let mut cues = Vec::new();

        // Equip then unequip
        world.equip(&char_id, &item, &cat, &mut cues).unwrap();
        world.unequip(&char_id, &item, &cat, &mut cues).unwrap();

        let ch = &world.characters[&char_id];
        let still_equipped = ch.equipment.values().any(|v| v == &item);
        assert!(!still_equipped, "item should not be in equipment after unequip");

        // Item still in inventory
        assert!(ch.inventory.item_ids.contains(&item), "item should stay in inventory");

        // Still free
        assert_eq!(ch.actions_this_round, 0);
        assert!(ch.history.is_empty());
    }

    #[test]
    fn unequip_two_handed_frees_both_hands() {
        let cat = simple_cat_with("items/greatsword", weapon_desc(SlotKind::Hand, Some(true)));
        let (mut world, char_id) = world_with_items(&[("gs-1", "items/greatsword")], &cat);

        let item = iid("gs-1");
        let mut cues = Vec::new();

        world.equip(&char_id, &item, &cat, &mut cues).unwrap();

        // Verify both hands occupied
        {
            let ch = &world.characters[&char_id];
            assert_eq!(ch.equipment.get("leftHand"), Some(&item));
            assert_eq!(ch.equipment.get("rightHand"), Some(&item));
        }

        world.unequip(&char_id, &item, &cat, &mut cues).unwrap();

        let ch = &world.characters[&char_id];
        assert!(ch.equipment.get("leftHand").is_none(), "leftHand should be free");
        assert!(ch.equipment.get("rightHand").is_none(), "rightHand should be free");
    }

    #[test]
    fn unequip_not_held_returns_err() {
        let cat = simple_cat_with("items/sword", weapon_desc(SlotKind::Hand, None));
        let (mut world, char_id) = world_with_items(&[], &cat);

        let item = iid("sword-ghost");
        world.items.insert(
            item.clone(),
            ItemSnapshot::Item {
                id: item.clone(),
                behavior_key: "items/sword".into(),
                durability: Some(5),
                modifier: 0,
            },
        );

        let mut cues = Vec::new();
        let result = world.unequip(&char_id, &item, &cat, &mut cues);
        assert!(result.is_err(), "unequip of unheld item should return Err");
    }

    #[test]
    fn unequip_not_equipped_returns_err() {
        let cat = simple_cat_with("items/sword", weapon_desc(SlotKind::Hand, None));
        let (mut world, char_id) = world_with_items(&[("sword-1", "items/sword")], &cat);

        let item = iid("sword-1");
        // Item is in inventory but NOT equipped
        let mut cues = Vec::new();
        let result = world.unequip(&char_id, &item, &cat, &mut cues);
        assert!(result.is_err(), "unequip of non-equipped item should return Err");
    }

    #[test]
    fn equip_canonical_slot_order_lefthand_before_righthand() {
        // First hand-slot item should go to leftHand (canonical order: leftHand before rightHand)
        let cat = simple_cat_with("items/sword", weapon_desc(SlotKind::Hand, None));
        let (mut world, char_id) = world_with_items(&[("sword-1", "items/sword")], &cat);

        let item = iid("sword-1");
        let mut cues = Vec::new();
        world.equip(&char_id, &item, &cat, &mut cues).unwrap();

        let ch = &world.characters[&char_id];
        assert_eq!(
            ch.equipment.get("leftHand"),
            Some(&item),
            "first hand item should go to leftHand per canonical DEFAULT_EQUIPMENT_SLOTS order"
        );
    }

    // ── take (loot → inventory) ────────────────────────────────────────────────

    use crate::world::ids::{LootId, RoomId};
    use crate::world::snapshot::{LootSnapshot, RoomSnapshot};

    fn consumable_desc() -> ItemDescriptor {
        ItemDescriptor {
            name: "Old Coin".into(),
            r#type: ItemType::Consumable,
            stat: crate::stats::StatType::Health,
            modifier: 0,
            properties: ItemProperties {
                equippable: false,
                equipped: false,
                destroyable: false,
                usable: true,
                droppable: None,
            },
            slot: None,
            two_handed: None,
            emits_light: None,
            max_durability: None,
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

    fn rid(s: &str) -> RoomId { RoomId(s.into()) }
    fn lid(s: &str) -> LootId { LootId(s.into()) }

    /// Build a world with one lit room, a loot container, an item, and the player in the room.
    fn take_world(dark: bool, slots: i64) -> (World, CharacterId) {
        let mut world = world_with_party(&["pc"], 10);
        let pc_id = CharacterId("pc".into());

        // Put player in "room1"
        world.characters.get_mut(&pc_id).unwrap().current_room_id = Some(rid("room1"));
        world.characters.get_mut(&pc_id).unwrap().inventory.slots = slots;

        // Add the item to world.items
        let item_id = iid("item-1");
        world.items.insert(
            item_id.clone(),
            ItemSnapshot::Item {
                id: item_id.clone(),
                behavior_key: "items/coin".into(),
                durability: None,
                modifier: 0,
            },
        );

        // Add a loot container with that item
        let loot_id = lid("loot-1");
        world.loot.insert(loot_id.clone(), LootSnapshot {
            id: loot_id.clone(),
            description: "A chest".into(),
            capacity: 10,
            content_ids: alloc::vec![item_id],
        });

        // Add the room with the loot container
        let room = RoomSnapshot {
            id: rid("room1"),
            name: "Test Room".into(),
            description: String::new(),
            exits: BTreeMap::new(),
            dark,
            spawn_modifier: 0,
            occupant_ids: alloc::vec![pc_id.clone()],
            loot_ids: alloc::vec![loot_id],
            material_cache_ids: alloc::vec![],
            light_source_ids: alloc::vec![],
            scenes: alloc::vec![],
        };
        world.rooms.insert(rid("room1"), room);

        (world, pc_id)
    }

    #[test]
    fn take_moves_item_to_inventory_removes_from_loot_ticks_budget_records_history_emits_cue() {
        let cat = simple_cat_with("items/coin", consumable_desc());
        let (mut world, pc_id) = take_world(/*dark=*/false, /*slots=*/6);
        let item_id = iid("item-1");
        let mut cues = Vec::new();

        let returned_loot_id = world.take(&pc_id, &item_id, &cat, &mut cues).unwrap();

        // Returns the correct loot container id
        assert_eq!(returned_loot_id, Some(lid("loot-1")));

        // Item is now in inventory
        let ch = &world.characters[&pc_id];
        assert!(ch.inventory.item_ids.contains(&item_id), "item should be in inventory");

        // Item is removed from loot content_ids
        let loot = &world.loot[&lid("loot-1")];
        assert!(!loot.content_ids.contains(&item_id), "item should be removed from loot");

        // Budget ticked +1
        assert_eq!(ch.actions_this_round, 1, "take should tick budget");

        // History has a PickUp entry
        assert_eq!(ch.history.len(), 1);
        match &ch.history[0] {
            ActionHistoryEntry::PickUp { round: 0, items } => {
                assert_eq!(items.len(), 1);
                assert_eq!(items[0].id, item_id);
                assert_eq!(items[0].name, "Old Coin");
            }
            other => panic!("expected PickUp history entry, got {:?}", other),
        }

        // An action cue (pickUp) was emitted
        assert_eq!(cues.len(), 1);
        match &cues[0] {
            PresentationCue::Action { action: ActionKind::PickUp, actor, sound: None } => {
                assert_eq!(actor.id, "pc");
            }
            other => panic!("expected Action(pickUp) cue, got {:?}", other),
        }
    }

    #[test]
    fn take_in_dark_room_returns_err() {
        let cat = simple_cat_with("items/coin", consumable_desc());
        let (mut world, pc_id) = take_world(/*dark=*/true, /*slots=*/6);
        let item_id = iid("item-1");
        let mut cues = Vec::new();

        let result = world.take(&pc_id, &item_id, &cat, &mut cues);
        assert!(result.is_err(), "take in a dark room should return Err");
        let err = result.unwrap_err();
        assert!(err.0.contains("dark"), "error message should mention 'dark', got: {}", err.0);
    }

    #[test]
    fn take_absent_item_returns_err() {
        let cat = simple_cat_with("items/coin", consumable_desc());
        let (mut world, pc_id) = take_world(/*dark=*/false, /*slots=*/6);
        // item-99 does not exist in any loot container
        let missing = iid("item-99");
        let mut cues = Vec::new();

        let result = world.take(&pc_id, &missing, &cat, &mut cues);
        assert!(result.is_err(), "take of absent item should return Err");
    }

    #[test]
    fn take_when_inventory_full_returns_err() {
        let cat = simple_cat_with("items/coin", consumable_desc());
        // slots=0 → inventory full
        let (mut world, pc_id) = take_world(/*dark=*/false, /*slots=*/0);
        let item_id = iid("item-1");
        let mut cues = Vec::new();

        let result = world.take(&pc_id, &item_id, &cat, &mut cues);
        assert!(result.is_err(), "take with full inventory should return Err");
    }

    #[test]
    fn take_key_bypasses_slot_check() {
        // Even with slots=0, a key can be picked up (goes to key_ids, not item_ids)
        let mut world = world_with_party(&["pc"], 10);
        let pc_id = CharacterId("pc".into());
        world.characters.get_mut(&pc_id).unwrap().current_room_id = Some(rid("room1"));
        world.characters.get_mut(&pc_id).unwrap().inventory.slots = 0; // full

        let key_id = iid("key-1");
        world.items.insert(
            key_id.clone(),
            ItemSnapshot::Key {
                id: key_id.clone(),
                name: "Brass Key".into(),
                key_code: "door-east".into(),
                consume_on_use: false,
            },
        );

        let loot_id = lid("loot-key");
        world.loot.insert(loot_id.clone(), LootSnapshot {
            id: loot_id.clone(),
            description: "Lockbox".into(),
            capacity: 5,
            content_ids: alloc::vec![key_id.clone()],
        });

        let room = RoomSnapshot {
            id: rid("room1"),
            name: "Room".into(),
            description: String::new(),
            exits: BTreeMap::new(),
            dark: false,
            spawn_modifier: 0,
            occupant_ids: alloc::vec![pc_id.clone()],
            loot_ids: alloc::vec![loot_id.clone()],
            material_cache_ids: alloc::vec![],
            light_source_ids: alloc::vec![],
            scenes: alloc::vec![],
        };
        world.rooms.insert(rid("room1"), room);

        let cat = Catalog::default();
        let mut cues = Vec::new();
        let result = world.take(&pc_id, &key_id, &cat, &mut cues);
        assert!(result.is_ok(), "key pickup should bypass slot check; err={:?}", result.err());

        let ch = &world.characters[&pc_id];
        assert!(ch.inventory.key_ids.contains(&key_id), "key should be in key_ids");
        assert!(!ch.inventory.item_ids.contains(&key_id), "key should NOT be in item_ids");
        assert!(ch.inventory.item_ids.is_empty(), "item_ids still empty (slots=0 enforced)");
    }

    #[test]
    fn take_key_ticks_budget_and_records_pickup_history() {
        // Reuse the key-take fixture from take_key_bypasses_slot_check.
        // After a successful key take, actions_this_round must increment by exactly 1
        // and history must gain a PickUp entry whose items[0] has the key's id and name.
        let mut world = world_with_party(&["pc"], 10);
        let pc_id = CharacterId("pc".into());
        world.characters.get_mut(&pc_id).unwrap().current_room_id = Some(rid("room1"));
        world.characters.get_mut(&pc_id).unwrap().inventory.slots = 0; // full — key bypasses this

        let key_id = iid("key-1");
        world.items.insert(
            key_id.clone(),
            ItemSnapshot::Key {
                id: key_id.clone(),
                name: "Brass Key".into(),
                key_code: "door-east".into(),
                consume_on_use: false,
            },
        );

        let loot_id = lid("loot-key");
        world.loot.insert(loot_id.clone(), LootSnapshot {
            id: loot_id.clone(),
            description: "Lockbox".into(),
            capacity: 5,
            content_ids: alloc::vec![key_id.clone()],
        });

        let room = RoomSnapshot {
            id: rid("room1"),
            name: "Room".into(),
            description: String::new(),
            exits: BTreeMap::new(),
            dark: false,
            spawn_modifier: 0,
            occupant_ids: alloc::vec![pc_id.clone()],
            loot_ids: alloc::vec![loot_id.clone()],
            material_cache_ids: alloc::vec![],
            light_source_ids: alloc::vec![],
            scenes: alloc::vec![],
        };
        world.rooms.insert(rid("room1"), room);

        let cat = Catalog::default();
        let mut cues = Vec::new();
        world.take(&pc_id, &key_id, &cat, &mut cues).unwrap();

        let ch = &world.characters[&pc_id];

        // Budget ticked exactly +1
        assert_eq!(ch.actions_this_round, 1, "key take should tick budget by exactly 1");

        // History gained a PickUp entry with the key's id and name
        assert_eq!(ch.history.len(), 1, "key take should record exactly one history entry");
        match &ch.history[0] {
            ActionHistoryEntry::PickUp { items, .. } => {
                assert_eq!(items.len(), 1, "PickUp entry should list exactly one item");
                assert_eq!(items[0].id, key_id, "PickUp item id should match the key id");
                assert_eq!(items[0].name, "Brass Key", "PickUp item name should match the key name");
            }
            other => panic!("expected PickUp history entry, got {:?}", other),
        }
    }

    #[test]
    fn take_with_actor_in_no_room_returns_err() {
        // When the acting character's current_room_id is None, take() must return
        // Err(ProceduralViolation) rather than panicking or succeeding.
        let cat = simple_cat_with("items/coin", consumable_desc());
        let (mut world, pc_id) = take_world(/*dark=*/false, /*slots=*/6);

        // Explicitly clear the actor's room assignment
        world.characters.get_mut(&pc_id).unwrap().current_room_id = None;

        let item_id = iid("item-1");
        let mut cues = Vec::new();
        let result = world.take(&pc_id, &item_id, &cat, &mut cues);
        assert!(result.is_err(), "take with actor in no room should return Err");
    }

    // ── drop_item ──────────────────────────────────────────────────────────────

    fn droppable_desc() -> ItemDescriptor {
        ItemDescriptor {
            name: "Rusty Dagger".into(),
            r#type: ItemType::Weapon,
            stat: crate::stats::StatType::Health,
            modifier: 1,
            properties: ItemProperties {
                equippable: false,
                equipped: false,
                destroyable: true,
                usable: false,
                droppable: None, // None = freely droppable
            },
            slot: None,
            two_handed: None,
            emits_light: None,
            max_durability: None,
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

    fn required_item_desc() -> ItemDescriptor {
        ItemDescriptor {
            name: "Ancient Relic".into(),
            r#type: ItemType::Consumable,
            stat: crate::stats::StatType::Health,
            modifier: 0,
            properties: ItemProperties {
                equippable: false,
                equipped: false,
                destroyable: false,
                usable: false,
                droppable: Some(false), // required / quest item
            },
            slot: None,
            two_handed: None,
            emits_light: None,
            max_durability: None,
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
    fn drop_item_removes_from_inventory_ticks_budget_records_drop_history_emits_cue() {
        let cat = simple_cat_with("items/dagger", droppable_desc());
        let (mut world, pc_id) = world_with_items(&[("dagger-1", "items/dagger")], &cat);
        let item_id = iid("dagger-1");
        let mut cues = Vec::new();

        world.drop_item(&pc_id, &item_id, &cat, &mut cues).unwrap();

        let ch = &world.characters[&pc_id];

        // Item removed from inventory
        assert!(!ch.inventory.item_ids.contains(&item_id), "item should be removed from inventory");

        // Item still orphaned in world.items (no room mutation)
        assert!(world.items.contains_key(&item_id), "item should still exist in world.items (orphaned)");

        // Budget ticked +1
        assert_eq!(ch.actions_this_round, 1, "drop should tick budget");

        // History has a Drop entry
        assert_eq!(ch.history.len(), 1);
        match &ch.history[0] {
            ActionHistoryEntry::Drop { round: 0, items } => {
                assert_eq!(items.len(), 1);
                assert_eq!(items[0].id, item_id);
                assert_eq!(items[0].name, "Rusty Dagger");
            }
            other => panic!("expected Drop history entry, got {:?}", other),
        }

        // Drop action cue emitted
        assert_eq!(cues.len(), 1);
        match &cues[0] {
            PresentationCue::Action { action: ActionKind::Drop, actor, sound: None } => {
                assert_eq!(actor.id, "pc");
            }
            other => panic!("expected Action(drop) cue, got {:?}", other),
        }
    }

    #[test]
    fn drop_item_key_returns_err() {
        // A Key-type item cannot be dropped (even if someone shoved one into item_ids somehow).
        let mut cat_items = alloc::collections::BTreeMap::new();
        // Key type items are normally in ItemSnapshot::Key, but we fake a catalog entry
        // with type=Key for the type-check path.
        cat_items.insert("items/brass-key".to_string(), ItemDescriptor {
            name: "Brass Key".into(),
            r#type: ItemType::Key,
            stat: crate::stats::StatType::Health,
            modifier: 0,
            properties: ItemProperties {
                equippable: false,
                equipped: false,
                destroyable: false,
                usable: false,
                droppable: None,
            },
            slot: None,
            two_handed: None,
            emits_light: None,
            max_durability: None,
            lore: None,
            presentation: None,
            key_code: Some("door-east".into()),
            consume_on_use: None,
            recipe: json!({}),
            teaches: json!(null),
            immunities: json!([]),
            grants_immunity: json!(null),
        });
        let cat = Catalog { items: cat_items, aliases: alloc::collections::BTreeMap::new() };

        let (mut world, pc_id) = world_with_items(&[("key-x", "items/brass-key")], &cat);
        let item_id = iid("key-x");
        let mut cues = Vec::new();

        let result = world.drop_item(&pc_id, &item_id, &cat, &mut cues);
        assert!(result.is_err(), "dropping a Key-type item should return Err");
        let err = result.unwrap_err();
        assert!(err.0.contains("Keys cannot be dropped"), "error should mention keys, got: {}", err.0);
    }

    #[test]
    fn drop_item_required_item_succeeds_at_engine_layer() {
        // The engine mirrors removeFromInventory (character.ts:583-604) which does NOT
        // check `droppable`. Required-item drop rejection is enforced at the
        // session/authority layer (session.ts:209), not here.
        let cat = simple_cat_with("items/relic", required_item_desc());
        let (mut world, pc_id) = world_with_items(&[("relic-1", "items/relic")], &cat);
        let item_id = iid("relic-1");
        let mut cues = Vec::new();

        let result = world.drop_item(&pc_id, &item_id, &cat, &mut cues);
        assert!(result.is_ok(), "engine should allow dropping required items (droppable:false); err={:?}", result.err());

        let ch = &world.characters[&pc_id];
        // Item removed from inventory
        assert!(!ch.inventory.item_ids.contains(&item_id), "item should be removed from inventory");
        // Budget ticked +1
        assert_eq!(ch.actions_this_round, 1, "drop should tick budget");
        // History has a Drop entry
        assert_eq!(ch.history.len(), 1);
        match &ch.history[0] {
            ActionHistoryEntry::Drop { items, .. } => {
                assert_eq!(items.len(), 1);
                assert_eq!(items[0].id, item_id);
                assert_eq!(items[0].name, "Ancient Relic");
            }
            other => panic!("expected Drop history entry, got {:?}", other),
        }
    }

    #[test]
    fn drop_item_unheld_returns_err() {
        let cat = simple_cat_with("items/dagger", droppable_desc());
        let (mut world, pc_id) = world_with_items(&[], &cat); // empty inventory

        let item_id = iid("dagger-ghost");
        // Add snapshot to world but NOT to inventory
        world.items.insert(
            item_id.clone(),
            ItemSnapshot::Item {
                id: item_id.clone(),
                behavior_key: "items/dagger".into(),
                durability: None,
                modifier: 0,
            },
        );

        let mut cues = Vec::new();
        let result = world.drop_item(&pc_id, &item_id, &cat, &mut cues);
        assert!(result.is_err(), "dropping unheld item should return Err");
        let err = result.unwrap_err();
        assert!(
            err.0.contains("item was not in the character's inventory"),
            "error should mention inventory, got: {}",
            err.0
        );
    }

    // ── use_item ───────────────────────────────────────────────────────────────

    fn usable_immunity_desc() -> ItemDescriptor {
        ItemDescriptor {
            name: "Panic Tonic".into(),
            r#type: ItemType::Consumable,
            stat: crate::stats::StatType::Health,
            modifier: 0,
            properties: ItemProperties {
                equippable: false,
                equipped: false,
                destroyable: false,
                usable: true,
                droppable: None,
            },
            slot: None,
            two_handed: None,
            emits_light: None,
            max_durability: None,
            lore: None,
            presentation: None,
            key_code: None,
            consume_on_use: Some(true),
            recipe: json!({}),
            teaches: json!(null),
            immunities: json!([]),
            grants_immunity: json!({ "statuses": ["panic"], "turns": 2 }),
        }
    }

    fn usable_desc() -> ItemDescriptor {
        ItemDescriptor {
            name: "Health Potion".into(),
            r#type: ItemType::Consumable,
            stat: crate::stats::StatType::Health,
            modifier: 3,
            properties: ItemProperties {
                equippable: false,
                equipped: false,
                destroyable: false,
                usable: true, // usable
                droppable: None,
            },
            slot: None,
            two_handed: None,
            emits_light: None,
            max_durability: None,
            lore: None,
            presentation: None,
            key_code: None,
            consume_on_use: Some(true),
            recipe: json!({}),
            teaches: json!(null),
            immunities: json!([]),
            grants_immunity: json!(null),
        }
    }

    fn non_usable_desc() -> ItemDescriptor {
        ItemDescriptor {
            name: "Old Journal".into(),
            r#type: ItemType::Consumable,
            stat: crate::stats::StatType::Health,
            modifier: 0,
            properties: ItemProperties {
                equippable: false,
                equipped: false,
                destroyable: false,
                usable: false, // NOT usable
                droppable: None,
            },
            slot: None,
            two_handed: None,
            emits_light: None,
            max_durability: None,
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
    fn use_item_consumes_ticks_budget_records_drop_history_emits_drop_cue() {
        let cat = simple_cat_with("items/potion", usable_desc());
        let (mut world, pc_id) = world_with_items(&[("potion-1", "items/potion")], &cat);
        let item_id = iid("potion-1");
        let mut cues = Vec::new();

        world.use_item(&pc_id, &item_id, &cat, &mut cues).unwrap();

        let ch = &world.characters[&pc_id];

        // Item consumed (removed from inventory)
        assert!(!ch.inventory.item_ids.contains(&item_id), "item should be consumed (removed from inventory)");

        // Item still orphaned in world.items (no room mutation)
        assert!(world.items.contains_key(&item_id), "item should still exist in world.items (orphaned)");

        // Budget ticked +1
        assert_eq!(ch.actions_this_round, 1, "use should tick budget");

        // History has a Drop entry (CONSUME_VIA_USE → removeFromInventory records drop)
        assert_eq!(ch.history.len(), 1);
        match &ch.history[0] {
            ActionHistoryEntry::Drop { round: 0, items } => {
                assert_eq!(items.len(), 1);
                assert_eq!(items[0].id, item_id);
                assert_eq!(items[0].name, "Health Potion");
            }
            other => panic!("expected Drop history entry for use, got {:?}", other),
        }

        // Drop action cue emitted (not PickUp — use records a drop cue)
        assert_eq!(cues.len(), 1);
        match &cues[0] {
            PresentationCue::Action { action: ActionKind::Drop, actor, sound: None } => {
                assert_eq!(actor.id, "pc");
            }
            other => panic!("expected Action(drop) cue for use, got {:?}", other),
        }
    }

    #[test]
    fn use_item_non_usable_returns_err() {
        let cat = simple_cat_with("items/journal", non_usable_desc());
        let (mut world, pc_id) = world_with_items(&[("journal-1", "items/journal")], &cat);
        let item_id = iid("journal-1");
        let mut cues = Vec::new();

        let result = world.use_item(&pc_id, &item_id, &cat, &mut cues);
        assert!(result.is_err(), "using a non-usable item should return Err");
        let err = result.unwrap_err();
        assert!(
            err.0.contains("isn't something you can use"),
            "error should mention 'isn't something you can use', got: {}",
            err.0
        );
    }

    #[test]
    fn use_item_with_grants_immunity_grants_then_consumes() {
        use crate::world::afflictions::Status;
        let cat = simple_cat_with("items/tonic", usable_immunity_desc());
        let (mut world, pc_id) = world_with_items(&[("tonic-1", "items/tonic")], &cat);
        let item_id = iid("tonic-1");
        let mut cues = Vec::new();

        world.use_item(&pc_id, &item_id, &cat, &mut cues).unwrap();

        let ch = &world.characters[&pc_id];
        // Immunity granted for Panic with 2 turns
        assert_eq!(
            ch.afflictions.immunity_of(Status::Panic), 2,
            "use of tonic should grant 2 turns of Panic immunity"
        );
        // Item consumed (removed from inventory)
        assert!(
            !ch.inventory.item_ids.contains(&item_id),
            "tonic should be consumed (removed from inventory)"
        );
    }

    #[test]
    fn use_item_unheld_returns_err() {
        let cat = simple_cat_with("items/potion", usable_desc());
        let (mut world, pc_id) = world_with_items(&[], &cat); // empty inventory

        let item_id = iid("potion-ghost");
        world.items.insert(
            item_id.clone(),
            ItemSnapshot::Item {
                id: item_id.clone(),
                behavior_key: "items/potion".into(),
                durability: None,
                modifier: 0,
            },
        );

        let mut cues = Vec::new();
        let result = world.use_item(&pc_id, &item_id, &cat, &mut cues);
        assert!(result.is_err(), "using unheld item should return Err");
        let err = result.unwrap_err();
        assert!(
            err.0.contains("not holding"),
            "error should mention 'not holding', got: {}",
            err.0
        );
    }

    // ── affliction gating (block/fizzle) integration ────────────────────────────

    /// Force a Confused fizzle by advancing the actor's rng until the next draw
    /// yields `roll(100) <= confused_fail_chance`. Returns with the world's rng
    /// primed so the very next `gate` draw fizzles.
    fn prime_confused_fizzle(world: &mut World, actor: &CharacterId) {
        use crate::world::afflictions::default_affliction_config;
        world.characters.get_mut(actor).unwrap().afflictions.set_active(Status::Confused, true);
        let fail = default_affliction_config().confused_fail_chance;
        loop {
            let mut peek = world.rng.clone();
            let r = (crate::dice::roll(100, peek.next_f64()) as i64) <= fail;
            if r { break; }
            world.rng.next_f64(); // burn a non-fizzling draw
        }
    }

    #[test]
    fn panicked_take_is_blocked_with_err() {
        let cat = simple_cat_with("items/coin", consumable_desc());
        let (mut world, pc_id) = take_world(/*dark=*/false, /*slots=*/6);
        world.characters.get_mut(&pc_id).unwrap().afflictions.set_active(Status::Panic, true);
        let item_id = iid("item-1");
        let mut cues = Vec::new();

        let result = world.take(&pc_id, &item_id, &cat, &mut cues);
        assert!(result.is_err(), "panicked take (non-move) should be blocked");
        assert_eq!(result.unwrap_err().0, "Panicked: can only move.");

        // Block leaves NO side-effects: item not moved, no budget tick, no history, no cue.
        let ch = &world.characters[&pc_id];
        assert!(!ch.inventory.item_ids.contains(&item_id), "item must not move on block");
        assert_eq!(ch.actions_this_round, 0, "block does not tick budget");
        assert!(ch.history.is_empty(), "block records no history");
        assert!(cues.is_empty(), "block emits no cue");
        assert!(world.loot[&lid("loot-1")].content_ids.contains(&item_id), "item stays in loot");
    }

    #[test]
    fn confused_take_fizzles_records_fumble_does_not_tick_budget_item_not_moved() {
        let cat = simple_cat_with("items/coin", consumable_desc());
        let (mut world, pc_id) = take_world(/*dark=*/false, /*slots=*/6);
        prime_confused_fizzle(&mut world, &pc_id);
        let item_id = iid("item-1");
        let mut cues = Vec::new();

        let result = world.take(&pc_id, &item_id, &cat, &mut cues).unwrap();
        assert_eq!(result, None, "fizzled take returns None (no loot taken)");

        let ch = &world.characters[&pc_id];
        // Fumble recorded but budget NOT ticked: the TS gate is on
        // `takeFromLootBox` (player-character.ts:217), which is not registered in
        // `isActionMap`, so recordAction finds `budgeted === false`
        // (character.ts:530). Only a SUCCESSFUL take ticks, via the internal
        // addToInventory/pickUp. Verified by the afflictions differential gate.
        assert_eq!(ch.actions_this_round, 0, "fizzled take does NOT tick budget");
        assert_eq!(ch.history.len(), 1);
        match &ch.history[0] {
            ActionHistoryEntry::Fumble { round: 0, action } => assert_eq!(action, "takeFromLootBox"),
            other => panic!("expected Fumble history, got {:?}", other),
        }
        // Fumble cue emitted.
        assert_eq!(cues.len(), 1);
        assert!(matches!(&cues[0], PresentationCue::Action { action: ActionKind::Fumble, .. }));
        // Item NOT moved.
        assert!(!ch.inventory.item_ids.contains(&item_id), "item must not move on fizzle");
        assert!(world.loot[&lid("loot-1")].content_ids.contains(&item_id), "item stays in loot");
    }

    #[test]
    fn confused_equip_fizzles_records_fumble_but_does_not_tick_budget() {
        let cat = simple_cat_with("items/sword", weapon_desc(SlotKind::Hand, None));
        let (mut world, char_id) = world_with_items(&[("sword-1", "items/sword")], &cat);
        prime_confused_fizzle(&mut world, &char_id);
        let item = iid("sword-1");
        let mut cues = Vec::new();

        world.equip(&char_id, &item, &cat, &mut cues).unwrap();

        let ch = &world.characters[&char_id];
        // Fumble recorded but budget NOT ticked (equip is free).
        assert_eq!(ch.actions_this_round, 0, "fizzled equip does NOT tick budget (free action)");
        assert_eq!(ch.history.len(), 1);
        match &ch.history[0] {
            ActionHistoryEntry::Fumble { action, .. } => assert_eq!(action, "equip"),
            other => panic!("expected Fumble history, got {:?}", other),
        }
        assert_eq!(cues.len(), 1);
        assert!(matches!(&cues[0], PresentationCue::Action { action: ActionKind::Fumble, .. }));
        // Item NOT equipped.
        assert!(!ch.equipment.values().any(|v| v == &item), "item must not equip on fizzle");
    }

    #[test]
    fn ko_use_item_returns_err_and_does_not_consume_or_grant() {
        use crate::world::afflictions::Status;
        let cat = simple_cat_with("items/tonic", usable_immunity_desc());
        let (mut world, pc_id) = world_with_items(&[("tonic-1", "items/tonic")], &cat);
        world.characters.get_mut(&pc_id).unwrap().afflictions.set_active(Status::Ko, true);
        let item_id = iid("tonic-1");
        let mut cues = Vec::new();

        let result = world.use_item(&pc_id, &item_id, &cat, &mut cues);
        assert!(result.is_err(), "KO'd use should return Err");
        assert_eq!(result.unwrap_err().0, "Cannot use items while KO'd.");

        let ch = &world.characters[&pc_id];
        // Item NOT consumed, immunity NOT granted, no budget tick / history / cue.
        assert!(ch.inventory.item_ids.contains(&item_id), "item must not be consumed while KO'd");
        assert_eq!(ch.afflictions.immunity_of(Status::Panic), 0, "no immunity granted while KO'd");
        assert_eq!(ch.actions_this_round, 0, "no budget tick");
        assert!(cues.is_empty(), "no cue emitted");
    }
}
