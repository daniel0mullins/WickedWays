//! Materials & crafting: the campaign material pool, harvesting caches, crafting
//! recipes, and repairing gear.
//!
//! Ports the pool ops (`canAfford`/`withdrawMaterials`/`claimMaterials`/
//! `discoverRecipe`) and the character verbs `harvest`/`craft`/`repair`. All three
//! character verbs are **free** (no budget tick, no history) — they require the
//! actor's turn (enforced upstream in the sync `authorize`) but never spend an
//! action. Material deposits (harvest) still route through
//! [`World::deposit_materials`], which additively merges the pool and records the
//! `material` codex entries.

use alloc::collections::BTreeMap;
use alloc::format;
use alloc::string::String;

use serde_json::{json, Value};

use crate::error::ProceduralViolation;
use crate::presentation::PresentationCue;
use crate::world::descriptor::Catalog;
use crate::world::ids::{CharacterId, ItemId, MaterialCacheId};
use crate::world::resolve::resolve_item;
use crate::world::snapshot::ItemSnapshot;
use crate::world::World;

impl World {
    // ---- Campaign material pool --------------------------------

    /// Whether the shared pool holds every requested component at ≥ the requested
    /// quantity. Mirrors `Campaign.canAfford`.
    pub fn can_afford(&self, cost: &BTreeMap<String, i64>) -> bool {
        let pool = self.campaign.materials.as_object();
        cost.iter().all(|(component, qty)| {
            let have = pool
                .and_then(|p| p.get(component))
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            have >= *qty as f64
        })
    }

    /// Remove `cost` from the pool, deleting any component that reaches ≤ 0. The
    /// whole cost is checked up front, so a failed withdrawal leaves the pool
    /// untouched. Mirrors `Campaign.withdrawMaterials`.
    fn withdraw_materials(
        &mut self,
        cost: &BTreeMap<String, i64>,
    ) -> Result<(), ProceduralViolation> {
        if !self.can_afford(cost) {
            return Err(ProceduralViolation(
                "Insufficient materials in the party pool".into(),
            ));
        }
        if !self.campaign.materials.is_object() {
            self.campaign.materials = json!({});
        }
        if let Some(pool) = self.campaign.materials.as_object_mut() {
            for (component, qty) in cost {
                let remaining =
                    pool.get(component).and_then(Value::as_f64).unwrap_or(0.0) - *qty as f64;
                if remaining > 0.0 {
                    pool.insert(component.clone(), json!(remaining));
                } else {
                    pool.remove(component);
                }
            }
        }
        Ok(())
    }

    /// Whether the party already knows a recipe. Mirrors `Campaign.knows`.
    pub fn knows_recipe(&self, recipe_id: &str) -> bool {
        self.campaign.known_recipes.iter().any(|r| r == recipe_id)
    }

    // ---- Character verbs --------------------------------------

    /// Empty a material cache in the actor's current room into the shared pool.
    /// Idempotent: a depleted cache deposits nothing (anti-farming). **Free** — no
    /// budget tick. Mirrors `Character.harvest`.
    ///
    /// # Errors
    /// `ProceduralViolation` if the actor cannot see (dark room) or the cache is not
    /// in the actor's current room.
    pub fn harvest(
        &mut self,
        actor: &CharacterId,
        cache_id: &MaterialCacheId,
        cat: &Catalog,
        _cues: &mut [PresentationCue],
    ) -> Result<(), ProceduralViolation> {
        self.require_visible_target(actor, "harvest", cat)?;
        let room_id = self
            .characters
            .get(actor)
            .and_then(|c| c.current_room_id.clone())
            .ok_or_else(|| ProceduralViolation("Cannot harvest while not in a room".into()))?;
        let in_room = self
            .rooms
            .get(&room_id)
            .is_some_and(|r| r.material_cache_ids.iter().any(|id| id == cache_id));
        if !in_room {
            return Err(ProceduralViolation(
                "Cannot harvest a material cache that is not in the current room".into(),
            ));
        }
        // DEPLETE: take the contents and mark the cache spent. A depleted cache
        // yields `{}` and changes nothing.
        let mats = {
            let Some(cache) = self.material_caches.get_mut(cache_id) else {
                return Err(ProceduralViolation("Material cache not found".into()));
            };
            if cache.depleted {
                return Ok(());
            }
            cache.depleted = true;
            // `mem::replace` moves the contents out and leaves `{}` in their place —
            // Rust can't just "take" a field out of a borrowed struct (that would
            // leave a hole), so the swap hands us ownership without a clone.
            core::mem::replace(&mut cache.contents, json!({}))
        };
        // Deposit into the pool + record the `material` codex entries.
        self.deposit_materials(&mats, Some(&actor.0), Some(&room_id.0));
        Ok(())
    }

    /// Turn a known recipe into an item placed in the actor's inventory. **Free** —
    /// no budget tick. Mirrors `Character.craft`'s materials track (the Rust
    /// `RecipeMeta` models only material recipes; a keys track lands with the
    /// keyring port).
    ///
    /// # Errors
    /// `ProceduralViolation` for an unknown recipe, a recipe with no craftable
    /// output, an unaffordable cost, or a full inventory.
    pub fn craft(
        &mut self,
        actor: &CharacterId,
        recipe_id: &str,
        cat: &Catalog,
        _cues: &mut [PresentationCue],
    ) -> Result<ItemId, ProceduralViolation> {
        if !self.knows_recipe(recipe_id) {
            return Err(ProceduralViolation(
                "Cannot craft an undiscovered recipe".into(),
            ));
        }
        let recipe = cat
            .recipes
            .get(recipe_id)
            .ok_or_else(|| ProceduralViolation("No recipe registered for that id".into()))?
            .clone();
        let output_key = recipe
            .output_item_key
            .ok_or_else(|| ProceduralViolation("Recipe has no craftable output item".into()))?;
        let descriptor = cat.items.get(&output_key).ok_or_else(|| {
            ProceduralViolation(format!("No item registered for key '{output_key}'"))
        })?;

        if !self.can_afford(&recipe.materials) {
            return Err(ProceduralViolation("Not enough materials to craft".into()));
        }
        // Capacity: a non-key output needs a free slot. (Materials recipes produce
        // slotted items; the keys track — free-stored — arrives with the keyring.)
        let ch = self
            .characters
            .get(actor)
            .ok_or_else(|| ProceduralViolation("Actor not found".into()))?;
        if ch.inventory.item_ids.len() as i64 >= ch.inventory.slots {
            return Err(ProceduralViolation(
                "No inventory slot for the crafted item".into(),
            ));
        }

        self.withdraw_materials(&recipe.materials)?;

        // Build a fresh instance from the catalog: a new id, the output descriptor's
        // key, full durability, and the descriptor's modifier (mirrors the TS
        // factory output + `receiveItem`).
        let id = self.mint_item_id();
        let item = ItemSnapshot::Item {
            id: id.clone(),
            behavior_key: output_key,
            durability: descriptor.max_durability,
            modifier: descriptor.modifier,
        };
        self.items.insert(id.clone(), item);
        if let Some(ch) = self.characters.get_mut(actor) {
            ch.inventory.item_ids.push(id.clone());
        }
        Ok(id)
    }

    /// Restore a held, damaged, durable item to full for a material cost
    /// proportional to the missing fraction. **Free** — no budget tick. Mirrors
    /// `Character.repair`.
    ///
    /// # Errors
    /// `ProceduralViolation` if the item is a key, unheld, has no durability, is
    /// already full, or the party cannot afford the cost.
    pub fn repair(
        &mut self,
        actor: &CharacterId,
        item_id: &ItemId,
        cat: &Catalog,
        _cues: &mut [PresentationCue],
    ) -> Result<(), ProceduralViolation> {
        let held = self
            .characters
            .get(actor)
            .is_some_and(|c| c.inventory.item_ids.iter().any(|i| i == item_id));
        // Keys carry no durability; reject them with a clear reason.
        if self
            .characters
            .get(actor)
            .is_some_and(|c| c.inventory.key_ids.iter().any(|i| i == item_id))
        {
            return Err(ProceduralViolation("Keys cannot be repaired.".into()));
        }
        if !held {
            return Err(ProceduralViolation(
                "Cannot repair an item the character is not holding.".into(),
            ));
        }
        let snap = self
            .items
            .get(item_id)
            .ok_or_else(|| ProceduralViolation("Item snapshot not found.".into()))?
            .clone();
        let resolved = resolve_item(&snap, cat)?;
        // `let (Some(a), Some(b)) = … else`: both options must be present or we
        // bail — a two-value destructure-or-return in one statement.
        let (Some(max), Some(cur)) = (resolved.max_durability, resolved.durability) else {
            return Err(ProceduralViolation(
                "Cannot repair an item that has no durability.".into(),
            ));
        };
        if cur >= max {
            return Err(ProceduralViolation(
                "Cannot repair an item that is not damaged.".into(),
            ));
        }

        // Proportional cost from the item's own material composition (`recipe`):
        // ceil(qty * missing / maxDurability) per component.
        let missing = max - cur;
        let ItemSnapshot::Item { behavior_key, .. } = &snap else {
            return Err(ProceduralViolation("Keys cannot be repaired.".into()));
        };
        let recipe = cat
            .items
            .get(behavior_key)
            .map_or_else(|| json!({}), |d| d.recipe.clone());
        let mut cost: BTreeMap<String, i64> = BTreeMap::new();
        if let Some(obj) = recipe.as_object() {
            for (component, qty) in obj {
                let Some(qty) = qty.as_f64() else { continue };
                // integer ceil of (qty * missing) / max
                // Integer ceil of (qty * missing) / max; both non-negative, max > 0.
                let numerator = (qty as i64) * missing;
                let per = (numerator + max - 1) / max;
                if per > 0 {
                    cost.insert(component.clone(), per);
                }
            }
        }
        if !self.can_afford(&cost) {
            return Err(ProceduralViolation(
                "Not enough materials to repair.".into(),
            ));
        }
        self.withdraw_materials(&cost)?;
        self.set_durability(item_id, max);
        Ok(())
    }

    /// Scrap a held, destroyable item: deposit its material makeup (`recipe`) into
    /// the shared pool and consume the item. **Free** — no budget tick, and (like the
    /// `relinquishItem` path) it logs no drop. Mirrors the item `destroy` action.
    ///
    /// # Errors
    /// `ProceduralViolation` if the item is not held or is not destroyable (e.g. a key).
    pub fn destroy(
        &mut self,
        actor: &CharacterId,
        item_id: &ItemId,
        cat: &Catalog,
        _cues: &mut [PresentationCue],
    ) -> Result<(), ProceduralViolation> {
        let held = self
            .characters
            .get(actor)
            .is_some_and(|c| c.inventory.item_ids.iter().any(|i| i == item_id));
        if !held {
            return Err(ProceduralViolation(
                "Cannot destroy an item the character is not holding.".into(),
            ));
        }
        let snap = self
            .items
            .get(item_id)
            .ok_or_else(|| ProceduralViolation("Item snapshot not found.".into()))?
            .clone();
        let resolved = resolve_item(&snap, cat)?;
        if !resolved.properties.destroyable {
            return Err(ProceduralViolation(
                "That item cannot be broken down.".into(),
            ));
        }
        // The item's `recipe` (material makeup) returns to the pool — the same field
        // craft/repair price against.
        let room = self
            .characters
            .get(actor)
            .and_then(|c| c.current_room_id.clone());
        let recipe = match &snap {
            ItemSnapshot::Item { behavior_key, .. } => cat
                .items
                .get(behavior_key)
                .map_or_else(|| json!({}), |d| d.recipe.clone()),
            ItemSnapshot::Key { .. } => json!({}),
        };
        self.deposit_materials(&recipe, Some(&actor.0), room.as_ref().map(|r| r.0.as_str()));
        // Consume the item: pull from inventory and drop the snapshot (silent — no drop log).
        if let Some(ch) = self.characters.get_mut(actor) {
            ch.inventory.item_ids.retain(|i| i != item_id);
        }
        self.items.remove(item_id);
        Ok(())
    }

    /// Mint a fresh, unused item id. The crafted item's concrete id rides the sync
    /// delta to replicas, so this need only be unique within the authority (the TS
    /// side uses a uuid, which likewise can't be gated byte-for-byte). Drawn from the
    /// injected rng and retried on the (astronomically unlikely) collision.
    fn mint_item_id(&mut self) -> ItemId {
        loop {
            let a = (self.rng.next_f64() * 4_294_967_296.0) as u64;
            let b = (self.rng.next_f64() * 4_294_967_296.0) as u64;
            let id = ItemId(format!("item:crafted:{a:08x}{b:08x}"));
            if !self.items.contains_key(&id) {
                return id;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stats::StatType;
    use crate::world::descriptor::{ItemDescriptor, ItemType, RecipeMeta, SlotKind};
    use crate::world::ids::RoomId;
    use crate::world::snapshot::MaterialCacheSnapshot;
    use crate::world::test_support::world_two_rooms;
    use crate::world::test_support::{item_desc, props};
    use alloc::collections::BTreeMap;

    fn pc() -> CharacterId {
        CharacterId("pc".into())
    }

    /// A weapon descriptor with a material `recipe` composition (drives repair cost).
    fn weapon_desc(max_dur: Option<i64>, recipe: Value) -> ItemDescriptor {
        ItemDescriptor {
            properties: props(true, true, false),
            slot: Some(SlotKind::Hand),
            max_durability: max_dur,
            recipe,
            ..item_desc("Iron Blade", ItemType::Weapon, StatType::Health, 2)
        }
    }

    fn catalog_with(
        items: BTreeMap<String, ItemDescriptor>,
        recipes: BTreeMap<String, RecipeMeta>,
    ) -> Catalog {
        Catalog {
            items,
            recipes,
            ..Catalog::default()
        }
    }

    fn place_cache(world: &mut World, room: &str, id: &str, contents: Value) {
        let cid = MaterialCacheId(id.into());
        world.material_caches.insert(
            cid.clone(),
            MaterialCacheSnapshot {
                id: cid.clone(),
                contents,
                depleted: false,
            },
        );
        world
            .rooms
            .get_mut(&RoomId(room.into()))
            .unwrap()
            .material_cache_ids
            .push(cid);
    }

    #[test]
    fn harvest_deposits_into_the_pool_and_depletes_the_cache() {
        let mut world = world_two_rooms(false); // pc in the lit "start" room
        place_cache(
            &mut world,
            "start",
            "cache:vein",
            json!({ "iron": 3, "salt": 2 }),
        );
        let cat = Catalog::default();
        let mut cues = Vec::new();

        world
            .harvest(
                &pc(),
                &MaterialCacheId("cache:vein".into()),
                &cat,
                &mut cues,
            )
            .unwrap();

        assert_eq!(
            world.campaign.materials,
            json!({ "iron": 3.0, "salt": 2.0 })
        );
        assert!(world.material_caches[&MaterialCacheId("cache:vein".into())].depleted);

        // A second harvest is a safe no-op (anti-farming): pool unchanged.
        world
            .harvest(
                &pc(),
                &MaterialCacheId("cache:vein".into()),
                &cat,
                &mut cues,
            )
            .unwrap();
        assert_eq!(
            world.campaign.materials,
            json!({ "iron": 3.0, "salt": 2.0 })
        );
    }

    #[test]
    fn harvest_in_the_dark_is_refused() {
        let mut world = world_two_rooms(false);
        // Darken the start room and drop its light so the actor can't see.
        world.rooms.get_mut(&RoomId("start".into())).unwrap().dark = true;
        place_cache(&mut world, "start", "cache:vein", json!({ "iron": 1 }));
        let err = world
            .harvest(
                &pc(),
                &MaterialCacheId("cache:vein".into()),
                &Catalog::default(),
                &mut Vec::new(),
            )
            .unwrap_err();
        assert!(err.0.contains("dark"), "got {err:?}");
    }

    #[test]
    fn harvest_a_cache_in_another_room_is_refused() {
        let mut world = world_two_rooms(false);
        place_cache(&mut world, "next", "cache:vein", json!({ "iron": 1 })); // pc is in "start"
        let err = world
            .harvest(
                &pc(),
                &MaterialCacheId("cache:vein".into()),
                &Catalog::default(),
                &mut Vec::new(),
            )
            .unwrap_err();
        assert!(err.0.contains("not in the current room"), "got {err:?}");
    }

    fn craftable_catalog() -> Catalog {
        let mut items = BTreeMap::new();
        items.insert(
            "items/blade".to_string(),
            weapon_desc(Some(4), json!({ "iron": 2 })),
        );
        let mut recipes = BTreeMap::new();
        recipes.insert(
            "blade".to_string(),
            RecipeMeta {
                id: "blade".into(),
                output_name: "Iron Blade".into(),
                materials: BTreeMap::from([("iron".to_string(), 2)]),
                output_item_key: Some("items/blade".into()),
            },
        );
        catalog_with(items, recipes)
    }

    #[test]
    fn craft_withdraws_materials_and_adds_the_output_to_inventory() {
        let mut world = world_two_rooms(false);
        world.campaign.known_recipes.push("blade".into());
        world.campaign.materials = json!({ "iron": 5 });
        let cat = craftable_catalog();

        let id = world.craft(&pc(), "blade", &cat, &mut Vec::new()).unwrap();

        // Output is a fresh full-durability instance of the recipe's item, now held.
        assert!(world.characters[&pc()].inventory.item_ids.contains(&id));
        match &world.items[&id] {
            ItemSnapshot::Item {
                behavior_key,
                durability,
                modifier,
                ..
            } => {
                assert_eq!(behavior_key, "items/blade");
                assert_eq!(*durability, Some(4));
                assert_eq!(*modifier, 2);
            }
            _ => panic!("expected an item"),
        }
        // Pool debited by the recipe cost (5 - 2 = 3).
        assert_eq!(world.campaign.materials, json!({ "iron": 3.0 }));
    }

    #[test]
    fn craft_an_undiscovered_recipe_is_refused() {
        let mut world = world_two_rooms(false);
        world.campaign.materials = json!({ "iron": 5 });
        let err = world
            .craft(&pc(), "blade", &craftable_catalog(), &mut Vec::new())
            .unwrap_err();
        assert!(err.0.contains("undiscovered"), "got {err:?}");
    }

    #[test]
    fn craft_without_enough_materials_is_refused_and_spends_nothing() {
        let mut world = world_two_rooms(false);
        world.campaign.known_recipes.push("blade".into());
        world.campaign.materials = json!({ "iron": 1 });
        let err = world
            .craft(&pc(), "blade", &craftable_catalog(), &mut Vec::new())
            .unwrap_err();
        assert!(err.0.contains("Not enough materials"), "got {err:?}");
        assert_eq!(
            world.campaign.materials,
            json!({ "iron": 1 }),
            "pool untouched on failure"
        );
    }

    #[test]
    fn craft_with_a_full_inventory_is_refused() {
        let mut world = world_two_rooms(false);
        world.campaign.known_recipes.push("blade".into());
        world.campaign.materials = json!({ "iron": 5 });
        // Fill the single... actually two_rooms pc has 6 slots; fill them.
        let slots = world.characters[&pc()].inventory.slots;
        for i in 0..slots {
            world
                .characters
                .get_mut(&pc())
                .unwrap()
                .inventory
                .item_ids
                .push(ItemId(format!("filler{i}")));
        }
        let err = world
            .craft(&pc(), "blade", &craftable_catalog(), &mut Vec::new())
            .unwrap_err();
        assert!(err.0.contains("No inventory slot"), "got {err:?}");
        assert_eq!(
            world.campaign.materials,
            json!({ "iron": 5 }),
            "pool untouched on failure"
        );
    }

    #[test]
    fn repair_restores_full_durability_for_a_proportional_cost() {
        let mut world = world_two_rooms(false);
        // A held blade worn to 1/4; recipe { iron: 4 } → cost ceil(4 * 3 / 4) = 3.
        let mut items = BTreeMap::new();
        items.insert(
            "items/blade".to_string(),
            weapon_desc(Some(4), json!({ "iron": 4 })),
        );
        let cat = catalog_with(items, BTreeMap::new());
        let bid = ItemId("blade-1".into());
        world.items.insert(
            bid.clone(),
            ItemSnapshot::Item {
                id: bid.clone(),
                behavior_key: "items/blade".into(),
                durability: Some(1),
                modifier: 2,
            },
        );
        world
            .characters
            .get_mut(&pc())
            .unwrap()
            .inventory
            .item_ids
            .push(bid.clone());
        world.campaign.materials = json!({ "iron": 10 });

        world.repair(&pc(), &bid, &cat, &mut Vec::new()).unwrap();

        match &world.items[&bid] {
            ItemSnapshot::Item { durability, .. } => {
                assert_eq!(*durability, Some(4), "restored to full");
            }
            _ => panic!(),
        }
        assert_eq!(
            world.campaign.materials,
            json!({ "iron": 7.0 }),
            "cost of 3 withdrawn"
        );
    }

    #[test]
    fn repair_an_undamaged_item_is_refused() {
        let mut world = world_two_rooms(false);
        let mut items = BTreeMap::new();
        items.insert(
            "items/blade".to_string(),
            weapon_desc(Some(4), json!({ "iron": 4 })),
        );
        let cat = catalog_with(items, BTreeMap::new());
        let bid = ItemId("blade-1".into());
        world.items.insert(
            bid.clone(),
            ItemSnapshot::Item {
                id: bid.clone(),
                behavior_key: "items/blade".into(),
                durability: Some(4),
                modifier: 2,
            },
        );
        world
            .characters
            .get_mut(&pc())
            .unwrap()
            .inventory
            .item_ids
            .push(bid.clone());
        let err = world
            .repair(&pc(), &bid, &cat, &mut Vec::new())
            .unwrap_err();
        assert!(err.0.contains("not damaged"), "got {err:?}");
    }

    #[test]
    fn destroy_scraps_a_held_item_into_the_pool() {
        let mut world = world_two_rooms(false);
        let mut items = BTreeMap::new();
        items.insert(
            "items/blade".to_string(),
            weapon_desc(Some(4), json!({ "iron": 2, "salt": 1 })),
        );
        let cat = catalog_with(items, BTreeMap::new());
        let bid = ItemId("blade-1".into());
        world.items.insert(
            bid.clone(),
            ItemSnapshot::Item {
                id: bid.clone(),
                behavior_key: "items/blade".into(),
                durability: Some(3),
                modifier: 2,
            },
        );
        world
            .characters
            .get_mut(&pc())
            .unwrap()
            .inventory
            .item_ids
            .push(bid.clone());

        world.destroy(&pc(), &bid, &cat, &mut Vec::new()).unwrap();

        // The item's makeup returned to the pool and the item is gone.
        assert_eq!(
            world.campaign.materials,
            json!({ "iron": 2.0, "salt": 1.0 })
        );
        assert!(!world.items.contains_key(&bid), "snapshot removed");
        assert!(
            !world.characters[&pc()].inventory.item_ids.contains(&bid),
            "not held"
        );
    }

    #[test]
    fn destroy_a_non_destroyable_item_is_refused() {
        let mut world = world_two_rooms(false);
        let mut desc = weapon_desc(Some(4), json!({ "iron": 2 }));
        desc.properties.destroyable = false;
        let mut items = BTreeMap::new();
        items.insert("items/anvil".to_string(), desc);
        let cat = catalog_with(items, BTreeMap::new());
        let bid = ItemId("anvil-1".into());
        world.items.insert(
            bid.clone(),
            ItemSnapshot::Item {
                id: bid.clone(),
                behavior_key: "items/anvil".into(),
                durability: Some(4),
                modifier: 2,
            },
        );
        world
            .characters
            .get_mut(&pc())
            .unwrap()
            .inventory
            .item_ids
            .push(bid.clone());
        let err = world
            .destroy(&pc(), &bid, &cat, &mut Vec::new())
            .unwrap_err();
        assert!(err.0.contains("cannot be broken down"), "got {err:?}");
        assert!(world.items.contains_key(&bid), "untouched on refusal");
    }

    #[test]
    fn repair_an_unheld_item_is_refused() {
        let mut world = world_two_rooms(false);
        let mut items = BTreeMap::new();
        items.insert(
            "items/blade".to_string(),
            weapon_desc(Some(4), json!({ "iron": 4 })),
        );
        let cat = catalog_with(items, BTreeMap::new());
        let bid = ItemId("blade-1".into());
        world.items.insert(
            bid.clone(),
            ItemSnapshot::Item {
                id: bid.clone(),
                behavior_key: "items/blade".into(),
                durability: Some(1),
                modifier: 2,
            },
        );
        let err = world
            .repair(&pc(), &bid, &cat, &mut Vec::new())
            .unwrap_err();
        assert!(err.0.contains("not holding"), "got {err:?}");
    }
}
