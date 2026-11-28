//! Kimi Code (`kimi-code`, local `kimi`). v1
//! `packages/provider-acp-registry/src/server/kimiAcp.ts@916b5ccc1b2` (whole file).
//!
//! Kimi can answer `session/prompt` with `end_turn` for a turn it ended with an error. Its own
//! session log (`<KIMI_CODE_HOME or HOME/.kimi-code>/sessions/<workspace>/<session>/agents/main/wire.jsonl`)
//! says how the turn really ended: before the prompt GOAT notes where the log ends, and after an
//! `end_turn` it reads what Kimi appended, matching `turn.prompt` to `turn.ended` by turn id.
//! A `failed` turn fails GOAT's turn and restarts Kimi. v1 compares the environment the session
//! was recorded with to the runtime one (`kimiRecordedEnvironment`); GOAT 2 has one environment per
//! process and reads HOME / KIMI_CODE_HOME from it. v1's warnings for an unreadable log are not
//! logged (the crate has no logger); the turn keeps its reported outcome, as in v1.

use std::collections::{HashMap, VecDeque};
use std::fs::{self, File, Metadata};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;

use crate::flavor::{AgentEnv, PromptOutcomeCheck};

const READ_CHUNK_BYTES: u64 = 65_536;
const MAX_OUTCOME_BYTES: u64 = 8 * 1024 * 1024;
const MAX_WORKSPACES: usize = 1_024;
const MAX_SESSION_CURSORS: usize = 128;
const MAX_SEEN_TURNS: usize = 64;
/// v1 `Effect.retry({ times: 40, schedule: Schedule.spaced("50 millis") })`: Kimi may flush
/// `turn.ended` just after answering the prompt.
const RETRIES: u32 = 40;
const RETRY_SPACING: Duration = Duration::from_millis(50);
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

#[derive(Debug, PartialEq)]
enum ReadError {
    NotEnded,
    Reset,
    Limit,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct FileIdentity {
    dev: u64,
    ino: u64,
    size: u64,
}

#[cfg(unix)]
fn identity(meta: &Metadata) -> Option<FileIdentity> {
    use std::os::unix::fs::MetadataExt;
    Some(FileIdentity {
        dev: meta.dev(),
        ino: meta.ino(),
        size: meta.len(),
    })
}

/// v1 returns no outcome when the file system reports no inode.
#[cfg(not(unix))]
fn identity(_meta: &Metadata) -> Option<FileIdentity> {
    None
}

fn native_session_id(id: &str) -> bool {
    (1..=128).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

type Seen = Arc<Mutex<VecDeque<i64>>>;

fn remember(seen: &Seen, turn: i64) {
    let mut seen = seen.lock().expect("kimi turns");
    seen.retain(|t| *t != turn);
    seen.push_back(turn);
    if seen.len() > MAX_SEEN_TURNS {
        seen.pop_front();
    }
}

/// The one `wire.jsonl` of this session under the Kimi home (v1 `findWire` :133-175).
fn find_wire(home: &Path, session_id: &str) -> Result<Option<PathBuf>, ReadError> {
    let requested = home.join("sessions");
    if !requested.exists() {
        return Ok(None);
    }
    let sessions = fs::canonicalize(&requested).map_err(|_| ReadError::Reset)?;
    if sessions.strip_prefix(home).is_err() {
        return Err(ReadError::Reset);
    }
    let workspaces: Vec<_> = fs::read_dir(&sessions)
        .map_err(|_| ReadError::Reset)?
        .filter_map(|entry| entry.ok().map(|e| e.file_name()))
        .collect();
    if workspaces.len() > MAX_WORKSPACES {
        return Err(ReadError::Limit);
    }
    let mut found = Vec::new();
    for workspace in workspaces {
        if workspace == "." || workspace == ".." {
            continue;
        }
        let candidate = sessions
            .join(&workspace)
            .join(session_id)
            .join("agents")
            .join("main")
            .join("wire.jsonl");
        if !candidate.exists() {
            continue;
        }
        let resolved = fs::canonicalize(&candidate).map_err(|_| ReadError::Reset)?;
        if resolved != candidate {
            return Err(ReadError::Reset);
        }
        found.push(resolved);
    }
    if found.len() > 1 {
        return Err(ReadError::Reset);
    }
    Ok(found.pop())
}

fn read_at(file: &mut File, position: u64, length: u64) -> Option<Vec<u8>> {
    file.seek(SeekFrom::Start(position)).ok()?;
    let mut bytes = Vec::new();
    file.take(length).read_to_end(&mut bytes).ok()?;
    Some(bytes)
}

fn safe_integer(value: Option<&Value>) -> Option<i64> {
    let number = value?.as_f64()?;
    (number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER).then_some(number as i64)
}

/// v1 `KimiTurnPrompt` (:18-25): the turn id of a main-agent prompt line.
fn turn_prompt(line: &str) -> Option<i64> {
    let value: Value = serde_json::from_str(line).ok()?;
    if value.get("type")?.as_str()? != "turn.prompt" || value.get("agentId")?.as_str()? != "main" {
        return None;
    }
    value.get("turnId")?.as_f64()?;
    safe_integer(value.get("turnId"))
}

/// v1 `KimiTurnEnded` (:27-43).
#[derive(Debug, PartialEq)]
struct TurnEnded {
    turn_id: i64,
    reason: String,
    message: Option<String>,
}

fn turn_ended(line: &str) -> Option<TurnEnded> {
    let value: Value = serde_json::from_str(line).ok()?;
    if value.get("type")?.as_str()? != "turn.ended" || value.get("agentId")?.as_str()? != "main" {
        return None;
    }
    let reason = value.get("reason")?.as_str()?.to_owned();
    value.get("turnId")?.as_f64()?;
    let message = match value.get("error") {
        None => None,
        Some(Value::Object(error)) => {
            for (key, bool_field) in [("code", false), ("message", false), ("retryable", true)] {
                match error.get(key) {
                    None => {}
                    Some(Value::Bool(_)) if bool_field => {}
                    Some(Value::String(_)) if !bool_field => {}
                    Some(_) => return None,
                }
            }
            error
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_owned)
        }
        Some(_) => return None,
    };
    Some(TurnEnded {
        turn_id: safe_integer(value.get("turnId"))?,
        reason,
        message,
    })
}

/// v1 `turnFailure` (:51-65). v1's failure class and retryability have no GOAT 2 field.
fn turn_failure(ended: &TurnEnded) -> Option<String> {
    (ended.reason == "failed").then(|| {
        ended
            .message
            .clone()
            .unwrap_or_else(|| "Kimi stopped this turn because of an error.".to_owned())
    })
}

/// v1 `makeKimiPromptOutcomeWatch` (:105-312): per adapter, cursors by Kimi home and session.
#[derive(Debug, Default)]
pub struct KimiOutcomeWatch {
    sessions: Mutex<HashMap<String, Seen>>,
}

impl KimiOutcomeWatch {
    pub fn watch(&self, session_id: &str, env: &AgentEnv) -> Option<Box<dyn PromptOutcomeCheck>> {
        if !native_session_id(session_id) {
            return None;
        }
        let home = env
            .get("KIMI_CODE_HOME")
            .map(|h| h.trim().to_owned())
            .filter(|h| !h.is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                env.get("HOME")
                    .filter(|h| !h.is_empty())
                    .map(|h| Path::new(&h).join(".kimi-code"))
            })?;
        if !home.is_absolute() {
            return None;
        }
        let home = fs::canonicalize(&home).ok()?;
        let key = format!("{}\0{session_id}", home.display());
        let seen = {
            let mut sessions = self.sessions.lock().expect("kimi sessions");
            if !sessions.contains_key(&key) && sessions.len() >= MAX_SESSION_CURSORS {
                return None;
            }
            sessions.entry(key).or_default().clone()
        };
        let before = find_wire(&home, session_id).ok()?;
        let previous = match &before {
            Some(path) => Some(identity(&fs::metadata(path).ok()?)?),
            None => None,
        };
        let start = previous.map(|p| p.size).unwrap_or(0);
        let anchor_size = start.min(64);
        let anchor = match (&before, anchor_size) {
            (Some(path), size) if size > 0 => {
                let mut file = File::open(path).ok()?;
                let info = identity(&file.metadata().ok()?)?;
                if Some(info) != previous {
                    return None;
                }
                let bytes = read_at(&mut file, start - size, size)?;
                if bytes.len() as u64 != size {
                    return None;
                }
                bytes
            }
            _ => Vec::new(),
        };
        Some(Box::new(KimiCheck {
            home,
            session_id: session_id.to_owned(),
            seen,
            before,
            previous,
            start,
            anchor,
        }))
    }
}

struct KimiCheck {
    home: PathBuf,
    session_id: String,
    seen: Seen,
    before: Option<PathBuf>,
    previous: Option<FileIdentity>,
    start: u64,
    anchor: Vec<u8>,
}

struct Cursor {
    offset: u64,
    discard_old_partial: bool,
    identity: Option<FileIdentity>,
    prompt_turn: Option<i64>,
    replayed_turn: Option<i64>,
}

impl KimiCheck {
    /// v1 `readAppended` (:222-291).
    fn read_appended(&self, wire: &Path, cursor: &mut Cursor) -> Result<TurnEnded, ReadError> {
        let mut file = File::open(wire).map_err(|_| ReadError::Reset)?;
        let info = file
            .metadata()
            .ok()
            .and_then(|m| identity(&m))
            .ok_or(ReadError::Reset)?;
        if let Some(known) = cursor.identity
            && (info.dev != known.dev || info.ino != known.ino || info.size < cursor.offset)
        {
            return Err(ReadError::Reset);
        }
        cursor.identity.get_or_insert(info);
        let anchor_size = self.anchor.len() as u64;
        if anchor_size > 0 {
            let current = read_at(&mut file, self.start - anchor_size, anchor_size);
            if current.as_deref() != Some(self.anchor.as_slice()) {
                return Err(ReadError::Reset);
            }
        }
        let mut bytes = Vec::new();
        let mut position = cursor.offset;
        while position - self.start < MAX_OUTCOME_BYTES {
            let remaining = MAX_OUTCOME_BYTES - (position - self.start);
            let chunk =
                read_at(&mut file, position, READ_CHUNK_BYTES.min(remaining)).unwrap_or_default();
            if chunk.is_empty() {
                break;
            }
            position += chunk.len() as u64;
            bytes.extend_from_slice(&chunk);
        }
        let complete = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
        cursor.offset += complete as u64;
        let mut fresh = &bytes[..complete];
        if cursor.discard_old_partial && complete > 0 {
            let first = fresh.iter().position(|b| *b == b'\n').map_or(0, |i| i + 1);
            fresh = &fresh[first..];
            cursor.discard_old_partial = false;
        }
        for line in String::from_utf8_lossy(fresh).split('\n') {
            if line.contains("\"turn.prompt\"") {
                if let Some(turn) = turn_prompt(line) {
                    if self.seen.lock().expect("kimi turns").contains(&turn) {
                        cursor.replayed_turn = Some(turn);
                        continue;
                    }
                    if cursor.prompt_turn.is_some_and(|p| p != turn) {
                        return Err(ReadError::Reset);
                    }
                    cursor.prompt_turn = Some(turn);
                    remember(&self.seen, turn);
                }
            } else if line.contains("\"turn.ended\"")
                && let Some(ended) = turn_ended(line)
            {
                if cursor.replayed_turn == Some(ended.turn_id) {
                    cursor.replayed_turn = None;
                    continue;
                }
                remember(&self.seen, ended.turn_id);
                if cursor.prompt_turn == Some(ended.turn_id) {
                    return Ok(ended);
                }
            }
        }
        if position - self.start >= MAX_OUTCOME_BYTES {
            return Err(ReadError::Limit);
        }
        Err(ReadError::NotEnded)
    }
}

impl PromptOutcomeCheck for KimiCheck {
    /// v1 `KimiTurnOutcome.check` (:211-310).
    fn check(self: Box<Self>, response: &Value) -> Option<String> {
        if response.get("stopReason").and_then(Value::as_str) != Some("end_turn") {
            return None;
        }
        let wire = match &self.before {
            Some(path) => path.clone(),
            None => find_wire(&self.home, &self.session_id).ok()??,
        };
        let mut cursor = Cursor {
            offset: self.start,
            discard_old_partial: self.anchor.last().is_some_and(|b| *b != b'\n'),
            identity: self.previous,
            prompt_turn: None,
            replayed_turn: None,
        };
        for attempt in 0..=RETRIES {
            match self.read_appended(&wire, &mut cursor) {
                Ok(ended) => return turn_failure(&ended),
                Err(ReadError::NotEnded) if attempt < RETRIES => std::thread::sleep(RETRY_SPACING),
                Err(_) => return None,
            }
        }
        None
    }
}

// Log identity is Unix only here (round 7 part 7.3); the tests unwrap `watch`.
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    fn env(home: &Path) -> AgentEnv {
        AgentEnv {
            set: vec![("KIMI_CODE_HOME".into(), home.to_string_lossy().into_owned())],
            ..AgentEnv::default()
        }
    }

    fn wire(home: &Path, session: &str) -> PathBuf {
        let dir = home
            .join("sessions")
            .join("ws1")
            .join(session)
            .join("agents")
            .join("main");
        fs::create_dir_all(&dir).unwrap();
        dir.join("wire.jsonl")
    }

    fn append(path: &Path, lines: &[Value]) {
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        for line in lines {
            writeln!(file, "{line}").unwrap();
        }
    }

    fn end_turn() -> Value {
        json!({"stopReason": "end_turn"})
    }

    #[test]
    fn a_failed_turn_after_end_turn_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        let home = fs::canonicalize(dir.path()).unwrap();
        let path = wire(&home, "s1");
        append(
            &path,
            &[
                json!({"type": "turn.prompt", "agentId": "main", "turnId": 1}),
                json!({"type": "turn.ended", "agentId": "main", "turnId": 1, "reason": "completed"}),
            ],
        );
        let watch = KimiOutcomeWatch::default();
        let check = watch.watch("s1", &env(&home)).unwrap();
        append(
            &path,
            &[
                json!({"type": "turn.prompt", "agentId": "main", "turnId": 2}),
                json!({"type": "turn.ended", "agentId": "sub", "turnId": 2, "reason": "failed"}),
                json!({"type": "turn.ended", "agentId": "main", "turnId": 2, "reason": "failed", "error": {"code": "provider.rate_limit", "message": "Rate limited", "retryable": true}}),
            ],
        );
        assert_eq!(check.check(&end_turn()), Some("Rate limited".into()));
        // A completed turn keeps its outcome; other stop reasons are not checked.
        let check = watch.watch("s1", &env(&home)).unwrap();
        append(
            &path,
            &[
                json!({"type": "turn.prompt", "agentId": "main", "turnId": 3}),
                json!({"type": "turn.ended", "agentId": "main", "turnId": 3, "reason": "completed"}),
            ],
        );
        assert_eq!(check.check(&end_turn()), None);
        let check = watch.watch("s1", &env(&home)).unwrap();
        append(
            &path,
            &[
                json!({"type": "turn.prompt", "agentId": "main", "turnId": 4}),
                json!({"type": "turn.ended", "agentId": "main", "turnId": 4, "reason": "failed"}),
            ],
        );
        assert_eq!(check.check(&json!({"stopReason": "cancelled"})), None);
    }

    #[test]
    fn a_new_session_log_is_found_after_the_prompt() {
        let dir = tempfile::tempdir().unwrap();
        let home = fs::canonicalize(dir.path()).unwrap();
        let watch = KimiOutcomeWatch::default();
        let check = watch.watch("fresh", &env(&home)).unwrap();
        let path = wire(&home, "fresh");
        append(
            &path,
            &[
                json!({"type": "turn.prompt", "agentId": "main", "turnId": 1}),
                json!({"type": "turn.ended", "agentId": "main", "turnId": 1, "reason": "failed"}),
            ],
        );
        assert_eq!(
            check.check(&end_turn()),
            Some("Kimi stopped this turn because of an error.".into())
        );
    }

    #[test]
    fn a_rewritten_log_or_bad_session_gives_no_outcome() {
        let dir = tempfile::tempdir().unwrap();
        let home = fs::canonicalize(dir.path()).unwrap();
        let path = wire(&home, "s1");
        append(
            &path,
            &[json!({"type": "turn.prompt", "agentId": "main", "turnId": 1})],
        );
        let watch = KimiOutcomeWatch::default();
        let check = watch.watch("s1", &env(&home)).unwrap();
        fs::write(
            &path,
            "{\"type\":\"turn.prompt\",\"agentId\":\"main\",\"turnId\":9}\n",
        )
        .unwrap();
        assert_eq!(check.check(&end_turn()), None);
        assert!(watch.watch("../escape", &env(&home)).is_none());
        assert!(
            watch
                .watch(
                    "s1",
                    &AgentEnv {
                        set: vec![("KIMI_CODE_HOME".into(), "relative".into())],
                        ..AgentEnv::default()
                    }
                )
                .is_none()
        );
    }

    #[test]
    fn line_decoding_matches_v1() {
        assert_eq!(
            turn_prompt(r#"{"type":"turn.prompt","agentId":"main","turnId":1.5}"#),
            None
        );
        assert_eq!(
            turn_prompt(r#"{"type":"turn.prompt","agentId":"main","turnId":7}"#),
            Some(7)
        );
        assert!(turn_ended(r#"{"type":"turn.ended","agentId":"main","turnId":1,"reason":"failed","error":{"code":5}}"#).is_none());
        assert_eq!(turn_ended(r#"{"type":"turn.ended","agentId":"main","turnId":1,"reason":"failed","error":{"message":"x"}}"#).unwrap().message.as_deref(), Some("x"));
    }
}
