//! fx skills for the `$` picker, found the way fx 0.0.13 finds them, without starting `fx acp`.
//!
//! v1 `packages/provider-fx/src/server/skills.ts` at 916b5ccc1b2 (fx `src/builtins/skills.zig`,
//! `src/core/skills/skill_contract.zig`, `skill_runtime.zig`): the managed `~/.fx/skills`, then
//! each workspace directory's `.fx/skills` and `skills/` up to HOME, then the compatibility roots;
//! a line-based SKILL.md header (not YAML); a folder reached twice counts once and the first copy
//! of a name wins.

use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};

const MAX_FRONTMATTER_BYTES: usize = 64 * 1024;
const MAX_NAME_BYTES: usize = 256;
const BLOCK_DESCRIPTION_STYLES: [&str; 3] = [">", ">-", "|"];

/// v1 `SkillRoot` (:16-45): fx's menu order is managed (0), workspace (1), compatibility (2).
struct SkillRoot {
    relative: &'static str,
    rank: u8,
    follows_links: bool,
}

const FX_WORKSPACE_ROOTS: [SkillRoot; 7] = [
    SkillRoot {
        relative: ".fx/skills",
        rank: 1,
        follows_links: true,
    },
    SkillRoot {
        relative: "skills",
        rank: 1,
        follows_links: true,
    },
    SkillRoot {
        relative: ".opencode/skills",
        rank: 2,
        follows_links: true,
    },
    SkillRoot {
        relative: ".codex/skills",
        rank: 2,
        follows_links: true,
    },
    SkillRoot {
        relative: ".claude/skills",
        rank: 2,
        follows_links: true,
    },
    SkillRoot {
        relative: ".agents/skills",
        rank: 2,
        follows_links: true,
    },
    SkillRoot {
        relative: ".claw/skills",
        rank: 2,
        follows_links: true,
    },
];
const FX_HOME_ROOTS: [SkillRoot; 6] = [
    SkillRoot {
        relative: ".fx/skills",
        rank: 0,
        follows_links: false,
    },
    SkillRoot {
        relative: ".config/opencode/skills",
        rank: 2,
        follows_links: true,
    },
    SkillRoot {
        relative: ".codex/skills",
        rank: 2,
        follows_links: true,
    },
    SkillRoot {
        relative: ".claude/skills",
        rank: 2,
        follows_links: true,
    },
    SkillRoot {
        relative: ".agents/skills",
        rank: 2,
        follows_links: true,
    },
    SkillRoot {
        relative: ".claw/skills",
        rank: 2,
        follows_links: true,
    },
];

/// v1 `ServerProviderSkill` as fx fills it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FxSkill {
    pub name: String,
    pub path: PathBuf,
    /// `project` or `user`.
    pub scope: &'static str,
    pub enabled: bool,
    pub description: Option<String>,
}

/// v1 `decodeSkillFile` (:54-71): the BOM is kept (it means no frontmatter), and a line with
/// invalid UTF-8 ends in NUL, which the parser rejects.
fn decode_skill_file(bytes: &[u8]) -> String {
    bytes
        .split(|b| *b == b'\n')
        .map(|line| match std::str::from_utf8(line) {
            Ok(text) => text.to_owned(),
            Err(_) => format!("{}\u{0}", String::from_utf8_lossy(line)),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// v1 `trimSpaceTab` (:92-93).
fn trim_space_tab(value: &str) -> &str {
    value.trim_matches([' ', '\t'])
}

/// v1 `hasControlByte` (:95-96).
fn has_control_byte(value: &str) -> bool {
    value.chars().any(|c| c < ' ' || c == '\u{7f}')
}

/// v1 `recognizedValue` (:98-104): one quoted or bare scalar.
fn recognized_value(raw: &str) -> Option<String> {
    if raw.starts_with('|') || raw.starts_with('>') {
        return None;
    }
    let quote = |c: char| c == '\'' || c == '"';
    if !raw.starts_with(quote) && !raw.ends_with(quote) {
        return Some(raw.to_owned());
    }
    let mut chars = raw.chars();
    let (first, last) = (chars.next(), chars.next_back());
    (first.is_some() && last.is_some() && first == last).then(|| raw[1..raw.len() - 1].to_owned())
}

/// v1 `validSkillName` (:210-221).
fn valid_skill_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_NAME_BYTES
        && !has_control_byte(name)
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.contains('\\')
}

/// v1 `decodeBlockDescription` (:192-208).
fn decode_block_description(lines: &[Option<String>], style: &str) -> String {
    let Some(last) = lines.iter().rposition(Option::is_some) else {
        return String::new();
    };
    let mut text = String::new();
    for index in 0..=last {
        if index > 0 {
            let joined = style != "|" && lines[index - 1].is_some() && lines[index].is_some();
            text.push(if joined { ' ' } else { '\n' });
        }
        text.push_str(lines[index].as_deref().unwrap_or_default());
    }
    text.trim().to_owned()
}

/// v1 `parseSkillMetadata` (:106-190): name and description, or None when fx would skip it.
fn parse_skill_metadata(contents: &str, folder_name: &str) -> Option<(String, Option<String>)> {
    let opening = if contents == "---" {
        "---"
    } else if contents.starts_with("---\r\n") {
        "---\r\n"
    } else if contents.starts_with("---\n") {
        "---\n"
    } else {
        return valid_skill_name(folder_name).then(|| (folder_name.to_owned(), None));
    };
    let lines: Vec<&str> = contents[opening.len()..].split('\n').collect();
    let unterminated = |index: usize| index == lines.len() - 1;
    let closing = lines.iter().enumerate().position(|(index, line)| {
        let line = if unterminated(index) {
            *line
        } else {
            line.strip_suffix('\r').unwrap_or(line)
        };
        line == "---"
    })?;
    let through_closing = opening.len() + lines[..=closing].join("\n").len();
    let body_start = through_closing + usize::from(!unterminated(closing));
    if body_start > MAX_FRONTMATTER_BYTES {
        return None;
    }
    let header: Vec<&str> = lines[..closing]
        .iter()
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect();
    let mut name = None;
    let mut description = None;
    let (mut saw_name, mut saw_description, mut previous_recognized) = (false, false, false);
    let mut index = 0;
    while index < header.len() {
        let line = header[index];
        let trimmed = trim_space_tab(line);
        if trimmed.is_empty() || trimmed.starts_with('#') {
            index += 1;
            continue;
        }
        if previous_recognized && line.starts_with([' ', '\t']) {
            return None;
        }
        previous_recognized = false;
        let Some(colon) = trimmed.find(':') else {
            index += 1;
            continue;
        };
        let key = trim_space_tab(&trimmed[..colon]);
        let raw = trim_space_tab(&trimmed[colon + 1..]);
        if key == "name" {
            if saw_name {
                return None;
            }
            saw_name = true;
            name = Some(recognized_value(raw)?);
            previous_recognized = true;
        } else if key == "description" {
            if saw_description {
                return None;
            }
            saw_description = true;
            if BLOCK_DESCRIPTION_STYLES.contains(&raw) {
                // A block runs over the following space-indented lines; blank lines stay in it.
                let mut block: Vec<Option<String>> = Vec::new();
                let mut base_indent: Option<usize> = None;
                while index + 1 < header.len() {
                    let next = header[index + 1];
                    if trim_space_tab(next).is_empty() {
                        block.push(None);
                        index += 1;
                        continue;
                    }
                    let indent = next.len() - next.trim_start_matches(' ').len();
                    if next[indent..].starts_with('\t') {
                        return None;
                    }
                    if indent == 0 {
                        break;
                    }
                    if base_indent.is_some_and(|base| indent < base) {
                        return None;
                    }
                    let base = *base_indent.get_or_insert(indent);
                    let content = &next[base..];
                    if has_control_byte(content) {
                        return None;
                    }
                    block.push(Some(content.to_owned()));
                    index += 1;
                }
                description = Some(decode_block_description(&block, raw));
            } else {
                let value = recognized_value(raw)?;
                if has_control_byte(&value) {
                    return None;
                }
                description = Some(value);
                previous_recognized = true;
            }
        }
        index += 1;
    }
    let name = name.filter(|n| valid_skill_name(n))?;
    Some((name, description.filter(|d| !d.is_empty())))
}

struct Root {
    directory: PathBuf,
    scope: &'static str,
    rank: u8,
    follows_links: bool,
}

/// v1 `skillRoots` (:223-256): the workspace roots of each directory up to (not including) HOME,
/// then the home roots.
fn skill_roots(cwd: &Path, home: &Path) -> Vec<Root> {
    let mut roots = Vec::new();
    let mut current = cwd.to_path_buf();
    while current != home {
        for root in &FX_WORKSPACE_ROOTS {
            roots.push(Root {
                directory: current.join(root.relative),
                scope: "project",
                rank: root.rank,
                follows_links: root.follows_links,
            });
        }
        match current.parent() {
            Some(parent) if parent != current => current = parent.to_path_buf(),
            _ => break,
        }
    }
    for root in &FX_HOME_ROOTS {
        roots.push(Root {
            directory: home.join(root.relative),
            scope: "user",
            rank: root.rank,
            follows_links: root.follows_links,
        });
    }
    roots
}

fn is_link(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink())
}

/// v1 `discoverSkillsInRoot` (:274-336).
fn discover_in_root(root: &Root) -> Vec<(FxSkill, PathBuf)> {
    // The managed root has no read authority through links (HOME is a real path here).
    if !root.follows_links
        && std::fs::canonicalize(&root.directory).is_ok_and(|real| real != root.directory)
    {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(&root.directory) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    // fx reads a root's folders in UTF-8 byte order.
    names.sort();
    let mut skills = Vec::new();
    for entry in names {
        let folder = root.directory.join(&entry);
        if !root.follows_links && is_link(&folder) {
            continue;
        }
        // A stray file is no skill folder.
        if !std::fs::metadata(&folder).is_ok_and(|m| m.is_dir()) {
            continue;
        }
        let skill_path = folder.join("SKILL.md");
        if !root.follows_links && is_link(&skill_path) {
            continue;
        }
        if !std::fs::metadata(&skill_path).is_ok_and(|m| m.is_file()) {
            continue;
        }
        // fx reads only the metadata prefix, so a long body never hides a skill.
        let mut prefix = Vec::new();
        if std::fs::File::open(&skill_path)
            .and_then(|f| {
                f.take(MAX_FRONTMATTER_BYTES as u64 + 1)
                    .read_to_end(&mut prefix)
            })
            .is_err()
        {
            continue;
        }
        let Some((name, description)) = parse_skill_metadata(&decode_skill_file(&prefix), &entry)
        else {
            continue;
        };
        let real = std::fs::canonicalize(&folder).unwrap_or(folder);
        skills.push((
            FxSkill {
                name,
                path: skill_path,
                scope: root.scope,
                enabled: true,
                description,
            },
            real,
        ));
    }
    skills
}

/// v1 `discoverFxSkills` (:338-373): skills in fx's menu order. fx reads skills only under a set
/// HOME and compares HOME and the workspace by their real paths.
pub fn discover_fx_skills(cwd: &Path, home: Option<&str>) -> Vec<FxSkill> {
    let Some(home) = home.map(str::trim).filter(|h| !h.is_empty()) else {
        return Vec::new();
    };
    let real = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let home = real(Path::new(home));
    let cwd = real(cwd);
    let mut seen_folders = HashSet::new();
    // `$review` and `$Review` load different skills: only an exact repeat is dropped.
    let mut seen_names = HashSet::new();
    let mut found: Vec<(FxSkill, u8)> = Vec::new();
    for root in skill_roots(&cwd, &home) {
        for (skill, folder) in discover_in_root(&root) {
            if !seen_folders.insert(folder) || !seen_names.insert(skill.name.clone()) {
                continue;
            }
            found.push((skill, root.rank));
        }
    }
    found.sort_by_key(|(_, rank)| *rank);
    found.into_iter().map(|(skill, _)| skill).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_is_read_line_by_line() {
        assert_eq!(
            parse_skill_metadata("# no header", "folder"),
            Some(("folder".into(), None))
        );
        assert_eq!(
            parse_skill_metadata(
                "---\nname: \"review\"\ndescription: Review code\n---\nbody",
                "f"
            ),
            Some(("review".into(), Some("Review code".into())))
        );
        assert_eq!(
            parse_skill_metadata(
                "---\nname: a\ndescription: >\n  one\n  two\n\n  three\n---\n",
                "f"
            ),
            Some(("a".into(), Some("one two\n\nthree".into())))
        );
        assert_eq!(
            parse_skill_metadata("---\nname: a\ndescription: |\n  one\n  two\n---\n", "f"),
            Some(("a".into(), Some("one\ntwo".into())))
        );
        // No closing line, a repeated name, a continued value, a slash: skipped.
        assert_eq!(parse_skill_metadata("---\nname: a\n", "f"), None);
        assert_eq!(
            parse_skill_metadata("---\nname: a\nname: b\n---\n", "f"),
            None
        );
        assert_eq!(
            parse_skill_metadata("---\nname: a\n  more\n---\n", "f"),
            None
        );
        assert_eq!(parse_skill_metadata("---\nname: a/b\n---\n", "f"), None);
        assert_eq!(
            parse_skill_metadata("\u{feff}---\nname: a\n---\n", "f"),
            Some(("f".into(), None))
        );
        assert_eq!(
            parse_skill_metadata(&decode_skill_file(b"---\nname: \xff\n---\n"), "f"),
            None
        );
    }

    #[test]
    fn scans_in_fx_menu_order() {
        let home = tempfile::tempdir().unwrap();
        let work = home.path().join("code/app");
        let write = |dir: &Path, body: &str| {
            std::fs::create_dir_all(dir).unwrap();
            std::fs::write(dir.join("SKILL.md"), body).unwrap();
        };
        write(
            &home.path().join(".claude/skills/compat"),
            "---\nname: compat\n---\n",
        );
        write(&work.join(".fx/skills/beta"), "---\nname: beta\n---\n");
        write(
            &work.join(".fx/skills/alpha"),
            "---\nname: alpha\ndescription: A\n---\n",
        );
        write(&home.path().join(".fx/skills/managed"), "plain body");
        write(
            &home.path().join("code/.codex/skills/alpha2"),
            "---\nname: alpha\n---\n",
        );
        std::fs::write(work.join(".fx/skills/README"), "not a skill").unwrap();
        let skills = discover_fx_skills(&work, Some(&home.path().to_string_lossy()));
        let names: Vec<(&str, &str)> = skills.iter().map(|s| (s.name.as_str(), s.scope)).collect();
        assert_eq!(
            names,
            [
                ("managed", "user"),
                ("alpha", "project"),
                ("beta", "project"),
                ("compat", "user")
            ]
        );
        assert_eq!(skills[1].description.as_deref(), Some("A"));
        assert!(discover_fx_skills(&work, None).is_empty());
    }
}
