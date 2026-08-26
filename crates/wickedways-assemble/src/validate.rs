//! The validate-all pass: collects EVERY problem; never short-circuits. All
//! existence checks are catalog lookups.

use std::collections::BTreeSet;

use wickedways_core::world::descriptor::Catalog;

use crate::description::CampaignDescription;
use crate::error::Problem;

// A note on the closure style throughout this pass: each helper closure takes
// `problems: &mut Vec<Problem>` as a PARAMETER instead of capturing it. In JS a
// closure would simply close over the array; here two closures both capturing
// `problems` mutably would collide with the one-`&mut`-at-a-time borrow rule,
// so each call site lends the list for the duration of the call instead.
pub fn validate(desc: &CampaignDescription, catalog: &Catalog) -> Vec<Problem> {
    let mut problems = Vec::new();

    // ---- duplicate names ----
    let dup = |kind: &'static str, names: Vec<&str>, problems: &mut Vec<Problem>| {
        let mut seen = BTreeSet::new();
        for n in names {
            // `insert` returns false when the value was already present —
            // JS `Set.add` returns the set, so this dual-purpose call reads odd.
            if !seen.insert(n) {
                problems.push(Problem::DuplicateName {
                    kind,
                    name: n.to_owned(),
                });
            }
        }
    };
    dup(
        "room",
        desc.rooms.iter().map(|r| r.name.as_str()).collect(),
        &mut problems,
    );
    dup(
        "mob",
        desc.mobs.iter().map(|m| m.name.as_str()).collect(),
        &mut problems,
    );
    dup(
        "loot",
        desc.loot.iter().map(|l| l.name.as_str()).collect(),
        &mut problems,
    );
    dup(
        "cache",
        desc.caches.iter().map(|c| c.name.as_str()).collect(),
        &mut problems,
    );
    dup(
        "npc",
        desc.npcs.iter().map(|n| n.name.as_str()).collect(),
        &mut problems,
    );

    let room_names: BTreeSet<&str> = desc.rooms.iter().map(|r| r.name.as_str()).collect();
    let require_room = |ctx: String, name: &str, problems: &mut Vec<Problem>| {
        if !room_names.contains(name) {
            problems.push(Problem::UndefinedRoom {
                ctx,
                room: name.to_owned(),
            });
        }
    };

    // ---- room references ----
    if let Some(sr) = &desc.start_room {
        require_room("startRoom".into(), sr, &mut problems);
    }
    for e in &desc.exits {
        require_room("exit.from".into(), &e.from, &mut problems);
        require_room("exit.to".into(), &e.to, &mut problems);
    }
    for m in &desc.mobs {
        if let Some(r) = &m.room {
            require_room(format!("mob '{}'", m.name), r, &mut problems);
        }
    }
    for l in &desc.loot {
        require_room(format!("loot '{}'", l.name), &l.room, &mut problems);
    }
    for c in &desc.caches {
        require_room(format!("cache '{}'", c.name), &c.room, &mut problems);
    }
    for n in &desc.npcs {
        if let Some(r) = &n.room {
            require_room(format!("npc '{}'", n.name), r, &mut problems);
        }
    }
    for s in &desc.scenes {
        require_room(format!("scene '{}'", s.key), &s.room, &mut problems);
    }

    // ---- item keys ----
    let require_item = |ctx: String, k: &str, problems: &mut Vec<Problem>| {
        if !catalog.items.contains_key(k) {
            problems.push(Problem::UnregisteredItem {
                ctx,
                key: k.to_owned(),
            });
        }
    };
    for m in &desc.mobs {
        for k in &m.drops {
            require_item(format!("mob '{}' drop", m.name), k, &mut problems);
        }
    }
    for l in &desc.loot {
        for k in &l.items {
            require_item(format!("loot '{}' item", l.name), k, &mut problems);
        }
    }
    for r in &desc.rooms {
        for k in &r.lights {
            require_item(format!("room '{}' light", r.name), k, &mut problems);
        }
    }
    for n in &desc.npcs {
        for k in &n.holds {
            require_item(format!("npc '{}' holds", n.name), k, &mut problems);
        }
    }

    // ---- recipes ----
    // DELIBERATE DIVERGENCE: declared recipe keys get no existence check here, though
    // the oracle's authoring path had one. The catalog DOES now carry a `recipes` map
    // (added for codex reconstruction — see construct.rs), so the check is cheaply
    // closeable in place: flag any `desc.recipes` key missing from `catalog.recipes`.
    // It is deliberately deferred until author input becomes untrusted (modding);
    // while the toolchain is trusted, genesis bytes are unaffected (`knownRecipes`
    // comes straight from `desc.recipes`).

    // ---- conditions ----
    // Conditions are the "victory" behavior family, NOT "condition". Verified: the
    // hollow-house win/lose keys (reached-attic-with-journal, sanity-zero, party-down)
    // are all `family: "victory"` in the catalog.
    for (ctx, list) in [
        ("winWhen", &desc.win_conditions),
        ("loseWhen", &desc.lose_conditions),
    ] {
        for c in list {
            if !has_behavior(catalog, &c.key, "victory") {
                problems.push(Problem::UnregisteredCondition {
                    ctx: ctx.into(),
                    key: c.key.clone(),
                });
            }
        }
    }

    // ---- scenes ----
    for s in &desc.scenes {
        if !has_behavior(catalog, &s.key, "scene") {
            problems.push(Problem::UnregisteredScene { key: s.key.clone() });
        }
    }

    // ---- keyed exits ----
    for e in &desc.exits {
        if let Some(k) = &e.behavior_key {
            if !has_behavior(catalog, k, "exit") {
                problems.push(Problem::UnregisteredExit {
                    from: e.from.clone(),
                    to: e.to.clone(),
                    key: k.clone(),
                });
            }
        }
    }

    // ---- formations ----
    for f in &desc.formations {
        if !catalog.formations.contains_key(&f.key) {
            problems.push(Problem::UnregisteredFormation { key: f.key.clone() });
        }
    }

    // ---- npc behaviors ----
    for n in &desc.npcs {
        if !has_behavior(catalog, &n.behavior, "npc") {
            problems.push(Problem::UnregisteredNpc {
                npc: n.name.clone(),
                key: n.behavior.clone(),
            });
        }
    }

    // ---- mechanics: duplicate THEN unregistered ----
    let mut seen_mech: BTreeSet<&str> = BTreeSet::new();
    for m in &desc.mechanics {
        if !seen_mech.insert(m.key.as_str()) {
            problems.push(Problem::DuplicateMechanic { key: m.key.clone() });
        }
        if !has_behavior(catalog, &m.key, "mechanic") {
            problems.push(Problem::UnregisteredMechanic { key: m.key.clone() });
        }
    }

    // ---- villain ----
    // The character must be a declared mob/npc (mob-first, matching
    // construct.rs's id resolution) or the "@gm" sentinel; every deck key must
    // resolve — the compiled-in card registry first, then a Card-family
    // catalog behavior (mirroring the engine's native-then-catalog lookup).
    if let Some(v) = &desc.villain {
        if v.character != "@gm"
            && !desc.mobs.iter().any(|m| m.name == v.character)
            && !desc.npcs.iter().any(|n| n.name == v.character)
        {
            problems.push(Problem::UndefinedVillainCharacter {
                character: v.character.clone(),
            });
        }
        for key in &v.deck {
            let native = wickedways_core::world::villain::card_behavior(key).is_some();
            if !native && !has_behavior(catalog, key, "card") {
                problems.push(Problem::UnregisteredCard { key: key.clone() });
            }
        }
    }

    // ---- policy bounds ----
    // The `as_ref().and_then(..).and_then(..)` chain is Rust's optional
    // chaining: read it as `desc.chat?.backfillWindow` where the value must
    // also parse as an integer, else the whole chain yields `None`.
    if let Some(w) = desc
        .chat
        .as_ref()
        .and_then(|c| c.get("backfillWindow"))
        .and_then(serde_json::Value::as_i64)
    {
        if w < 1 {
            problems.push(Problem::ChatBackfillWindow { got: w });
        }
    }
    if let Some(n) = desc
        .av
        .as_ref()
        .and_then(|a| a.get("maxParticipants"))
        .and_then(serde_json::Value::as_i64)
    {
        if n < 1 {
            problems.push(Problem::AvMaxParticipants { got: n });
        }
    }

    problems
}

// ---------------------------------------------------------------------------
// Catalog-lookup helpers
// ---------------------------------------------------------------------------

/// Does `catalog.behaviors` hold `key` with the given `family` tag?
fn has_behavior(catalog: &Catalog, key: &str, family: &str) -> bool {
    catalog
        .behaviors
        .get(key)
        // `is_some_and` = "present AND the predicate holds" — the Option-aware
        // cousin of `map.get(key)?.family === family`.
        .is_some_and(|b| behavior_family(b) == family)
}

/// `BehaviorScript` is an externally-tagged union with a `family` field.
/// Serializing to `Value` and reading the tag keeps this independent of the AST's
/// internal Rust shape.
fn behavior_family(b: &wickedways_core::script::ast::BehaviorScript) -> String {
    serde_json::to_value(b)
        .ok()
        .and_then(|v| v.get("family").and_then(|f| f.as_str().map(str::to_owned)))
        .unwrap_or_default()
}
