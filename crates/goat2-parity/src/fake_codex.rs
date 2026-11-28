//! Method-oriented replay of recorded Codex app-server traffic.
use crate::transcript::{self, Record};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug)]
struct Exchange {
    outbound: Value,
    inbound: Vec<Value>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub consumed: usize,
    pub significant_total: usize,
    pub significant_consumed: usize,
    pub outbound_checked: usize,
    pub mismatches: Vec<String>,
    pub synthesized: Vec<String>,
}

pub struct Replay {
    exchanges: Vec<Exchange>,
    used: Vec<bool>,
    thread: String,
    claim: usize,
    dir: PathBuf,
    pub report: Report,
}

fn method(frame: &Value) -> &str {
    frame.get("method").and_then(Value::as_str).unwrap_or("")
}
fn significant(m: &str) -> bool {
    matches!(
        m,
        "thread/start" | "thread/resume" | "turn/start" | "turn/steer" | "turn/interrupt"
    )
}
fn skippable(m: &str) -> bool {
    matches!(
        m,
        "config/read"
            | "thread/name/set"
            | "thread/read"
            | "account/read"
            | "model/list"
            | "initialized"
    )
}
fn thread_id(frame: &Value) -> Option<&str> {
    frame
        .pointer("/params/threadId")
        .or_else(|| frame.pointer("/params/thread/id"))
        .and_then(Value::as_str)
}
fn text_input(frame: &Value) -> String {
    frame
        .pointer("/params/input")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.get("text").and_then(Value::as_str))
                .collect::<String>()
        })
        .unwrap_or_default()
}

/// How many turn/completed frames the runner allows so far: the number in the release file of
/// the fake dir, 0 when absent. Without the hold, unlimited.
pub fn allowed_completions(dir: &Path, hold: bool) -> u64 {
    if !hold {
        return u64::MAX;
    }
    fs::read_to_string(dir.join("release"))
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}

/// Take one turn completion from the runner's budget. The count is shared by every fake process
/// of the run (a restarted host or another thread starts a new process), so a release spent by an
/// earlier process is not spent again (review r14). It is guarded by an OS file lock, released
/// when its process exits, and any lock or counter error is returned: the caller then emits
/// nothing and fails (review r15).
pub fn take_completion(dir: &Path, hold: bool) -> Result<bool, String> {
    if !hold {
        return Ok(true);
    }
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join("completed.lock"))
        .map_err(|e| format!("completion lock: {e}"))?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        match lock.try_lock() {
            Ok(()) => break,
            Err(fs::TryLockError::WouldBlock) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(5))
            }
            Err(fs::TryLockError::WouldBlock) => return Err("completion lock: timed out".into()),
            Err(fs::TryLockError::Error(e)) => return Err(format!("completion lock: {e}")),
        }
    }
    let path = dir.join("completed");
    let done: u64 = match fs::read_to_string(&path) {
        Ok(text) => text
            .trim()
            .parse()
            .map_err(|e| format!("completion count {text:?}: {e}"))?,
        Err(e) if e.kind() == io::ErrorKind::NotFound => 0,
        Err(e) => return Err(format!("completion count: {e}")),
    };
    let ok = done < allowed_completions(dir, hold);
    if ok {
        fs::write(&path, (done + 1).to_string()).map_err(|e| format!("completion count: {e}"))?;
    }
    // Dropping the file releases the lock.
    Ok(ok)
}

type Frames = Vec<(bool, Value)>;
type Sessions = (Vec<Frames>, Vec<(usize, String)>);

/// The thread a thread/start or thread/resume at index i opens: the id in its response.
fn opened(frames: &[(bool, Value)], i: usize) -> Option<String> {
    let id = frames[i].1.get("id");
    frames[i + 1..].iter().find_map(|(o, f)| {
        (!o && f.get("method").is_none() && f.get("id") == id)
            .then(|| f.pointer("/result/thread/id").and_then(Value::as_str))
            .flatten()
            .map(str::to_owned)
    })
}

/// The recording's app-server sessions (runtime_exit-separated segments) and its claimable
/// units: each thread a session starts or resumes, in recorded order. A GOAT 2 process (one per
/// thread) claims the next one, so a host restart that resumes the thread in a new process
/// replays the recording's next session.
fn sessions(transcript: &Path) -> Result<Sessions, String> {
    let records = transcript::parse(&fs::read(transcript).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let mut segments: Vec<Frames> = vec![Vec::new()];
    for record in records {
        match record {
            Record::ExpectOutbound { frame, .. } => {
                segments.last_mut().unwrap().push((true, frame))
            }
            Record::EmitInbound { frame, .. } => segments.last_mut().unwrap().push((false, frame)),
            Record::RuntimeExit { .. } => segments.push(Vec::new()),
            _ => {}
        }
    }
    let mut units = Vec::new();
    for (index, frames) in segments.iter().enumerate() {
        for (i, (outbound, frame)) in frames.iter().enumerate() {
            if *outbound && matches!(method(frame), "thread/start" | "thread/resume") {
                // A session the recording opens without a thread id in the response cannot be
                // claimed or checked, so the recording is refused (review r14).
                let thread = opened(frames, i).ok_or_else(|| {
                    format!(
                        "unsupported recording: {} in session {index} has no response naming its thread",
                        method(frame)
                    )
                })?;
                units.push((index, thread));
            }
        }
    }
    Ok((segments, units))
}

/// How many fake processes a full replay of this recording needs (one report each).
pub fn claim_count(transcript: &Path) -> Result<usize, String> {
    Ok(sessions(transcript)?.1.len())
}

/// Request fields compared besides the text: a model the recording names must be the one GOAT 2
/// asks for. Not compared: approvalPolicy (the fixtures predate v1's current full-access mapping,
/// which GOAT 2 follows: CodexTurnStartParams.ts:75-90 sends a granular policy where the
/// recordings say "never"), cwd, config overrides, client ids and collaboration settings, which
/// are GOAT 2's own.
fn param_mismatch(m: &str, recorded: &Value, live: &Value) -> Option<String> {
    let differs = |pointer: &str, what: &str| -> Option<String> {
        let want = recorded.pointer(pointer)?;
        let sent = live.pointer(pointer);
        (sent != Some(want)).then(|| {
            format!(
                "{m} {what} differs: recorded {want}, sent {}",
                sent.unwrap_or(&Value::Null)
            )
        })
    };
    // The thread a request names (resume after restart, turns, steers, interrupts) must be the
    // recorded native thread (review r14).
    if matches!(
        m,
        "thread/resume" | "turn/start" | "turn/steer" | "turn/interrupt"
    ) && let Some(mismatch) = differs("/params/threadId", "threadId")
    {
        return Some(mismatch);
    }
    if matches!(m, "thread/start" | "thread/resume" | "turn/start") {
        return differs("/params/model", "model");
    }
    None
}

impl Replay {
    pub fn open(transcript: &Path, dir: &Path) -> Result<Self, String> {
        let (mut segments, units) = sessions(transcript)?;
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let mut chosen = None;
        for (claim, unit) in units.iter().enumerate() {
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(dir.join(format!("claim-{claim}")))
            {
                Ok(_) => {
                    chosen = Some((claim, unit.clone()));
                    break;
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e.to_string()),
            }
        }
        let (claim, (segment, thread)) =
            chosen.ok_or("no unclaimed thread/start or thread/resume exchange")?;
        let frames = std::mem::take(&mut segments[segment]);
        // One process per GOAT 2 thread, one v1 process for all: keep this thread's frames plus
        // frames that belong to no thread (initialize, account reads). A frame belongs to the thread
        // it names; a response to the request it answers; an unnamed notification to the request
        // it follows. Grouping after filtering keeps this thread's inbound frames that v1 received
        // while another thread's request was the latest one.
        let mut request_owner: std::collections::HashMap<String, Option<String>> =
            std::collections::HashMap::new();
        let mut current: Option<String> = None;
        let mut exchanges: Vec<Exchange> = Vec::new();
        for i in 0..frames.len() {
            let (outbound, frame) = &frames[i];
            let owner = if *outbound {
                let owner = if matches!(method(frame), "thread/start" | "thread/resume") {
                    opened(&frames, i)
                } else {
                    thread_id(frame).map(str::to_owned)
                };
                if let Some(id) = frame.get("id") {
                    request_owner.insert(id.to_string(), owner.clone());
                }
                current = owner.clone();
                owner
            } else if let Some(id) = thread_id(frame) {
                Some(id.to_owned())
            } else if frame.get("method").is_none() {
                frame
                    .get("id")
                    .and_then(|id| request_owner.get(&id.to_string()).cloned())
                    .flatten()
            } else {
                current.clone()
            };
            if owner.as_ref().is_some_and(|o| o != &thread) {
                continue;
            }
            if *outbound {
                exchanges.push(Exchange {
                    outbound: frame.clone(),
                    inbound: Vec::new(),
                });
            } else if let Some(e) = exchanges.last_mut() {
                e.inbound.push(frame.clone());
            }
        }
        let used = vec![false; exchanges.len()];
        let total = exchanges
            .iter()
            .zip(&used)
            .filter(|(e, u)| !**u && significant(method(&e.outbound)))
            .count();
        let replay = Self {
            exchanges,
            used,
            thread,
            claim,
            dir: dir.to_owned(),
            report: Report {
                significant_total: total,
                ..Report::default()
            },
        };
        replay.write_report()?;
        Ok(replay)
    }
    pub fn thread(&self) -> &str {
        &self.thread
    }
    fn write_report(&self) -> Result<(), String> {
        let tmp = self
            .dir
            .join(format!(".report-{}-{}.tmp", self.claim, std::process::id()));
        fs::write(
            &tmp,
            serde_json::to_vec(&self.report).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        fs::rename(tmp, self.dir.join(format!("report-{}.json", self.claim)))
            .map_err(|e| e.to_string())
    }
    fn emit(&self, index: usize, live_id: Option<&Value>, skip: bool) -> Vec<Value> {
        let e = &self.exchanges[index];
        e.inbound
            .iter()
            .filter_map(|f| {
                if thread_id(f).is_some_and(|id| id != self.thread) {
                    return None;
                }
                let response = f.get("method").is_none() && f.get("id").is_some();
                if response && (skip || f.get("id") != e.outbound.get("id")) {
                    return None;
                }
                let mut f = f.clone();
                if response {
                    if let Some(id) = live_id {
                        f["id"] = id.clone();
                    } else {
                        return None;
                    }
                }
                Some(f)
            })
            .collect()
    }
    pub fn handle(&mut self, frame: &Value) -> Result<Vec<Value>, String> {
        let m = method(frame);
        if m.is_empty() {
            return Ok(Vec::new());
        } // response to a server request
        self.report.outbound_checked += 1;
        let pos = self
            .exchanges
            .iter()
            .enumerate()
            .find(|(i, e)| !self.used[*i] && method(&e.outbound) == m)
            .map(|(i, _)| i);
        let mut output = Vec::new();
        if let Some(pos) = pos {
            let blocked = (0..pos)
                .find(|i| !self.used[*i] && !skippable(method(&self.exchanges[*i].outbound)));
            if let Some(i) = blocked {
                if matches!(m, "config/read" | "account/read" | "model/list") {
                    return self.synthesize(frame);
                }
                self.report.mismatches.push(format!(
                    "out of order {m}; expected {}",
                    method(&self.exchanges[i].outbound)
                ));
                if let Some(id) = frame.get("id") {
                    output.push(json!({"id":id,"error":{"code":-32601,"message":"out of order"}}));
                }
            } else {
                for i in 0..pos {
                    if !self.used[i] {
                        output.extend(self.emit(i, None, true));
                        self.used[i] = true;
                        self.report.consumed += 1;
                    }
                }
                if matches!(m, "turn/start" | "turn/steer")
                    && text_input(frame) != text_input(&self.exchanges[pos].outbound)
                {
                    self.report.mismatches.push(format!("{m} text differs"));
                }
                if let Some(mismatch) = param_mismatch(m, &self.exchanges[pos].outbound, frame) {
                    self.report.mismatches.push(mismatch);
                }
                output.extend(self.emit(pos, frame.get("id"), false));
                self.used[pos] = true;
                self.report.consumed += 1;
                if significant(m) {
                    self.report.significant_consumed += 1;
                }
            }
        } else if matches!(m, "config/read" | "account/read" | "model/list") {
            return self.synthesize(frame);
        } else {
            self.report
                .mismatches
                .push(format!("unrecorded method {m}"));
            if let Some(id) = frame.get("id") {
                output
                    .push(json!({"id":id,"error":{"code":-32601,"message":"method not recorded"}}));
            }
        }
        self.write_report()?;
        Ok(output)
    }
    fn synthesize(&mut self, frame: &Value) -> Result<Vec<Value>, String> {
        let m = method(frame);
        self.report.synthesized.push(m.into());
        let result = self
            .exchanges
            .iter()
            .rev()
            .filter(|e| method(&e.outbound) == m)
            .flat_map(|e| e.inbound.iter())
            .find_map(|f| f.get("result").cloned())
            .unwrap_or_else(|| match m {
                "config/read" => json!({"config":{},"origins":{}}),
                "model/list" => json!({"data":[],"nextCursor":null}),
                _ => json!({}),
            });
        self.write_report()?;
        Ok(frame
            .get("id")
            .map(|id| vec![json!({"id":id,"result":result})])
            .unwrap_or_default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup(scenario: &str) -> (Replay, PathBuf) {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("scenarios")
            .join(scenario)
            .join("transcripts/codex.ndjson");
        // One directory per test: claims are per directory.
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "goat2-parity-replay-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        let replay = Replay::open(&root, &dir).unwrap();
        (replay, dir)
    }
    #[test]
    fn simple_replay_and_order() {
        let (mut r, dir) = setup("simple_turn");
        r.handle(&json!({"id":42,"method":"initialize","params":{}}))
            .unwrap();
        r.handle(&json!({"method":"initialized"})).unwrap();
        let start = r
            .handle(&json!({"id":43,"method":"thread/start","params":{"model":"gpt-6-luna"}}))
            .unwrap();
        assert!(
            start
                .iter()
                .any(|f| f["id"] == 43 && f.get("result").is_some())
        );
        r.handle(&json!({"id":44,"method":"config/read","params":{}}))
            .unwrap();
        let thread = r.thread().to_owned();
        let events = r.handle(&json!({"id":45,"method":"turn/start","params":{"threadId":thread,"model":"gpt-6-luna","input":[{"type":"text","text":"Respond with the following text: fixture simple ok"}]}})).unwrap();
        assert!(events.iter().any(|f| method(f) == "turn/completed"));
        assert_eq!(r.report.significant_total, r.report.significant_consumed);
        assert!(r.report.mismatches.is_empty());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn mismatch_and_out_of_order() {
        let (mut r, dir) = setup("simple_turn");
        r.handle(&json!({"id":1,"method":"initialize"})).unwrap();
        r.handle(&json!({"method":"initialized"})).unwrap();
        r.handle(&json!({"id":2,"method":"turn/start"})).unwrap();
        assert!(r.report.mismatches[0].contains("out of order"));
        r.handle(&json!({"id":3,"method":"thread/start"})).unwrap();
        r.handle(&json!({"id":4,"method":"turn/start","params":{"input":[{"type":"text","text":"wrong"}]}})).unwrap();
        assert!(
            r.report
                .mismatches
                .iter()
                .any(|m| m.contains("text differs"))
        );
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn distinct_claims() {
        let (first, dir) = setup("thread_tools_send_wait");
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("scenarios/thread_tools_send_wait/transcripts/codex.ndjson");
        let second = Replay::open(&path, &dir).unwrap();
        assert_ne!(first.thread(), second.thread());
        fs::remove_dir_all(dir).unwrap();
    }

    /// Frames shaped like the GOAT 2 driver's (crates/goat2-engine-codex/tests/fixtures/
    /// codex-0.167.0/basic.json): other initialize params, config/read before turn/start.
    #[test]
    fn goat2_shaped_frames_replay_a_v1_recording() {
        let (mut r, dir) = setup("simple_turn");
        let init = r.handle(&json!({"id": 1, "method": "initialize", "params": {"capabilities": {"experimentalApi": true}, "clientInfo": {"name": "T3 Code", "title": "T3 Code", "version": "0.0.0"}}})).unwrap();
        assert!(
            init.iter()
                .any(|f| f["id"] == 1 && f.get("result").is_some())
        );
        r.handle(&json!({"method": "initialized"})).unwrap();
        let start = r.handle(&json!({"id": 2, "method": "thread/start", "params": {"cwd": "/w", "model": "gpt-6-luna"}})).unwrap();
        let thread = start
            .iter()
            .find_map(|f| f.pointer("/result/thread/id"))
            .unwrap()
            .clone();
        let config = r.handle(&json!({"id": 3, "method": "config/read", "params": {"cwd": "/w", "includeLayers": false}})).unwrap();
        assert!(config.iter().any(|f| f["id"] == 3));
        let turn = r.handle(&json!({"id": 4, "method": "turn/start", "params": {"model": "gpt-6-luna", "threadId": thread, "clientUserMessageId": "goat-input-1", "input": [{"text": "Respond with the following text: fixture simple ok", "text_elements": [], "type": "text"}]}})).unwrap();
        assert!(
            turn.iter()
                .any(|f| f["id"] == 4 && f.get("result").is_some())
        );
        assert!(turn.iter().any(|f| method(f) == "turn/completed"));
        assert_eq!(r.report.significant_consumed, r.report.significant_total);
        assert!(r.report.mismatches.is_empty(), "{:?}", r.report.mismatches);
        fs::remove_dir_all(dir).unwrap();
    }
    /// The second process of a two-thread recording replays the child's frames only.
    #[test]
    fn second_claim_replays_the_child_thread() {
        let (_parent, dir) = setup("thread_tools_send_wait");
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("scenarios/thread_tools_send_wait/transcripts/codex.ndjson");
        let mut child = Replay::open(&path, &dir).unwrap();
        let thread = child.thread().to_owned();
        child
            .handle(&json!({"id": 1, "method": "initialize", "params": {}}))
            .unwrap();
        child.handle(&json!({"method": "initialized"})).unwrap();
        let start = child
            .handle(&json!({"id": 2, "method": "thread/start", "params": {}}))
            .unwrap();
        assert_eq!(
            start
                .iter()
                .find_map(|f| f.pointer("/result/thread/id"))
                .unwrap(),
            &json!(thread)
        );
        let turn = child.handle(&json!({"id": 3, "method": "turn/start", "params": {"threadId": thread, "input": []}})).unwrap();
        assert!(
            turn.iter()
                .any(|f| f["id"] == 3 && f.get("result").is_some())
        );
        assert!(
            turn.iter()
                .all(|f| thread_id(f).is_none_or(|t| t == thread))
        );
        assert!(turn.iter().any(|f| method(f) == "turn/started"));
        fs::remove_dir_all(dir).unwrap();
    }

    /// After a host restart the thread's new process claims the recording's next session, which
    /// resumes the same native thread.
    #[test]
    fn a_restarted_process_claims_the_resumed_session() {
        let (first, dir) = setup("restart_idle_resume");
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("scenarios/restart_idle_resume/transcripts/codex.ndjson");
        let mut second = Replay::open(&path, &dir).unwrap();
        assert_eq!(first.thread(), second.thread());
        second
            .handle(&json!({"id": 1, "method": "initialize", "params": {}}))
            .unwrap();
        second.handle(&json!({"method": "initialized"})).unwrap();
        let resumed = second
            .handle(&json!({"id": 2, "method": "thread/resume", "params": {"model": "gpt-6-luna", "threadId": first.thread()}}))
            .unwrap();
        assert!(
            resumed
                .iter()
                .any(|f| f["id"] == 2 && f.get("result").is_some())
        );
        assert!(
            second.report.mismatches.is_empty(),
            "{:?}",
            second.report.mismatches
        );
        fs::remove_dir_all(dir).unwrap();
    }

    /// r13: a request naming another model than the recording is a mismatch.
    #[test]
    fn a_different_model_is_a_mismatch() {
        let recorded = json!({"method": "turn/start", "params": {"model": "gpt-6-luna"}});
        assert!(
            param_mismatch(
                "turn/start",
                &recorded,
                &json!({"params": {"model": "gpt-6-luna"}})
            )
            .is_none()
        );
        assert!(
            param_mismatch(
                "turn/start",
                &recorded,
                &json!({"params": {"model": "other"}})
            )
            .is_some()
        );
        assert!(param_mismatch("turn/start", &recorded, &json!({"params": {}})).is_some());
        assert_eq!(
            claim_count(
                &PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("scenarios/thread_tools_send_wait/transcripts/codex.ndjson")
            )
            .unwrap(),
            2
        );
        assert_eq!(
            claim_count(
                &PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("scenarios/restart_idle_resume/transcripts/codex.ndjson")
            )
            .unwrap(),
            2
        );
    }

    /// r14: a resume naming another thread than the recorded one is a mismatch.
    #[test]
    fn a_resume_of_another_thread_is_a_mismatch() {
        let (first, dir) = setup("restart_idle_resume");
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("scenarios/restart_idle_resume/transcripts/codex.ndjson");
        let mut second = Replay::open(&path, &dir).unwrap();
        second
            .handle(&json!({"id": 1, "method": "initialize", "params": {}}))
            .unwrap();
        second.handle(&json!({"method": "initialized"})).unwrap();
        second
            .handle(&json!({"id": 2, "method": "thread/resume", "params": {"model": "gpt-6-luna", "threadId": "not-the-recorded-thread"}}))
            .unwrap();
        assert!(
            second
                .report
                .mismatches
                .iter()
                .any(|m| m.contains("threadId differs")),
            "{:?}",
            second.report.mismatches
        );
        drop(first);
        fs::remove_dir_all(dir).unwrap();
    }
    /// r14: a recorded thread/start without a response naming its thread is refused.
    #[test]
    fn an_unanswered_thread_start_is_refused() {
        let src = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("scenarios/simple_turn/transcripts/codex.ndjson");
        let mut text = fs::read_to_string(src).unwrap();
        text.push_str(&json!({"type": "runtime_exit", "status": "success"}).to_string());
        text.push('\n');
        text.push_str(&json!({"type": "expect_outbound", "frame": {"id": 99, "method": "thread/start", "params": {}}}).to_string());
        text.push('\n');
        let path = std::env::temp_dir().join(format!(
            "goat2-parity-unanswered-{}.ndjson",
            std::process::id()
        ));
        fs::write(&path, text).unwrap();
        let err = claim_count(&path).unwrap_err();
        let _ = fs::remove_file(&path);
        assert!(err.contains("no response naming its thread"), "{err}");
    }
    /// r14: completions are one budget for all fake processes of a run.
    #[test]
    fn the_completion_budget_is_shared_across_processes() {
        let (_r, dir) = setup("simple_turn");
        fs::write(dir.join("release"), "1").unwrap();
        assert!(take_completion(&dir, true).unwrap());
        // A later process (restarted host) does not get the spent release again.
        assert!(!take_completion(&dir, true).unwrap());
        fs::write(dir.join("release"), "2").unwrap();
        assert!(take_completion(&dir, true).unwrap());
        assert!(take_completion(&dir, false).unwrap());
        // r15: an unwritable counter is an error, never a completion.
        fs::write(dir.join("release"), "9").unwrap();
        fs::remove_file(dir.join("completed")).unwrap();
        fs::create_dir(dir.join("completed")).unwrap();
        assert!(take_completion(&dir, true).is_err());
        fs::remove_dir(dir.join("completed")).unwrap();
        // r15: while another handle holds the OS lock it is not taken; once released it is.
        let held = OpenOptions::new()
            .write(true)
            .open(dir.join("completed.lock"))
            .unwrap();
        held.lock().unwrap();
        let other = OpenOptions::new()
            .write(true)
            .open(dir.join("completed.lock"))
            .unwrap();
        assert!(matches!(
            other.try_lock(),
            Err(fs::TryLockError::WouldBlock)
        ));
        drop(held);
        assert!(take_completion(&dir, true).unwrap());
        fs::remove_dir_all(dir).unwrap();
    }
}
