//! Resolve a UI [`Intent`] into an actor-tagged sync [`Command`] for a **named** seat.
//!
//! This generalizes the web client's `intent_to_command`, which hard-codes the *active* seat. On a
//! physical board the moved piece's NFC tag *is* the `actor_id`, so the bridge must build a command
//! for whichever seat acted; the engine's `authorize` gate then rejects it if it isn't that seat's
//! turn. The single-seat/active-seat path is just `command_for(world, cat, world.active_character_id()?, …)`.

use wickedways_core::sync::Command;
use wickedways_core::world::descriptor::Catalog;
use wickedways_core::world::ids::{CharacterId, ItemId, MaterialCacheId};
use wickedways_core::world::intent::Intent;
use wickedways_core::World;

/// Build the actor-tagged [`Command`] for `intent`, acting as `actor_id`. Returns `Err` with a cue
/// string for a blocked move (locked door) or a local-only verb (`open`).
pub fn command_for(
    world: &World,
    catalog: &Catalog,
    actor_id: CharacterId,
    intent: &Intent,
) -> Result<Command, String> {
    let actor = actor_id;
    // An exhaustive `match`: every `Intent` variant must have an arm, or this fails to *compile* —
    // unlike a JS `switch`, there is no silent fall-through and no need for a `default`. Adding a
    // new intent to the engine forces this function to handle it.
    match intent {
        Intent::Move { dir } => {
            // `.get()` returns an `Option` (Rust's explicit `T | undefined`); `ok_or` upgrades it
            // to a `Result` with an error message, and `?` early-returns that `Err` — the moral
            // equivalent of `throw`, except the failure is part of the signature.
            let room_id = world
                .characters
                .get(&actor)
                .and_then(|c| c.current_room_id.clone())
                .ok_or("you are nowhere")?;
            let room = world.rooms.get(&room_id).ok_or("room not found")?;
            let exit_id = room
                .exits
                .get(dir.as_key())
                .ok_or_else(|| format!("no exit {}", dir.as_key()))?;
            let ex = world.exits.get(exit_id).ok_or("exit not found")?;
            // Gate the move on the exit's keyed-door behavior, the way the single-seat `go` does — the
            // sync `move` (by room id) lands via `move_to`, which performs no door check. A locked
            // door returns its fail message and no command is issued.
            if let Some(reason) = world.exit_block_reason(&actor, *dir, catalog) {
                return Err(reason);
            }
            let dest = if ex.endpoint_ids[0] == room_id {
                ex.endpoint_ids[1].clone()
            } else {
                ex.endpoint_ids[0].clone()
            };
            Ok(Command::Move {
                actor_id: actor,
                room_id: dest,
            })
        }
        // The arms below are mechanical translation. `ItemId(...)`/`CharacterId(...)` are newtype
        // wrappers — single-field tuple structs that "brand" a plain `String` so an item id can't
        // be passed where a character id belongs (the type-level trick TS emulates with branded
        // types). The `.clone()`s exist because `intent` is borrowed (we only have a reference to
        // it), while the returned `Command` must own its strings outright.
        Intent::Take { target_id } => Ok(Command::PickUp {
            actor_id: actor,
            item_ids: vec![ItemId(target_id.clone())],
        }),
        Intent::Drop { target_id } => Ok(Command::Drop {
            actor_id: actor,
            item_ids: vec![ItemId(target_id.clone())],
        }),
        Intent::Attack { target_id } => Ok(Command::Attack {
            actor_id: actor,
            target_id: CharacterId(target_id.clone()),
        }),
        Intent::Equip { target_id } => Ok(Command::Equip {
            actor_id: actor,
            item_id: ItemId(target_id.clone()),
            slot: None,
        }),
        Intent::Unequip { target_id } => Ok(Command::Unequip {
            actor_id: actor,
            item_id: ItemId(target_id.clone()),
        }),
        Intent::Use { target_id } => Ok(Command::Use {
            actor_id: actor,
            item_id: ItemId(target_id.clone()),
        }),
        Intent::Harvest { target_id } => Ok(Command::Harvest {
            actor_id: actor,
            cache_id: MaterialCacheId(target_id.clone()),
        }),
        Intent::Craft { recipe_id } => Ok(Command::Craft {
            actor_id: actor,
            recipe_id: recipe_id.clone(),
        }),
        Intent::Repair { target_id } => Ok(Command::Repair {
            actor_id: actor,
            item_id: ItemId(target_id.clone()),
        }),
        Intent::Destroy { target_id } => Ok(Command::Destroy {
            actor_id: actor,
            item_id: ItemId(target_id.clone()),
        }),
        // `open` is a local view reveal — surfaces handle it against the current view.
        Intent::Open { .. } => Err("(opening is a local view action)".into()),
        Intent::Talk { npc_id, prompt } => Ok(Command::Talk {
            actor_id: actor,
            npc_id: CharacterId(npc_id.clone()),
            prompt: prompt.clone(),
        }),
        Intent::Wait => Ok(Command::Wait { actor_id: actor }),
        // The Villain's card actions. `room` arrives as a NAME (the text
        // parser has no room scope); resolve it here against the live world,
        // case-insensitively — Shadow Step may target ANY room, visited or not.
        Intent::PlayCard { card_key, room } => {
            let room_id = match room {
                None => None,
                Some(name) => {
                    let want = name.to_lowercase();
                    Some(
                        world
                            .rooms
                            .values()
                            .find(|r| r.name.to_lowercase() == want)
                            .map(|r| r.id.clone())
                            .ok_or_else(|| format!("You know of no place called \"{name}\"."))?,
                    )
                }
            };
            Ok(Command::PlayCard {
                actor_id: actor,
                card_key: card_key.clone(),
                room_id,
                target_id: None,
            })
        }
        Intent::Mulligan { card_keys } => Ok(Command::Mulligan {
            actor_id: actor,
            card_keys: card_keys.clone(),
        }),
    }
}
