//! Content-derived id minting. The single source of truth for every id shape.
//!
//! These rules are the load-bearing assumption of the conformance gate: get one
//! wrong and the byte diff fires. No randomness, no uuids — an id is a pure
//! function of content.

pub fn campaign_id(title: &str) -> String {
    format!("campaign:{title}")
}
pub fn room_id(name: &str) -> String {
    format!("room:{name}")
}
pub fn mob_id(name: &str) -> String {
    format!("mob:{name}")
}
pub fn npc_id(name: &str) -> String {
    format!("npc:{name}")
}
pub fn cache_id(name: &str) -> String {
    format!("cache:{name}")
}
pub fn loot_id(name: &str) -> String {
    format!("loot:{name}")
}

/// `player:{name}` — minted at seating time, not by the construct pass; folded in
/// here because this crate's `assemble` also seats the party.
pub fn player_id(name: &str) -> String {
    format!("player:{name}")
}

/// `exit:{a}|{b}` where `[a, b]` is the sorted pair of the two AUTHOR-SUPPLIED
/// ROOM NAMES — not room ids, and not `from|to` order.
///
/// The golden-emitting oracle sorts with JS `Array.prototype.sort()`, which compares
/// UTF-16 code units; `str: Ord` compares UTF-8 bytes. They agree on ASCII and
/// diverge above the BMP, which is why room names are constrained to ASCII.
pub fn exit_id(from: &str, to: &str) -> String {
    let (a, b) = if from <= to { (from, to) } else { (to, from) };
    format!("exit:{a}|{b}")
}

/// `scene:{room}:{key}:{phase}`, with `phase` defaulting to `"enter"`.
pub fn scene_id(room: &str, key: &str, phase: Option<&str>) -> String {
    format!("scene:{room}:{key}:{}", phase.unwrap_or("enter"))
}

pub fn loot_item_id(loot_name: &str, i: usize) -> String {
    format!("loot:{loot_name}:item#{i}")
}
pub fn mob_drop_id(mob_name: &str, i: usize) -> String {
    format!("mob:{mob_name}:drop#{i}")
}
pub fn room_light_id(room_name: &str, i: usize) -> String {
    format!("room:{room_name}:light#{i}")
}
pub fn npc_item_id(npc_name: &str, i: usize) -> String {
    format!("npc:{npc_name}:item#{i}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simple_entity_ids() {
        assert_eq!(campaign_id("Crypt"), "campaign:Crypt");
        assert_eq!(room_id("start"), "room:start");
        assert_eq!(mob_id("goblin"), "mob:goblin");
        assert_eq!(npc_id("Keeper"), "npc:Keeper");
        assert_eq!(cache_id("vein"), "cache:vein");
        assert_eq!(loot_id("chest"), "loot:chest");
        assert_eq!(player_id("Ada"), "player:Ada");
    }

    /// Sorted-pair id over AUTHOR ROOM NAMES, not room ids: start->next must mint
    /// exactly "exit:next|start".
    #[test]
    fn exit_id_sorts_author_room_names() {
        assert_eq!(exit_id("start", "next"), "exit:next|start");
        assert_eq!(exit_id("next", "start"), "exit:next|start");
        // hollow-house: `Foyer --south--> Cellar` serializes as exit:Cellar|Foyer
        assert_eq!(exit_id("Foyer", "Cellar"), "exit:Cellar|Foyer");
        // ...while `Foyer --north--> Hall` serializes as exit:Foyer|Hall
        assert_eq!(exit_id("Foyer", "Hall"), "exit:Foyer|Hall");
    }

    #[test]
    fn scene_id_defaults_phase_to_enter() {
        assert_eq!(scene_id("start", "intro", None), "scene:start:intro:enter");
        assert_eq!(
            scene_id("start", "intro", Some("exit")),
            "scene:start:intro:exit"
        );
    }

    /// The infix differs by holder: item# / drop# / light#. Four rules, not one.
    #[test]
    fn item_ids_are_positional_and_holder_specific() {
        assert_eq!(loot_item_id("chest", 0), "loot:chest:item#0");
        assert_eq!(loot_item_id("chest", 1), "loot:chest:item#1");
        assert_eq!(mob_drop_id("goblin", 0), "mob:goblin:drop#0");
        assert_eq!(room_light_id("next", 0), "room:next:light#0");
        assert_eq!(npc_item_id("Keeper", 0), "npc:Keeper:item#0");
    }
}
