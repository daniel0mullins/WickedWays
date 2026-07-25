//! Point-and-click affordances — ViewModel → clickable hotspots + inventory verbs (Phase 2c,
//! sub-project D — slice 3).
//!
//! Ports `packages/play-surface/src/pnc/affordances.ts` 1:1: the pure, framework-free logic that
//! derives what the player can click in a scene ([`scene_hotspots`]) and which verbs an inventory
//! item offers ([`inventory_actions`]), gated by the entity's capabilities so the menu never offers a
//! verb the engine would reject. It is the point-and-click analog of the CRT [`parser`](crate::parser)
//! — browser-free, so it is unit-tested exhaustively on the host; a later slice's PnC components turn
//! these descriptors into DOM (scene hotspots, the radial action menu, the inventory grid).
//!
//! Takes `&ViewModel`/`&ScopeEntity` (the only inputs the TS functions read), which keeps the port
//! and its tests trivial and independent of the multiplayer/transport machinery.

use wickedways_core::world::direction::Direction;
use wickedways_core::world::intent::Intent;
use wickedways_core::world::view::{ScopeEntity, ViewModel};

use std::collections::BTreeSet;

/// One selectable verb on a hotspot or inventory item. Mirrors the TS `ActionDescriptor` union: an
/// engine [`Intent`] to submit, or a free `examine`/`read` routed locally by the surface.
#[derive(Clone, Debug, PartialEq)]
pub enum ActionDescriptor {
    Intent { label: String, intent: Intent },
    Examine { label: String, target_id: String },
    Read { label: String, target_id: String },
}

impl ActionDescriptor {
    /// The button text for this action (the `label` field of every variant).
    pub fn label(&self) -> &str {
        match self {
            ActionDescriptor::Intent { label, .. }
            | ActionDescriptor::Examine { label, .. }
            | ActionDescriptor::Read { label, .. } => label,
        }
    }
}

/// The kind of scene hotspot — drives which glyph/affordance the PnC scene renders.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HotspotKind {
    Exit,
    Locked,
    Occupant,
    /// A co-located party member (another player) — distinguished so surfaces can show who's here.
    Player,
    Loot,
    Item,
    /// An un-harvested material cache in the room.
    Cache,
}

/// A clickable element in the current scene. Mirrors the TS `Hotspot`.
#[derive(Clone, Debug, PartialEq)]
pub struct Hotspot {
    /// Stable key: the direction key for exits/doors, the entity id otherwise.
    pub key: String,
    /// Display label — "North", "Revenant", "Chest", "Brass Key".
    pub label: String,
    pub kind: HotspotKind,
    /// Present for exits and locked doors.
    pub dir: Option<Direction>,
    /// The entity/room image, if the campaign supplied one (opaque passthrough — the surface owns
    /// rendering it). Mirrors the TS `image?: string`, carried through as the core's `AssetRef`.
    pub image: Option<serde_json::Value>,
    /// The verbs this hotspot offers; `[]` for locked doors (informational only).
    pub actions: Vec<ActionDescriptor>,
}

/// Capitalise a lowercase [`Direction`] key for display ("north" → "North"). Only the first byte is
/// uppercased (so "northeast" → "Northeast", NOT "NorthEast") — matches the TS `cap`.
fn cap(dir: Direction) -> String {
    let key = dir.as_key();
    let mut chars = key.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// Derive all clickable hotspots for the current scene from a [`ViewModel`].
///
/// Order: exits, locked doors, occupants, loot containers, floor items.
///
/// "Floor items" are scope entities of kind `"item"` that belong neither to the player inventory
/// (items + keys) nor to any *closed* loot container's contents. Once a container is opened its
/// contents are revealed and become individually clickable floor items so the player can take them.
pub fn scene_hotspots(vm: &ViewModel) -> Vec<Hotspot> {
    let mut hotspots: Vec<Hotspot> = Vec::new();

    // ── Exits ────────────────────────────────────────────────────────────────
    for exit in &vm.exits {
        let label = cap(exit.dir);
        hotspots.push(Hotspot {
            key: exit.dir.as_key().to_string(),
            label: label.clone(),
            kind: HotspotKind::Exit,
            dir: Some(exit.dir),
            image: None,
            actions: vec![ActionDescriptor::Intent {
                label: format!("Go {label}"),
                intent: Intent::Move { dir: exit.dir },
            }],
        });
    }

    // ── Locked doors ───────────────────────────────────────────────────────────
    for door in &vm.locked_doors {
        hotspots.push(Hotspot {
            key: door.dir.as_key().to_string(),
            label: door.name.clone(),
            kind: HotspotKind::Locked,
            dir: Some(door.dir),
            image: None,
            actions: Vec::new(),
        });
    }

    // ── Occupants ──────────────────────────────────────────────────────────────
    for occupant in &vm.occupants {
        let is_player = occupant.player == Some(true);
        let mut actions = vec![ActionDescriptor::Examine {
            label: "Examine".into(),
            target_id: occupant.id.clone(),
        }];
        if occupant.talkable == Some(true) {
            actions.push(ActionDescriptor::Intent {
                label: "Talk".into(),
                intent: Intent::Talk {
                    npc_id: occupant.id.clone(),
                    prompt: None,
                },
            });
        }
        // Fellow players aren't foes — no attack verb on a party member.
        if !is_player && occupant.defeated != Some(true) {
            actions.push(ActionDescriptor::Intent {
                label: "Attack".into(),
                intent: Intent::Attack {
                    target_id: occupant.id.clone(),
                },
            });
        }
        hotspots.push(Hotspot {
            key: occupant.id.clone(),
            label: occupant.name.clone(),
            kind: if is_player {
                HotspotKind::Player
            } else {
                HotspotKind::Occupant
            },
            dir: None,
            image: occupant.image.clone(),
            actions,
        });
    }

    // ── Loot containers ─────────────────────────────────────────────────────────
    for loot in &vm.loot {
        hotspots.push(Hotspot {
            key: loot.id.clone(),
            label: loot.description.clone(),
            kind: HotspotKind::Loot,
            dir: None,
            image: None,
            actions: vec![
                ActionDescriptor::Examine {
                    label: "Examine".into(),
                    target_id: loot.id.clone(),
                },
                ActionDescriptor::Intent {
                    label: "Open".into(),
                    intent: Intent::Open {
                        target_id: loot.id.clone(),
                    },
                },
            ],
        });
    }

    // ── Material caches ──────────────────────────────────────────────────────────
    for cache in &vm.caches {
        hotspots.push(Hotspot {
            key: cache.id.clone(),
            label: cache.name.clone(),
            kind: HotspotKind::Cache,
            dir: None,
            image: cache.image.clone(),
            actions: vec![
                ActionDescriptor::Examine {
                    label: "Examine".into(),
                    target_id: cache.id.clone(),
                },
                ActionDescriptor::Intent {
                    label: "Harvest".into(),
                    intent: Intent::Harvest {
                        target_id: cache.id.clone(),
                    },
                },
            ],
        });
    }

    // ── Floor items ──────────────────────────────────────────────────────────────
    let mut inventory_ids: BTreeSet<&str> = BTreeSet::new();
    for i in &vm.inventory.items {
        inventory_ids.insert(i.id.as_str());
    }
    for k in &vm.inventory.keys {
        inventory_ids.insert(k.id.as_str());
    }
    let mut loot_content_ids: BTreeSet<&str> = BTreeSet::new();
    for l in &vm.loot {
        if !l.opened {
            for c in &l.contents {
                loot_content_ids.insert(c.id.as_str());
            }
        }
    }
    for item in &vm.scope {
        if item.kind == "item"
            && !inventory_ids.contains(item.id.as_str())
            && !loot_content_ids.contains(item.id.as_str())
        {
            hotspots.push(Hotspot {
                key: item.id.clone(),
                label: item.name.clone(),
                kind: HotspotKind::Item,
                dir: None,
                image: item.image.clone(),
                actions: vec![
                    ActionDescriptor::Examine {
                        label: "Examine".into(),
                        target_id: item.id.clone(),
                    },
                    ActionDescriptor::Intent {
                        label: "Take".into(),
                        intent: Intent::Take {
                            target_id: item.id.clone(),
                        },
                    },
                ],
            });
        }
    }

    hotspots
}

/// Returns the action verbs available for an inventory item, gated by the item's capabilities so the
/// menu never offers a verb the engine would reject:
///
/// - Examine (always) — a generic look.
/// - Read — only if the item carries lore.
/// - Equip / Unequip — only if the item is equippable (swapped by the `equipped` flag).
/// - Use — only if the item is usable (consumed on use).
/// - Repair — only if the item is durable and worn below full (`damaged`).
/// - Drop (always, unless the item is a required quest item — `droppable == Some(false)`).
/// - Break down — only if the item is `destroyable` (scraps it into the material pool).
pub fn inventory_actions(item: &ScopeEntity, equipped: bool) -> Vec<ActionDescriptor> {
    let mut actions = vec![ActionDescriptor::Examine {
        label: "Examine".into(),
        target_id: item.id.clone(),
    }];
    if item.has_lore == Some(true) {
        actions.push(ActionDescriptor::Read {
            label: "Read".into(),
            target_id: item.id.clone(),
        });
    }
    if item.equippable == Some(true) {
        actions.push(if equipped {
            ActionDescriptor::Intent {
                label: "Unequip".into(),
                intent: Intent::Unequip {
                    target_id: item.id.clone(),
                },
            }
        } else {
            ActionDescriptor::Intent {
                label: "Equip".into(),
                intent: Intent::Equip {
                    target_id: item.id.clone(),
                },
            }
        });
    }
    if item.usable == Some(true) {
        actions.push(ActionDescriptor::Intent {
            label: "Use".into(),
            intent: Intent::Use {
                target_id: item.id.clone(),
            },
        });
    }
    // Repair — only a durable item worn below full (free, restores to full for a material cost).
    if item.damaged == Some(true) {
        actions.push(ActionDescriptor::Intent {
            label: "Repair".into(),
            intent: Intent::Repair {
                target_id: item.id.clone(),
            },
        });
    }
    // Required quest items (droppable === false) can't be set down.
    if item.droppable != Some(false) {
        actions.push(ActionDescriptor::Intent {
            label: "Drop".into(),
            intent: Intent::Drop {
                target_id: item.id.clone(),
            },
        });
    }
    // Break down — only a destroyable item (scraps it back into the shared material pool).
    if item.destroyable == Some(true) {
        actions.push(ActionDescriptor::Intent {
            label: "Break down".into(),
            intent: Intent::Destroy {
                target_id: item.id.clone(),
            },
        });
    }
    actions
}

#[cfg(test)]
mod tests {
    use super::*;
    use wickedways_core::presentation::CampaignOutcome;
    use wickedways_core::world::view::{
        ExitView, Inventory, LockedDoorView, LootView, StatusView, ThinRoom,
    };

    fn mk_vm() -> ViewModel {
        ViewModel {
            room: ThinRoom {
                id: "r".into(),
                name: "Hall".into(),
                description: "a hall".into(),
                is_lit: true,
            },
            exits: Vec::new(),
            locked_doors: Vec::new(),
            occupants: Vec::new(),
            loot: Vec::new(),
            caches: Vec::new(),
            inventory: Inventory {
                items: Vec::new(),
                keys: Vec::new(),
                equipped_names: Vec::new(),
                slots: 6,
            },
            scope: Vec::new(),
            materials: Vec::new(),
            recipes: Vec::new(),
            status: StatusView {
                location_name: "Hall".into(),
                turn: 1,
                max_turns: 150,
                health: 10.0,
                sanity: 10.0,
            },
            outcome: CampaignOutcome::Ongoing,
            finished: false,
        }
    }

    fn ent(id: &str, name: &str, kind: &str) -> ScopeEntity {
        ScopeEntity {
            id: id.into(),
            name: name.into(),
            aliases: vec![name.to_lowercase()],
            kind: kind.into(),
            health: None,
            image: None,
            equippable: None,
            usable: None,
            has_lore: None,
            droppable: None,
            destroyable: None,
            damaged: None,
            defeated: None,
            talkable: None,
            player: None,
        }
    }

    // ── Exits ──────────────────────────────────────────────────────────────────

    #[test]
    fn passable_exit_produces_a_go_dir_move_intent() {
        let mut vm = mk_vm();
        vm.exits = vec![ExitView {
            dir: Direction::North,
            to_name: "Landing".into(),
        }];
        let hotspots = scene_hotspots(&vm);
        assert_eq!(hotspots.len(), 1);
        let h = &hotspots[0];
        assert_eq!(h.kind, HotspotKind::Exit);
        assert_eq!(h.key, "north");
        assert_eq!(h.label, "North");
        assert_eq!(h.dir, Some(Direction::North));
        assert_eq!(
            h.actions,
            vec![ActionDescriptor::Intent {
                label: "Go North".into(),
                intent: Intent::Move {
                    dir: Direction::North
                },
            }]
        );
    }

    #[test]
    fn capitalises_all_eight_directions() {
        let dirs = [
            Direction::North,
            Direction::South,
            Direction::East,
            Direction::West,
            Direction::Northeast,
            Direction::Northwest,
            Direction::Southeast,
            Direction::Southwest,
        ];
        let mut vm = mk_vm();
        vm.exits = dirs
            .iter()
            .map(|&dir| ExitView {
                dir,
                to_name: "Room".into(),
            })
            .collect();
        let labels: Vec<String> = scene_hotspots(&vm).into_iter().map(|h| h.label).collect();
        assert_eq!(
            labels,
            [
                "North",
                "South",
                "East",
                "West",
                "Northeast",
                "Northwest",
                "Southeast",
                "Southwest"
            ]
        );
    }

    // ── Locked doors ─────────────────────────────────────────────────────────────

    #[test]
    fn locked_door_has_empty_actions_key_is_dir_and_label_is_the_name() {
        let mut vm = mk_vm();
        vm.locked_doors = vec![LockedDoorView {
            name: "Iron Gate".into(),
            dir: Direction::East,
        }];
        let hotspots = scene_hotspots(&vm);
        assert_eq!(hotspots.len(), 1);
        let h = &hotspots[0];
        assert_eq!(h.kind, HotspotKind::Locked);
        assert_eq!(h.key, "east");
        assert_eq!(h.dir, Some(Direction::East));
        assert!(h.label.contains("Iron Gate"));
        assert!(h.actions.is_empty());
    }

    // ── Occupants ────────────────────────────────────────────────────────────────

    #[test]
    fn living_occupant_offers_examine_then_attack() {
        let mut vm = mk_vm();
        vm.occupants = vec![ent("mob-1", "Revenant", "occupant")];
        let h = &scene_hotspots(&vm)[0];
        assert_eq!(h.kind, HotspotKind::Occupant);
        assert_eq!(h.key, "mob-1");
        assert_eq!(h.label, "Revenant");
        assert_eq!(
            h.actions,
            vec![
                ActionDescriptor::Examine {
                    label: "Examine".into(),
                    target_id: "mob-1".into()
                },
                ActionDescriptor::Intent {
                    label: "Attack".into(),
                    intent: Intent::Attack {
                        target_id: "mob-1".into()
                    }
                },
            ]
        );
    }

    #[test]
    fn material_cache_offers_examine_then_harvest() {
        let mut vm = mk_vm();
        vm.caches = vec![ent("cache:vein", "Iron Vein", "cache")];
        let h = scene_hotspots(&vm)
            .into_iter()
            .find(|h| h.kind == HotspotKind::Cache)
            .expect("cache hotspot");
        assert_eq!(h.key, "cache:vein");
        assert_eq!(h.label, "Iron Vein");
        assert_eq!(
            h.actions,
            vec![
                ActionDescriptor::Examine {
                    label: "Examine".into(),
                    target_id: "cache:vein".into()
                },
                ActionDescriptor::Intent {
                    label: "Harvest".into(),
                    intent: Intent::Harvest {
                        target_id: "cache:vein".into()
                    }
                },
            ]
        );
    }

    #[test]
    fn defeated_occupant_offers_only_examine() {
        let mut vm = mk_vm();
        let mut mob = ent("mob-2", "Wraith", "occupant");
        mob.defeated = Some(true);
        vm.occupants = vec![mob];
        let h = &scene_hotspots(&vm)[0];
        assert_eq!(
            h.actions,
            vec![ActionDescriptor::Examine {
                label: "Examine".into(),
                target_id: "mob-2".into()
            }]
        );
    }

    #[test]
    fn talkable_npc_offers_examine_talk_attack_in_that_order() {
        let mut vm = mk_vm();
        let mut npc = ent("npc-1", "Caretaker", "occupant");
        npc.talkable = Some(true);
        vm.occupants = vec![npc];
        let h = &scene_hotspots(&vm)[0];
        assert_eq!(
            h.actions,
            vec![
                ActionDescriptor::Examine {
                    label: "Examine".into(),
                    target_id: "npc-1".into()
                },
                ActionDescriptor::Intent {
                    label: "Talk".into(),
                    intent: Intent::Talk {
                        npc_id: "npc-1".into(),
                        prompt: None
                    }
                },
                ActionDescriptor::Intent {
                    label: "Attack".into(),
                    intent: Intent::Attack {
                        target_id: "npc-1".into()
                    }
                },
            ]
        );
    }

    #[test]
    fn occupant_carries_image_when_present_else_none() {
        let mut vm = mk_vm();
        let mut ghost = ent("mob-3", "Ghost", "occupant");
        ghost.image = Some(serde_json::json!("ghost.png"));
        let shade = ent("mob-4", "Shade", "occupant");
        vm.occupants = vec![ghost, shade];
        let hotspots = scene_hotspots(&vm);
        assert_eq!(hotspots[0].image, Some(serde_json::json!("ghost.png")));
        assert_eq!(hotspots[1].image, None);
    }

    // ── Loot ─────────────────────────────────────────────────────────────────────

    #[test]
    fn loot_offers_examine_then_open() {
        let mut vm = mk_vm();
        vm.loot = vec![LootView {
            id: "chest-1".into(),
            description: "an old chest".into(),
            opened: false,
            contents: Vec::new(),
        }];
        let h = &scene_hotspots(&vm)[0];
        assert_eq!(h.kind, HotspotKind::Loot);
        assert_eq!(h.key, "chest-1");
        assert_eq!(h.label, "an old chest");
        assert_eq!(
            h.actions,
            vec![
                ActionDescriptor::Examine {
                    label: "Examine".into(),
                    target_id: "chest-1".into()
                },
                ActionDescriptor::Intent {
                    label: "Open".into(),
                    intent: Intent::Open {
                        target_id: "chest-1".into()
                    }
                },
            ]
        );
    }

    // ── Floor items ──────────────────────────────────────────────────────────────

    #[test]
    fn floor_item_not_in_inventory_or_loot_offers_examine_then_take() {
        let mut vm = mk_vm();
        let mut lantern = ent("lantern-1", "Brass Lantern", "item");
        lantern.image = Some(serde_json::json!("lantern.png"));
        vm.scope = vec![lantern];
        let h = &scene_hotspots(&vm)[0];
        assert_eq!(h.kind, HotspotKind::Item);
        assert_eq!(h.key, "lantern-1");
        assert_eq!(h.label, "Brass Lantern");
        assert_eq!(h.image, Some(serde_json::json!("lantern.png")));
        assert_eq!(
            h.actions,
            vec![
                ActionDescriptor::Examine {
                    label: "Examine".into(),
                    target_id: "lantern-1".into()
                },
                ActionDescriptor::Intent {
                    label: "Take".into(),
                    intent: Intent::Take {
                        target_id: "lantern-1".into()
                    }
                },
            ]
        );
    }

    #[test]
    fn inventory_items_and_keys_are_excluded_from_floor_hotspots() {
        let mut vm = mk_vm();
        let inv_item = ent("key-1", "Brass Key", "item");
        let key_item = ent("skel-key", "Skeleton Key", "item");
        vm.scope = vec![inv_item.clone(), key_item.clone()];
        vm.inventory = Inventory {
            items: vec![inv_item],
            keys: vec![key_item],
            equipped_names: Vec::new(),
            slots: 6,
        };
        let hotspots = scene_hotspots(&vm);
        assert!(hotspots.iter().all(|h| h.key != "key-1"));
        assert!(hotspots.iter().all(|h| h.key != "skel-key"));
    }

    #[test]
    fn closed_loot_contents_are_hidden_but_opened_contents_become_floor_items() {
        let content = ent("candle-1", "Candle", "item");
        // Closed container → the content is not a floor hotspot.
        let mut closed = mk_vm();
        closed.scope = vec![content.clone()];
        closed.loot = vec![LootView {
            id: "box-1".into(),
            description: "a box".into(),
            opened: false,
            contents: vec![content.clone()],
        }];
        assert!(scene_hotspots(&closed)
            .iter()
            .filter(|h| h.kind == HotspotKind::Item)
            .all(|h| h.key != "candle-1"));

        // Opened container → the content IS a floor hotspot.
        let mut opened = mk_vm();
        opened.scope = vec![content.clone()];
        opened.loot = vec![LootView {
            id: "box-1".into(),
            description: "a box".into(),
            opened: true,
            contents: vec![content],
        }];
        assert!(scene_hotspots(&opened)
            .iter()
            .filter(|h| h.kind == HotspotKind::Item)
            .any(|h| h.key == "candle-1"));
    }

    // ── inventory_actions ────────────────────────────────────────────────────────

    fn sword() -> ScopeEntity {
        let mut s = ent("sword-1", "Rusty Sword", "item");
        s.equippable = Some(true);
        s.usable = Some(true);
        s
    }

    #[test]
    fn damaged_destroyable_item_offers_repair_and_break_down() {
        let mut s = ent("blade-1", "Iron Blade", "item");
        s.destroyable = Some(true);
        s.damaged = Some(true);
        let labels = inventory_actions(&s, false)
            .into_iter()
            .map(|a| match a {
                ActionDescriptor::Examine { label, .. }
                | ActionDescriptor::Read { label, .. }
                | ActionDescriptor::Intent { label, .. } => label,
            })
            .collect::<Vec<_>>();
        assert_eq!(labels, vec!["Examine", "Repair", "Drop", "Break down"]);
    }

    #[test]
    fn an_undamaged_indestructible_item_offers_neither() {
        // A full-durability, non-destroyable item (e.g. a quest tablet): no Repair, no Break down.
        let mut s = ent("tablet", "Rite Tablet", "item");
        s.destroyable = Some(false);
        s.damaged = Some(false);
        let labels = inventory_actions(&s, false)
            .into_iter()
            .map(|a| match a {
                ActionDescriptor::Examine { label, .. }
                | ActionDescriptor::Read { label, .. }
                | ActionDescriptor::Intent { label, .. } => label,
            })
            .collect::<Vec<_>>();
        assert!(
            !labels.contains(&"Repair".to_string()) && !labels.contains(&"Break down".to_string()),
            "got {labels:?}"
        );
    }

    #[test]
    fn unequipped_equippable_usable_item_offers_examine_equip_use_drop() {
        assert_eq!(
            inventory_actions(&sword(), false),
            vec![
                ActionDescriptor::Examine {
                    label: "Examine".into(),
                    target_id: "sword-1".into()
                },
                ActionDescriptor::Intent {
                    label: "Equip".into(),
                    intent: Intent::Equip {
                        target_id: "sword-1".into()
                    }
                },
                ActionDescriptor::Intent {
                    label: "Use".into(),
                    intent: Intent::Use {
                        target_id: "sword-1".into()
                    }
                },
                ActionDescriptor::Intent {
                    label: "Drop".into(),
                    intent: Intent::Drop {
                        target_id: "sword-1".into()
                    }
                },
            ]
        );
    }

    /// Collect an item's action labels in order, for the ordering assertions below.
    fn labels(item: &ScopeEntity, equipped: bool) -> Vec<String> {
        inventory_actions(item, equipped)
            .iter()
            .map(|a| a.label().to_string())
            .collect()
    }

    #[test]
    fn equipped_item_swaps_equip_for_unequip() {
        assert_eq!(
            labels(&sword(), true),
            ["Examine", "Unequip", "Use", "Drop"]
        );
    }

    #[test]
    fn read_offered_after_examine_only_for_items_with_lore() {
        let mut journal = ent("j-1", "Journal", "item");
        journal.has_lore = Some(true);
        assert_eq!(labels(&journal, false)[1], "Read");
        assert!(!labels(&sword(), false).iter().any(|l| l == "Read"));
    }

    #[test]
    fn drop_omitted_for_non_droppable_quest_items() {
        let mut quest = ent("q-1", "Journal", "item");
        quest.has_lore = Some(true);
        quest.droppable = Some(false);
        assert!(!labels(&quest, false).iter().any(|l| l == "Drop"));
        assert!(labels(&sword(), false).iter().any(|l| l == "Drop"));
    }

    #[test]
    fn use_and_equip_omitted_for_a_plain_story_item() {
        let mut journal = ent("j-1", "Journal", "item");
        journal.has_lore = Some(true);
        assert_eq!(labels(&journal, false), ["Examine", "Read", "Drop"]);
    }

    // ── Mixed scene order ─────────────────────────────────────────────────────────

    #[test]
    fn emits_hotspots_in_order_exits_locked_occupants_loot_floor_items() {
        let mut vm = mk_vm();
        let occupant = ent("mob-1", "Zombie", "occupant");
        let floor_item = ent("bone-1", "Bone", "item");
        vm.exits = vec![ExitView {
            dir: Direction::North,
            to_name: "Hall".into(),
        }];
        vm.locked_doors = vec![LockedDoorView {
            name: "Rusted Door".into(),
            dir: Direction::South,
        }];
        vm.occupants = vec![occupant.clone()];
        vm.loot = vec![LootView {
            id: "crate-1".into(),
            description: "a crate".into(),
            opened: false,
            contents: Vec::new(),
        }];
        vm.scope = vec![occupant, floor_item];
        let kinds: Vec<HotspotKind> = scene_hotspots(&vm).into_iter().map(|h| h.kind).collect();
        assert_eq!(
            kinds,
            [
                HotspotKind::Exit,
                HotspotKind::Locked,
                HotspotKind::Occupant,
                HotspotKind::Loot,
                HotspotKind::Item
            ]
        );
    }
}
