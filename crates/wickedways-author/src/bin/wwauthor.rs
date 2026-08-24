//! `wwauthor` — compile a campaign TOML into its `description.json` + `catalog.json`.
//!
//! Usage: `wwauthor <campaign.toml>`
//!
//! Reads the TOML path from argv, [`compile_all`](wickedways_author::compile_all)s it, and
//! writes `<stem>.description.json` + `<stem>.catalog.json` (pretty-printed, trailing
//! newline) beside the input. Compile failures print EVERY collected finding to stderr
//! (one line each, labeled with its body's TOML path) and exit non-zero; author input
//! never panics.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use wickedways_author::compile_all;

fn main() -> ExitCode {
    let mut args = std::env::args_os().skip(1);
    let input = match args.next() {
        Some(p) => PathBuf::from(p),
        None => {
            eprintln!("usage: wwauthor <campaign.toml>");
            return ExitCode::FAILURE;
        }
    };

    match run(&input) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}

/// Compile `input` and write the two JSON artifacts beside it. Returns the
/// message to print on failure (an I/O message or the `CompileError` `Display`).
fn run(input: &Path) -> Result<(), String> {
    let toml_src = std::fs::read_to_string(input)
        .map_err(|e| format!("failed to read {}: {e}", input.display()))?;

    // The collect-all compile: report every broken body at once (each finding
    // labeled with its TOML path), not just the first — the modder's fix loop.
    let compiled = compile_all(&toml_src).map_err(|errors| {
        let mut msg = format!("{} compile finding(s):", errors.len());
        for e in &errors {
            msg.push_str("\n  ");
            msg.push_str(&e.to_string());
        }
        msg
    })?;

    let description = serde_json::to_string_pretty(&compiled.description)
        .map_err(|e| format!("failed to serialize description: {e}"))?;
    let catalog = serde_json::to_string_pretty(&compiled.catalog)
        .map_err(|e| format!("failed to serialize catalog: {e}"))?;

    write_beside(input, "description.json", &description)?;
    write_beside(input, "catalog.json", &catalog)?;
    Ok(())
}

/// Write `<input-stem>.<suffix>` next to `input`, with a trailing newline.
fn write_beside(input: &Path, suffix: &str, contents: &str) -> Result<(), String> {
    let stem = input
        .file_stem()
        .ok_or_else(|| format!("input path has no file name: {}", input.display()))?;
    let mut name = stem.to_os_string();
    name.push(".");
    name.push(suffix);
    let out = input.with_file_name(name);
    std::fs::write(&out, format!("{contents}\n"))
        .map_err(|e| format!("failed to write {}: {e}", out.display()))
}
