//! The `selectArchetype` setup action (Phase 2c, sub-project A1).
//!
//! Ports `PlayerCharacter.selectArchetype` (`src/lib/character/player-character.ts`): a setup-only,
//! once-only operation that applies a campaign archetype's effects to a character — the named base
//! stats override the character's stats, the inventory-slot delta adjusts capacity (floored at 0),
//! and the immunities become a standing passive trait. The archetype catalogue lives inert on
//! `campaign.archetypes` (an `Archetype[]` JSON value); this is the first engine reader of it.

use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use serde::Deserialize;

use crate::error::ProceduralViolation;
use crate::world::afflictions::Status;
use crate::world::ids::CharacterId;
use crate::world::World;

/// The subset of an archetype the action applies. Extra fields (e.g. `name`) are ignored.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchetypeDef {
    id: String,
    #[serde(default)]
    base_stats: BaseStats,
    #[serde(default)]
    inventory_slots: Option<i64>,
    #[serde(default)]
    immunities: Vec<Status>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct BaseStats {
    health: Option<f64>,
    sanity: Option<f64>,
    energy: Option<f64>,
}

impl World {
    /// Selects `archetype_id` from the campaign catalogue for `actor`, applying its effects exactly
    /// once. Mirrors `PlayerCharacter.selectArchetype`.
    ///
    /// # Errors
    /// [`ProceduralViolation`] if the campaign has begun, the character already has an archetype,
    /// the actor is unknown, or `archetype_id` is not in the catalogue.
    pub fn select_archetype(
        &mut self,
        actor: &CharacterId,
        archetype_id: &str,
    ) -> Result<(), ProceduralViolation> {
        if self.campaign.started {
            return Err(ProceduralViolation(
                "Cannot select an archetype after the campaign has begun.".into(),
            ));
        }
        let ch = self
            .characters
            .get(actor)
            .ok_or_else(|| ProceduralViolation("Actor not found.".into()))?;
        if ch.archetype_id.is_some() {
            return Err(ProceduralViolation(
                "Character has already selected an archetype.".into(),
            ));
        }

        // Resolve the archetype from the inert catalogue (validated before any mutation).
        let defs: Vec<ArchetypeDef> = serde_json::from_value(self.campaign.archetypes.clone())
            .map_err(|e| ProceduralViolation(format!("malformed archetypes catalogue: {e}")))?;
        let def = defs
            .into_iter()
            .find(|d| d.id == archetype_id)
            .ok_or_else(|| ProceduralViolation("Unknown archetype.".into()))?;

        // Apply. The named base stats OVERRIDE (not add to) the character's stats, matching the TS.
        let ch = self.characters.get_mut(actor).expect("actor present above");
        if let Some(v) = def.base_stats.health {
            ch.stats.health = v;
        }
        if let Some(v) = def.base_stats.sanity {
            ch.stats.sanity = v;
        }
        if let Some(v) = def.base_stats.energy {
            ch.stats.energy = v;
        }
        if let Some(delta) = def.inventory_slots {
            ch.inventory.slots = (ch.inventory.slots + delta).max(0);
        }
        ch.archetype_immunities = def.immunities;
        ch.archetype_id = Some(archetype_id.into());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::test_support::world_with_party;
    use serde_json::json;

    fn pre_start_world_with_archetypes(archetypes: serde_json::Value) -> World {
        let mut w = world_with_party(&["pc"], 10);
        w.campaign.started = false;
        w.campaign.archetypes = archetypes;
        w
    }

    #[test]
    fn applies_base_stats_slots_and_immunities() {
        let mut w = pre_start_world_with_archetypes(json!([{
            "id": "delver", "name": "Delver",
            "baseStats": { "health": 2 },
            "inventorySlots": -1,
            "immunities": ["fear"]
        }]));
        w.select_archetype(&CharacterId("pc".into()), "delver").unwrap();
        let ch = &w.characters[&CharacterId("pc".into())];
        assert_eq!(ch.stats.health, 2.0, "base stat overridden");
        assert_eq!(ch.stats.sanity, 5.0, "unspecified stat unchanged");
        assert_eq!(ch.inventory.slots, 5, "slot delta applied (6 + -1)");
        assert_eq!(ch.archetype_immunities, alloc::vec![Status::Fear]);
        assert_eq!(ch.archetype_id.as_deref(), Some("delver"));
    }

    #[test]
    fn inventory_slots_floor_at_zero() {
        let mut w = pre_start_world_with_archetypes(json!([{
            "id": "burdened", "baseStats": {}, "inventorySlots": -100
        }]));
        w.select_archetype(&CharacterId("pc".into()), "burdened").unwrap();
        assert_eq!(w.characters[&CharacterId("pc".into())].inventory.slots, 0);
    }

    #[test]
    fn rejects_after_start() {
        let mut w = pre_start_world_with_archetypes(json!([{ "id": "a", "baseStats": {} }]));
        w.campaign.started = true;
        assert!(w.select_archetype(&CharacterId("pc".into()), "a").is_err());
    }

    #[test]
    fn rejects_a_second_selection() {
        let mut w = pre_start_world_with_archetypes(json!([
            { "id": "a", "baseStats": {} }, { "id": "b", "baseStats": {} }
        ]));
        w.select_archetype(&CharacterId("pc".into()), "a").unwrap();
        assert!(w.select_archetype(&CharacterId("pc".into()), "b").is_err());
    }

    #[test]
    fn rejects_an_unknown_archetype() {
        let mut w = pre_start_world_with_archetypes(json!([{ "id": "a", "baseStats": {} }]));
        assert!(matches!(
            w.select_archetype(&CharacterId("pc".into()), "ghost"),
            Err(ProceduralViolation(_))
        ));
        // …and nothing was mutated (no archetype set).
        assert!(w.characters[&CharacterId("pc".into())].archetype_id.is_none());
    }
}
