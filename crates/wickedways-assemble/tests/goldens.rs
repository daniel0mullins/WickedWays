//! The differential conformance gate. THE AUTHORITY.
//!
//! Never edit a golden to make this pass. If Rust and the golden disagree, Rust is
//! wrong until proven otherwise, and the fix goes in the assembler.
//!
//! Only PRE-BEGIN goldens are valid oracles: `started: false`. The 31 `started: true`
//! snapshots encode `Authority::begin_campaign`'s work, not the assembler's.

use serde_json::Value;
use std::path::{Path, PathBuf};
use wickedways_assemble::{assemble, description::CampaignDescription, Seat};
use wickedways_core::world::descriptor::Catalog;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/fixtures")
}

fn read_json<T: serde::de::DeserializeOwned>(p: &Path) -> T {
    let s = std::fs::read_to_string(p).unwrap_or_else(|e| panic!("read {}: {e}", p.display()));
    serde_json::from_str(&s).unwrap_or_else(|e| panic!("parse {}: {e}", p.display()))
}

/// Normalize numbers to JS/JSON value semantics before comparison.
///
/// The goldens are `JSON.stringify` output, where there is a single number type:
/// `10.0` and `10` are the SAME value and stringify identically to `10`. But the
/// Rust core types `Stats`/`PartialStats` are `f64`, so `serde_json` emits whole
/// stats as `10.0`, and `serde_json`'s `Number` equality is *stricter* than JSON
/// value equality — it distinguishes the int/float representations (`10.0 != 10`).
/// That strictness is a bug relative to `canonicalize()`'s semantics, which this
/// gate exists to mirror. Collapsing whole-valued floats to integers on BOTH sides
/// makes the comparator faithful to JSON value equality. It is not a relaxation:
/// every genuinely different value still differs (array order, keys, non-whole
/// numbers, strings, presence/absence are all unchanged).
fn canon_numbers(v: &Value) -> Value {
    match v {
        Value::Number(n) => {
            if let Some(f) = n.as_f64() {
                if f.is_finite() && f.fract() == 0.0 && n.as_i64().is_none() && n.as_u64().is_none()
                {
                    // A float that is integer-valued: re-key it as an integer.
                    if f >= 0.0 && f <= u64::MAX as f64 {
                        return Value::Number((f as u64).into());
                    }
                    if f >= i64::MIN as f64 && f <= i64::MAX as f64 {
                        return Value::Number((f as i64).into());
                    }
                }
            }
            v.clone()
        }
        Value::Array(a) => Value::Array(a.iter().map(canon_numbers).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, x)| (k.clone(), canon_numbers(x)))
                .collect(),
        ),
        _ => v.clone(),
    }
}

/// Prints the first differing JSON pointer instead of dumping 200KB of diff.
fn assert_json_eq(got: &Value, want: &Value, fixture: &str) {
    let got = canon_numbers(got);
    let want = canon_numbers(want);
    if got == want {
        return;
    }
    let mut path = String::new();
    let (g, w) = first_diff(&got, &want, &mut path);
    panic!("byte-parity FAILED for {fixture}\n  at: {path}\n  rust: {g}\n  golden: {w}",);
}

fn first_diff(a: &Value, b: &Value, path: &mut String) -> (String, String) {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            for (k, xv) in x {
                match y.get(k) {
                    None => return (format!("<present: {xv}>"), "<absent>".into()),
                    Some(yv) if xv != yv => {
                        path.push('/');
                        path.push_str(k);
                        return first_diff(xv, yv, path);
                    }
                    _ => {}
                }
            }
            for k in y.keys() {
                if !x.contains_key(k) {
                    path.push('/');
                    path.push_str(k);
                    return ("<absent>".into(), format!("<present: {}>", y[k]));
                }
            }
            (a.to_string(), b.to_string())
        }
        (Value::Array(x), Value::Array(y)) => {
            if x.len() != y.len() {
                return (format!("<len {}>", x.len()), format!("<len {}>", y.len()));
            }
            for (i, (xv, yv)) in x.iter().zip(y).enumerate() {
                if xv != yv {
                    path.push_str(&format!("/{i}"));
                    return first_diff(xv, yv, path);
                }
            }
            (a.to_string(), b.to_string())
        }
        _ => (a.to_string(), b.to_string()),
    }
}

/// Assemble `<name>.description.json` + `<name>.catalog.json` with `party`,
/// and compare to `<golden>`.
fn gate(name: &str, golden: &str, catalog_name: Option<&str>, party: &[Seat]) {
    let dir = fixtures();
    let desc: CampaignDescription = read_json(&dir.join(format!("{name}.description.json")));
    let catalog: Catalog = catalog_name
        .map(|c| read_json::<Catalog>(&dir.join(format!("{c}.catalog.json"))))
        .unwrap_or_default();
    let want: Value = read_json(&dir.join(golden));
    let got = serde_json::to_value(assemble(&desc, &catalog, party).expect("assemble"))
        .expect("to_value");
    assert_json_eq(&got, &want, golden);
}

/// The single seat every facade fixture boots with: `player:Ada`, archetype
/// `delver`. Confirmed against all 14 goldens — each carries exactly one PC,
/// `player:Ada`, whose `archetypeId` is `delver` (the archetype's per-fixture
/// `baseStats` drive the PC's varying stats).
fn ada() -> Vec<Seat> {
    vec![Seat {
        name: "Ada".into(),
        archetype: Some("delver".into()),
    }]
}

/// Every pre-begin `*.genesis.json` facade golden carries exactly one PC,
/// `player:Ada` (archetype `delver`). This gates ALL FOURTEEN, proving
/// `seat_party` byte-parity across the interesting shapes: an empty start room
/// (`facade-loot` — codex is room-only), multiple co-located mobs
/// (`facade-ko-piling`), NPCs recorded as codex `mob` entries (`npc-dialogue`),
/// a mob in a NON-start room that is therefore NOT discovered (`scripted-scene`),
/// held-key NPCs (`caretaker`, `npc-foundation`), and an opted-in mechanic
/// (`facade-talk`).
#[test]
fn facade_genesis_goldens_single_pc() {
    for name in [
        "caretaker",
        "facade-afflicted-mob",
        "facade-free-vs-advancing",
        "facade-ko-piling",
        "facade-legality",
        "facade-lit-entry",
        "facade-loot",
        "facade-mob-combat",
        "facade-open-fail",
        "facade-talk",
        "facade-undo",
        "npc-dialogue",
        "npc-foundation",
        "scripted-scene",
    ] {
        gate(name, &format!("{name}.genesis.json"), Some(name), &ada());
    }
}

/// The ONLY pre-begin MULTI-PC oracle. Every other pre-begin golden is single-PC
/// (or player-less); `combat.start.snapshot.json` has two PCs but is `started: true`,
/// so `assemble()` cannot reproduce it. This gates `seat_party` at `party.len() == 2`
/// (party ordering, per-seat codex/`encountered`, GM = first seat) AND byte-checks
/// construct branches no other fixture exercises: a material cache
/// (`MaterialCacheSnapshot`), a room light (`room(..., { lights })`), a one-way exit,
/// and a two-way DIAGONAL exit (`reverse_direction` for `northeast`/`southwest`).
#[test]
fn two_pc_genesis_golden() {
    let party = vec![
        Seat {
            name: "Ada".into(),
            archetype: Some("delver".into()),
        },
        Seat {
            name: "Ben".into(),
            archetype: Some("delver".into()),
        },
    ];
    gate("two-pc", "two-pc.genesis.json", Some("two-pc"), &party);
}

/// The g2-vault author oracle: the canonical `Vault` campaign, seated with a single
/// PC that declares NO archetype (`Seat { archetype: None }` — the TOML author
/// surface has no archetype concept, so `player:Ada`'s `archetypeId` is `null` in
/// the genesis). Gates the assembler over a keyed door (`hasKey(actor, 'vault')`),
/// an authored key item placed inside a loot container (`shelf` holds `vault-key`),
/// and a `party[0].room.name == 'Vault'` victory.
#[test]
fn g2_vault_genesis_golden() {
    let party = vec![Seat {
        name: "Ada".into(),
        archetype: None,
    }];
    gate(
        "g2-vault",
        "g2-vault.genesis.json",
        Some("g2-vault"),
        &party,
    );
}

/// The g2-scene author oracle (scene bodies), seated with a single PC that declares
/// NO archetype (`Seat { archetype: None }` — the surface has no archetype concept,
/// so `player:Ada`'s `archetypeId` is `null` in the genesis). Gates the assembler over
/// a room-attached enter-scene: the `[[scenes]]` attachment reaches the genesis as a
/// pristine (pre-begin, `state: {}`) `scene:Threshold:scene/threshold-draft:enter`
/// entry, and its `BehaviorScript::Scene` (canPlay expr + onEnter statement body)
/// rides in the catalog untouched.
#[test]
fn g2_scene_genesis_golden() {
    let party = vec![Seat {
        name: "Ada".into(),
        archetype: None,
    }];
    gate(
        "g2-scene",
        "g2-scene.genesis.json",
        Some("g2-scene"),
        &party,
    );
}

/// The g2-item author oracle (item bodies), seated with a single PC that declares
/// NO archetype (`Seat { archetype: None }` — the surface has no archetype concept,
/// so `player:Ada`'s stats are the campaign defaults). Gates the assembler over a
/// declared-but-unplaced usable consumable: the `[[items]]` consumable descriptor
/// (`type:"consumable"`, `usable:true`, `stat:"sanity"`, `modifier:6`, author-data
/// `recipe:{healing:1}`) and its `BehaviorScript::Item` (an `onUse` statement body
/// emitting `adjustStat`) ride in the catalog untouched; the pre-begin genesis is a
/// single room + PC (the item is not reachable at genesis).
#[test]
fn g2_item_genesis_golden() {
    let party = vec![Seat {
        name: "Ada".into(),
        archetype: None,
    }];
    gate("g2-item", "g2-item.genesis.json", Some("g2-item"), &party);
}

/// The g2-npc author oracle (npc dialogue), seated with a single PC that declares
/// NO archetype (`Seat { archetype: None }` — the surface has no archetype concept,
/// so `player:Ada`'s stats are the campaign defaults). Gates the assembler over a placed
/// NPC holding a key: the `[[npcs]]` `NpcDef` (name/stats/room/behavior/holds) seats
/// `npc:Caretaker` in the Foyer, mints its held `npc:Caretaker:item#0` cellar key, and
/// records it as a codex `mob`; its `BehaviorScript::Npc` (description + a `default`
/// Exact-"" entry giving the key + hiding him, plus a Fuzzy dialogue entry) rides in
/// the catalog untouched.
#[test]
fn g2_npc_genesis_golden() {
    let party = vec![Seat {
        name: "Ada".into(),
        archetype: None,
    }];
    gate("g2-npc", "g2-npc.genesis.json", Some("g2-npc"), &party);
}

/// The g2-mechanic author oracle (mechanic scaffolding), seated with a single PC that
/// declares NO archetype (`Seat { archetype: None }` — the surface has no archetype
/// concept, so `player:Ada`'s stats are the campaign defaults). Gates the assembler over a
/// `[[mechanics]]` opt-in: the mechanic reaches the genesis as a pristine
/// `{ key: "dread", state: {} }` entry (`state` seeded from the behavior's `init`),
/// and its `BehaviorScript::Mechanic` (`init` + an `onTurnStart` guard/emit body, incl.
/// the negative-`-1` `adjustStat` delta) rides in the catalog untouched.
#[test]
fn g2_mechanic_genesis_golden() {
    let party = vec![Seat {
        name: "Ada".into(),
        archetype: None,
    }];
    gate(
        "g2-mechanic",
        "g2-mechanic.genesis.json",
        Some("g2-mechanic"),
        &party,
    );
}

/// The g2-archetype author oracle: the real hollow-house `Heir` archetype, with a
/// PC seated AS it — so the genesis PC carries the archetype id + its statline/immunities.
#[test]
fn g2_archetype_genesis_golden() {
    let party = vec![Seat {
        name: "Ada".into(),
        archetype: Some("heir".into()),
    }];
    gate(
        "g2-archetype",
        "g2-archetype.genesis.json",
        Some("g2-archetype"),
        &party,
    );
}

/// The g2-timeout author oracle: the real hollow-house timeout cue, authored as a
/// `timeoutNarration` string lowered to the `{ text }` shape.
#[test]
fn g2_timeout_genesis_golden() {
    let party = vec![Seat {
        name: "Ada".into(),
        archetype: None,
    }];
    gate(
        "g2-timeout",
        "g2-timeout.genesis.json",
        Some("g2-timeout"),
        &party,
    );
}

/// The g2-opts author oracle (campaign opts): the real hollow-house bounds (maxRounds
/// 150, baseEncounterChance 20) via the `[opts]` table.
#[test]
fn g2_opts_genesis_golden() {
    let party = vec![Seat {
        name: "Ada".into(),
        archetype: None,
    }];
    gate("g2-opts", "g2-opts.genesis.json", Some("g2-opts"), &party);
}

/// The g2-formations author oracle: the real roving rats — the `rat-single`/
/// `rat-pair` weighted opt-ins (description) + their `MobSpec` rosters (catalog).
#[test]
fn g2_formations_genesis_golden() {
    let party = vec![Seat {
        name: "Ada".into(),
        archetype: None,
    }];
    gate(
        "g2-formations",
        "g2-formations.genesis.json",
        Some("g2-formations"),
        &party,
    );
}

/// The g2-exit-state author oracle (exit name + `initialState`): a keyed door
/// carrying a display name + `{ unlocked: false }` initial state, atop the real
/// doorScript behavior.
#[test]
fn g2_exit_state_genesis_golden() {
    let party = vec![Seat {
        name: "Ada".into(),
        archetype: None,
    }];
    gate(
        "g2-exit-state",
        "g2-exit-state.genesis.json",
        Some("g2-exit-state"),
        &party,
    );
}

/// The g2-dark-rooms author oracle (room `dark` + `spawnModifier`): a lightless
/// Cellar + a biased-encounter Hall, proving those RoomDef sub-fields reach the
/// genesis.
#[test]
fn g2_dark_rooms_genesis_golden() {
    let party = vec![Seat {
        name: "Ada".into(),
        archetype: None,
    }];
    gate(
        "g2-dark-rooms",
        "g2-dark-rooms.genesis.json",
        Some("g2-dark-rooms"),
        &party,
    );
}

/// The g2-mobs author oracle (placed mobs): the two real hollow-house mobs (Wraith,
/// Revenant) with stats/room/drops/naturalAttack, in connected rooms.
#[test]
fn g2_mobs_genesis_golden() {
    let party = vec![Seat {
        name: "Ada".into(),
        archetype: None,
    }];
    gate("g2-mobs", "g2-mobs.genesis.json", Some("g2-mobs"), &party);
}

/// The g2-equipment author oracle (full item descriptor): three real hollow-house
/// items (lantern/poker/journal) exercising slot/emitsLight/maxDurability/lore/
/// equippable/droppable, seated in a Hall loot container.
#[test]
fn g2_equipment_genesis_golden() {
    let party = vec![Seat {
        name: "Ada".into(),
        archetype: None,
    }];
    gate(
        "g2-equipment",
        "g2-equipment.genesis.json",
        Some("g2-equipment"),
        &party,
    );
}

/// The g2-door author oracle (exit `runScript` + `pass`): a keyed door whose
/// narration `runScript` (a `when` latching `unlocked` + a `pass`) rides in the
/// catalog, seated with a single no-archetype PC.
#[test]
fn g2_door_genesis_golden() {
    let party = vec![Seat {
        name: "Ada".into(),
        archetype: None,
    }];
    gate("g2-door", "g2-door.genesis.json", Some("g2-door"), &party);
}

/// The g2-storyteller author oracle: the real hollow-house `storyteller`
/// mechanic over a 1-entry lore map. Its genesis carries the mechanic state seeded
/// from `init` (`{ seen: {} }`); the `onAction` guard chain (action subject, mapLit,
/// has, lookup, stateGetIn, setStateIn) rides in the catalog.
#[test]
fn g2_storyteller_genesis_golden() {
    let party = vec![Seat {
        name: "Ada".into(),
        archetype: None,
    }];
    gate(
        "g2-storyteller",
        "g2-storyteller.genesis.json",
        Some("g2-storyteller"),
        &party,
    );
}

/// The g2-status-bar author oracle: the real hollow-house `status-bar`
/// mechanic. Genesis carries the `{}`-seeded mechanic state; the onRoundStart/
/// onTurnEnd bodies (str/concat/length/first + the Status effect) ride in the catalog.
#[test]
fn g2_status_bar_genesis_golden() {
    let party = vec![Seat {
        name: "Ada".into(),
        archetype: None,
    }];
    gate(
        "g2-status-bar",
        "g2-status-bar.genesis.json",
        Some("g2-status-bar"),
        &party,
    );
}

/// The g2-victory author oracle (victory quantifiers): the three real hollow-house
/// win/lose conditions (reached-attic-with-journal / sanity-zero / party-down). Their keys +
/// narration reach the genesis win/lose lists; each `test` predicate (some/every/
/// includes/element/first/length) rides in the catalog as a `BehaviorScript::Victory`.
#[test]
fn g2_victory_genesis_golden() {
    let party = vec![Seat {
        name: "Ada".into(),
        archetype: None,
    }];
    gate(
        "g2-victory",
        "g2-victory.genesis.json",
        Some("g2-victory"),
        &party,
    );
}

/// The g2-effects author oracle: a bespoke `hex` mechanic emitting
/// `damage`/`heal`/`grantImmunity` behind a `defined(...)` guard. Genesis carries
/// the `{}`-seeded mechanic state; the onTurnStart body rides in the catalog.
#[test]
fn g2_effects_genesis_golden() {
    let party = vec![Seat {
        name: "Ada".into(),
        archetype: None,
    }];
    gate(
        "g2-effects",
        "g2-effects.genesis.json",
        Some("g2-effects"),
        &party,
    );
}

/// The g2-mechanic-actions author oracle (`modifyDamage` + custom actions), seated
/// with a single PC that declares NO archetype (`Seat { archetype: None }`). Gates the assembler over
/// the same `[[mechanics]]` opt-in as `g2-mechanic` — the mechanic still reaches the
/// genesis as a pristine `{ key: "dread", state: {} }` entry — while its richer
/// `BehaviorScript::Mechanic` (now carrying a `modifyDamage` transform and a `brace`
/// custom action alongside the hook) rides in the catalog untouched.
#[test]
fn g2_mechanic_actions_genesis_golden() {
    let party = vec![Seat {
        name: "Ada".into(),
        archetype: None,
    }];
    gate(
        "g2-mechanic-actions",
        "g2-mechanic-actions.genesis.json",
        Some("g2-mechanic-actions"),
        &party,
    );
}

#[test]
fn hollow_house_pristine() {
    gate(
        "hollow-house",
        "hollow-house.snapshot.json",
        Some("hollow-house"),
        &[],
    );
}

/// The **playable** genesis the web-client launcher bundles: the pristine campaign seated with one
/// Heir PC (who becomes the GM), so single-player boot can `BeginCampaign`. Same `assemble` path as
/// the pristine snapshot above, just with a party — this gates that the committed genesis stays a
/// faithful assembly.
#[test]
fn hollow_house_playable_genesis() {
    gate(
        "hollow-house",
        "hollow-house.genesis.json",
        Some("hollow-house"),
        &[Seat {
            name: "Heir".into(),
            archetype: Some("heir".into()),
        }],
    );
}

/// The **multiplayer** Covenant genesis the room server seeds: the campaign seated with only the GM
/// host (`Keeper`), so players self-join their own Wardens at runtime (`JoinCampaign`). Gates
/// `seat_party` at a single archetype'd GM seat, and holds the co-op `twin-wards-held` win condition
/// (a `some(party, element.room.name == 'North Ward') && some(party, ... 'South Ward')` scripted
/// victory) faithful to its authored, committed catalog. The self-join + win path is driven in
/// `covenant_playable.rs`.
#[test]
fn covenant_playable_genesis() {
    let party = vec![Seat {
        name: "Keeper".into(),
        archetype: Some("warden".into()),
    }];
    gate(
        "covenant",
        "covenant.genesis.json",
        Some("covenant"),
        &party,
    );
}

#[test]
fn seed_pristine() {
    gate("seed", "seed.snapshot.json", Some("seed"), &[]);
}

/// Byte-parity depends on stable iteration order. A stray `HashMap` reaching
/// serialization would make this flap.
#[test]
fn assembly_is_deterministic() {
    let dir = fixtures();
    let desc: CampaignDescription = read_json(&dir.join("hollow-house.description.json"));
    let catalog: Catalog = read_json(&dir.join("hollow-house.catalog.json"));
    let a = serde_json::to_value(assemble(&desc, &catalog, &[]).expect("a")).expect("va");
    let b = serde_json::to_value(assemble(&desc, &catalog, &[]).expect("b")).expect("vb");
    assert_eq!(a, b, "assemble() is not deterministic");
}
