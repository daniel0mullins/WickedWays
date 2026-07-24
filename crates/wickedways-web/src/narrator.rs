//! The narrator — cue/query/intent → prose (Phase 2c, sub-project D — slice 2).
//!
//! Ports `packages/play-surface/src/shared/narrator.ts` 1:1: a pure(-ish) translator from engine data
//! (the [`ViewModel`], a resolved [`Intent`], [`PresentationCue`]s, [`MobAttack`]s) to the lines of
//! prose the CRT transcript prints. The only state it carries is which rooms have been visited (kept
//! for parity with the TS type even though — as in TS — the room description prints on every visit
//! regardless; `first_visit` only paces presentation, which this client doesn't yet animate).

use std::collections::BTreeSet;

use wickedways_core::presentation::PresentationCue;
use wickedways_core::world::intent::Intent;
use wickedways_core::world::submit::MobAttack;
use wickedways_core::world::view::{ScopeEntity, ViewModel};

use crate::parser::Query;

fn sentence(items: &[String], head: &str) -> Option<String> {
    if items.is_empty() {
        None
    } else {
        Some(format!("{head} {}.", items.join(", ")))
    }
}

/// The room description split into presentation parts. Mirrors TS `RoomParts`.
#[derive(Clone, Debug, PartialEq)]
pub struct RoomParts {
    pub header: String,
    pub description: Option<String>,
    pub body: Vec<String>,
    /// True the first time a room is described this session — pacing only (the
    /// description prints on every visit).
    pub first_visit: bool,
}

#[derive(Default)]
pub struct Narrator {
    visited: BTreeSet<String>,
}

impl Narrator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn render_room_parts(&mut self, vm: &ViewModel) -> RoomParts {
        let header = vm.room.name.clone();
        let first_visit = !self.visited.contains(&vm.room.id);
        self.visited.insert(vm.room.id.clone());
        // The room description prints on every visit (firstVisit only paces typing).
        let description = Some(vm.room.description.clone());

        let mut body: Vec<String> = Vec::new();
        if !vm.room.is_lit {
            body.push("It is pitch dark. You can see nothing.".to_string());
            return RoomParts { header, description, body, first_visit };
        }

        // Loot ("Here: …") and exits ("Exits: …") live in the persistent bottom HUD, not the
        // scrolling transcript. Only occupants stay in the transcript body. Defeated mobs linger
        // in the room (KO is a downed status, not removal) but are no longer "present" — list
        // only the living.
        let living: Vec<String> = vm
            .occupants
            .iter()
            .filter(|o| o.defeated != Some(true))
            .map(|o| o.name.clone())
            .collect();
        if let Some(line) = sentence(&living, "You see") {
            body.push(line);
        }

        RoomParts { header, description, body, first_visit }
    }

    pub fn render_room(&mut self, vm: &ViewModel) -> Vec<String> {
        let parts = self.render_room_parts(vm);
        let mut lines = vec![parts.header];
        if let Some(d) = parts.description {
            lines.push(d);
        }
        lines.extend(parts.body);
        lines
    }

    pub fn render_cues(&self, cues: &[PresentationCue]) -> Vec<String> {
        let mut lines = Vec::new();
        for cue in cues {
            match cue {
                PresentationCue::Mechanic { cue } => {
                    if let Some(text) = &cue.text {
                        lines.push(text.clone());
                    }
                }
                PresentationCue::Encounter { mob, .. } => lines.push(format!("A {} is here.", mob.name)),
                PresentationCue::Visibility { lit, .. } => lines.push(
                    if *lit { "Light spills into the room.".to_string() } else { "Darkness closes in.".to_string() },
                ),
                PresentationCue::Resolution { narration, .. } => {
                    if let Some(text) = narration.as_ref().and_then(|n| n.text.as_ref()) {
                        lines.push(String::new());
                        lines.push(text.clone());
                    }
                }
                // movement/attack already implied by room re-render; keep terse
                PresentationCue::Action { .. } => {}
                // status cues render in the HUD, not the transcript
                PresentationCue::Status { .. } => {}
            }
        }
        lines
    }

    pub fn render_query(&mut self, query: Query, vm: &ViewModel) -> Vec<String> {
        match query {
            Query::Look => self.render_room(vm),
            Query::Inventory => {
                let names: Vec<String> = vm
                    .inventory
                    .items
                    .iter()
                    .chain(vm.inventory.keys.iter())
                    .map(|i| i.name.clone())
                    .collect();
                if names.is_empty() {
                    vec!["You are carrying nothing.".to_string()]
                } else {
                    vec![format!("You are carrying: {}.", names.join(", "))]
                }
            }
            Query::Exits => {
                let mut ways: Vec<String> =
                    vm.exits.iter().map(|e| format!("{} to the {}", e.dir.as_key(), e.to_name)).collect();
                ways.extend(
                    vm.locked_doors.iter().map(|d| format!("{} (the {}, locked)", d.dir.as_key(), d.name)),
                );
                if ways.is_empty() {
                    vec!["There are no obvious exits.".to_string()]
                } else {
                    vec![format!("Exits: {}.", ways.join(", "))]
                }
            }
            Query::Help => vec![
                "go <dir> (n/s/e/w/ne/nw/se/sw) — walk; into a locked door with its key opens it".into(),
                "look — describe the room again".into(),
                "examine / read <thing> — inspect something closely".into(),
                "take / drop <thing> — pick up or set down".into(),
                "open <chest> — open a container".into(),
                "equip / use <thing> — wield, wear, or use an item".into(),
                "attack <foe> — strike an enemy".into(),
                "inventory — what you are carrying".into(),
                "exits — the ways out of this room".into(),
                "wait — let a turn pass".into(),
                "map — show the explored map".into(),
                "save / restore — store or reload your game".into(),
                "undo — take back the last turn".into(),
                "restart — begin again from the start".into(),
                "fullscreen — toggle fullscreen".into(),
                "audio — toggle sound".into(),
                "help — show this list".into(),
            ],
        }
    }

    /// Loot containers carry their full description as `name` (e.g. "A hall table with a single
    /// drawer."), so strip a leading article and trailing period before the "the …" frame to avoid
    /// "the A hall table…..". Bare item/occupant names have neither, so this is a no-op for them.
    pub fn render_examine(&self, target: &ScopeEntity) -> Vec<String> {
        let noun = strip_trailing_period(strip_leading_article(&target.name));
        vec![format!("You look closely at the {noun}. Nothing more reveals itself — yet.")]
    }

    /// Confirmation line(s) for a state-changing action. The engine emits only a terse `action` cue
    /// (kind + actor, no item name), so feedback for take/drop/open/equip/use is synthesized here
    /// from the parsed intent and the before/after viewmodels. `move` and `talk` return nothing —
    /// the room re-render (and dialogue cues) already speak for them.
    pub fn render_action(&self, intent: &Intent, before: &ViewModel, after: &ViewModel) -> Vec<String> {
        // Resolve a target's display name from either view's scope. `before` covers
        // take/drop/equip (item still visible beforehand); `after` covers unequip (the item only
        // re-enters inventory scope once unequipped).
        let name_of = |id: &str| -> String {
            for v in [before, after] {
                if let Some(hit) = v.scope.iter().find(|e| e.id == id) {
                    return hit.name.clone();
                }
            }
            "it".to_string()
        };

        match intent {
            Intent::Take { target_id } => vec![format!("You take the {}.", name_of(target_id))],
            Intent::Drop { target_id } => vec![format!("You set down the {}.", name_of(target_id))],
            Intent::Equip { target_id } => vec![format!("You ready the {}.", name_of(target_id))],
            Intent::Unequip { target_id } => vec![format!("You put away the {}.", name_of(target_id))],
            Intent::Use { target_id } => vec![format!("You use the {}.", name_of(target_id))],
            Intent::Open { target_id } => {
                let contents: Vec<String> = before
                    .loot
                    .iter()
                    .find(|l| &l.id == target_id)
                    .or_else(|| after.loot.iter().find(|l| &l.id == target_id))
                    .map(|b| b.contents.iter().map(|c| c.name.clone()).collect())
                    .unwrap_or_default();
                if contents.is_empty() {
                    vec!["You open it. It is empty.".to_string()]
                } else {
                    vec![format!("You open it. Inside: {}.", contents.join(", "))]
                }
            }
            Intent::Wait => vec!["You wait. The house holds its breath.".to_string()],
            Intent::Attack { target_id } => {
                let target = before.occupants.iter().find(|o| &o.id == target_id);
                let result = after.occupants.iter().find(|o| &o.id == target_id);
                let name = target
                    .or(result)
                    .map(|o| o.name.clone())
                    .unwrap_or_else(|| "it".to_string());
                let was_defeated = target.and_then(|t| t.defeated).unwrap_or(false);
                let now_defeated = result.and_then(|r| r.defeated).unwrap_or(false);
                if now_defeated && !was_defeated {
                    vec![format!("You strike the {name} down. It leaves its remains behind.")]
                } else {
                    let damage = target.and_then(|t| t.health).unwrap_or(0.0)
                        - result.and_then(|r| r.health).unwrap_or(0.0);
                    if damage > 0.0 {
                        vec![format!("You hit the {name} for {damage} Health.")]
                    } else {
                        vec![format!("Your blow glances off the {name}.")]
                    }
                }
            }
            Intent::Harvest { target_id } => vec![format!("You strip the {} of its materials.", name_of(target_id))],
            Intent::Craft { recipe_id } => vec![format!("You forge the {}.", name_of(recipe_id))],
            Intent::Repair { target_id } => vec![format!("You mend the {}, good as new.", name_of(target_id))],
            Intent::Destroy { target_id } => vec![format!("You break the {} down for parts.", name_of(target_id))],
            Intent::Move { .. } | Intent::Talk { .. } => Vec::new(),
        }
    }

    /// Renders incoming mob strikes, each naming the stat lost so the player sees what kind of harm
    /// landed (Sanity vs Health vs Energy).
    pub fn render_mob_attacks(&self, attacks: &[MobAttack]) -> Vec<String> {
        // Shares the single prose source with the solo turn loop (which emits the same lines as
        // mechanic cues); see `MobAttack::narration`.
        attacks.iter().map(|a| a.narration()).collect()
    }
}

fn strip_leading_article(name: &str) -> &str {
    let lower = name.to_lowercase();
    for article in ["a ", "an ", "the "] {
        if lower.starts_with(article) {
            return &name[article.len()..];
        }
    }
    name
}

fn strip_trailing_period(s: &str) -> String {
    let trimmed = s.trim_end();
    trimmed.strip_suffix('.').map(str::trim_end).unwrap_or(trimmed).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use wickedways_core::world::direction::Direction;
    use wickedways_core::world::view::{ExitView, Inventory, LootView, StatusView, ThinRoom};
    use wickedways_core::presentation::CampaignOutcome;
    use wickedways_core::StatType;

    fn entity(id: &str, name: &str, kind: &str) -> ScopeEntity {
        ScopeEntity {
            id: id.into(),
            name: name.into(),
            aliases: Vec::new(),
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
            talkable: None, player: None,
        }
    }

    fn occupant(id: &str, name: &str, health: f64, defeated: bool) -> ScopeEntity {
        ScopeEntity { health: Some(health), defeated: Some(defeated), ..entity(id, name, "occupant") }
    }

    fn base_vm() -> ViewModel {
        ViewModel {
            room: ThinRoom { id: "hall".into(), name: "Hall".into(), description: "A long central hall.".into(), is_lit: true },
            exits: vec![ExitView { dir: Direction::North, to_name: "Landing".into() }],
            locked_doors: Vec::new(),
            occupants: Vec::new(),
            loot: Vec::new(),
            caches: Vec::new(),
            inventory: Inventory { items: Vec::new(), keys: Vec::new(), equipped_names: Vec::new(), slots: 0 },
            scope: Vec::new(),
            materials: Vec::new(),
            recipes: Vec::new(),
            status: StatusView { location_name: "Hall".into(), turn: 1, max_turns: 150, health: 10.0, sanity: 10.0 },
            outcome: CampaignOutcome::Ongoing,
            finished: false,
        }
    }

    #[test]
    fn render_room_gives_the_full_description_on_every_visit() {
        let mut n = Narrator::new();
        let first = n.render_room(&base_vm()).join("\n");
        assert!(first.contains("A long central hall."));
        let second = n.render_room(&base_vm()).join("\n");
        assert!(second.contains("A long central hall."));
        assert!(second.contains("Hall"));
    }

    #[test]
    fn render_room_parts_header_is_the_bare_room_name() {
        let mut n = Narrator::new();
        let parts = n.render_room_parts(&base_vm());
        assert_eq!(parts.header, "Hall");
    }

    #[test]
    fn render_room_parts_body_contains_living_occupants_only() {
        let mut n = Narrator::new();
        let mut vm = base_vm();
        vm.occupants = vec![occupant("ghost", "ghost", 3.0, false), occupant("corpse", "Wraith", 0.0, true)];
        let parts = n.render_room_parts(&vm);
        let body = parts.body.join("\n");
        assert!(body.contains("You see ghost."));
        assert!(!body.contains("Wraith"));
    }

    #[test]
    fn render_room_parts_dark_room_reports_darkness_but_keeps_description() {
        let mut n = Narrator::new();
        let mut vm = base_vm();
        vm.room = ThinRoom { id: "cellar".into(), name: "Cellar".into(), description: "A dank cellar.".into(), is_lit: false };
        let parts = n.render_room_parts(&vm);
        assert_eq!(parts.description.as_deref(), Some("A dank cellar."));
        assert!(parts.body.contains(&"It is pitch dark. You can see nothing.".to_string()));
    }

    #[test]
    fn render_room_and_render_room_parts_produce_the_same_flat_lines() {
        let mut n1 = Narrator::new();
        let mut n2 = Narrator::new();
        let flat = n1.render_room(&base_vm());
        let parts = n2.render_room_parts(&base_vm());
        let mut from_parts = vec![parts.header];
        from_parts.extend(parts.description);
        from_parts.extend(parts.body);
        assert_eq!(flat, from_parts);
    }

    #[test]
    fn render_action_take_names_the_item() {
        let n = Narrator::new();
        let journal = entity("journal", "Water-Stained Journal", "item");
        let mut before = base_vm();
        before.scope = vec![journal.clone()];
        let mut after = base_vm();
        after.scope = vec![journal.clone()];
        after.inventory = Inventory { items: vec![journal], keys: Vec::new(), equipped_names: Vec::new(), slots: 6 };
        let line = n.render_action(&Intent::Take { target_id: "journal".into() }, &before, &after).join(" ");
        assert!(line.contains("Water-Stained Journal"));
    }

    #[test]
    fn render_action_open_lists_contents() {
        let n = Narrator::new();
        let journal = entity("journal", "Water-Stained Journal", "item");
        let mut before = base_vm();
        before.loot = vec![LootView {
            id: "drawer".into(),
            description: "A hall table with a single drawer.".into(),
            opened: true,
            contents: vec![journal.clone()],
        }];
        before.scope = vec![journal];
        let line = n.render_action(&Intent::Open { target_id: "drawer".into() }, &before, &before).join(" ");
        assert!(line.contains("Water-Stained Journal"));
    }

    #[test]
    fn render_action_move_is_silent() {
        let n = Narrator::new();
        let vm = base_vm();
        assert!(n.render_action(&Intent::Move { dir: Direction::North }, &vm, &vm).is_empty());
    }

    #[test]
    fn render_action_attack_reports_damage_dealt() {
        let n = Narrator::new();
        let mut before = base_vm();
        before.occupants = vec![occupant("w", "Wraith", 6.0, false)];
        let mut after = base_vm();
        after.occupants = vec![occupant("w", "Wraith", 4.0, false)];
        let line = n.render_action(&Intent::Attack { target_id: "w".into() }, &before, &after).join(" ");
        assert!(line.contains("for 2 Health"));
    }

    #[test]
    fn render_action_attack_announces_a_killing_blow() {
        let n = Narrator::new();
        let mut before = base_vm();
        before.occupants = vec![occupant("w", "Wraith", 1.0, false)];
        let mut after = base_vm();
        after.occupants = vec![occupant("w", "Wraith", 0.0, true)];
        let line = n.render_action(&Intent::Attack { target_id: "w".into() }, &before, &after).join(" ").to_lowercase();
        assert!(line.contains("down"));
    }

    #[test]
    fn render_action_attack_notes_a_glancing_blow() {
        let n = Narrator::new();
        let mut before = base_vm();
        before.occupants = vec![occupant("w", "Wraith", 6.0, false)];
        let after = before.clone();
        let line = n.render_action(&Intent::Attack { target_id: "w".into() }, &before, &after).join(" ").to_lowercase();
        assert!(line.contains("glance"));
    }

    #[test]
    fn render_examine_strips_article_and_avoids_a_doubled_period() {
        let n = Narrator::new();
        let loot = entity("table", "A hall table with a single drawer.", "loot");
        let line = n.render_examine(&loot).join(" ");
        assert!(!line.contains("the A "));
        assert!(!line.contains(".."));
        assert!(line.contains("the hall table with a single drawer."));
    }

    #[test]
    fn render_examine_leaves_a_plain_item_name_untouched() {
        let n = Narrator::new();
        let item = entity("j", "Water-Stained Journal", "item");
        assert!(n.render_examine(&item).join(" ").contains("the Water-Stained Journal."));
    }

    #[test]
    fn render_mob_attacks_names_the_stat_lost() {
        let n = Narrator::new();
        let lines = n.render_mob_attacks(&[
            MobAttack { name: "Wraith".into(), stat: StatType::Sanity, amount: 3.0 },
            MobAttack { name: "Revenant".into(), stat: StatType::Health, amount: 2.0 },
        ]);
        assert!(lines[0].contains("Wraith"));
        assert!(lines[0].contains("3 Sanity"));
        assert!(lines[0].to_lowercase().contains("mind"));
        assert!(lines[1].contains("2 Health"));
    }

    #[test]
    fn render_mob_attacks_renders_nothing_for_no_attacks() {
        assert!(Narrator::new().render_mob_attacks(&[]).is_empty());
    }

    #[test]
    fn render_cues_passes_mechanic_text_verbatim() {
        use wickedways_core::presentation::MechanicCue;
        let n = Narrator::new();
        let cues = vec![PresentationCue::Mechanic { cue: MechanicCue { text: Some("The cellar reeks of old water.".into()), sound: None } }];
        assert!(n.render_cues(&cues).contains(&"The cellar reeks of old water.".to_string()));
    }

    #[test]
    fn render_cues_renders_a_resolution_cue_as_the_closing_line() {
        use wickedways_core::presentation::OutcomeNarration;
        let n = Narrator::new();
        let cues = vec![PresentationCue::Resolution {
            outcome: CampaignOutcome::Won,
            reason: None,
            narration: Some(OutcomeNarration { text: Some("You may leave.".into()), sound: None }),
        }];
        assert!(n.render_cues(&cues).join("\n").contains("You may leave."));
    }
}
