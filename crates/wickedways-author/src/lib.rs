//! Campaign author: `toml -> (CampaignDescription, Catalog)`.
//! Compiles the friendly TOML surface + an infix expression language into the
//! artifacts `wickedways_assemble::assemble` consumes. Panic-free on author input.
pub mod author_doc;
pub(crate) mod damage_body;
pub mod error;
pub(crate) mod expr;
pub(crate) mod lower;
pub(crate) mod mechanic;
pub(crate) mod npc;
pub(crate) mod stmt;
pub mod validate;

use error::CompileError;
use wickedways_assemble::description::CampaignDescription;
use wickedways_core::world::descriptor::Catalog;

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct CompiledCampaign {
    pub description: CampaignDescription,
    pub catalog: Catalog,
}

/// Parse the friendly TOML surface and lower it — expressions, statement bodies,
/// and behaviors alike — into the [`CampaignDescription`] + [`Catalog`] pair that
/// `wickedways_assemble::assemble` consumes. Every behavior family the surface
/// defines — exit / victory / scene / item / npc / mechanic — is compiled.
pub fn compile(toml_src: &str) -> Result<CompiledCampaign, CompileError> {
    let doc: author_doc::AuthorDoc =
        toml::from_str(toml_src).map_err(|e| CompileError::TomlParse {
            message: e.to_string(),
        })?;
    lower::lower(&doc)
}

/// One `compile_all` finding: the body it came from (a dotted TOML path like
/// `behaviors.exit.vault-door.canPass`) plus the compiler's error.
#[derive(Clone, Debug, PartialEq)]
pub struct LabeledError {
    pub context: String,
    pub error: CompileError,
}

impl core::fmt::Display for LabeledError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{}: {}", self.context, self.error)
    }
}

/// The collect-all variant of [`compile`] (the editor-tooling seam, spec upstream
/// change #3): instead of stopping at the first error, sweep EVERY DSL body with
/// its slot's parser (via [`validate`]) and report all findings at once, each
/// labeled with the body it came from. A clean sweep then runs the real
/// [`compile`] — the authority — so `Ok` here is exactly `compile`'s `Ok`, and
/// anything only whole-document lowering can catch still surfaces (as one
/// labeled `compile` finding).
pub fn compile_all(toml_src: &str) -> Result<CompiledCampaign, Vec<LabeledError>> {
    let doc: author_doc::AuthorDoc = match toml::from_str(toml_src) {
        Ok(doc) => doc,
        Err(e) => {
            return Err(vec![LabeledError {
                context: "toml".to_string(),
                error: CompileError::TomlParse {
                    message: e.to_string(),
                },
            }]);
        }
    };
    let mut errors: Vec<LabeledError> = Vec::new();
    let mut check = |context: String, result: Result<(), CompileError>| {
        if let Err(error) = result {
            errors.push(LabeledError { context, error });
        }
    };

    for (key, b) in &doc.behaviors.exit {
        check(
            format!("behaviors.exit.{key}.canPass"),
            validate::expression(&b.can_pass),
        );
        if let Some(s) = &b.run_script {
            check(
                format!("behaviors.exit.{key}.runScript"),
                validate::exit_script(s),
            );
        }
    }
    for (key, b) in &doc.behaviors.scene {
        if let Some(s) = &b.can_play {
            check(
                format!("behaviors.scene.{key}.canPlay"),
                validate::expression(s),
            );
        }
        for (hook, body) in [("onEnter", &b.on_enter), ("onExit", &b.on_exit)] {
            if let Some(s) = body {
                check(
                    format!("behaviors.scene.{key}.{hook}"),
                    validate::statements(s),
                );
            }
        }
    }
    for (key, b) in &doc.behaviors.item {
        for (hook, body) in [("onUse", &b.on_use), ("onRead", &b.on_read)] {
            if let Some(s) = body {
                check(
                    format!("behaviors.item.{key}.{hook}"),
                    validate::statements(s),
                );
            }
        }
    }
    for (key, b) in &doc.behaviors.npc {
        for (label, entry) in core::iter::once(("default".to_string(), &b.default)).chain(
            b.dialogue
                .iter()
                .enumerate()
                .map(|(i, e)| (format!("dialogue[{i}]"), e)),
        ) {
            if let Some(s) = &entry.effects {
                check(
                    format!("behaviors.npc.{key}.{label}.effects"),
                    validate::effects(s),
                );
            }
        }
    }
    for (key, b) in &doc.behaviors.mechanic {
        let hooks = [
            ("onRoundStart", &b.on_round_start),
            ("onRoundEnd", &b.on_round_end),
            ("onTurnStart", &b.on_turn_start),
            ("onTurnEnd", &b.on_turn_end),
            ("onAction", &b.on_action),
        ];
        for (hook, body) in hooks {
            if let Some(s) = body {
                check(
                    format!("behaviors.mechanic.{key}.{hook}"),
                    validate::statements(s),
                );
            }
        }
        if let Some(s) = &b.modify_damage {
            check(
                format!("behaviors.mechanic.{key}.modifyDamage"),
                validate::modify_damage(s),
            );
        }
        for (action, s) in &b.actions {
            check(
                format!("behaviors.mechanic.{key}.actions.{action}"),
                validate::statements(s),
            );
        }
    }
    for (key, b) in &doc.behaviors.card {
        if let Some(s) = &b.on_play {
            check(
                format!("behaviors.card.{key}.onPlay"),
                validate::statements(s),
            );
        }
    }
    for (kind, list) in [("win", &doc.victory.win), ("lose", &doc.victory.lose)] {
        for c in list {
            check(
                format!("victory.{kind}.{}.test", c.key),
                validate::expression(&c.test),
            );
        }
    }
    // The one lowering-time reference check with no body of its own: an exit
    // naming an undefined behavior.
    for e in &doc.exits {
        if let Some(key) = &e.behavior {
            if !doc.behaviors.exit.contains_key(key) {
                errors.push(LabeledError {
                    context: format!("exits ({} → {})", e.from, e.to),
                    error: CompileError::UnresolvedKey {
                        kind: "exit behavior",
                        key: key.clone(),
                    },
                });
            }
        }
    }

    if !errors.is_empty() {
        return Err(errors);
    }
    // Clean sweep: the real compiler is the authority. Anything it still rejects
    // (a gap in the sweep) surfaces as a single labeled finding.
    compile(toml_src).map_err(|error| {
        vec![LabeledError {
            context: "compile".to_string(),
            error,
        }]
    })
}

#[cfg(test)]
mod compile_all_tests {
    use super::*;

    #[test]
    fn collects_every_broken_body_at_once() {
        let src = r#"
            title = "Broken"
            [[rooms]]
            name = "A"
            description = "a"
            [[exits]]
            from = "A"
            to = "A"
            direction = "north"
            behavior = "missing-behavior"
            [behaviors.exit.door]
            canPass = "hasKey(actor,"
            [behaviors.item.elixir]
            onUse = "explode everything"
            [[victory.win]]
            key = "w"
            test = "nonsense_subject == 1"
        "#;
        let errors = compile_all(src).unwrap_err();
        let contexts: Vec<&str> = errors.iter().map(|e| e.context.as_str()).collect();
        assert!(contexts.contains(&"behaviors.exit.door.canPass"));
        assert!(contexts.contains(&"behaviors.item.elixir.onUse"));
        assert!(contexts.contains(&"victory.win.w.test"));
        assert!(
            contexts.iter().any(|c| c.starts_with("exits (")),
            "the dangling exit-behavior reference is labeled: {contexts:?}"
        );
        assert!(errors.len() >= 4, "all findings at once: {errors:?}");
    }

    #[test]
    fn agrees_with_compile_on_a_clean_campaign() {
        let src = r#"
            title = "Vault"
            startRoom = "Hall"
            [[rooms]]
            name = "Hall"
            description = "A cold stone hall."
            [[victory.win]]
            key = "endure"
            test = "round == maxRounds"
        "#;
        let a = compile(src).expect("compile ok");
        let b = compile_all(src).expect("compile_all ok");
        assert_eq!(a, b, "Ok is exactly compile's Ok");
    }
}
