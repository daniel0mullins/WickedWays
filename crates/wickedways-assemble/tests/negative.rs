//! One test per `Problem` variant. The gate proves parity on campaigns that WORK;
//! these prove the validation paths.

use serde_json::json;
use wickedways_assemble::{assemble, description::CampaignDescription, error::Problem};
use wickedways_core::world::descriptor::Catalog;

fn desc_from(v: serde_json::Value) -> CampaignDescription {
    serde_json::from_value(v).expect("test description must parse")
}

fn base() -> serde_json::Value {
    json!({
        "title": "T", "opts": {},
        "archetypes": [], "rooms": [{ "name": "start", "description": "entry" }],
        "startRoom": "start",
        "exits": [], "mobs": [], "loot": [], "caches": [], "npcs": [],
        "formations": [], "scenes": [], "recipes": [], "materials": [],
        "winConditions": [], "loseConditions": [], "mechanics": []
    })
}

fn problems(v: serde_json::Value) -> Vec<Problem> {
    match assemble(&desc_from(v), &Catalog::default(), &[]) {
        Err(e) => e.problems,
        Ok(_) => vec![],
    }
}

#[test]
fn duplicate_room_name() {
    let mut v = base();
    v["rooms"] = json!([
        { "name": "start", "description": "a" },
        { "name": "start", "description": "b" }
    ]);
    let ps = problems(v);
    assert!(ps
        .iter()
        .any(|p| matches!(p, Problem::DuplicateName { kind: "room", name } if name == "start")));
}

#[test]
fn undefined_start_room() {
    let mut v = base();
    v["startRoom"] = json!("ghost");
    let ps = problems(v);
    assert!(ps.iter().any(|p| matches!(p, Problem::UndefinedRoom { ctx, room } if ctx == "startRoom" && room == "ghost")));
}

#[test]
fn exit_references_undefined_room() {
    let mut v = base();
    v["exits"] = json!([{ "from": "start", "direction": "north", "to": "nowhere" }]);
    let ps = problems(v);
    assert!(ps
        .iter()
        .any(|p| matches!(p, Problem::UndefinedRoom { room, .. } if room == "nowhere")));
}

/// ALL validation problems are collected into one error: three simultaneous
/// faults must all appear. Fail-fast would return only one.
#[test]
fn collects_all_problems_not_just_the_first() {
    let mut v = base();
    v["rooms"] = json!([
        { "name": "start", "description": "a" },
        { "name": "start", "description": "b" }
    ]);
    v["startRoom"] = json!("ghost");
    v["exits"] = json!([{ "from": "start", "direction": "north", "to": "nowhere" }]);
    assert!(
        problems(v).len() >= 3,
        "expected >= 3 problems, got fewer (fail-fast bug)"
    );
}

#[test]
fn unregistered_item_key_on_loot() {
    let mut v = base();
    v["loot"] = json!([{ "name": "chest", "room": "start", "items": ["missing-item"] }]);
    let ps = problems(v);
    assert!(ps
        .iter()
        .any(|p| matches!(p, Problem::UnregisteredItem { key, .. } if key == "missing-item")));
}

#[test]
fn unregistered_npc_behavior_key() {
    let mut v = base();
    v["npcs"] = json!([{ "name": "Keeper", "stats": { "health": 1.0, "sanity": 1.0, "energy": 1.0 },
                         "room": "start", "behavior": "missing" }]);
    let ps = problems(v);
    assert!(ps
        .iter()
        .any(|p| matches!(p, Problem::UnregisteredNpc { key, .. } if key == "missing")));
}

#[test]
fn npc_references_undefined_room() {
    let mut v = base();
    v["npcs"] = json!([{ "name": "Keeper", "stats": { "health": 1.0, "sanity": 1.0, "energy": 1.0 },
                         "room": "nowhere", "behavior": "sage" }]);
    let ps = problems(v);
    assert!(ps
        .iter()
        .any(|p| matches!(p, Problem::UndefinedRoom { room, .. } if room == "nowhere")));
}

#[test]
fn unregistered_scene_key() {
    let mut v = base();
    v["scenes"] = json!([{ "room": "start", "key": "missing" }]);
    let ps = problems(v);
    assert!(ps
        .iter()
        .any(|p| matches!(p, Problem::UnregisteredScene { key } if key == "missing")));
}

#[test]
fn unregistered_formation_key() {
    let mut v = base();
    v["formations"] = json!([{ "key": "missing" }]);
    let ps = problems(v);
    assert!(ps
        .iter()
        .any(|p| matches!(p, Problem::UnregisteredFormation { key } if key == "missing")));
}

#[test]
fn unregistered_exit_behavior_key() {
    let mut v = base();
    v["rooms"] =
        json!([{ "name": "start", "description": "a" }, { "name": "next", "description": "b" }]);
    v["exits"] =
        json!([{ "from": "start", "direction": "north", "to": "next", "behaviorKey": "missing" }]);
    let ps = problems(v);
    assert!(ps
        .iter()
        .any(|p| matches!(p, Problem::UnregisteredExit { key, .. } if key == "missing")));
}

#[test]
fn duplicate_and_unregistered_mechanics() {
    let mut v = base();
    v["mechanics"] = json!([{ "key": "doom" }, { "key": "doom" }]);
    let ps = problems(v);
    assert!(ps
        .iter()
        .any(|p| matches!(p, Problem::DuplicateMechanic { key } if key == "doom")));
    assert!(ps
        .iter()
        .any(|p| matches!(p, Problem::UnregisteredMechanic { key } if key == "doom")));
}

/// Conditions live in the catalog under `family: "victory"` (verified against the
/// hollow-house keys reached-attic-with-journal / sanity-zero / party-down).
#[test]
fn unregistered_condition_keys() {
    let mut v = base();
    v["winConditions"] = json!([{ "key": "missing-win" }]);
    v["loseConditions"] = json!([{ "key": "missing-lose" }]);
    let ps = problems(v);
    assert!(ps.iter().any(|p| matches!(p, Problem::UnregisteredCondition { ctx, key } if ctx == "winWhen" && key == "missing-win")));
    assert!(ps.iter().any(|p| matches!(p, Problem::UnregisteredCondition { ctx, key } if ctx == "loseWhen" && key == "missing-lose")));
}

// NOTE: there is no `unregistered_recipe_key` test — recipe-key validation is
// deliberately absent (see the DELIBERATE DIVERGENCE note in validate.rs).

#[test]
fn chat_backfill_window_below_one() {
    let mut v = base();
    v["chat"] = json!({ "enabled": true, "whisper": true, "edit": true, "reactions": true,
                        "readReceipts": true, "typing": true, "backfillWindow": 0 });
    let ps = problems(v);
    assert!(ps
        .iter()
        .any(|p| matches!(p, Problem::ChatBackfillWindow { got: 0 })));
}

#[test]
fn av_max_participants_below_one() {
    let mut v = base();
    v["av"] = json!({ "enabled": true, "video": true, "maxParticipants": 0 });
    let ps = problems(v);
    assert!(ps
        .iter()
        .any(|p| matches!(p, Problem::AvMaxParticipants { got: 0 })));
}

#[test]
fn villain_referencing_undeclared_character() {
    let mut v = base();
    v["villain"] = json!({ "character": "Nobody", "deck": [] });
    let ps = problems(v);
    assert!(ps.iter().any(
        |p| matches!(p, Problem::UndefinedVillainCharacter { character } if character == "Nobody")
    ));
}

#[test]
fn villain_deck_with_unregistered_card() {
    let mut v = base();
    v["mobs"] = json!([{
        "name": "Warden",
        "stats": { "health": 8.0, "sanity": 6.0, "energy": 6.0 },
        "room": "start"
    }]);
    v["villain"] = json!({
        "character": "Warden",
        "deck": ["wicked:lights-out", "no-such-card"]
    });
    let ps = problems(v);
    // Native keys pass; the unknown key is the only complaint.
    assert!(!ps
        .iter()
        .any(|p| matches!(p, Problem::UnregisteredCard { key } if key == "wicked:lights-out")));
    assert!(ps
        .iter()
        .any(|p| matches!(p, Problem::UnregisteredCard { key } if key == "no-such-card")));
}

#[test]
fn gm_villain_sentinel_is_always_a_legal_character() {
    let mut v = base();
    v["villain"] = json!({ "character": "@gm", "deck": ["wicked:ruin"] });
    let ps = problems(v);
    assert!(!ps
        .iter()
        .any(|p| matches!(p, Problem::UndefinedVillainCharacter { .. })));
}

/// The "@gm" sentinel resolves to the seated GM; a pristine (unseated) genesis
/// carries no villain, exactly as it carries no GM.
#[test]
fn gm_villain_resolves_at_seating() {
    use wickedways_assemble::Seat;
    let mut v = base();
    v["villain"] = json!({ "character": "@gm", "deck": ["wicked:ruin"] });
    let desc = desc_from(v);
    let pristine = assemble(&desc, &Catalog::default(), &[]).expect("assembles");
    assert!(pristine.campaign.villain.is_none(), "unseated: no villain");
    let seated = assemble(
        &desc,
        &Catalog::default(),
        &[Seat {
            name: "Ada".into(),
            archetype: None,
        }],
    )
    .expect("assembles");
    let villain = seated.campaign.villain.expect("seated villain");
    assert_eq!(villain.character_id.0, "player:Ada");
    assert_eq!(villain.deck, vec!["wicked:ruin".to_string()]);
    assert!(villain.hand.is_empty(), "the hand deals at begin_campaign");
}

/// The modding trust boundary: malformed author data must never panic.
#[test]
fn never_panics_on_hostile_input() {
    let v = json!({ "title": "T", "opts": {},
        "rooms": [{ "name": "start", "description": "a" }],
        "startRoom": "nope",
        "exits": [{ "from": "x", "direction": "sideways", "to": "y" }],
        "mobs": [], "loot": [], "caches": [], "npcs": [], "archetypes": [],
        "formations": [], "scenes": [], "recipes": [], "materials": [],
        "winConditions": [], "loseConditions": [], "mechanics": [] });
    let _ = assemble(&desc_from(v), &Catalog::default(), &[]); // must return Err, not panic
}
