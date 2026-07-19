//! `actor_of` for a `joinCampaign` command (Phase 2c, sub-project C — slice 1).
//!
//! A join command carries a full `CharacterSnapshot`, which is impractical to hand-write, so this
//! borrows a real character from the committed `sync-move` genesis fixture and asserts the derived
//! seat is `join` on that character's id. (The turn/setup/GM branches of `actor_of` are unit-tested
//! in `src/membership.rs`.)

use std::path::Path;

use wickedways_core::sync::Command;
use wickedways_core::CampaignSnapshot;
use wickedways_server::membership::actor_of;
use wickedways_server::transport::Actor;

#[test]
fn actor_of_join_is_a_self_claim_on_the_joining_character() {
    let p = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../conformance/fixtures/sync-move.genesis.json");
    let snapshot: CampaignSnapshot =
        serde_json::from_str(&std::fs::read_to_string(&p).expect("read genesis")).expect("parse");

    let character = snapshot.characters.into_iter().next().expect("genesis has a character");
    let character_id = character.id.0.clone();
    let join = Command::JoinCampaign { character: Box::new(character) };

    assert_eq!(actor_of(&join), Actor::Join { character_id });
}
