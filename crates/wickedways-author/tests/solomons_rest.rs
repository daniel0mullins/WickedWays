//! Playability smoke test for the shipped Solomon's Rest campaign — NOT a
//! golden gate (the campaign is not part of the conformance corpus; nothing
//! here pins bytes). It proves the TOML compiles, assembles, seats a full
//! multiplayer table (the GM's Sexton — the "@gm" Villain — plus the four
//! teens), generates a connected map at `begin_campaign`, marches the night
//! clock to daybreak, and enforces the Sexton's lone-prey compact.

use wickedways_assemble::{assemble, Seat};
use wickedways_author::compile;
use wickedways_core::stats::StatType;
use wickedways_core::world::ids::{CharacterId, RoomId};
use wickedways_core::world::World;

fn build_world(seed: u32) -> (World, wickedways_core::world::descriptor::Catalog) {
    let src = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../campaigns/solomons-rest.toml"
    ))
    .expect("read solomons-rest.toml");
    let compiled = compile(&src).expect("campaign compiles");
    // The GM hosts as the Sexton (first seat = GM; the "@gm" villain resolves
    // to him); the teens fill the table the way lobby joiners would.
    let seats = [
        Seat {
            name: "The Sexton".into(),
            archetype: Some("sexton".into()),
        },
        Seat {
            name: "Alex".into(),
            archetype: Some("quiet-one".into()),
        },
        Seat {
            name: "Priya".into(),
            archetype: Some("valedictorian".into()),
        },
        Seat {
            name: "Brock".into(),
            archetype: Some("quarterback".into()),
        },
        Seat {
            name: "Tiffany".into(),
            archetype: Some("cheer-captain".into()),
        },
    ];
    let genesis = assemble(&compiled.description, &compiled.catalog, &seats).expect("assembles");
    let mut world = World::from_snapshot(genesis);
    world.seed_rng(seed);
    world
        .validate_mechanics(&compiled.catalog)
        .expect("mechanics/behaviors all resolve");
    (world, compiled.catalog)
}

/// BFS over exits from the start room.
fn reachable_rooms(w: &World, from: &RoomId) -> usize {
    let mut seen = std::collections::BTreeSet::new();
    let mut queue = vec![from.clone()];
    while let Some(r) = queue.pop() {
        if !seen.insert(r.clone()) {
            continue;
        }
        if let Some(room) = w.rooms.get(&r) {
            for exit_id in room.exits.values() {
                if let Some(e) = w.exits.get(exit_id) {
                    for ep in &e.endpoint_ids {
                        if !seen.contains(ep) {
                            queue.push(ep.clone());
                        }
                    }
                }
            }
        }
    }
    seen.len()
}

#[test]
fn begin_generates_a_connected_map_with_sealed_crypts() {
    for seed in [1u32, 2, 3, 42] {
        let (mut w, cat) = build_world(seed);
        assert!(w.exits.is_empty(), "genesis carries no exits (mapGen)");
        let mut cues = Vec::new();
        w.begin_campaign(&cat, &mut cues).expect("begin");
        assert!(!w.exits.is_empty(), "begin wired the map");
        let start = RoomId("room:Lychgate".into());
        assert_eq!(
            reachable_rooms(&w, &start),
            w.rooms.len(),
            "seed {seed}: every room reachable from the Lychgate"
        );
        // The two crypts stay sealed behind their single keyed door.
        for (room, door) in [
            ("room:Undercroft", "undercroft-door"),
            ("room:Founders Mausoleum", "founders-door"),
        ] {
            let r = w.rooms.get(&RoomId(room.into())).expect("crypt exists");
            assert_eq!(r.exits.len(), 1, "seed {seed}: {room} has one way in");
            let e = w
                .exits
                .get(r.exits.values().next().expect("one exit"))
                .expect("exit");
            assert_eq!(e.behavior_key.as_deref(), Some(door), "seed {seed}");
            assert_eq!(e.state, serde_json::json!({ "unlocked": false }));
        }
    }
}

#[test]
fn different_seeds_lay_out_different_cemeteries() {
    let map_shape = |seed: u32| {
        let (mut w, cat) = build_world(seed);
        let mut cues = Vec::new();
        w.begin_campaign(&cat, &mut cues).expect("begin");
        w.rooms
            .values()
            .map(|r| (r.id.0.clone(), r.exits.clone()))
            .collect::<Vec<_>>()
    };
    assert_eq!(map_shape(7), map_shape(7), "same seed, same map");
    assert_ne!(map_shape(7), map_shape(8), "different seed, different map");
}

#[test]
fn the_night_clock_reaches_daybreak_and_any_survivor_wins() {
    let (mut w, cat) = build_world(5);
    let mut cues = Vec::new();
    w.begin_campaign(&cat, &mut cues).expect("begin");
    // Drive whole rounds: each next_player marks the active seat acted; the
    // fourth rolls the round over (firing the night clock's onRoundEnd).
    for _ in 0..40 {
        if w.campaign.outcome != wickedways_core::presentation::CampaignOutcome::Ongoing {
            break;
        }
        for _ in 0..w.campaign.party_ids.len() {
            w.next_player(&cat, &mut cues).expect("advance");
            if w.campaign.outcome != wickedways_core::presentation::CampaignOutcome::Ongoing {
                break;
            }
        }
    }
    // 3 rounds/hour * 8 hours = 24 rounds to daybreak; nobody attacked the
    // party, so someone is still conscious and the win condition fires.
    assert_eq!(
        w.campaign.outcome,
        wickedways_core::presentation::CampaignOutcome::Won,
        "outcome: {:?} (reason {:?}) at round {}",
        w.campaign.outcome,
        w.campaign.outcome_reason,
        w.campaign.round
    );
    assert_eq!(
        w.campaign.outcome_reason.as_deref(),
        Some("survived-to-daybreak")
    );
    assert_eq!(w.campaign.world_state["daybreak"], serde_json::json!(true));
}

#[test]
fn the_sexton_harms_only_the_sundered() {
    let (mut w, cat) = build_world(9);
    let mut cues = Vec::new();
    w.begin_campaign(&cat, &mut cues).expect("begin");
    let sexton = CharacterId("player:The Sexton".into());
    assert_eq!(
        w.campaign.villain.as_ref().map(|v| v.character_id.clone()),
        Some(sexton.clone()),
        "the '@gm' villain resolved to the GM's seat"
    );
    let alex = CharacterId("player:Alex".into());
    let priya = CharacterId("player:Priya".into());

    // The night has worn Alex down: a Sanity mitigator at or above the cap
    // would absorb ANY health damage (the stat cycle), so drop it first —
    // exactly what the clock drain, the hounds, and Cold Hands do in play.
    if let Some(c) = w.characters.get_mut(&alex) {
        c.stats.sanity = 4.0;
    }

    // Together in the Lychgate: the compact stays his hand — zero damage.
    let before = w.characters[&alex].stats.health;
    w.take_damage_from(
        &alex,
        Some(&sexton),
        10.0,
        StatType::Health,
        &cat,
        &mut cues,
    )
    .expect("witnessed blow");
    assert_eq!(
        w.characters[&alex].stats.health, before,
        "a witnessed hero takes nothing from the Sexton"
    );

    // Move every teen but Alex away (via the villain-privileged teleport
    // seam). The Sexton himself still stands with Alex — and a villain can
    // never witness for his own prey — so the sundered take his full strength.
    let far = RoomId("room:Bone Hollow".into());
    for other in [
        priya.clone(),
        CharacterId("player:Brock".into()),
        CharacterId("player:Tiffany".into()),
    ] {
        w.apply_card_effect(
            wickedways_core::world::villain::CardEffect::Teleport {
                target: other,
                room: far.clone(),
            },
            &cat,
            &mut cues,
        )
        .expect("teleport");
    }
    let before = w.characters[&alex].stats.health;
    w.take_damage_from(
        &alex,
        Some(&sexton),
        10.0,
        StatType::Health,
        &cat,
        &mut cues,
    )
    .expect("sundered blow");
    assert!(
        w.characters[&alex].stats.health < before,
        "an isolated hero takes real damage from the Sexton"
    );

    // And the Sexton himself cannot be harmed by anything the living carry.
    let before = w.characters[&sexton].stats.health;
    w.take_damage_from(
        &sexton,
        Some(&alex),
        10.0,
        StatType::Health,
        &cat,
        &mut cues,
    )
    .expect("futile blow");
    assert_eq!(
        w.characters[&sexton].stats.health, before,
        "the Sexton shrugs off mortal weapons"
    );
}

#[test]
fn grave_wards_gate_the_wight_behind_fire() {
    let (mut w, cat) = build_world(11);
    let mut cues = Vec::new();
    w.begin_campaign(&cat, &mut cues).expect("begin");
    let wight = CharacterId("mob:Wight of the Founder".into());
    let alex = CharacterId("player:Alex".into());

    // Bare-handed: the ward zeroes the blow.
    let before = w.characters[&wight].stats.health;
    w.take_damage_from(&wight, Some(&alex), 6.0, StatType::Health, &cat, &mut cues)
        .expect("unwarded blow");
    assert_eq!(
        w.characters[&wight].stats.health, before,
        "steel passes through the wight"
    );

    // Hand Alex a lit torch (equipped): fire bites.
    use wickedways_core::world::ids::ItemId;
    use wickedways_core::world::snapshot::ItemSnapshot;
    let torch = ItemId("test:torch".into());
    w.items.insert(
        torch.clone(),
        ItemSnapshot::Item {
            id: torch.clone(),
            behavior_key: "torch".into(),
            durability: Some(14),
            modifier: 2,
        },
    );
    if let Some(c) = w.characters.get_mut(&alex) {
        c.equipment.insert("hand-main".into(), torch.clone());
    }
    let before = w.characters[&wight].stats.health;
    w.take_damage_from(&wight, Some(&alex), 6.0, StatType::Health, &cat, &mut cues)
        .expect("torch blow");
    assert!(
        w.characters[&wight].stats.health < before,
        "fire harms the wight"
    );
}
