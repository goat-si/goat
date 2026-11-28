//! Validate source references in parity documents.
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

pub const V1_COMMIT: &str = "916b5ccc1b2b6d4ecd991ab1573172bab8fb1cc4";
#[derive(Debug, Clone)]
pub struct Roots {
    pub v1: PathBuf,
    pub sdk_py: PathBuf,
    pub sdk_ts: PathBuf,
    pub design: PathBuf,
    pub goat2: PathBuf,
}

pub fn check(roots: &Roots, docs: &[PathBuf]) -> Result<String, String> {
    let mappings = [
        ("claude-agent-sdk-python/", &roots.sdk_py),
        ("@anthropic-ai/claude-agent-sdk@0.3.276/", &roots.sdk_ts),
        ("goat2-design/", &roots.design),
        ("goat2/", &roots.goat2),
        ("", &roots.v1),
    ];
    let mut output = String::new();
    let mut bad = 0;
    let mut ok = 0;
    if docs.is_empty() {
        return Err("no input files".into());
    }
    for (prefix, root) in mappings {
        if !root.is_dir() {
            output.push_str(&format!("ROOT-MISSING {} -> {}\n", prefix, root.display()));
            bad += 1;
            continue;
        }
        if root.join(".git").exists() {
            match Command::new("git")
                .args(["-C"])
                .arg(root)
                .args(["rev-parse", "HEAD"])
                .output()
            {
                Ok(o) if o.status.success() => {
                    let head = String::from_utf8_lossy(&o.stdout).trim().to_owned();
                    output.push_str(&format!("{} HEAD {head}\n", root.display()));
                    if prefix.is_empty() && head != V1_COMMIT {
                        output.push_str("v1 identity mismatch\n");
                        bad += 1;
                    }
                }
                _ => {
                    output.push_str(&format!("{} identity unavailable\n", root.display()));
                    bad += 1;
                }
            }
        } else {
            output.push_str(&format!("{} identity unverified\n", root.display()));
        }
    }
    for doc in docs {
        let content = match fs::read_to_string(doc) {
            Ok(s) => s,
            Err(e) => {
                output.push_str(&format!("{}: {e}\n", doc.display()));
                bad += 1;
                continue;
            }
        };
        let mut count = 0;
        for (line, text) in content.lines().enumerate() {
            let mut parts = text.split('`');
            parts.next();
            while let Some(span) = parts.next() {
                if parts.next().is_none() {
                    break;
                }
                let s = span.trim();
                if !looks_like(s) {
                    continue;
                }
                let fail = |reason: &str, out: &mut String| {
                    out.push_str(&format!("{reason} {}:{} {s}\n", doc.display(), line + 1))
                };
                match validate(s, &mappings) {
                    Ok(()) => {
                        ok += 1;
                        count += 1;
                    }
                    Err(reason) => {
                        bad += 1;
                        fail(&reason, &mut output);
                    }
                }
            }
        }
        if count == 0 {
            output.push_str(&format!("NO-REFS {}\n", doc.display()));
            bad += 1;
        }
    }
    output.push_str(&format!("files={} refs ok={ok} bad={bad}\n", docs.len()));
    if bad == 0 { Ok(output) } else { Err(output) }
}
fn looks_like(s: &str) -> bool {
    s.match_indices('.').any(|(i, _)| {
        let tail = &s[i + 1..];
        let n = tail.bytes().take_while(u8::is_ascii_alphanumeric).count();
        n > 0
            && tail.as_bytes().get(n) == Some(&b':')
            && tail
                .as_bytes()
                .get(n + 1)
                .is_some_and(|c| !c.is_ascii_whitespace() && *c != b'/')
    })
}
fn validate(s: &str, mappings: &[(&str, &PathBuf)]) -> Result<(), String> {
    let (path, ranges) = s.rsplit_once(':').ok_or("MALFORMED")?;
    let (base, ext) = path.rsplit_once('.').ok_or("MALFORMED")?;
    if base.is_empty()
        || ext.is_empty()
        || !ext.bytes().all(|c| c.is_ascii_alphanumeric())
        || !path
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_./@+-".contains(&c))
    {
        return Err("MALFORMED".into());
    }
    if path.starts_with('/') || !path.contains('/') {
        return Err("BARE-OR-ABSOLUTE".into());
    }
    let mut numbers = Vec::new();
    for part in ranges.split(',') {
        let part = part.trim();
        let (a, b) = part.split_once('-').unwrap_or((part, part));
        if a.is_empty()
            || b.is_empty()
            || !a.bytes().all(|c| c.is_ascii_digit())
            || !b.bytes().all(|c| c.is_ascii_digit())
        {
            return Err("MALFORMED".into());
        }
        numbers.push((
            a.parse::<usize>().map_err(|_| "MALFORMED")?,
            b.parse::<usize>().map_err(|_| "MALFORMED")?,
        ));
    }
    let (prefix, root) = mappings
        .iter()
        .find(|(p, _)| path.starts_with(p))
        .ok_or("NO-ROOT")?;
    let root = root.canonicalize().map_err(|_| "NO-ROOT")?;
    let relative = &path[prefix.len()..];
    // Canonicalize the nearest existing parent to detect escapes even for missing leaves.
    let joined = root.join(relative);
    let mut ancestor = joined.as_path();
    while !ancestor.exists() {
        ancestor = ancestor.parent().ok_or("ESCAPE")?;
    }
    if !ancestor
        .canonicalize()
        .map_err(|_| "ESCAPE")?
        .starts_with(&root)
    {
        return Err("ESCAPE".into());
    }
    let full = joined.canonicalize().map_err(|_| "MISSING")?;
    if !full.starts_with(&root) {
        return Err("ESCAPE".into());
    }
    if !full.is_file() {
        return Err("MISSING".into());
    }
    let bytes = fs::read(&full).map_err(|_| "MISSING")?;
    let n = String::from_utf8_lossy(&bytes).lines().count();
    if numbers.iter().any(|(a, b)| *a == 0 || a > b || *b > n) {
        return Err(format!("RANGE (file has {n} lines)"));
    }
    Ok(())
}
#[allow(dead_code)]
fn _path(_: &Path) {}
