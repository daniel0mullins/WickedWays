//! The CRT command parser (Phase 2c, sub-project D — slice 2).
//!
//! Ports `packages/play-surface/src/crt/parser.ts` 1:1 — a pure function turning a line of terminal
//! input into a [`ParseResult`] against the current scope (the entities the player can name). It is
//! framework-free and browser-free, so it is unit-tested exhaustively on the host; the shell wires
//! its output — [`Intent`]s become sync `Command`s, queries render locally.
//!
//! Takes `&[ScopeEntity]` (the ViewModel's `scope`) rather than the whole ViewModel — that is the
//! only field the TS parser reads — which keeps the port and its tests trivial.

use wickedways_core::world::direction::Direction;
use wickedways_core::world::intent::Intent;
use wickedways_core::world::view::ScopeEntity;

/// What a parsed line resolves to. Mirrors `ParseResult` in `parser.ts`.
#[derive(Clone, Debug, PartialEq)]
pub enum ParseResult {
    Intent(Intent),
    Query(Query),
    Examine(ScopeEntity),
    Meta(Meta),
    Ambiguous(Vec<ScopeEntity>),
    Error(String),
}

/// A zero-noun informational query (rendered locally, no command).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Query {
    Look,
    Inventory,
    Exits,
    Help,
}

/// A client/session meta command (save/undo/map/…), handled by the surface, not the engine.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Meta {
    Save,
    Restore,
    Undo,
    Restart,
    Fullscreen,
    Audio,
    Map,
}

/// `north`/`n`/… → a compass [`Direction`]. Mirrors the `DIRECTIONS` table.
fn parse_dir(s: &str) -> Option<Direction> {
    use Direction::*;
    Some(match s {
        "north" | "n" => North,
        "south" | "s" => South,
        "east" | "e" => East,
        "west" | "w" => West,
        "northeast" | "ne" => Northeast,
        "northwest" | "nw" => Northwest,
        "southeast" | "se" => Southeast,
        "southwest" | "sw" => Southwest,
        _ => return None,
    })
}

/// Leading filler stripped from a noun phrase (articles + the common `look at`/`give to`/… prepositions).
const STOP_WORDS: &[&str] = &["the", "a", "an", "at", "to", "with", "on"];

fn is_stop(w: &str) -> bool {
    STOP_WORDS.contains(&w)
}

/// Whether `verb` is a verb that takes a noun (take/attack/open/…).
fn is_noun_verb(verb: &str) -> bool {
    matches!(
        verb,
        "take" | "get" | "drop" | "attack" | "kill" | "hit" | "equip" | "wear" | "wield" | "light"
            | "unequip" | "remove" | "extinguish" | "use" | "open"
            | "harvest" | "scavenge" | "gather" | "craft" | "forge" | "make"
            | "repair" | "mend" | "fix" | "destroy" | "scrap" | "break"
    )
}

/// A verb needing a resolved noun → an `Intent`, or an error string.
fn noun_verb(verb: &str, t: &ScopeEntity) -> Option<Result<Intent, String>> {
    let id = t.id.clone();
    let carry_err = || Err("That's not something you can carry — try taking what's inside it.".to_string());
    Some(match verb {
        "take" | "get" => {
            if t.kind == "loot" {
                carry_err()
            } else {
                Ok(Intent::Take { target_id: id })
            }
        }
        "drop" => Ok(Intent::Drop { target_id: id }),
        "attack" | "kill" | "hit" => Ok(Intent::Attack { target_id: id }),
        "equip" | "wear" | "wield" | "light" => Ok(Intent::Equip { target_id: id }),
        "unequip" | "remove" | "extinguish" => Ok(Intent::Unequip { target_id: id }),
        "use" => Ok(Intent::Use { target_id: id }),
        "open" => {
            if t.kind == "loot" {
                Ok(Intent::Open { target_id: id })
            } else {
                Err("You can't open that.".to_string())
            }
        }
        // Materials & crafting. Each verb wants a specific kind of target: a cache to
        // harvest, a recipe to craft, a held item to repair or scrap.
        "harvest" | "scavenge" | "gather" => {
            if t.kind == "cache" {
                Ok(Intent::Harvest { target_id: id })
            } else {
                Err("There's nothing to harvest there.".to_string())
            }
        }
        "craft" | "forge" | "make" => {
            if t.kind == "recipe" {
                Ok(Intent::Craft { recipe_id: id })
            } else {
                Err("You don't know how to craft that.".to_string())
            }
        }
        "repair" | "mend" | "fix" => {
            if t.kind == "item" {
                Ok(Intent::Repair { target_id: id })
            } else {
                Err("You can't repair that.".to_string())
            }
        }
        "destroy" | "scrap" | "break" => {
            if t.kind == "item" {
                Ok(Intent::Destroy { target_id: id })
            } else {
                Err("You can't break that down.".to_string())
            }
        }
        _ => return None,
    })
}

/// Parses one line of input against `scope`. Mirrors `parse()`.
pub fn parse(input: &str, scope: &[ScopeEntity]) -> ParseResult {
    let lowered = input.trim().to_lowercase();
    let tokens: Vec<&str> = lowered.split_whitespace().collect();
    let Some(&verb) = tokens.first() else {
        return ParseResult::Error("Say something.".into());
    };

    // Bare direction or "go/walk <dir>".
    if let Some(dir) = parse_dir(verb) {
        return ParseResult::Intent(Intent::Move { dir });
    }
    if verb == "go" || verb == "walk" {
        return match tokens.get(1).and_then(|t| parse_dir(t)) {
            Some(dir) => ParseResult::Intent(Intent::Move { dir }),
            None => ParseResult::Error("Go where?".into()),
        };
    }

    // Meta verbs.
    match verb {
        "save" => return ParseResult::Meta(Meta::Save),
        "restore" | "load" => return ParseResult::Meta(Meta::Restore),
        "undo" => return ParseResult::Meta(Meta::Undo),
        "restart" => return ParseResult::Meta(Meta::Restart),
        "fullscreen" | "fs" => return ParseResult::Meta(Meta::Fullscreen),
        "audio" | "sound" | "mute" => return ParseResult::Meta(Meta::Audio),
        "map" => return ParseResult::Meta(Meta::Map),
        _ => {}
    }

    // Zero-noun queries + wait.
    match verb {
        "inventory" | "i" | "inv" => return ParseResult::Query(Query::Inventory),
        "exits" => return ParseResult::Query(Query::Exits),
        "help" | "?" => return ParseResult::Query(Query::Help),
        "wait" | "z" => return ParseResult::Intent(Intent::Wait),
        _ => {}
    }

    // talk/speak/ask <npc> with an optional quoted prompt (case preserved from raw input).
    if verb == "talk" || verb == "speak" || verb == "ask" {
        let (prompt, remainder) = extract_quoted_prompt(input);
        let target = remainder
            .trim()
            .to_lowercase()
            .split_whitespace()
            .skip(1)
            .filter(|t| !is_stop(t))
            .collect::<Vec<_>>()
            .join(" ");
        if target.is_empty() {
            return ParseResult::Error(format!("{verb} to whom?"));
        }
        return resolve_then(&target, scope, |t| {
            ParseResult::Intent(Intent::Talk { npc_id: t.id.clone(), prompt: prompt.clone() })
        });
    }

    let noun_phrase = tokens.iter().skip(1).filter(|t| !is_stop(t)).copied().collect::<Vec<_>>().join(" ");

    // examine / look-at / read — resolve then examine; bare `look`/`l` is the room query.
    if matches!(verb, "examine" | "x" | "look-at" | "read" | "look" | "l") {
        if noun_phrase.is_empty() {
            return ParseResult::Query(Query::Look);
        }
        return resolve_then(&noun_phrase, scope, |t| ParseResult::Examine(t.clone()));
    }

    // Noun verbs (take/drop/attack/…).
    if !is_noun_verb(verb) {
        return ParseResult::Error(format!("I don't know how to \"{verb}\"."));
    }
    if noun_phrase.is_empty() {
        return ParseResult::Error(format!("{verb} what?"));
    }
    resolve_then(&noun_phrase, scope, |t| match noun_verb(verb, t) {
        Some(Ok(intent)) => ParseResult::Intent(intent),
        Some(Err(msg)) => ParseResult::Error(msg),
        None => ParseResult::Error(format!("I don't know how to \"{verb}\".")),
    })
}

/// Resolve `phrase` against `scope`; 0 → error, >1 → ambiguous, 1 → `build`.
fn resolve_then(phrase: &str, scope: &[ScopeEntity], build: impl Fn(&ScopeEntity) -> ParseResult) -> ParseResult {
    let matches = resolve(phrase, scope);
    match matches.len() {
        0 => ParseResult::Error("You don't see that here.".into()),
        1 => build(matches[0]),
        _ => ParseResult::Ambiguous(matches.into_iter().cloned().collect()),
    }
}

/// Match a phrase against each entity's name + aliases (exact first, then substring), deduped by id.
fn resolve<'a>(phrase: &str, scope: &'a [ScopeEntity]) -> Vec<&'a ScopeEntity> {
    let exact: Vec<&ScopeEntity> = scope
        .iter()
        .filter(|e| e.aliases.iter().any(|a| a == phrase) || e.name.to_lowercase() == phrase)
        .collect();
    if !exact.is_empty() {
        return dedupe(exact);
    }
    let partial = scope
        .iter()
        .filter(|e| {
            e.aliases.iter().any(|a| a.contains(phrase) || phrase.contains(a.as_str()))
                || e.name.to_lowercase().contains(phrase)
        })
        .collect();
    dedupe(partial)
}

fn dedupe(entities: Vec<&ScopeEntity>) -> Vec<&ScopeEntity> {
    let mut seen = std::collections::HashSet::new();
    entities.into_iter().filter(|e| seen.insert(e.id.clone())).collect()
}

/// Pull the first `"…"` segment from raw input: its trimmed contents (None if empty/absent) and the
/// input with that segment removed. Mirrors `extractQuotedPrompt`.
fn extract_quoted_prompt(input: &str) -> (Option<String>, String) {
    if let Some(open) = input.find('"') {
        if let Some(rel_close) = input[open + 1..].find('"') {
            let close = open + 1 + rel_close;
            let prompt = input[open + 1..close].trim().to_string();
            let mut remainder = String::with_capacity(input.len());
            remainder.push_str(&input[..open]);
            remainder.push_str(&input[close + 1..]);
            return (if prompt.is_empty() { None } else { Some(prompt) }, remainder);
        }
    }
    (None, input.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ent(id: &str, name: &str, kind: &str, aliases: &[&str]) -> ScopeEntity {
        ScopeEntity {
            id: id.into(),
            name: name.into(),
            kind: kind.into(),
            aliases: aliases.iter().map(|s| s.to_string()).collect(),
            health: None,
            image: None,
            equippable: None,
            usable: None,
            has_lore: None,
            droppable: None,
            destroyable: None,
            damaged: None,
            defeated: None,
            talkable: None, player: None,
        }
    }

    fn scope() -> Vec<ScopeEntity> {
        vec![
            ent("m:rat", "Rat", "occupant", &["rat"]),
            ent("i:torch", "Torch", "item", &["torch", "brand"]),
            ent("l:chest", "Chest", "loot", &["chest"]),
        ]
    }

    #[test]
    fn bare_direction_and_go_move() {
        assert_eq!(parse("north", &[]), ParseResult::Intent(Intent::Move { dir: Direction::North }));
        assert_eq!(parse("n", &[]), ParseResult::Intent(Intent::Move { dir: Direction::North }));
        assert_eq!(parse("go west", &[]), ParseResult::Intent(Intent::Move { dir: Direction::West }));
        assert_eq!(parse("go", &[]), ParseResult::Error("Go where?".into()));
    }

    #[test]
    fn empty_input_and_unknown_verb() {
        assert_eq!(parse("   ", &[]), ParseResult::Error("Say something.".into()));
        assert_eq!(parse("frobnicate", &[]), ParseResult::Error("I don't know how to \"frobnicate\".".into()));
    }

    #[test]
    fn meta_and_queries() {
        assert_eq!(parse("save", &[]), ParseResult::Meta(Meta::Save));
        assert_eq!(parse("map", &[]), ParseResult::Meta(Meta::Map));
        assert_eq!(parse("inventory", &[]), ParseResult::Query(Query::Inventory));
        assert_eq!(parse("i", &[]), ParseResult::Query(Query::Inventory));
        assert_eq!(parse("exits", &[]), ParseResult::Query(Query::Exits));
        assert_eq!(parse("look", &[]), ParseResult::Query(Query::Look));
        assert_eq!(parse("wait", &[]), ParseResult::Intent(Intent::Wait));
    }

    #[test]
    fn noun_verbs_resolve_the_target() {
        let s = scope();
        assert_eq!(parse("attack rat", &s), ParseResult::Intent(Intent::Attack { target_id: "m:rat".into() }));
        assert_eq!(parse("take torch", &s), ParseResult::Intent(Intent::Take { target_id: "i:torch".into() }));
        assert_eq!(parse("take the torch", &s), ParseResult::Intent(Intent::Take { target_id: "i:torch".into() }));
        assert_eq!(parse("wield brand", &s), ParseResult::Intent(Intent::Equip { target_id: "i:torch".into() }));
        assert_eq!(parse("open chest", &s), ParseResult::Intent(Intent::Open { target_id: "l:chest".into() }));
    }

    #[test]
    fn loot_cannot_be_taken_and_items_cannot_be_opened() {
        let s = scope();
        assert!(matches!(parse("take chest", &s), ParseResult::Error(m) if m.contains("can carry")));
        assert!(matches!(parse("open torch", &s), ParseResult::Error(m) if m == "You can't open that."));
    }

    #[test]
    fn missing_or_unseen_noun() {
        let s = scope();
        assert_eq!(parse("take", &s), ParseResult::Error("take what?".into()));
        assert_eq!(parse("attack ghost", &s), ParseResult::Error("You don't see that here.".into()));
    }

    #[test]
    fn examine_resolves_and_bare_look_is_a_query() {
        let s = scope();
        assert_eq!(parse("look", &s), ParseResult::Query(Query::Look));
        assert_eq!(parse("examine rat", &s), ParseResult::Examine(s[0].clone()));
        assert_eq!(parse("look at torch", &s), ParseResult::Examine(s[1].clone()));
    }

    #[test]
    fn ambiguous_when_two_entities_share_a_substring() {
        let s = vec![ent("k:1", "Brass Key", "item", &["key"]), ent("k:2", "Iron Key", "item", &["key"])];
        match parse("take key", &s) {
            ParseResult::Ambiguous(c) => assert_eq!(c.len(), 2),
            other => panic!("expected ambiguous, got {other:?}"),
        }
    }

    #[test]
    fn crafting_verbs_resolve_by_kind() {
        let s = vec![
            ent("cache:vein", "Iron Vein", "cache", &["iron vein", "vein"]),
            ent("blade", "Iron Blade", "recipe", &["iron blade"]),
            ent("i:sword", "Sword", "item", &["sword"]),
        ];
        assert_eq!(parse("harvest vein", &s), ParseResult::Intent(Intent::Harvest { target_id: "cache:vein".into() }));
        assert_eq!(parse("craft iron blade", &s), ParseResult::Intent(Intent::Craft { recipe_id: "blade".into() }));
        assert_eq!(parse("repair sword", &s), ParseResult::Intent(Intent::Repair { target_id: "i:sword".into() }));
        assert_eq!(parse("scrap sword", &s), ParseResult::Intent(Intent::Destroy { target_id: "i:sword".into() }));
    }

    #[test]
    fn crafting_verbs_reject_the_wrong_kind() {
        let s = vec![ent("i:sword", "Sword", "item", &["sword"]), ent("cache:vein", "Iron Vein", "cache", &["vein"])];
        assert!(matches!(parse("harvest sword", &s), ParseResult::Error(m) if m.contains("nothing to harvest")));
        assert!(matches!(parse("craft sword", &s), ParseResult::Error(m) if m.contains("don't know how to craft")));
        assert!(matches!(parse("repair vein", &s), ParseResult::Error(m) if m.contains("can't repair")));
    }

    #[test]
    fn talk_with_a_quoted_prompt() {
        let s = vec![ent("npc:keeper", "Keeper", "occupant", &["keeper"])];
        assert_eq!(
            parse("talk to keeper \"how do I get out\"", &s),
            ParseResult::Intent(Intent::Talk { npc_id: "npc:keeper".into(), prompt: Some("how do I get out".into()) }),
        );
        assert_eq!(
            parse("talk keeper", &s),
            ParseResult::Intent(Intent::Talk { npc_id: "npc:keeper".into(), prompt: None }),
        );
        assert_eq!(parse("talk", &s), ParseResult::Error("talk to whom?".into()));
    }
}
