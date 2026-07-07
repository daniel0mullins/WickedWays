//! Native happy-path smoke test of the Authority handle. Error paths return
//! Result<_, JsValue> and are only exercised in the wasm/conformance harness
//! (JsValue cannot be materialized off-wasm).
use wickedways_wasm::Authority;

/// Minimal PRE-begin genesis (started:false, round 0) — the mod.rs sample world
/// (crates/wickedways-core/src/world/mod.rs:142-156) with started set false.
fn genesis() -> &'static str {
    r#"{ "schemaVersion":6, "campaign":{ "id":"camp1","title":"HH","maxRounds":20,"round":0,
    "started":false,"outcome":"ongoing","winConditions":[],"loseConditions":[],
    "activeCharacterIndex":0,"partyIds":["c1"],"actedThisRound":[],"gmId":null,"materials":{},
    "claims":[],"encountered":[],"knownRecipes":[],"archetypes":[],"actionSounds":{},
    "encounterTable":{"baseChance":0,"visited":[],"formations":[]},"chatPolicy":{},"avPolicy":{},
    "mechanics":[]}, "rooms":[{"id":"r1","name":"F","description":"d","exits":{},"dark":false,
    "spawnModifier":0,"occupantIds":["c1"],"lootIds":[],"materialCacheIds":[],"lightSourceIds":[],
    "scenes":[]}], "exits":[], "characters":[{"kind":"player","id":"c1","name":"H",
    "stats":{"energy":5,"sanity":7,"health":10},"actionsPerRound":2,"actionsThisRound":0,
    "currentRoomId":"r1","inventory":{"slots":6,"itemIds":[],"keyIds":[]},"equipment":{},
    "history":[],"archetypeImmunities":[],"afflictions":{"active":{},"turnsActive":{},
    "shakenOff":[],"immunity":{}}}], "items":[],"loot":[],"materialCaches":[],"codex":[] }"#
}

const CATALOG: &str = r#"{ "items": {}, "aliases": {} }"#;

#[test]
fn boot_submit_snapshot_restore_roundtrip() {
    let mut auth = Authority::new(genesis(), CATALOG, 0x7e57).expect("boot");
    // core-begins: started flipped, no mechanics → empty startup cues
    let startup = auth.take_startup_cues().expect("startup");
    assert_eq!(startup, "[]");
    assert!(!auth.finished());
    assert_eq!(auth.outcome(), "ongoing");

    // wait advances the single-member party → round 1
    let out = auth.submit(r#"{ "kind": "wait" }"#).expect("submit");
    let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["mobAttacks"], serde_json::json!([]));
    assert!(parsed.get("error").is_none());

    let snap_at_1 = auth.snapshot().expect("snapshot");
    let v: serde_json::Value = serde_json::from_str(&snap_at_1).unwrap();
    assert_eq!(v["campaign"]["round"], serde_json::json!(1));
    assert_eq!(v["campaign"]["started"], serde_json::json!(true));

    // restore rehydrates in place
    auth.submit(r#"{ "kind": "wait" }"#).expect("submit 2"); // round 2
    auth.restore(&snap_at_1).expect("restore");
    let back: serde_json::Value =
        serde_json::from_str(&auth.snapshot().expect("snapshot 2")).unwrap();
    assert_eq!(back["campaign"]["round"], serde_json::json!(1));

    // view is the full widened shape
    let vm: serde_json::Value = serde_json::from_str(&auth.view().expect("view")).unwrap();
    assert_eq!(vm["room"]["name"], serde_json::json!("F"));
    assert!(vm["status"]["locationName"].is_string());
    assert!(vm["exits"].is_array());

    // read of an unheld id: quiet no-op
    assert_eq!(auth.read("nope").expect("read"), "[]");
}

#[test]
fn talk_returns_error_result_not_a_throw() {
    let mut auth = Authority::new(genesis(), CATALOG, 1).expect("boot");
    let out = auth.submit(r#"{ "kind": "talk", "npcId": "n1" }"#).expect("submit");
    let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["error"], serde_json::json!("There's no one here to talk to."));
    assert!(parsed.get("mobAttacks").is_none());
}
