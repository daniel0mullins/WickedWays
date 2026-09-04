//! Release tooling: semantic versioning driven by changesets.
//!
//! The workflow (the npm "changesets" model, implemented natively for this Cargo workspace):
//!
//! 1. A change that belongs in the next release's notes records a changeset — a small markdown
//!    file in `.changesets/` naming its semver bump (`major`/`minor`/`patch`) and describing the
//!    change. `cargo xtask add <bump> <summary…>` writes one; CI requires one on code-touching
//!    pull requests (`.github/workflows/changeset.yml`).
//! 2. `cargo xtask release` consumes every pending changeset at once: the largest bump decides
//!    the next version, the entries become a dated CHANGELOG.md section (grouped
//!    breaking/features/fixes), the shared `[workspace.package] version` in the root manifest and
//!    the workspace-excluded `desktop/Cargo.toml` are rewritten, and the consumed files are
//!    deleted. Committing and tagging stay explicit git steps, printed at the end.
//!
//! Everything stateful is a plain textual file transform, so a release is reviewable as a diff
//! and reproducible; the pure helpers are unit-tested below.

use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

/// The semver bump a changeset asks for. Variant order gives `Ord`: a release takes the
/// largest bump among its pending changesets.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Bump {
    Patch,
    Minor,
    Major,
}

impl Bump {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "major" => Some(Self::Major),
            "minor" => Some(Self::Minor),
            "patch" => Some(Self::Patch),
            _ => None,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Major => "major",
            Self::Minor => "minor",
            Self::Patch => "patch",
        }
    }

    /// The CHANGELOG section this bump's entries land under.
    fn heading(self) -> &'static str {
        match self {
            Self::Major => "Breaking changes",
            Self::Minor => "Features",
            Self::Patch => "Fixes",
        }
    }
}

/// A `major.minor.patch` semantic version.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Version {
    major: u64,
    minor: u64,
    patch: u64,
}

impl Version {
    fn parse(s: &str) -> Result<Self, String> {
        let mut parts = s.trim().splitn(3, '.');
        let mut next = |what: &str| -> Result<u64, String> {
            parts
                .next()
                .ok_or_else(|| format!("version `{s}` is missing its {what} component"))?
                .parse()
                .map_err(|_| format!("version `{s}` has a non-numeric {what} component"))
        };
        Ok(Self {
            major: next("major")?,
            minor: next("minor")?,
            patch: next("patch")?,
        })
    }

    fn bumped(self, bump: Bump) -> Self {
        match bump {
            Bump::Major => Self {
                major: self.major + 1,
                minor: 0,
                patch: 0,
            },
            Bump::Minor => Self {
                minor: self.minor + 1,
                patch: 0,
                ..self
            },
            Bump::Patch => Self {
                patch: self.patch + 1,
                ..self
            },
        }
    }
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

/// One pending changeset, loaded from `.changesets/<name>.md`.
#[derive(Debug, PartialEq, Eq)]
struct Changeset {
    /// The file name, the deterministic sort key for CHANGELOG entry order.
    name: String,
    path: PathBuf,
    bump: Bump,
    /// The markdown body after the frontmatter, trimmed.
    body: String,
}

/// Parse a changeset file: a `---`-fenced frontmatter carrying `bump: <major|minor|patch>`,
/// then a non-empty markdown body.
fn parse_changeset(text: &str) -> Result<(Bump, String), String> {
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return Err("must start with a `---` frontmatter fence".into());
    }
    let mut bump = None;
    loop {
        let Some(line) = lines.next() else {
            return Err("frontmatter is never closed with `---`".into());
        };
        let line = line.trim();
        if line == "---" {
            break;
        }
        if let Some(value) = line.strip_prefix("bump:") {
            bump = Some(Bump::parse(value.trim()).ok_or_else(|| {
                format!("unknown bump `{}` (want major|minor|patch)", value.trim())
            })?);
        } else if !line.is_empty() {
            return Err(format!(
                "unknown frontmatter line `{line}` (only `bump:` is understood)"
            ));
        }
    }
    let bump = bump.ok_or("frontmatter is missing `bump: <major|minor|patch>`")?;
    let body = lines.collect::<Vec<_>>().join("\n").trim().to_string();
    if body.is_empty() {
        return Err("the body (the CHANGELOG entry) is empty".into());
    }
    Ok((bump, body))
}

/// Load every pending changeset in `dir` (each `*.md` except `README.md`), sorted by file name.
/// A missing directory is simply "no pending changesets".
fn load_changesets(dir: &Path) -> Result<Vec<Changeset>, String> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("read {}: {e}", dir.display())),
    };
    let mut sets = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("read {}: {e}", dir.display()))?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if path.extension().is_none_or(|ext| ext != "md") || name == "README.md" {
            continue;
        }
        let text =
            fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
        let (bump, body) =
            parse_changeset(&text).map_err(|e| format!("{}: {e}", path.display()))?;
        sets.push(Changeset {
            name,
            path,
            bump,
            body,
        });
    }
    sets.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(sets)
}

/// Rewrite the first `version = "…"` line inside `[section]` of a Cargo manifest.
fn with_manifest_version(manifest: &str, section: &str, next: Version) -> Result<String, String> {
    let header = format!("[{section}]");
    let mut in_section = false;
    let mut replaced = false;
    let mut out = String::with_capacity(manifest.len());
    for line in manifest.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_section = trimmed == header;
        }
        if in_section && !replaced && trimmed.starts_with("version = \"") {
            out.push_str(&format!("version = \"{next}\""));
            replaced = true;
        } else {
            out.push_str(line);
        }
        out.push('\n');
    }
    if replaced {
        Ok(out)
    } else {
        Err(format!("no `version = \"…\"` line under `{header}`"))
    }
}

/// Bump every workspace-local package pin in a Cargo.lock. Local (path) packages are exactly
/// the `[[package]]` blocks WITHOUT a `source` line, and they all inherit the one workspace
/// version; registry/git packages keep their pins, and the preamble (the lockfile-format
/// `version = N`) sits before the first block and is never touched. Purely textual, so a
/// release needs no cargo subprocess (which can't resolve offline in every environment) and
/// stays byte-deterministic.
fn with_lockfile_versions(lock: &str, next: Version) -> String {
    let mut parts = lock.split("[[package]]");
    let mut out = String::from(parts.next().unwrap_or_default());
    for block in parts {
        out.push_str("[[package]]");
        let version_at = if block.contains("\nsource = ") {
            None
        } else {
            block.find("\nversion = \"")
        };
        match version_at {
            Some(at) => {
                let open = at + "\nversion = \"".len();
                match block[open..].find('"') {
                    Some(len) => {
                        out.push_str(&block[..open]);
                        out.push_str(&next.to_string());
                        out.push_str(&block[open + len..]);
                    }
                    None => out.push_str(block),
                }
            }
            None => out.push_str(block),
        }
    }
    out
}

/// Read the `version = "…"` inside `[section]` of a Cargo manifest.
fn manifest_version(manifest: &str, section: &str) -> Result<Version, String> {
    let header = format!("[{section}]");
    let mut in_section = false;
    for line in manifest.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_section = trimmed == header;
        }
        if in_section {
            if let Some(rest) = trimmed.strip_prefix("version = \"") {
                if let Some(v) = rest.strip_suffix('"') {
                    return Version::parse(v);
                }
            }
        }
    }
    Err(format!("no `version = \"…\"` line under `{header}`"))
}

/// Render one release's CHANGELOG section (no trailing newline): a dated `##` heading, then the
/// entries grouped under Breaking changes / Features / Fixes in that order. A multi-line
/// changeset body keeps its extra lines, indented under its bullet.
fn render_release(version: Version, date: &str, sets: &[Changeset]) -> String {
    let mut out = format!("## {version} — {date}");
    for bump in [Bump::Major, Bump::Minor, Bump::Patch] {
        let group: Vec<&Changeset> = sets.iter().filter(|c| c.bump == bump).collect();
        if group.is_empty() {
            continue;
        }
        out.push_str(&format!("\n\n### {}\n", bump.heading()));
        for set in group {
            let mut lines = set.body.lines();
            let first = lines.next().unwrap_or_default();
            out.push_str(&format!("\n- {first}"));
            for line in lines {
                out.push('\n');
                if !line.trim().is_empty() {
                    out.push_str("  ");
                }
                out.push_str(line);
            }
        }
    }
    out
}

/// Insert a rendered release section at the top of the CHANGELOG's release list (before the
/// first existing `## ` heading, after the intro prose).
fn insert_release(changelog: &str, release: &str) -> String {
    let split = if changelog.starts_with("## ") {
        Some(0)
    } else {
        changelog.find("\n## ").map(|i| i + 1)
    };
    let (head, tail) = match split {
        Some(i) => (&changelog[..i], changelog[i..].trim_start()),
        None => (changelog, ""),
    };
    let mut out = if head.trim().is_empty() {
        format!("{release}\n")
    } else {
        format!("{}\n\n{release}\n", head.trim_end())
    };
    if !tail.is_empty() {
        out.push('\n');
        out.push_str(tail);
    }
    out
}

/// Gregorian date from days-since-Unix-epoch (Howard Hinnant's `civil_from_days`).
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Today's UTC date as `YYYY-MM-DD`.
fn utc_today() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock predates the Unix epoch")
        .as_secs();
    let (y, m, d) = civil_from_days(i64::try_from(secs / 86_400).expect("clock overflow"));
    format!("{y:04}-{m:02}-{d:02}")
}

/// A changeset file name from its summary: lowercase alphanumeric runs joined by `-`,
/// capped to keep names short.
fn slug(summary: &str) -> String {
    let mut out = String::new();
    for word in summary
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
    {
        if out.len() + word.len() >= 48 && !out.is_empty() {
            break;
        }
        if !out.is_empty() {
            out.push('-');
        }
        out.push_str(&word.to_ascii_lowercase());
    }
    // A single over-long first word skips the loop's cap — enforce it unconditionally.
    out.truncate(48);
    if out.is_empty() {
        out.push_str("change");
    }
    out
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("xtask sits one level under the repo root")
        .to_path_buf()
}

fn changesets_dir(root: &Path) -> PathBuf {
    root.join(".changesets")
}

fn read(path: &Path) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))
}

fn write(path: &Path, text: &str) -> Result<(), String> {
    fs::write(path, text).map_err(|e| format!("write {}: {e}", path.display()))
}

/// `cargo xtask add <bump> <summary…>` — record one pending changeset.
fn cmd_add(args: &[String]) -> Result<(), String> {
    let (bump_arg, summary_args) = args
        .split_first()
        .ok_or("usage: cargo xtask add <major|minor|patch> <summary…>")?;
    let bump = Bump::parse(bump_arg)
        .ok_or_else(|| format!("unknown bump `{bump_arg}` (want major|minor|patch)"))?;
    let summary = summary_args.join(" ").trim().to_string();
    if summary.is_empty() {
        return Err("usage: cargo xtask add <major|minor|patch> <summary…>".into());
    }
    let dir = changesets_dir(&repo_root());
    fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let base = slug(&summary);
    let mut path = dir.join(format!("{base}.md"));
    let mut n = 1;
    while path.exists() {
        n += 1;
        path = dir.join(format!("{base}-{n}.md"));
    }
    write(
        &path,
        &format!("---\nbump: {}\n---\n\n{summary}\n", bump.label()),
    )?;
    println!("recorded {} ({})", path.display(), bump.label());
    println!("edit the body freely — it becomes the CHANGELOG entry verbatim.");
    Ok(())
}

/// `cargo xtask status` — show the pending changesets and the release they add up to.
fn cmd_status() -> Result<(), String> {
    let root = repo_root();
    let current = manifest_version(&read(&root.join("Cargo.toml"))?, "workspace.package")?;
    let sets = load_changesets(&changesets_dir(&root))?;
    println!("current version: {current}");
    if sets.is_empty() {
        println!("no pending changesets — nothing to release.");
        return Ok(());
    }
    println!("pending changesets ({}):", sets.len());
    for set in &sets {
        let first = set.body.lines().next().unwrap_or_default();
        println!("  {:<5}  {}  {first}", set.bump.label(), set.name);
    }
    let bump = sets.iter().map(|s| s.bump).max().expect("non-empty");
    println!(
        "next release: {} ({} bump)",
        current.bumped(bump),
        bump.label()
    );
    Ok(())
}

/// `cargo xtask release [--date YYYY-MM-DD]` — cut the release the pending changesets describe.
fn cmd_release(args: &[String]) -> Result<(), String> {
    let date = match args {
        [] => utc_today(),
        [flag, date] if flag == "--date" => date.clone(),
        _ => return Err("usage: cargo xtask release [--date YYYY-MM-DD]".into()),
    };
    let root = repo_root();
    let sets = load_changesets(&changesets_dir(&root))?;
    if sets.is_empty() {
        return Err(
            "no pending changesets in .changesets/ — record one with `cargo xtask add`".into(),
        );
    }
    let root_manifest_path = root.join("Cargo.toml");
    let root_manifest = read(&root_manifest_path)?;
    let current = manifest_version(&root_manifest, "workspace.package")?;
    let bump = sets.iter().map(|s| s.bump).max().expect("non-empty");
    let next = current.bumped(bump);

    // Read and transform EVERYTHING before the first write, so a malformed input can never
    // leave the repo half-released (version bumped, changesets still pending). The version
    // lands in five committed files: both manifests that literally carry it (the workspace
    // root, inherited by every member, and the workspace-excluded desktop shell), both
    // lockfiles (a stale pin would dirty the tree on the next build), and the CHANGELOG.
    let new_root_manifest = with_manifest_version(&root_manifest, "workspace.package", next)?;
    let desktop_path = root.join("desktop/Cargo.toml");
    let new_desktop_manifest = with_manifest_version(&read(&desktop_path)?, "package", next)?;
    let root_lock_path = root.join("Cargo.lock");
    let new_root_lock = with_lockfile_versions(&read(&root_lock_path)?, next);
    let desktop_lock_path = root.join("desktop/Cargo.lock");
    let new_desktop_lock = with_lockfile_versions(&read(&desktop_lock_path)?, next);
    let changelog_path = root.join("CHANGELOG.md");
    let new_changelog =
        insert_release(&read(&changelog_path)?, &render_release(next, &date, &sets));

    write(&root_manifest_path, &new_root_manifest)?;
    write(&desktop_path, &new_desktop_manifest)?;
    write(&root_lock_path, &new_root_lock)?;
    write(&desktop_lock_path, &new_desktop_lock)?;
    write(&changelog_path, &new_changelog)?;
    for set in &sets {
        fs::remove_file(&set.path).map_err(|e| format!("remove {}: {e}", set.path.display()))?;
    }

    println!(
        "released {next} ({} bump, {} changeset{})",
        bump.label(),
        sets.len(),
        if sets.len() == 1 { "" } else { "s" }
    );
    println!("review the diff, then:");
    println!("  git add -A && git commit -m \"Release {next}\"");
    println!("  git tag v{next}");
    Ok(())
}

const USAGE: &str = "\
usage: cargo xtask <command>

  add <major|minor|patch> <summary…>   record a changeset in .changesets/
  status                               show the pending changesets and the next version
  release [--date YYYY-MM-DD]          cut the release: bump the workspace version, write
                                       CHANGELOG.md, delete the consumed changesets";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.split_first() {
        Some((cmd, rest)) if cmd == "add" => cmd_add(rest),
        Some((cmd, [])) if cmd == "status" => cmd_status(),
        Some((cmd, rest)) if cmd == "release" => cmd_release(rest),
        _ => Err(USAGE.into()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(name: &str, bump: Bump, body: &str) -> Changeset {
        Changeset {
            name: name.into(),
            path: PathBuf::from(name),
            bump,
            body: body.into(),
        }
    }

    #[test]
    fn the_largest_bump_wins() {
        assert!(Bump::Major > Bump::Minor);
        assert!(Bump::Minor > Bump::Patch);
    }

    #[test]
    fn versions_parse_bump_and_print() {
        let v = Version::parse("1.2.3").unwrap();
        assert_eq!(v.bumped(Bump::Major).to_string(), "2.0.0");
        assert_eq!(v.bumped(Bump::Minor).to_string(), "1.3.0");
        assert_eq!(v.bumped(Bump::Patch).to_string(), "1.2.4");
        assert!(Version::parse("1.2").is_err());
        assert!(Version::parse("1.2.x").is_err());
    }

    #[test]
    fn changesets_parse_and_reject_malformed_files() {
        let (bump, body) =
            parse_changeset("---\nbump: minor\n---\n\nAdded a thing.\nMore detail.\n").unwrap();
        assert_eq!(bump, Bump::Minor);
        assert_eq!(body, "Added a thing.\nMore detail.");
        assert!(parse_changeset("Added a thing.").is_err(), "no frontmatter");
        assert!(parse_changeset("---\nbump: minor\n").is_err(), "unclosed");
        assert!(parse_changeset("---\n---\n\nBody.").is_err(), "no bump");
        assert!(
            parse_changeset("---\nbump: huge\n---\n\nBody.").is_err(),
            "bad bump"
        );
        assert!(
            parse_changeset("---\nbump: patch\n---\n\n").is_err(),
            "empty body"
        );
    }

    /// Only the named section's version line is touched — the root manifest's
    /// `[workspace.package]` must never be confused with a `[package]` (the desktop manifest)
    /// or a dependency's `version = "1"` key.
    #[test]
    fn manifest_rewrites_are_section_scoped() {
        let manifest = "[package]\nname = \"shell\"\nversion = \"0.0.1\"\n\n[dependencies]\nserde = { version = \"1\" }\n";
        let next = Version::parse("0.2.0").unwrap();
        let out = with_manifest_version(manifest, "package", next).unwrap();
        assert!(out.contains("version = \"0.2.0\""));
        assert!(out.contains("serde = { version = \"1\" }"));
        assert_eq!(manifest_version(&out, "package").unwrap(), next);
        // A manifest without the section refuses rather than guessing.
        assert!(with_manifest_version(manifest, "workspace.package", next).is_err());
        let ws = "[workspace]\nmembers = []\n\n[workspace.package]\nversion = \"0.0.1\"\n";
        assert_eq!(
            manifest_version(
                &with_manifest_version(ws, "workspace.package", next).unwrap(),
                "workspace.package"
            )
            .unwrap(),
            next
        );
    }

    #[test]
    fn releases_render_grouped_and_ordered() {
        let sets = vec![
            set("b-fix.md", Bump::Patch, "Fixed the door."),
            set("a-feat.md", Bump::Minor, "Added rooms.\nWith detail."),
            set("c-break.md", Bump::Major, "Removed the attic."),
        ];
        let out = render_release(Version::parse("1.0.0").unwrap(), "2026-09-04", &sets);
        assert_eq!(
            out,
            "## 1.0.0 — 2026-09-04\n\n### Breaking changes\n\n- Removed the attic.\n\n### Features\n\n- Added rooms.\n  With detail.\n\n### Fixes\n\n- Fixed the door."
        );
        // Absent groups leave no empty headings.
        let out = render_release(
            Version::parse("0.1.1").unwrap(),
            "2026-09-04",
            &sets[..1]
                .iter()
                .map(|s| set(&s.name, s.bump, &s.body))
                .collect::<Vec<_>>(),
        );
        assert!(!out.contains("Features") && !out.contains("Breaking"));
    }

    #[test]
    fn new_releases_insert_above_older_ones() {
        let log =
            "# Changelog\n\nIntro prose.\n\n## 0.1.0 — 2026-01-01\n\n### Fixes\n\n- Old fix.\n";
        let out = insert_release(log, "## 0.2.0 — 2026-09-04\n\n### Fixes\n\n- New fix.");
        assert_eq!(
            out,
            "# Changelog\n\nIntro prose.\n\n## 0.2.0 — 2026-09-04\n\n### Fixes\n\n- New fix.\n\n## 0.1.0 — 2026-01-01\n\n### Fixes\n\n- Old fix.\n"
        );
        // First release ever: appended after the intro.
        let out = insert_release("# Changelog\n\nIntro prose.\n", "## 0.1.0 — X\n\n- A.");
        assert_eq!(out, "# Changelog\n\nIntro prose.\n\n## 0.1.0 — X\n\n- A.\n");
    }

    #[test]
    fn civil_dates_match_known_days() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_700), (2026, 9, 4));
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
    }

    #[test]
    fn slugs_are_short_kebab_case() {
        assert_eq!(
            slug("Exits replicate through the sync delta!"),
            "exits-replicate-through-the-sync-delta"
        );
        assert_eq!(slug("???"), "change");
        assert!(
            slug("a very long summary that keeps going and going and going and going").len() <= 48
        );
        // A single over-long first word is capped too, not passed through whole.
        assert!(slug(&"x".repeat(80)).len() <= 48);
    }

    #[test]
    fn lockfiles_bump_only_local_path_packages() {
        let lock = "version = 4\n\n[[package]]\nname = \"serde\"\nversion = \"1.0.200\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\nchecksum = \"abc\"\n\n[[package]]\nname = \"wickedways-core\"\nversion = \"0.0.1\"\ndependencies = [\n \"serde\",\n]\n";
        let out = with_lockfile_versions(lock, Version::parse("0.2.0").unwrap());
        // The path-local package (no `source` line) is bumped…
        assert!(out.contains("name = \"wickedways-core\"\nversion = \"0.2.0\""));
        // …the registry package and the lockfile-format preamble are untouched.
        assert!(out.contains("version = \"1.0.200\""));
        assert!(out.starts_with("version = 4\n"));
        // Everything else is byte-identical.
        assert_eq!(out.replace("0.2.0", "0.0.1"), lock);
    }
}
