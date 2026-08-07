//! The live referential-integrity pass — layer 2 of the spec's validation stack.
//!
//! [`check_refs`] is a pure, all-errors sweep of the spec's reference graph over the
//! editor document, run after every mutation. It exists because `compile()` reports
//! one error at a time with no asset context, and the assembler's collect-all pass
//! runs on the *compiled* description — neither gives live, click-to-navigate
//! feedback. Each [`StudioProblem`] is machine-addressable to a family (nav badge)
//! and, where one exists, an editor id (inline marker / jump-to-asset).
//!
//! Also here: the mutation helpers the screens share — rename propagation (renames
//! rewrite every in-document reference; behavior-body text is never rewritten, per
//! the spec) and the reverse-exit convenience.

use std::collections::{BTreeMap, BTreeSet};

use crate::model::{opposite_direction, EditorDoc, DIRECTIONS};
use wickedways_author::author_doc::ExitEntry;

/// The asset families — the nav sections problems attach to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Family {
    Settings,
    Archetypes,
    Rooms,
    Exits,
    Items,
    Loot,
    Caches,
    Recipes,
    Scenes,
    Npcs,
    Mobs,
    Formations,
    Mechanics,
    Cards,
    Villain,
    Victory,
    Behaviors,
}

impl Family {
    /// The route-param / nav slug.
    #[must_use]
    pub const fn slug(self) -> &'static str {
        match self {
            Family::Settings => "settings",
            Family::Archetypes => "archetypes",
            Family::Rooms => "rooms",
            Family::Exits => "exits",
            Family::Items => "items",
            Family::Loot => "loot",
            Family::Caches => "caches",
            Family::Recipes => "recipes",
            Family::Scenes => "scenes",
            Family::Npcs => "npcs",
            Family::Mobs => "mobs",
            Family::Formations => "formations",
            Family::Mechanics => "mechanics",
            Family::Cards => "cards",
            Family::Villain => "villain",
            Family::Victory => "victory",
            Family::Behaviors => "behaviors",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Severity {
    Error,
    Warning,
    Info,
}

/// One live-integrity finding: severity, a human message, the owning family (nav
/// badge), and — when the finding pins to one list entry — its editor id.
#[derive(Clone, Debug, PartialEq)]
pub struct StudioProblem {
    pub severity: Severity,
    pub message: String,
    pub family: Family,
    pub asset: Option<u64>,
}

fn problem(
    severity: Severity,
    family: Family,
    asset: Option<u64>,
    message: String,
) -> StudioProblem {
    StudioProblem {
        severity,
        message,
        family,
        asset,
    }
}

/// The whole-document referential-integrity sweep. All findings at once, authored
/// order, errors before warnings before info.
#[must_use]
pub fn check_refs(doc: &EditorDoc) -> Vec<StudioProblem> {
    let mut out = Vec::new();
    let rooms: BTreeSet<&str> = doc.rooms.iter().map(|r| r.entry.name.as_str()).collect();
    let items: BTreeSet<&str> = doc.items.iter().map(|i| i.entry.key.as_str()).collect();

    let require_room = |out: &mut Vec<StudioProblem>, family, asset, ctx: &str, room: &str| {
        if !rooms.contains(room) {
            out.push(problem(
                Severity::Error,
                family,
                asset,
                format!("{ctx} references undefined room '{room}'"),
            ));
        }
    };
    let require_item = |out: &mut Vec<StudioProblem>, family, asset, ctx: &str, key: &str| {
        if !items.contains(key) {
            out.push(problem(
                Severity::Error,
                family,
                asset,
                format!("{ctx} references undefined item '{key}'"),
            ));
        }
    };

    // ---- duplicates (name/key is the reference identity, so a duplicate breaks
    // every reference to it) ----
    type DupEntries = Vec<(Option<u64>, String)>;
    let dup_checks: [(&str, Family, DupEntries); 8] = [
        (
            "room name",
            Family::Rooms,
            doc.rooms
                .iter()
                .map(|r| (Some(r.id), r.entry.name.clone()))
                .collect(),
        ),
        (
            "item key",
            Family::Items,
            doc.items
                .iter()
                .map(|i| (Some(i.id), i.entry.key.clone()))
                .collect(),
        ),
        (
            "archetype id",
            Family::Archetypes,
            doc.archetypes
                .iter()
                .map(|a| (Some(a.id), a.entry.id.clone()))
                .collect(),
        ),
        (
            "mob/npc name",
            Family::Mobs,
            doc.mobs
                .iter()
                .map(|m| (Some(m.id), m.entry.name.clone()))
                .chain(doc.npcs.iter().map(|n| (Some(n.id), n.entry.name.clone())))
                .collect(),
        ),
        (
            "formation key",
            Family::Formations,
            doc.formations
                .iter()
                .map(|f| (Some(f.id), f.entry.key.clone()))
                .collect(),
        ),
        (
            "mechanic key",
            Family::Mechanics,
            doc.mechanics
                .iter()
                .map(|m| (Some(m.id), m.entry.key.clone()))
                .collect(),
        ),
        (
            "card key",
            Family::Cards,
            doc.cards
                .iter()
                .map(|c| (Some(c.id), c.entry.key.clone()))
                .collect(),
        ),
        (
            "victory key",
            Family::Victory,
            doc.victory_win
                .iter()
                .chain(doc.victory_lose.iter())
                .map(|c| (Some(c.id), c.entry.key.clone()))
                .collect(),
        ),
    ];
    for (kind, family, entries) in dup_checks {
        let mut seen: BTreeMap<&str, u32> = BTreeMap::new();
        for (_, name) in &entries {
            *seen.entry(name.as_str()).or_default() += 1;
        }
        for (asset, name) in &entries {
            if !name.is_empty() && seen.get(name.as_str()).copied().unwrap_or(0) > 1 {
                out.push(problem(
                    Severity::Error,
                    family,
                    *asset,
                    format!("duplicate {kind} '{name}'"),
                ));
            }
        }
    }

    // ---- settings ----
    if let Some(start) = &doc.start_room {
        require_room(&mut out, Family::Settings, None, "startRoom", start);
    } else if !doc.rooms.is_empty() {
        out.push(problem(
            Severity::Warning,
            Family::Settings,
            None,
            "no startRoom set".to_string(),
        ));
    }

    // ---- rooms: lights are item keys ----
    for r in &doc.rooms {
        for key in &r.entry.lights {
            require_item(
                &mut out,
                Family::Rooms,
                Some(r.id),
                &format!("room '{}' lights", r.entry.name),
                key,
            );
        }
    }

    // ---- exits: room ends, direction vocabulary, behavior link, return-leg lint ----
    for e in &doc.exits {
        let ctx = format!("exit {} → {}", e.entry.from, e.entry.to);
        require_room(&mut out, Family::Exits, Some(e.id), &ctx, &e.entry.from);
        require_room(&mut out, Family::Exits, Some(e.id), &ctx, &e.entry.to);
        if !DIRECTIONS.contains(&e.entry.direction.as_str()) {
            out.push(problem(
                Severity::Error,
                Family::Exits,
                Some(e.id),
                format!("{ctx} has unknown direction '{}'", e.entry.direction),
            ));
        }
        if let Some(key) = &e.entry.behavior {
            if !doc.behaviors.exit.contains_key(key) {
                out.push(problem(
                    Severity::Error,
                    Family::Exits,
                    Some(e.id),
                    format!("{ctx} names undefined exit behavior '{key}'"),
                ));
            }
        }
        let one_way = e.entry.one_way.unwrap_or(false);
        let has_return = doc
            .exits
            .iter()
            .any(|o| o.entry.from == e.entry.to && o.entry.to == e.entry.from);
        if !one_way && !has_return {
            out.push(problem(
                Severity::Info,
                Family::Exits,
                Some(e.id),
                format!("{ctx} has no return exit (one-way passages should set oneWay)"),
            ));
        }
    }

    // ---- placements referencing rooms ----
    for l in &doc.loot {
        require_room(
            &mut out,
            Family::Loot,
            Some(l.id),
            &format!("loot '{}'", l.entry.name),
            &l.entry.room,
        );
        for key in &l.entry.items {
            require_item(
                &mut out,
                Family::Loot,
                Some(l.id),
                &format!("loot '{}'", l.entry.name),
                key,
            );
        }
    }
    for c in &doc.caches {
        require_room(
            &mut out,
            Family::Caches,
            Some(c.id),
            &format!("cache '{}'", c.entry.name),
            &c.entry.room,
        );
    }
    for s in &doc.scenes {
        require_room(
            &mut out,
            Family::Scenes,
            Some(s.id),
            &format!("scene '{}'", s.entry.key),
            &s.entry.room,
        );
        if !doc.behaviors.scene.contains_key(&s.entry.key) {
            out.push(problem(
                Severity::Error,
                Family::Scenes,
                Some(s.id),
                format!("scene '{}' has no [behaviors.scene] body", s.entry.key),
            ));
        }
    }
    for m in &doc.mobs {
        if let Some(room) = &m.entry.room {
            require_room(
                &mut out,
                Family::Mobs,
                Some(m.id),
                &format!("mob '{}'", m.entry.name),
                room,
            );
        }
        for key in &m.entry.drops {
            require_item(
                &mut out,
                Family::Mobs,
                Some(m.id),
                &format!("mob '{}' drop", m.entry.name),
                key,
            );
        }
    }
    for n in &doc.npcs {
        if let Some(room) = &n.entry.room {
            require_room(
                &mut out,
                Family::Npcs,
                Some(n.id),
                &format!("npc '{}'", n.entry.name),
                room,
            );
        }
        for key in &n.entry.holds {
            require_item(
                &mut out,
                Family::Npcs,
                Some(n.id),
                &format!("npc '{}' holds", n.entry.name),
                key,
            );
        }
        if !doc.behaviors.npc.contains_key(&n.entry.behavior) {
            out.push(problem(
                Severity::Error,
                Family::Npcs,
                Some(n.id),
                format!(
                    "npc '{}' names undefined npc behavior '{}'",
                    n.entry.name, n.entry.behavior
                ),
            ));
        }
    }

    // ---- items referenced by key ----
    for r in &doc.recipes {
        require_item(
            &mut out,
            Family::Recipes,
            Some(r.id),
            &format!("recipe '{}' output", r.entry.id),
            &r.entry.output_item,
        );
    }
    for f in &doc.formations {
        for spec in &f.entry.mobs {
            for key in &spec.drops {
                require_item(
                    &mut out,
                    Family::Formations,
                    Some(f.id),
                    &format!("formation '{}' mob '{}' drop", f.entry.key, spec.name),
                    key,
                );
            }
        }
        if f.entry.mobs.is_empty() {
            out.push(problem(
                Severity::Warning,
                Family::Formations,
                Some(f.id),
                format!("formation '{}' has an empty mob roster", f.entry.key),
            ));
        }
    }

    // ---- mechanics: key must be scripted here or a native mechanic key ----
    for m in &doc.mechanics {
        if !doc.behaviors.mechanic.contains_key(&m.entry.key) {
            out.push(problem(
                Severity::Warning,
                Family::Mechanics,
                Some(m.id),
                format!(
                    "mechanic '{}' has no [behaviors.mechanic] body (legal only if it is a native mechanic key — Check campaign verifies)",
                    m.entry.key
                ),
            ));
        }
    }

    // ---- cards + villain: native `wicked:*` keys need no local entry ----
    let card_keys: BTreeSet<&str> = doc.cards.iter().map(|c| c.entry.key.as_str()).collect();
    for c in &doc.cards {
        if !c.entry.key.starts_with("wicked:") && !doc.behaviors.card.contains_key(&c.entry.key) {
            out.push(problem(
                Severity::Warning,
                Family::Cards,
                Some(c.id),
                format!(
                    "card '{}' has no [behaviors.card] body (legal only if it is a native card key — Check campaign verifies)",
                    c.entry.key
                ),
            ));
        }
    }
    if let Some(v) = &doc.villain {
        if v.character != "@gm"
            && !doc.mobs.iter().any(|m| m.entry.name == v.character)
            && !doc.npcs.iter().any(|n| n.entry.name == v.character)
        {
            out.push(problem(
                Severity::Error,
                Family::Villain,
                None,
                format!(
                    "villain character '{}' is not a declared mob or npc (or \"@gm\")",
                    v.character
                ),
            ));
        }
        for key in &v.deck {
            if !key.starts_with("wicked:") && !card_keys.contains(key.as_str()) {
                out.push(problem(
                    Severity::Error,
                    Family::Villain,
                    None,
                    format!("villain deck names undefined card '{key}'"),
                ));
            }
        }
    }

    // ---- orphan behaviors (declared, referenced by nothing) ----
    let exit_used: BTreeSet<&str> = doc
        .exits
        .iter()
        .filter_map(|e| e.entry.behavior.as_deref())
        .collect();
    for key in doc.behaviors.exit.keys() {
        if !exit_used.contains(key.as_str()) {
            out.push(problem(
                Severity::Info,
                Family::Behaviors,
                None,
                format!("exit behavior '{key}' is not referenced by any exit"),
            ));
        }
    }
    let scene_used: BTreeSet<&str> = doc.scenes.iter().map(|s| s.entry.key.as_str()).collect();
    for key in doc.behaviors.scene.keys() {
        if !scene_used.contains(key.as_str()) {
            out.push(problem(
                Severity::Info,
                Family::Behaviors,
                None,
                format!("scene behavior '{key}' has no [[scenes]] placement"),
            ));
        }
    }
    let npc_used: BTreeSet<&str> = doc.npcs.iter().map(|n| n.entry.behavior.as_str()).collect();
    for key in doc.behaviors.npc.keys() {
        if !npc_used.contains(key.as_str()) {
            out.push(problem(
                Severity::Info,
                Family::Behaviors,
                None,
                format!("npc behavior '{key}' is not referenced by any npc"),
            ));
        }
    }
    // An item behavior's key must BE an item key (they share the key). A missing
    // behavior for an item is legal (the format's deliberate weak spot) — but a
    // behavior for a missing item is dead.
    for key in doc.behaviors.item.keys() {
        if !items.contains(key.as_str()) {
            out.push(problem(
                Severity::Warning,
                Family::Behaviors,
                None,
                format!("item behavior '{key}' has no matching [[items]] entry"),
            ));
        }
    }
    let mech_used: BTreeSet<&str> = doc.mechanics.iter().map(|m| m.entry.key.as_str()).collect();
    for key in doc.behaviors.mechanic.keys() {
        if !mech_used.contains(key.as_str()) {
            out.push(problem(
                Severity::Info,
                Family::Behaviors,
                None,
                format!("mechanic behavior '{key}' has no [[mechanics]] opt-in"),
            ));
        }
    }
    for key in doc.behaviors.card.keys() {
        if !card_keys.contains(key.as_str()) {
            out.push(problem(
                Severity::Info,
                Family::Behaviors,
                None,
                format!("card behavior '{key}' has no [[cards]] entry"),
            ));
        }
    }

    out.sort_by_key(|p| p.severity);
    out
}

/// Rename a room and rewrite every in-document reference to it. Returns the number
/// of references rewritten (the confirm dialog's count), NOT counting the room's own
/// `name` field. Behavior-body text is deliberately untouched (spec: flagged, never
/// rewritten). No-op returning 0 when `old == new` or the target name is taken.
pub fn rename_room(doc: &mut EditorDoc, old: &str, new: &str) -> usize {
    if old == new || doc.rooms.iter().any(|r| r.entry.name == new) {
        return 0;
    }
    let mut n = 0;
    let mut touch = |s: &mut String| {
        if s == old {
            *s = new.to_string();
            n += 1;
        }
    };
    if let Some(start) = doc.start_room.as_mut() {
        touch(start);
    }
    for e in &mut doc.exits {
        touch(&mut e.entry.from);
        touch(&mut e.entry.to);
    }
    for l in &mut doc.loot {
        touch(&mut l.entry.room);
    }
    for c in &mut doc.caches {
        touch(&mut c.entry.room);
    }
    for s in &mut doc.scenes {
        touch(&mut s.entry.room);
    }
    for m in &mut doc.mobs {
        if let Some(room) = m.entry.room.as_mut() {
            touch(room);
        }
    }
    for np in &mut doc.npcs {
        if let Some(room) = np.entry.room.as_mut() {
            touch(room);
        }
    }
    for r in &mut doc.rooms {
        if r.entry.name == old {
            r.entry.name = new.to_string();
        }
    }
    n
}

/// Rename an item key and rewrite every in-document reference, including the
/// shared-key `[behaviors.item.<key>]` entry (the behavior follows the item).
/// Returns the reference count (behavior-map move counts as one). Same no-op rules
/// as [`rename_room`].
pub fn rename_item_key(doc: &mut EditorDoc, old: &str, new: &str) -> usize {
    if old == new || doc.items.iter().any(|i| i.entry.key == new) {
        return 0;
    }
    let mut n = 0;
    let mut touch = |s: &mut String| {
        if s == old {
            *s = new.to_string();
            n += 1;
        }
    };
    for l in &mut doc.loot {
        for k in &mut l.entry.items {
            touch(k);
        }
    }
    for m in &mut doc.mobs {
        for k in &mut m.entry.drops {
            touch(k);
        }
    }
    for np in &mut doc.npcs {
        for k in &mut np.entry.holds {
            touch(k);
        }
    }
    for r in &mut doc.rooms {
        for k in &mut r.entry.lights {
            touch(k);
        }
    }
    for rec in &mut doc.recipes {
        touch(&mut rec.entry.output_item);
    }
    for f in &mut doc.formations {
        for spec in &mut f.entry.mobs {
            for k in &mut spec.drops {
                touch(k);
            }
        }
    }
    if let Some(body) = doc.behaviors.item.remove(old) {
        doc.behaviors.item.insert(new.to_string(), body);
        n += 1;
    }
    for i in &mut doc.items {
        if i.entry.key == old {
            i.entry.key = new.to_string();
        }
    }
    n
}

/// How many references a rename/delete would touch (the confirm dialogs), computed
/// on a clone so the document is untouched.
#[must_use]
pub fn count_room_refs(doc: &EditorDoc, name: &str) -> usize {
    rename_room(&mut doc.clone(), name, "\u{0}probe\u{0}")
}

/// See [`count_room_refs`].
#[must_use]
pub fn count_item_refs(doc: &EditorDoc, key: &str) -> usize {
    rename_item_key(&mut doc.clone(), key, "\u{0}probe\u{0}")
}

/// The return leg of an exit: swapped ends, opposite direction, copied
/// `behavior`/`name` (a locked door usually shares one behavior key — detachable
/// afterwards). `None` when the direction has no compass opposite. State is NOT
/// copied — a keyed door's state lives per-exit.
#[must_use]
pub fn reverse_exit(exit: &ExitEntry) -> Option<ExitEntry> {
    Some(ExitEntry {
        from: exit.to.clone(),
        to: exit.from.clone(),
        direction: opposite_direction(&exit.direction)?.to_string(),
        behavior: exit.behavior.clone(),
        name: exit.name.clone(),
        initial_state: exit.initial_state.clone(),
        one_way: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::export::import;

    fn doc(src: &str) -> EditorDoc {
        import(src).expect("test doc parses")
    }

    const BASE: &str = r#"
        title = "T"
        startRoom = "A"
        [[rooms]]
        name = "A"
        description = "a"
        lights = ["lantern"]
        [[rooms]]
        name = "B"
        description = "b"
        [[exits]]
        from = "A"
        to = "B"
        direction = "north"
        [[exits]]
        from = "B"
        to = "A"
        direction = "south"
        [[items]]
        key = "lantern"
        name = "Lantern"
        [[loot]]
        name = "chest"
        room = "A"
        items = ["lantern"]
        [[mobs]]
        name = "Wraith"
        stats = { health = 3.0, sanity = 1.0, energy = 1.0 }
        room = "B"
        drops = ["lantern"]
    "#;

    #[test]
    fn a_consistent_doc_has_no_errors() {
        let problems = check_refs(&doc(BASE));
        assert!(
            problems.iter().all(|p| p.severity != Severity::Error),
            "unexpected errors: {problems:?}"
        );
    }

    #[test]
    fn dangling_references_are_errors_pinned_to_the_asset() {
        let d = doc(r#"
            title = "T"
            startRoom = "Nowhere"
            [[rooms]]
            name = "A"
            description = "a"
            [[exits]]
            from = "A"
            to = "Gone"
            direction = "north"
            oneWay = true
            [[loot]]
            name = "chest"
            room = "A"
            items = ["ghost-item"]
        "#);
        let problems = check_refs(&d);
        let errors: Vec<&StudioProblem> = problems
            .iter()
            .filter(|p| p.severity == Severity::Error)
            .collect();
        assert!(errors
            .iter()
            .any(|p| p.family == Family::Settings && p.message.contains("Nowhere")));
        let exit_err = errors
            .iter()
            .find(|p| p.family == Family::Exits && p.message.contains("Gone"))
            .expect("exit error");
        assert_eq!(exit_err.asset, Some(d.exits[0].id));
        assert!(errors
            .iter()
            .any(|p| p.family == Family::Loot && p.message.contains("ghost-item")));
    }

    #[test]
    fn duplicates_and_bad_directions_are_errors() {
        let d = doc(r#"
            title = "T"
            [[rooms]]
            name = "A"
            description = "1"
            [[rooms]]
            name = "A"
            description = "2"
            [[exits]]
            from = "A"
            to = "A"
            direction = "sideways"
        "#);
        let problems = check_refs(&d);
        assert!(problems
            .iter()
            .any(|p| p.message.contains("duplicate room name 'A'")));
        assert!(problems
            .iter()
            .any(|p| p.message.contains("unknown direction 'sideways'")));
    }

    #[test]
    fn missing_return_exit_is_info_not_error() {
        let d = doc(r#"
            title = "T"
            startRoom = "A"
            [[rooms]]
            name = "A"
            description = "a"
            [[rooms]]
            name = "B"
            description = "b"
            [[exits]]
            from = "A"
            to = "B"
            direction = "north"
        "#);
        let p = check_refs(&d);
        let lint = p
            .iter()
            .find(|p| p.message.contains("no return exit"))
            .expect("return-exit lint");
        assert_eq!(lint.severity, Severity::Info);
    }

    #[test]
    fn behavior_links_and_villain_resolution_are_checked() {
        let d = doc(r#"
            title = "T"
            startRoom = "A"
            [[rooms]]
            name = "A"
            description = "a"
            [[exits]]
            from = "A"
            to = "A"
            direction = "north"
            behavior = "missing-door"
            oneWay = true
            [[npcs]]
            name = "Keeper"
            stats = { health = 1.0, sanity = 1.0, energy = 1.0 }
            behavior = "missing-npc"
            [villain]
            character = "Nobody"
            deck = ["wicked:lights-out", "missing-card"]
        "#);
        let msgs: Vec<String> = check_refs(&d)
            .into_iter()
            .filter(|p| p.severity == Severity::Error)
            .map(|p| p.message)
            .collect();
        assert!(msgs.iter().any(|m| m.contains("missing-door")));
        assert!(msgs.iter().any(|m| m.contains("missing-npc")));
        assert!(msgs.iter().any(|m| m.contains("Nobody")));
        assert!(msgs.iter().any(|m| m.contains("missing-card")));
        assert!(
            !msgs.iter().any(|m| m.contains("wicked:lights-out")),
            "native wicked:* deck keys need no local entry"
        );
    }

    #[test]
    fn rename_room_propagates_and_reports_the_count() {
        let mut d = doc(BASE);
        let n = rename_room(&mut d, "A", "Atrium");
        // startRoom + exit.from + exit.to + loot.room = 4 (mob is in B).
        assert_eq!(n, 4);
        assert_eq!(d.start_room.as_deref(), Some("Atrium"));
        assert_eq!(d.rooms[0].entry.name, "Atrium");
        assert!(d.exits.iter().any(|e| e.entry.from == "Atrium"));
        assert!(d.exits.iter().any(|e| e.entry.to == "Atrium"));
        assert_eq!(d.loot[0].entry.room, "Atrium");
        assert!(check_refs(&d).iter().all(|p| p.severity != Severity::Error));
        // Collision and no-op renames refuse.
        assert_eq!(rename_room(&mut d, "Atrium", "B"), 0);
        assert_eq!(d.rooms[0].entry.name, "Atrium");
    }

    #[test]
    fn rename_item_key_propagates_including_the_behavior_map() {
        let mut d = doc(r#"
            title = "T"
            [[items]]
            key = "elixir"
            name = "Elixir"
            type = "consumable"
            [[loot]]
            name = "shelf"
            room = "A"
            items = ["elixir"]
            [[rooms]]
            name = "A"
            description = "a"
            [behaviors.item.elixir]
            onUse = "emit adjustStat(actor, sanity, 6)"
        "#);
        let n = rename_item_key(&mut d, "elixir", "tonic");
        // loot.items + behavior-map move = 2.
        assert_eq!(n, 2);
        assert_eq!(d.items[0].entry.key, "tonic");
        assert_eq!(d.loot[0].entry.items[0], "tonic");
        assert!(d.behaviors.item.contains_key("tonic"));
        assert!(!d.behaviors.item.contains_key("elixir"));
    }

    #[test]
    fn count_refs_leaves_the_doc_untouched() {
        let d = doc(BASE);
        let before = d.clone();
        assert_eq!(count_room_refs(&d, "A"), 4);
        assert!(count_item_refs(&d, "lantern") >= 3);
        assert_eq!(d, before);
    }

    #[test]
    fn reverse_exit_swaps_ends_and_direction() {
        let e = ExitEntry {
            from: "A".into(),
            to: "B".into(),
            direction: "northeast".into(),
            behavior: Some("door".into()),
            name: Some("iron door".into()),
            initial_state: None,
            one_way: None,
        };
        let r = reverse_exit(&e).expect("reversible");
        assert_eq!(r.from, "B");
        assert_eq!(r.to, "A");
        assert_eq!(r.direction, "southwest");
        assert_eq!(r.behavior.as_deref(), Some("door"));
    }
}
