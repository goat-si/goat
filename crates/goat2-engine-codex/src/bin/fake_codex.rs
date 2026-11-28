//! `goat2-fake-codex`: replays a recorded `codex app-server` session.
//!
//! The transcript path comes from `GOAT2_FAKE_CODEX_TRANSCRIPT`; arguments (`app-server`, `-c ...`)
//! are ignored. Each `expect_outbound` reads one line from stdin and compares it structurally
//! (exit 3 on mismatch, 4 on EOF); each `emit_inbound` writes one line, after `afterMs` (capped at
//! 50 ms unless `GOAT2_FAKE_CODEX_REALTIME=1`); `runtime_exit` exits (0 success, 1 otherwise).
//! Recorded request ids are bound to the live ids GOAT used, and responses are rewritten to them.

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::time::Duration;

use goat2_engine_codex::transcript::{Entry, ExitKind, MatchRules, Transcript, frames_match};
use serde_json::Value;

fn main() {
    let path = match std::env::var("GOAT2_FAKE_CODEX_TRANSCRIPT") {
        Ok(path) => path,
        Err(_) => fail(2, "GOAT2_FAKE_CODEX_TRANSCRIPT is not set"),
    };
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| fail(2, &format!("read {path}: {e}")));
    let transcript: Transcript =
        serde_json::from_str(&text).unwrap_or_else(|e| fail(2, &format!("parse {path}: {e}")));
    let realtime = std::env::var("GOAT2_FAKE_CODEX_REALTIME").is_ok_and(|v| v == "1");
    let rules = MatchRules::for_transcript(&transcript);
    let stdin = std::io::stdin();
    let mut lines = stdin.lock().lines();
    let mut stdout = std::io::stdout().lock();
    let mut ids: HashMap<String, Value> = HashMap::new();

    for (index, entry) in transcript.entries.iter().enumerate() {
        match entry {
            Entry::ExpectOutbound { frame, wildcards, label } => {
                let line = match lines.next() {
                    Some(Ok(line)) => line,
                    _ => fail(4, &format!("entry {index}: stdin closed while expecting {}", describe(frame, label))),
                };
                let actual: Value = serde_json::from_str(&line)
                    .unwrap_or_else(|e| fail(3, &format!("entry {index}: outbound line is not JSON: {e}: {line}")));
                let rules = rules.with_extra_wildcards(wildcards);
                if let Err(mismatch) = frames_match(frame, &actual, &rules) {
                    fail(
                        3,
                        &format!(
                            "entry {index}: {mismatch}\nexpected: {frame}\nactual:   {actual}"
                        ),
                    );
                }
                if frame.get("method").is_some() {
                    if let (Some(recorded), Some(live)) = (frame.get("id"), actual.get("id")) {
                        let key = recorded.to_string();
                        if ids.contains_key(&key) {
                            fail(3, &format!("entry {index}: recorded id {key} bound twice"));
                        }
                        ids.insert(key, live.clone());
                    }
                }
            }
            Entry::EmitInbound { frame, after_ms, .. } => {
                if let Some(ms) = after_ms {
                    let ms = if realtime { *ms } else { (*ms).min(50) };
                    if ms > 0 {
                        std::thread::sleep(Duration::from_millis(ms));
                    }
                }
                let mut frame = frame.clone();
                let is_response = frame.get("method").is_none();
                if is_response {
                    if let Some(id) = frame.get("id").map(Value::to_string) {
                        if let Some(live) = ids.get(&id) {
                            frame["id"] = live.clone();
                        }
                    }
                }
                if writeln!(stdout, "{frame}").and_then(|_| stdout.flush()).is_err() {
                    fail(5, &format!("entry {index}: stdout closed"));
                }
            }
            Entry::RuntimeExit { status, .. } => {
                std::process::exit(if *status == ExitKind::Success { 0 } else { 1 });
            }
        }
    }
    // Done: wait for GOAT to close stdin.
    for line in lines {
        match line {
            Ok(line) if line.trim().is_empty() => {}
            Ok(line) => fail(3, &format!("unexpected outbound frame after the transcript ended: {line}")),
            Err(_) => break,
        }
    }
}

fn describe(frame: &Value, label: &Option<String>) -> String {
    label
        .clone()
        .or_else(|| frame.get("method").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_else(|| frame.to_string())
}

fn fail(code: i32, message: &str) -> ! {
    eprintln!("goat2-fake-codex: {message}");
    std::process::exit(code);
}
