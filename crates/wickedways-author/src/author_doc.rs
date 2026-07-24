use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorDoc {
    pub title: String,
    #[serde(default)]
    pub start_room: Option<String>,
    /// Campaign bounds (`maxRounds` / `baseEncounterChance`). Deserializes straight
    /// into the description's `CampaignOpts`; absent → its default (both `None`, so
    /// `assemble` applies the engine defaults maxRounds 100 / baseEncounterChance 20).
    #[serde(default)]
    pub opts: wickedways_assemble::description::CampaignOpts,
    #[serde(default)]
    pub archetypes: Vec<ArchetypeEntry>,
    #[serde(default)]
    pub rooms: Vec<RoomEntry>,
    #[serde(default)]
    pub exits: Vec<ExitEntry>,
    #[serde(default)]
    pub items: Vec<ItemEntry>,
    #[serde(default)]
    pub loot: Vec<LootEntry>,
    #[serde(default)]
    pub caches: Vec<CacheEntry>,
    #[serde(default)]
    pub recipes: Vec<RecipeEntry>,
    #[serde(default)]
    pub scenes: Vec<SceneEntry>,
    #[serde(default)]
    pub npcs: Vec<NpcEntry>,
    #[serde(default)]
    pub mobs: Vec<MobEntry>,
    #[serde(default)]
    pub formations: Vec<FormationEntry>,
    #[serde(default)]
    pub mechanics: Vec<MechanicEntryToml>,
    #[serde(default)]
    pub behaviors: Behaviors,
    #[serde(default)]
    pub victory: Victory,
    /// Narration shown when the campaign hits its round limit. A plain string lowers
    /// to the cue shape `{ "text": … }` (the description's `timeout_narration`).
    #[serde(default)]
    pub timeout_narration: Option<String>,
}

/// A `[[archetypes]]` entry: a player-character template. `base_stats` is a
/// stat-name → value map (`PartialStats`); `inventory_slots` overrides the default
/// slot count; `immunities` lists status keys the archetype resists. Mirrors the
/// description's `ArchetypeDef` (absent `baseStats`/`inventorySlots` → `None`,
/// absent `immunities` → empty).
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchetypeEntry {
    pub id: String,
    pub name: String,
    #[serde(default)] pub base_stats: Option<BTreeMap<String, f64>>,
    #[serde(default)] pub inventory_slots: Option<i64>,
    #[serde(default)] pub immunities: Vec<String>,
}

/// A `[[rooms]]` entry. `dark` marks a room unlit (the darkness mechanic);
/// `spawn_modifier` biases its encounter roll; `lights` lists item keys that light
/// it. Each is optional (absent `dark`/`spawnModifier` → `None`, absent `lights` →
/// empty) — mirrors the description's `RoomDef`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoomEntry {
    pub name: String,
    pub description: String,
    #[serde(default)] pub dark: Option<bool>,
    #[serde(default)] pub spawn_modifier: Option<i64>,
    #[serde(default)] pub lights: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExitEntry {
    pub from: String,
    pub to: String,
    pub direction: String,
    #[serde(default)] pub behavior: Option<String>,
    /// A display name for the exit (e.g. "cellar door"); absent → `None`.
    #[serde(default)] pub name: Option<String>,
    /// Seed state for a stateful exit (e.g. a keyed door's `{ unlocked = false }`),
    /// inert author-data (`toml::Value` → `serde_json::Value`); absent → `None`.
    #[serde(default)] pub initial_state: Option<toml::Value>,
    #[serde(default)] pub one_way: Option<bool>,
}

/// A `[[items]]` entry. A `keyCode` entry lowers to a key `ItemDescriptor`
/// (unchanged from the MVP); a `type = "consumable"` entry carries the consumable
/// descriptor fields below (`stat`/`modifier`/`usable`/`destroyable` + the inert
/// `recipe` crafting map — author-data, since consumables vary in recipe).
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ItemEntry {
    pub key: String,
    pub name: String,
    #[serde(default)] pub key_code: Option<String>,
    #[serde(default, rename = "type")] pub type_: Option<String>,
    #[serde(default)] pub stat: Option<String>,
    #[serde(default)] pub modifier: Option<i64>,
    #[serde(default)] pub usable: Option<bool>,
    #[serde(default)] pub destroyable: Option<bool>,
    #[serde(default)] pub recipe: Option<toml::Value>,
    // Full-descriptor fields (equippables, light sources, durable weapons, lore).
    // Each is optional; absent → the descriptor's skip-when-`None`/`false` default.
    #[serde(default)] pub equippable: Option<bool>,
    #[serde(default)] pub droppable: Option<bool>,
    #[serde(default)] pub slot: Option<String>,
    #[serde(default)] pub two_handed: Option<bool>,
    #[serde(default)] pub emits_light: Option<bool>,
    #[serde(default)] pub max_durability: Option<i64>,
    #[serde(default)] pub lore: Option<String>,
    /// Name aliases the play surface resolves this item by (e.g. `lamp`/`light` for
    /// the lantern). Lowered into `catalog.aliases[<key>]`; absent → no alias entry.
    #[serde(default)] pub aliases: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LootEntry { pub name: String, pub room: String, pub items: Vec<String>,
    #[serde(default)] pub description: Option<String> }

/// A `[[caches]]` entry: a single-use pile of raw crafting materials placed in a
/// room. Mirrors the description's `CacheDef { name, room, materials }`; harvesting
/// empties it into the campaign pool. `materials` is a `{ component = qty }` table
/// (e.g. `materials = { iron = 3, cloth = 1 }`).
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CacheEntry {
    pub name: String,
    pub room: String,
    pub materials: BTreeMap<String, i64>,
}

/// A `[[recipes]]` entry: a crafting recipe the party knows from the start. `id` is
/// the recipe key (added to the description's `recipes` known-set); `output_item`
/// names the `[[items]]` key the recipe instantiates; `materials` is the `{ component
/// = qty }` cost withdrawn from the shared pool. Lowers to a `catalog.recipes`
/// `RecipeMeta { id, outputName, materials, outputItemKey }`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecipeEntry {
    pub id: String,
    pub output_name: String,
    pub output_item: String,
    pub materials: BTreeMap<String, i64>,
}

/// A scene attached to a room (`[[scenes]]`). Mirrors the description's
/// `SceneDef { room, key, phase?, initialState? }`. `phase` selects the
/// enter/exit hook the SceneDef attaches to (default `"enter"`); `initial_state`
/// seeds the scene's state map when present.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneEntry {
    pub room: String,
    pub key: String,
    #[serde(default)] pub phase: Option<String>,
    #[serde(default)] pub initial_state: Option<toml::Value>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Behaviors {
    #[serde(default)] pub exit: BTreeMap<String, ExitBehaviorEntry>,
    #[serde(default)] pub scene: BTreeMap<String, SceneBehaviorEntry>,
    #[serde(default)] pub item: BTreeMap<String, ItemBehaviorEntry>,
    #[serde(default)] pub npc: BTreeMap<String, NpcBehaviorEntry>,
    #[serde(default)] pub mechanic: BTreeMap<String, MechanicBehaviorEntry>,
}

/// A `[[mechanics]]` entry: a placed mechanic. `key` names the
/// `[behaviors.mechanic.<key>]` body (the shared-key link); `config` is inert
/// author-data (mechanic-specific configuration), deferred this slice.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MechanicEntryToml {
    pub key: String,
    #[serde(default)] pub config: Option<toml::Value>,
}

/// A `[behaviors.mechanic.<key>]` body, keyed the same as its `[[mechanics]]`
/// entry's `key`. `init` is a literal state seed (inert author-data, becomes the
/// mechanic's `initialState`); the five `on_*` hooks are statement-block bodies
/// (the `'''...'''` grammar) lowering to `MechanicScript` hooks. `modify_damage`
/// is a `modifyDamage` transform body (its own `final`/ternary/value grammar);
/// `actions` maps each custom-action key to a statement-block body. Each field is
/// optional (absent init → `{}`; absent hook/transform → no-op; no `actions` → an
/// empty map).
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MechanicBehaviorEntry {
    #[serde(default)] pub init: Option<toml::Value>,
    #[serde(default)] pub on_round_start: Option<String>,
    #[serde(default)] pub on_round_end: Option<String>,
    #[serde(default)] pub on_turn_start: Option<String>,
    #[serde(default)] pub on_turn_end: Option<String>,
    #[serde(default)] pub on_action: Option<String>,
    #[serde(default)] pub modify_damage: Option<String>,
    #[serde(default)] pub actions: BTreeMap<String, String>,
}

/// A `[[formations]]` entry: a data-driven encounter formation. It carries BOTH
/// halves of a formation — the description-side `weight` opt-in (a `FormationDef`)
/// and the catalog-side `mobs` roster (a `FormationDescriptor` of core `MobSpec`s) —
/// keyed the same. `mobs` deserializes straight into the core spec (same camelCase
/// shape); absent `weight` → `None`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FormationEntry {
    pub key: String,
    #[serde(default)] pub weight: Option<i64>,
    #[serde(default)] pub mobs: Vec<wickedways_core::world::formation_descriptor::MobSpec>,
}

/// A `[[mobs]]` entry: a placed enemy. `stats` is the core `Stats` snapshot (same
/// shape as npcs); `drops` lists item keys it drops on defeat; `natural_attack` is
/// its `{stat, power}` unarmed attack (inert author-data, `toml::Value` →
/// `serde_json::Value`). The remaining overrides
/// (`inventory_slots`/`actions_per_round`/`base_escape_chance`/`material_drops`/
/// `light_averse`) are optional; absent → the engine's mob defaults.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MobEntry {
    pub name: String,
    pub stats: wickedways_core::world::snapshot::Stats,
    #[serde(default)] pub room: Option<String>,
    #[serde(default)] pub drops: Vec<String>,
    #[serde(default)] pub natural_attack: Option<toml::Value>,
    #[serde(default)] pub inventory_slots: Option<i64>,
    #[serde(default)] pub actions_per_round: Option<i64>,
    #[serde(default)] pub base_escape_chance: Option<i64>,
    #[serde(default)] pub material_drops: Option<toml::Value>,
    #[serde(default)] pub light_averse: Option<bool>,
}

/// A `[[npcs]]` entry: a placed NPC character. `stats` is the core `Stats`
/// snapshot (`energy`/`sanity`/`health`, all `f64`); `behavior` names the
/// `[behaviors.npc.<key>]` dialogue body; `holds` lists item keys it carries.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NpcEntry {
    pub name: String,
    pub stats: wickedways_core::world::snapshot::Stats,
    #[serde(default)] pub room: Option<String>,
    pub behavior: String,
    #[serde(default)] pub holds: Vec<String>,
}

/// A `[behaviors.npc.<key>]` body, keyed the same as its `[[npcs]]` entry's
/// `behavior`. A `description` (returned by `examine`), a `default` dialogue
/// entry (bare `talk`), and ordered prompt→response `dialogue` entries. Lowers
/// to `NpcScript`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NpcBehaviorEntry {
    pub description: String,
    pub default: DialogueEntryToml,
    #[serde(default)] pub dialogue: Vec<DialogueEntryToml>,
}

/// One authored dialogue entry: a `match` rule (a bare string → exact, or a
/// `{ fuzzy = [...] }` table → fuzzy), a text `response`, an optional `effects`
/// statement-block body, and a `once` latch.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DialogueEntryToml {
    #[serde(rename = "match")] pub match_: MatchToml,
    pub response: String,
    #[serde(default)] pub once: bool,
    #[serde(default)] pub effects: Option<String>,
}

/// The polymorphic match surface: a bare TOML string → `Exact`, a
/// `{ fuzzy = [...] }` table → `Fuzzy`. Untagged, so `deny_unknown_fields`
/// is NOT supported here (and intentionally omitted).
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum MatchToml {
    Exact(String),
    Fuzzy { fuzzy: Vec<String> },
}

/// A `[behaviors.item.<key>]` body, keyed the same as its `[[items]]` entry (the
/// shared-key link). `on_use`/`on_read` are statement-block bodies (the `'''...'''`
/// grammar) lowering to `ItemScript { on_use, on_read }`. Each is optional (absent
/// = that hook stays native / a no-op).
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ItemBehaviorEntry {
    #[serde(default)] pub on_use: Option<String>,
    #[serde(default)] pub on_read: Option<String>,
}

/// A `[behaviors.scene.<key>]` body. `can_play` is an expression string gating
/// whether the scene may play; `on_enter`/`on_exit` are statement-block bodies
/// (the `'''...'''` grammar). Each is optional (absent = no-op / always plays).
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneBehaviorEntry {
    #[serde(default)] pub can_play: Option<String>,
    #[serde(default)] pub on_enter: Option<String>,
    #[serde(default)] pub on_exit: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExitBehaviorEntry {
    pub can_pass: String,
    /// Optional narration script run on a successful pass (a script body — `pass
    /// <expr>` is legal here). Absent → an empty `run_script`.
    #[serde(default)] pub run_script: Option<String>,
    #[serde(default)] pub pass_message: Option<String>,
    #[serde(default)] pub fail_message: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Victory {
    #[serde(default)] pub win: Vec<ConditionEntry>,
    #[serde(default)] pub lose: Vec<ConditionEntry>,
}

/// A `[[victory.win]]` / `[[victory.lose]]` entry. An ARRAY of tables (not a
/// `[victory.win.<key>]` map) so the author controls the win/lose ORDER — the
/// description's `winConditions`/`loseConditions` are ordered arrays, and a real
/// campaign's order need not be alphabetical. `key` names the condition (shared
/// with its catalog `BehaviorScript::Victory`); `test` is the predicate expression.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConditionEntry {
    pub key: String,
    pub test: String,
    #[serde(default)] pub narration: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_minimal_surface() {
        let src = r#"
            title = "Vault"
            startRoom = "Hall"
            [[rooms]]
            name = "Hall"
            description = "A cold stone hall."
            [[exits]]
            from = "Hall"
            to = "Vault"
            direction = "north"
            behavior = "vault-door"
            [behaviors.exit.vault-door]
            canPass = "hasKey(actor, 'vault')"
            failMessage = "Locked."
            [[victory.win]]
            key = "reached-vault"
            test = "party[0].room.name == 'Vault'"
        "#;
        let doc: AuthorDoc = toml::from_str(src).expect("parse");
        assert_eq!(doc.title, "Vault");
        assert_eq!(doc.start_room.as_deref(), Some("Hall"));
        assert_eq!(doc.rooms.len(), 1);
        assert_eq!(doc.exits[0].behavior.as_deref(), Some("vault-door"));
        assert_eq!(doc.behaviors.exit["vault-door"].can_pass, "hasKey(actor, 'vault')");
        assert_eq!(doc.victory.win[0].key, "reached-vault");
        assert_eq!(doc.victory.win[0].test, "party[0].room.name == 'Vault'");
    }

    #[test]
    fn parses_the_scene_surface() {
        let src = r#"
            title = "Scene"
            [[scenes]]
            room = "Threshold"
            key = "threshold-draft"
            phase = "enter"
            [behaviors.scene.threshold-draft]
            canPlay = "!stateGet('seen', false)"
            onEnter = '''
              guard round == 0
              when !stateGet('revealed', false) {
                emit cue('A cold draft stirs the dust of the threshold.')
                set state.revealed = true
              }
              set state.seen = true
            '''
        "#;
        let doc: AuthorDoc = toml::from_str(src).expect("parse");
        assert_eq!(doc.scenes.len(), 1);
        assert_eq!(doc.scenes[0].room, "Threshold");
        assert_eq!(doc.scenes[0].key, "threshold-draft");
        assert_eq!(doc.scenes[0].phase.as_deref(), Some("enter"));
        assert!(doc.scenes[0].initial_state.is_none());
        let sb = &doc.behaviors.scene["threshold-draft"];
        assert_eq!(sb.can_play.as_deref(), Some("!stateGet('seen', false)"));
        assert!(sb.on_enter.as_deref().unwrap().contains("guard round == 0"));
        assert!(sb.on_enter.as_deref().unwrap().contains("emit cue("));
        assert!(sb.on_enter.as_deref().unwrap().contains("set state.seen = true"));
        assert!(sb.on_exit.is_none());
    }

    #[test]
    fn parses_the_consumable_item_surface() {
        let src = r#"
            title = "Item"
            [[items]]
            key = "laudanum"
            name = "Vial of Laudanum"
            type = "consumable"
            stat = "sanity"
            modifier = 6
            usable = true
            destroyable = true
            recipe = { healing = 1 }
            [behaviors.item.laudanum]
            onUse = "emit adjustStat(actor, sanity, 6)"
        "#;
        let doc: AuthorDoc = toml::from_str(src).expect("parse");
        assert_eq!(doc.items.len(), 1);
        let it = &doc.items[0];
        assert_eq!(it.key, "laudanum");
        assert_eq!(it.name, "Vial of Laudanum");
        assert_eq!(it.type_.as_deref(), Some("consumable"));
        assert_eq!(it.stat.as_deref(), Some("sanity"));
        assert_eq!(it.modifier, Some(6));
        assert_eq!(it.usable, Some(true));
        assert_eq!(it.destroyable, Some(true));
        assert!(it.key_code.is_none());
        // recipe is the inert crafting map (author-data): { healing = 1 }.
        let recipe = it.recipe.as_ref().expect("recipe present");
        assert_eq!(recipe.get("healing").and_then(toml::Value::as_integer), Some(1));
        let ib = &doc.behaviors.item["laudanum"];
        assert_eq!(ib.on_use.as_deref(), Some("emit adjustStat(actor, sanity, 6)"));
        assert!(ib.on_read.is_none());
    }

    #[test]
    fn parses_the_mechanic_surface() {
        let src = r#"
            title = "Sanity"
            [[mechanics]]
            key = "dwindling-light"
            config = { threshold = 3 }
            [behaviors.mechanic.dwindling-light]
            init = { turns = 0 }
            onTurnStart = '''
              guard !hasEquipped(actor, 'lantern')
              emit adjustStat(actor, sanity, -1)
            '''
            onRoundEnd = "emit cue('The dark deepens.')"
        "#;
        let doc: AuthorDoc = toml::from_str(src).expect("parse");
        assert_eq!(doc.mechanics.len(), 1);
        let m = &doc.mechanics[0];
        assert_eq!(m.key, "dwindling-light");
        // config is inert author-data (deferred this slice): { threshold = 3 }.
        let config = m.config.as_ref().expect("config present");
        assert_eq!(config.get("threshold").and_then(toml::Value::as_integer), Some(3));
        let mb = &doc.behaviors.mechanic["dwindling-light"];
        let init = mb.init.as_ref().expect("init present");
        assert_eq!(init.get("turns").and_then(toml::Value::as_integer), Some(0));
        assert!(mb.on_turn_start.as_deref().unwrap().contains("guard !hasEquipped"));
        assert!(mb.on_turn_start.as_deref().unwrap().contains("emit adjustStat"));
        assert_eq!(mb.on_round_end.as_deref(), Some("emit cue('The dark deepens.')"));
        assert!(mb.on_round_start.is_none());
        assert!(mb.on_turn_end.is_none());
        assert!(mb.on_action.is_none());
    }

    #[test]
    fn parses_the_npc_surface() {
        let src = r#"
            title = "Manor"
            [[npcs]]
            name = "The Caretaker"
            stats = { health = 1.0, sanity = 1.0, energy = 1.0 }
            room = "Foyer"
            behavior = "caretaker"
            holds = ["cellar-key"]
            [behaviors.npc.caretaker]
            description = "A stooped caretaker."
            [behaviors.npc.caretaker.default]
            match = ""
            response = "Take the key."
            once = true
            effects = "emit setVisible('npc:C', false)"
            [[behaviors.npc.caretaker.dialogue]]
            match = { fuzzy = ["key", "cellar"] }
            response = "It opens the cellar."
        "#;
        let doc: AuthorDoc = toml::from_str(src).expect("parse");
        assert_eq!(doc.npcs.len(), 1);
        let n = &doc.npcs[0];
        assert_eq!(n.name, "The Caretaker");
        assert_eq!(n.stats.health, 1.0);
        assert_eq!(n.stats.sanity, 1.0);
        assert_eq!(n.stats.energy, 1.0);
        assert_eq!(n.room.as_deref(), Some("Foyer"));
        assert_eq!(n.behavior, "caretaker");
        assert_eq!(n.holds, ["cellar-key"]);
        let nb = &doc.behaviors.npc["caretaker"];
        assert_eq!(nb.description, "A stooped caretaker.");
        assert_eq!(nb.default.response, "Take the key.");
        assert_eq!(nb.default.match_, MatchToml::Exact(String::new()));
        assert!(nb.default.once);
        assert_eq!(nb.default.effects.as_deref(), Some("emit setVisible('npc:C', false)"));
        assert_eq!(nb.dialogue.len(), 1);
        assert_eq!(
            nb.dialogue[0].match_,
            MatchToml::Fuzzy { fuzzy: vec!["key".to_string(), "cellar".to_string()] }
        );
        assert_eq!(nb.dialogue[0].response, "It opens the cellar.");
        assert!(!nb.dialogue[0].once);
        assert!(nb.dialogue[0].effects.is_none());
    }
}
