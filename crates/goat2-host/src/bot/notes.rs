//! Bot notes: one markdown file per bot, one note per line, newest last.
//!
//! Lifted from GOAT v1 (goat origin/dev 916b5ccc1b2) `apps/server/src/channels/channelBotNoteLines.ts`
//! (line format, corrections with ` (replaces: "<old>")`), `channelBotNotes.ts` (append,
//! NOTE_MAX_CHARS 500) and `channelBotNotesRecall.ts` (standing 6,000 chars newest first plus
//! 3,000 chars of older notes matched by BM25, scan the last 256 KiB). GOAT 2 path:
//! `<dataDir>/bots/<botId>/MEMORY.md` (PRD injection.md layer 3). Adapted: search terms are
//! lowercase letter/number runs with v1's prefix match (v1 uses GOAT memory's recallTerms with
//! Hangul particle stripping); the v1 "(asked in <inputId>)" source names the asking MCP call.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

/// v1 NOTES_HEADER.
pub const NOTES_HEADER: &str = "# GOAT Bot notes\n\nStanding notes people asked GOAT Bot to keep, newest last. Edit or delete lines freely.\n\n";
/// v1 NOTE_MAX_CHARS.
pub const NOTE_MAX_CHARS: usize = 500;
/// v1 NOTES_RECENT_CHARS.
pub const NOTES_RECENT_CHARS: usize = 6_000;
/// v1 NOTES_MATCHED_CHARS.
pub const NOTES_MATCHED_CHARS: usize = 3_000;
/// v1 NOTES_SECTION_CHARS.
pub const NOTES_SECTION_CHARS: usize = NOTES_RECENT_CHARS + NOTES_MATCHED_CHARS;
/// v1 NOTES_SCAN_BYTES.
pub const NOTES_SCAN_BYTES: u64 = 256 * 1024;
/// v1 NOTES_REPLACED_RULE.
pub const NOTES_REPLACED_RULE: &str = "A note line ending in (replaces: \"<old text>\") replaces the earlier note with that text; follow the newer note.";
const MARKER: &str = " (replaces: ";
const BM25_K1: f64 = 1.2;
const BM25_B: f64 = 0.75;
const QUERY_EDGE_CHARS: usize = 2_000;
const QUERY_HEAD_TERMS: usize = 48;
const QUERY_TAIL_TERMS: usize = 16;

/// The notes file of a bot.
pub fn notes_path(data_dir: &Path, bot_id: &str) -> PathBuf {
    data_dir.join("bots").join(bot_id).join("MEMORY.md")
}

/// One line of the notes file (v1 ChannelBotNoteLine).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteLine {
    pub index: usize,
    pub date: Option<String>,
    pub text: String,
    pub raw: String,
    pub source: Option<String>,
    pub replaces: Option<String>,
    pub replaced_by: Option<usize>,
}

/// v1 collapseNoteText.
pub fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// v1 replacesMarker: JSON keeps quotes and parentheses exact.
pub fn replaces_marker(text: &str) -> String {
    format!(
        "{MARKER}{})",
        serde_json::to_string(text).unwrap_or_default()
    )
}

fn is_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            _ => c.is_ascii_digit(),
        })
}

/// "- YYYY-MM-DD: text" -> (date, rest).
fn dated(raw: &str) -> Option<(String, String)> {
    let rest = raw.strip_prefix("- ")?;
    let date = rest.get(..10)?;
    let text = rest.get(10..)?.strip_prefix(": ")?;
    (is_date(date) && !text.is_empty()).then(|| (date.to_owned(), text.to_owned()))
}

/// "text (asked in <id>)" -> (text, id), v1 SOURCED.
fn sourced(text: &str) -> Option<(String, String)> {
    let body = text.strip_suffix(')')?;
    let at = body.rfind(" (asked in ")?;
    let id = &body[at + " (asked in ".len()..];
    (!id.is_empty() && !id.contains(char::is_whitespace))
        .then(|| (body[..at].to_owned(), id.to_owned()))
}

fn parse_line(raw: &str, index: usize) -> NoteLine {
    if raw.ends_with(')') {
        let mut from = 0;
        while let Some(found) = raw[from..].find(MARKER) {
            let at = from + found;
            let json = &raw[at + MARKER.len()..raw.len() - 1];
            if let Ok(serde_json::Value::String(replaces)) = serde_json::from_str(json)
                && let Some((date, text)) = dated(&raw[..at])
                && let Some((text, source)) = sourced(&text)
            {
                return NoteLine {
                    index,
                    date: Some(date),
                    text,
                    raw: raw.to_owned(),
                    source: Some(source),
                    replaces: Some(replaces),
                    replaced_by: None,
                };
            }
            from = at + 1;
        }
    }
    if let Some((date, text)) = dated(raw) {
        let (text, source) = match sourced(&text) {
            Some((t, s)) => (t, Some(s)),
            None => (text, None),
        };
        return NoteLine {
            index,
            date: Some(date),
            text,
            raw: raw.to_owned(),
            source,
            replaces: None,
            replaced_by: None,
        };
    }
    let text = raw
        .strip_prefix("- ")
        .or_else(|| raw.strip_prefix("* "))
        .unwrap_or(raw)
        .trim_start()
        .to_owned();
    NoteLine {
        index,
        date: None,
        text,
        raw: raw.to_owned(),
        source: None,
        replaces: None,
        replaced_by: None,
    }
}

/// v1 parseChannelBotNoteLines: every line, oldest first, without header, blanks or headings;
/// a correction replaces the nearest earlier note still in force with that text.
pub fn parse_lines(text: &str) -> Vec<NoteLine> {
    let normal = text.replace("\r\n", "\n");
    let body = normal.strip_prefix(NOTES_HEADER).unwrap_or(&normal);
    let mut lines: Vec<NoteLine> = Vec::new();
    for raw in body.split('\n') {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let n = lines.len();
        lines.push(parse_line(line, n));
    }
    let mut in_force: HashMap<String, Vec<usize>> = HashMap::new();
    let mut replaced_by: HashMap<usize, usize> = HashMap::new();
    for line in &lines {
        if let Some(old) = &line.replaces
            && let Some(earlier) = in_force.get_mut(&collapse(old)).and_then(Vec::pop)
        {
            replaced_by.insert(earlier, line.index);
        }
        in_force
            .entry(collapse(&line.text))
            .or_default()
            .push(line.index);
    }
    for line in &mut lines {
        line.replaced_by = replaced_by.get(&line.index).copied();
    }
    lines
}

/// Notes chosen for one message (v1 ChannelBotNotesSnapshot without `ranked`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NotesSnapshot {
    pub standing: String,
    pub matched: String,
    /// Digest of the text read; None = no file.
    pub revision: Option<String>,
}

impl NotesSnapshot {
    /// v1 channelBotNotesSection: matched older notes, then the standing ones.
    pub fn section(&self) -> String {
        [self.matched.as_str(), self.standing.as_str()]
            .into_iter()
            .filter(|p| !p.is_empty())
            .collect::<Vec<_>>()
            .join("\n")
    }
}

fn terms(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for ch in text.chars() {
        if ch.is_alphanumeric() || ch == '_' {
            cur.extend(ch.to_lowercase());
        } else if !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn query_terms(query: &str) -> Vec<String> {
    let chars: Vec<char> = query.chars().collect();
    let head: String = chars.iter().take(QUERY_EDGE_CHARS).collect();
    let mut all: Vec<String> = terms(&head).into_iter().take(QUERY_HEAD_TERMS).collect();
    if chars.len() > QUERY_EDGE_CHARS {
        let start = QUERY_EDGE_CHARS.max(chars.len() - QUERY_EDGE_CHARS);
        let tail: String = chars[start..].iter().collect();
        all.extend(terms(&tail).into_iter().take(QUERY_TAIL_TERMS));
    }
    let mut seen = HashSet::new();
    all.retain(|t| seen.insert(t.clone()));
    all
}

fn is_hangul(s: &str) -> bool {
    s.chars().any(|c| ('\u{AC00}'..='\u{D7A3}').contains(&c))
}

/// v1 minPrefix: shorter words also match longer ones they start.
fn min_prefix(term: &str) -> usize {
    if is_hangul(term) { 2 } else { 4 }
}

/// v1 scoreLines (BM25).
fn score_lines(lines: &[&NoteLine], query: &str) -> Vec<f64> {
    let mut postings: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    let lengths: Vec<usize> = lines
        .iter()
        .enumerate()
        .map(|(at, line)| {
            let t = terms(&line.text);
            for term in &t {
                postings.entry(term.clone()).or_default().push(at);
            }
            t.len()
        })
        .collect();
    let average = lengths.iter().sum::<usize>() as f64 / lines.len().max(1) as f64;
    let mut scores = vec![0.0; lines.len()];
    for term in query_terms(query) {
        let chars: Vec<char> = term.chars().collect();
        let mut words: HashSet<&String> = HashSet::new();
        if chars.len() >= min_prefix(&term) {
            for (word, _) in postings.range(term.clone()..) {
                if !word.starts_with(&term) {
                    break;
                }
                words.insert(word);
            }
        } else if let Some((w, _)) = postings.get_key_value(&term) {
            words.insert(w);
        }
        for len in min_prefix(&term)..chars.len() {
            let prefix: String = chars[..len].iter().collect();
            if let Some((w, _)) = postings.get_key_value(&prefix) {
                words.insert(w);
            }
        }
        let mut frequency: HashMap<usize, f64> = HashMap::new();
        for word in words {
            for at in &postings[word] {
                *frequency.entry(*at).or_default() += 1.0;
            }
        }
        if frequency.is_empty() {
            continue;
        }
        let n = lines.len() as f64;
        let df = frequency.len() as f64;
        let idf = (1.0 + (n - df + 0.5) / (df + 0.5)).ln();
        for (at, count) in frequency {
            let norm = 1.0 - BM25_B + BM25_B * lengths[at] as f64 / average.max(1.0);
            scores[at] += idf * count * (BM25_K1 + 1.0) / (count + BM25_K1 * norm);
        }
    }
    scores
}

/// v1 selectChannelBotNotes.
pub fn select(text: &str, query: &str, budget: usize) -> NotesSnapshot {
    let recent_budget = budget * NOTES_RECENT_CHARS / NOTES_SECTION_CHARS;
    let parsed = parse_lines(text);
    let live: Vec<&NoteLine> = parsed.iter().filter(|l| l.replaced_by.is_none()).collect();
    let chars = |s: &str| s.chars().count();
    let joined: usize = live
        .iter()
        .enumerate()
        .map(|(at, l)| chars(&l.raw) + usize::from(at != 0))
        .sum();
    let mut standing: HashSet<usize> = HashSet::new();
    let mut used = 0;
    for at in (0..live.len()).rev() {
        let length = chars(&live[at].raw);
        if joined > budget && length > recent_budget {
            continue;
        }
        let cost = length + usize::from(!standing.is_empty());
        if joined > budget && used + cost > recent_budget {
            break;
        }
        standing.insert(at);
        used += cost;
    }
    let scores = score_lines(&live, query);
    let mut ranked: Vec<(usize, f64)> = scores
        .iter()
        .enumerate()
        .filter(|(_, s)| **s > 0.0)
        .map(|(at, s)| (at, *s))
        .collect();
    ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then(b.0.cmp(&a.0)));
    let mut matched = Vec::new();
    let mut room = budget.saturating_sub(recent_budget);
    for (at, _) in ranked {
        let cost = chars(&live[at].raw) + 1;
        if standing.contains(&at) || cost > room {
            continue;
        }
        matched.push(at);
        room -= cost;
    }
    matched.sort_unstable();
    let join = |ids: &mut dyn Iterator<Item = usize>| {
        ids.map(|at| live[at].raw.clone())
            .collect::<Vec<_>>()
            .join("\n")
    };
    NotesSnapshot {
        standing: join(&mut (0..live.len()).filter(|at| standing.contains(at))),
        matched: join(&mut matched.into_iter()),
        revision: None,
    }
}

/// The newest `NOTES_SCAN_BYTES` of the file from a whole line; None when there is no file.
/// A non-regular file is refused (v1 channelBotNotesTail).
pub fn read_tail(path: &Path) -> std::io::Result<Option<String>> {
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    if !meta.is_file() {
        return Err(std::io::Error::other("notes file is not a regular file"));
    }
    let mut file = std::fs::File::open(path)?;
    let size = file.metadata()?.len();
    let truncated = size > NOTES_SCAN_BYTES;
    let start = if truncated {
        size - NOTES_SCAN_BYTES - 1
    } else {
        0
    };
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    if truncated {
        match bytes.iter().position(|b| *b == b'\n') {
            Some(end) => bytes.drain(..=end),
            None => bytes.drain(..),
        };
    }
    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
}

/// The notes to show for `query` (v1 readChannelBotNotesSnapshot). Err = unreadable.
pub fn snapshot(path: &Path, query: &str) -> std::io::Result<NotesSnapshot> {
    let Some(text) = read_tail(path)? else {
        return Ok(NotesSnapshot::default());
    };
    let mut snap = select(&text, query, NOTES_SECTION_CHARS);
    snap.revision = Some(crate::util::stable_id(&[&text]));
    Ok(snap)
}

/// v1 ChannelBotNoteSaved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Saved {
    Wrote {
        line: String,
        correction: Option<&'static str>,
    },
    /// Nothing written: empty note, the same source already saved, or a correction whose words
    /// several current notes read (`alike`).
    Unchanged {
        reason: &'static str,
        alike: Option<usize>,
    },
}

/// v1 channelBotNoteLine: one dated line, collapsed, at most NOTE_MAX_CHARS.
pub fn note_line(
    note: &str,
    day: &str,
    source: Option<&str>,
    replaces: Option<&str>,
) -> Option<String> {
    let text: String = collapse(note).chars().take(NOTE_MAX_CHARS).collect();
    if text.is_empty() {
        return None;
    }
    let source = source
        .map(|s| format!(" (asked in {})", s.split_whitespace().collect::<String>()))
        .unwrap_or_default();
    let marker = replaces.map(replaces_marker).unwrap_or_default();
    Some(format!(
        "- {}: {text}{source}{marker}",
        &day[..10.min(day.len())]
    ))
}

/// v1 appendChannelBotNote. `source` names the call that asked, so a repeated call saves
/// nothing. The caller holds the bot's notes lock.
pub fn append(
    path: &Path,
    note: &str,
    day: &str,
    source: Option<&str>,
    replaces: Option<&str>,
) -> std::io::Result<Saved> {
    if note_line(note, day, source, None).is_none() {
        return Ok(Saved::Unchanged {
            reason: "empty",
            alike: None,
        });
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let existing = match std::fs::read_to_string(path) {
        Ok(t) => Some(t),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e),
    };
    let text = existing.clone().unwrap_or_default();
    if let Some(src) = source
        && text.contains(&format!(" (asked in {src})"))
    {
        return Ok(Saved::Unchanged {
            reason: "already_saved",
            alike: None,
        });
    }
    let mut correction = None;
    let mut replaces_found = None;
    if let Some(old) = replaces {
        let lines = parse_lines(&text);
        let collapsed = collapse(old);
        let wanted = match dated(&collapsed) {
            Some((_, t)) => collapse(&t),
            None => collapsed,
        };
        let current: Vec<&NoteLine> = lines
            .iter()
            .filter(|l| l.replaced_by.is_none() && collapse(&l.text) == wanted)
            .collect();
        match current.len() {
            1 => {
                replaces_found = Some(current[0].text.clone());
                correction = Some("replaced");
            }
            0 => correction = Some("unmatched"),
            n => {
                return Ok(Saved::Unchanged {
                    reason: "alike",
                    alike: Some(n),
                });
            }
        }
    }
    let line = note_line(note, day, source, replaces_found.as_deref()).expect("non-empty");
    let prefix = match &existing {
        None => NOTES_HEADER,
        Some(t) if t.is_empty() || t.ends_with('\n') => "",
        Some(_) => "\n",
    };
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    file.write_all(format!("{prefix}{line}\n").as_bytes())?;
    file.sync_data()?;
    Ok(Saved::Wrote { line, correction })
}

/// `list_bot_notes`: the newest 256 KiB of the notes as lines (v1 channelBotNotes list shape).
/// `revision` is a digest of the whole file (None = no file), the token `write_bot_notes`
/// checks.
pub fn list(path: &Path) -> std::io::Result<goat2_contracts::ChannelListBotNotesResult> {
    let whole = match std::fs::read(path) {
        Ok(b) => String::from_utf8_lossy(&b).into_owned(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(goat2_contracts::ChannelListBotNotesResult {
                revision: None,
                notes: Vec::new(),
                truncated: false,
            });
        }
        Err(e) => return Err(e),
    };
    let tail = read_tail(path)?.unwrap_or_default();
    let notes = parse_lines(&tail)
        .into_iter()
        .map(|l| goat2_contracts::ChannelBotNote {
            index: l.index as u32,
            date: l.date,
            text: l.text,
            replaces: l.replaces,
            replaced_by: l.replaced_by.map(|i| i as u32),
        })
        .collect();
    Ok(goat2_contracts::ChannelListBotNotesResult {
        revision: Some(revision_of(&whole)),
        notes,
        truncated: whole.len() as u64 > NOTES_SCAN_BYTES,
    })
}

/// The notes file's revision token.
pub fn revision_of(text: &str) -> String {
    crate::util::stable_id(&[text])
}

/// Why a notes write did not happen.
#[derive(Debug)]
pub enum WriteError {
    /// The file changed since `expected_revision` (v1 has no direct edit; GOAT 2 refuses a stale one).
    Changed,
    TooLarge,
    Io(std::io::Error),
}

/// `write_bot_notes`: replace the whole notes file (the person's own edit). The caller holds the
/// notes lock.
pub fn write(path: &Path, text: &str, expected: Option<&str>) -> Result<(), WriteError> {
    if text.len() as u64 > NOTES_SCAN_BYTES {
        return Err(WriteError::TooLarge);
    }
    let current = match std::fs::read(path) {
        Ok(b) => Some(String::from_utf8_lossy(&b).into_owned()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(WriteError::Io(e)),
    };
    if let Some(expected) = expected
        && current.as_deref().map(revision_of).as_deref() != Some(expected)
    {
        return Err(WriteError::Changed);
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(WriteError::Io)?;
    }
    let tmp = path.with_extension("md.tmp");
    let body = if text.is_empty() || text.ends_with('\n') {
        text.to_owned()
    } else {
        format!("{text}\n")
    };
    std::fs::write(&tmp, body).map_err(WriteError::Io)?;
    std::fs::rename(tmp, path).map_err(WriteError::Io)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn correction_replaces_the_earlier_note() {
        let text = format!(
            "{NOTES_HEADER}- 2026-11-01: open PRs as drafts\n- 2026-11-02: open PRs ready (asked in in_1){}\n",
            replaces_marker("open PRs as drafts")
        );
        let lines = parse_lines(&text);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].replaced_by, Some(1));
        assert_eq!(lines[1].replaces.as_deref(), Some("open PRs as drafts"));
        let snap = select(&text, "", NOTES_SECTION_CHARS);
        assert!(!snap.standing.contains("- 2026-11-01: open PRs as drafts"));
        assert!(snap.standing.contains("open PRs ready"));
    }

    #[test]
    fn older_notes_that_match_join_the_standing_ones() {
        let mut text = String::from(NOTES_HEADER);
        text.push_str("- 2026-01-01: the deploy key lives in vault path ops/deploy\n");
        for i in 0..400 {
            text.push_str(&format!(
                "- 2026-02-01: filler note number {i} about nothing much at all\n"
            ));
        }
        let snap = select(&text, "where is the deploy key?", NOTES_SECTION_CHARS);
        assert!(snap.matched.contains("vault path"));
        assert!(!snap.standing.contains("vault path"));
        assert!(snap.standing.contains("number 399"));
        assert!(snap.standing.chars().count() <= NOTES_RECENT_CHARS);
    }

    #[test]
    fn append_writes_header_once_and_skips_a_repeated_source() {
        let dir = tempfile::tempdir().unwrap();
        let path = notes_path(dir.path(), "goat");
        let first = append(
            &path,
            "  likes   short answers ",
            "2026-11-28T00:00:00Z",
            Some("call_1"),
            None,
        )
        .unwrap();
        assert!(matches!(first, Saved::Wrote { .. }));
        let again = append(
            &path,
            "likes short answers",
            "2026-11-28",
            Some("call_1"),
            None,
        )
        .unwrap();
        assert!(matches!(
            again,
            Saved::Unchanged {
                reason: "already_saved",
                ..
            }
        ));
        let fix = append(
            &path,
            "likes long answers",
            "2026-11-29",
            Some("call_2"),
            Some("likes short answers"),
        )
        .unwrap();
        assert!(matches!(
            fix,
            Saved::Wrote {
                correction: Some("replaced"),
                ..
            }
        ));
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.starts_with(NOTES_HEADER));
        assert_eq!(text.matches("# GOAT Bot notes").count(), 1);
        let snap = snapshot(&path, "").unwrap();
        assert_eq!(
            snap.standing,
            "- 2026-11-29: likes long answers (asked in call_2) (replaces: \"likes short answers\")"
        );
        assert!(snap.revision.is_some());
    }

    #[test]
    fn missing_file_is_empty_and_a_directory_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            snapshot(&dir.path().join("none.md"), "x").unwrap(),
            NotesSnapshot::default()
        );
        assert!(snapshot(dir.path(), "x").is_err());
    }
}
