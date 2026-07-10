//! Campaign author: `toml -> (CampaignDescription, Catalog)`.
//! Compiles the friendly TOML surface + an infix expression language into the
//! artifacts `wickedways_assemble::assemble` consumes. Panic-free on author input.
pub mod author_doc;
pub mod error;
pub(crate) mod expr;
pub(crate) mod lower;

use wickedways_assemble::description::CampaignDescription;
use wickedways_core::world::descriptor::Catalog;
use error::CompileError;

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct CompiledCampaign { pub description: CampaignDescription, pub catalog: Catalog }

/// Parse the TOML surface. Lowering (expressions → description/catalog) lands in Tasks 4-5.
pub fn compile(toml_src: &str) -> Result<CompiledCampaign, CompileError> {
    let doc: author_doc::AuthorDoc = toml::from_str(toml_src)
        .map_err(|e| CompileError::TomlParse { message: e.to_string() })?;
    lower::lower(&doc)
}
