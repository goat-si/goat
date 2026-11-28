//! `goat2-fake-claude`: a stand-in for the `claude` CLI that replays a recorded session over the
//! stream-json wire, so driver tests never need a real CLI or a login.
//!
//! It reads GOAT v1's own Claude replay transcripts unchanged
//! (`apps/server/src/orchestration-v2/testkit/fixtures/<scenario>/claude_transcript.ndjson`,
//! replayed in v1 by `makeReplayQueryRunner`, `ClaudeAdapterV2.testkit.ts:488-890`) and keeps v1's
//! strict cursor: `emit_inbound` entries are written to stdout in order; an `expect_outbound` entry
//! waits for the driver's next frame and fails the run when it does not match. v1 transcripts are
//! SDK-level, so this binary translates each SDK frame to its wire form:
//!
//! | v1 transcript frame | wire |
//! |---|---|
//! | `query.open` options | argv: `--model`, `--permission-mode`, `--session-id=` / `--resume=` |
//! | `prompt.offer` | stdin `{type:"user",...}` (content and priority compared, uuid mapped) |
//! | `query.interrupt` | stdin control_request `interrupt`, answered with success |
//! | `query.set_model` / `query.set_permission_mode` | stdin control_request, answered with success |
//! | `permission.request` | stdout control_request `can_use_tool` |
//! | `permission.response` | stdin control_response to it (behavior, updatedInput, message, interrupt compared) |
//!
//! `initialize`, `mcp_set_servers` and `keep_alive` are answered whenever they arrive. GOAT 2 adds
//! `emit_wire` (a raw stdout frame), `expect_wire` (a raw stdin frame matched as a subset) and
//! `expect_argv` for wire details v1's SDK-level transcripts do not carry, plus `close_stdin`
//! (close stdin just before answering the named transport request, stdout stays open) and `sleep`.
//! `expect_wire` may answer a control request with `reply` (success), `replyError` (error) or
//! `defer` (no answer yet; a later `reply_deferred` entry answers it with success).
//!
//! Environment: `GOAT2_FAKE_CLAUDE_SCRIPT` (transcript path, required), `GOAT2_FAKE_CLAUDE_LOG`
//! (JSON lines: argv, selected env, cwd, every stdin frame, errors, `done`).

use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::process::exit;
use std::time::Duration;

use serde_json::{Value, json};

struct Fake {
    entries: Vec<Value>,
    cursor: usize,
    scenario: String,
    log: Option<std::fs::File>,
    args: Vec<String>,
    stdin: Box<dyn Iterator<Item = std::io::Result<String>>>,
    /// v1 transcript session id -> the id the driver launched with.
    session: Option<(String, String)>,
    /// Recorded prompt uuid -> the driver's prompt uuid (v1 `promptUuidReplacements`).
    uuids: HashMap<String, String>,
    /// can_use_tool requests written and not yet answered.
    open_permissions: Vec<String>,
    next_permission: u64,
    /// A control request whose answer an `expect_wire` entry deferred.
    deferred: Option<Value>,
}

const LOGGED_ENV: [&str; 9] = [
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CONFIG_DIR",
    "MCP_CONNECTION_NONBLOCKING",
    "NO_PROXY",
    "CLAUDECODE",
    "CLAUDE_CODE_SESSION_ID",
    "GOAT_THREAD_ID",
    "CODEX_THREAD_ID",
    "GOAT2_FAKE_CLAUDE_MARKER",
];

impl Fake {
    fn log(&mut self, value: Value) {
        if let Some(file) = self.log.as_mut() {
            let _ = writeln!(file, "{value}");
            let _ = file.flush();
        }
    }

    fn fail(&mut self, message: String) -> ! {
        let message = format!(
            "fake-claude {} at cursor {}: {message}",
            self.scenario, self.cursor
        );
        self.log(json!({"kind": "error", "message": message}));
        eprintln!("{message}");
        exit(3);
    }

    fn write(&mut self, frame: &Value) {
        let mut stdout = std::io::stdout().lock();
        if writeln!(stdout, "{frame}").is_err() || stdout.flush().is_err() {
            exit(0);
        }
    }

    fn arg_value(&self, flag: &str) -> Option<String> {
        let equals = format!("{flag}=");
        let mut iter = self.args.iter();
        while let Some(arg) = iter.next() {
            if arg == flag {
                return iter.next().cloned();
            }
            if let Some(value) = arg.strip_prefix(&equals) {
                return Some(value.to_string());
            }
        }
        None
    }

    /// Replace recorded ids with live ones in an outgoing frame.
    fn localize(&self, frame: &Value) -> Value {
        let mut text = frame.to_string();
        if let Some((recorded, live)) = &self.session
            && recorded != live
        {
            text = text.replace(recorded.as_str(), live.as_str());
        }
        for (recorded, live) in &self.uuids {
            text = text.replace(recorded.as_str(), live.as_str());
        }
        serde_json::from_str(&text).unwrap_or_else(|_| frame.clone())
    }

    /// Next stdin frame that needs the script; answers transport frames itself.
    fn next_frame(&mut self) -> Option<Value> {
        self.next_frame_closing(None)
    }

    /// [Self::next_frame]; when `close_before` names a transport request, stdin is closed just
    /// before that request is answered and None is returned.
    fn next_frame_closing(&mut self, close_before: Option<&str>) -> Option<Value> {
        loop {
            let line = match self.stdin.next() {
                Some(Ok(line)) => line,
                _ => return None,
            };
            if line.trim().is_empty() {
                continue;
            }
            let frame: Value = match serde_json::from_str(&line) {
                Ok(frame) => frame,
                Err(error) => self.fail(format!("stdin line is not JSON: {error}")),
            };
            self.log(json!({"kind": "stdin", "frame": frame}));
            let kind = frame.get("type").and_then(Value::as_str).unwrap_or("");
            if kind == "keep_alive" || kind == "control_cancel_request" {
                continue;
            }
            if kind == "control_request" {
                let id = frame["request_id"].as_str().unwrap_or_default().to_string();
                let subtype = frame["request"]["subtype"].as_str();
                let closing = close_before.is_some() && subtype == close_before;
                if closing {
                    self.stdin = Box::new(std::iter::empty());
                    #[cfg(unix)]
                    // SAFETY: closes this process's own stdin; nothing reads fd 0 any more.
                    unsafe {
                        libc::close(0);
                    }
                    self.log(json!({"kind": "stdin_closed"}));
                }
                match subtype {
                    Some("initialize") => {
                        self.write(&json!({"type": "control_response", "response": {
                        "subtype": "success", "request_id": id, "response": {
                            "commands": [], "agents": [], "output_style": "default",
                            "available_output_styles": ["default"], "models": [], "account": {}
                        }}}));
                        if closing {
                            return None;
                        }
                        continue;
                    }
                    Some("mcp_set_servers") => {
                        let names: Vec<String> = frame["request"]["servers"]
                            .as_object()
                            .map(|s| s.keys().cloned().collect())
                            .unwrap_or_default();
                        self.write(&json!({"type": "control_response", "response": {
                            "subtype": "success", "request_id": id,
                            "response": {"added": names, "removed": [], "errors": {}}}}));
                        if closing {
                            return None;
                        }
                        continue;
                    }
                    _ => {}
                }
            }
            return Some(frame);
        }
    }

    fn reply_success(&mut self, frame: &Value, response: Value) {
        let id = frame["request_id"].clone();
        self.write(&json!({"type": "control_response", "response": {
            "subtype": "success", "request_id": id, "response": response}}));
    }

    fn check_open(&mut self, options: &Value) {
        if let Some(model) = options.get("model").and_then(Value::as_str)
            && self.arg_value("--model").as_deref() != Some(model)
        {
            let actual = self.arg_value("--model");
            self.fail(format!("--model {actual:?}, expected {model}"));
        }
        if let Some(mode) = options.get("permissionMode").and_then(Value::as_str)
            && self.arg_value("--permission-mode").as_deref() != Some(mode)
        {
            let actual = self.arg_value("--permission-mode");
            self.fail(format!("--permission-mode {actual:?}, expected {mode}"));
        }
        if options.get("allowDangerouslySkipPermissions") == Some(&json!(true))
            && !self
                .args
                .iter()
                .any(|a| a == "--allow-dangerously-skip-permissions")
        {
            self.fail("missing --allow-dangerously-skip-permissions".into());
        }
        if !self.args.iter().any(|a| a == "--permission-prompt-tool") {
            self.fail("missing --permission-prompt-tool stdio".into());
        }
        // The live id an earlier process of this run launched with (see below).
        let state = std::env::var("GOAT2_FAKE_CLAUDE_LOG")
            .ok()
            .map(|log| format!("{log}.session"));
        if let Some(resume) = options.get("resume").and_then(Value::as_str) {
            let earlier = state
                .as_ref()
                .and_then(|path| std::fs::read_to_string(path).ok());
            match self.arg_value("--resume") {
                Some(actual) if actual == resume => {
                    self.session = Some((resume.to_string(), actual));
                }
                Some(actual) if earlier.as_deref() == Some(actual.as_str()) => {
                    self.session = Some((resume.to_string(), actual));
                }
                actual => self.fail(format!("--resume {actual:?}, expected {resume}")),
            }
        } else if let Some(recorded) = options.get("sessionId").and_then(Value::as_str) {
            match self.arg_value("--session-id") {
                Some(live) => {
                    if let Some(path) = &state {
                        let _ = std::fs::write(path, &live);
                    }
                    self.session = Some((recorded.to_string(), live));
                }
                None => self.fail("missing --session-id".into()),
            }
        }
    }

    fn expect(&mut self, label: &str, expected: &Value) {
        let kind = expected.get("type").and_then(Value::as_str).unwrap_or("");
        if kind == "query.open" {
            let options = expected.get("options").cloned().unwrap_or(Value::Null);
            self.check_open(&options);
            return;
        }
        let Some(actual) = self.next_frame() else {
            self.fail(format!("stdin closed while expecting {label}"));
        };
        let actual_kind = actual.get("type").and_then(Value::as_str).unwrap_or("");
        match kind {
            "prompt.offer" => {
                let want = &expected["message"];
                if actual_kind != "user"
                    || actual["message"]["content"] != want["message"]["content"]
                    || actual.get("priority") != want.get("priority")
                    || !actual["parent_tool_use_id"].is_null()
                {
                    self.fail(format!("{label}: got {actual}, expected {want}"));
                }
                if let (Some(recorded), Some(live)) =
                    (want["uuid"].as_str(), actual["uuid"].as_str())
                {
                    self.uuids.insert(recorded.to_string(), live.to_string());
                }
            }
            "query.interrupt" | "query.set_model" | "query.set_permission_mode" => {
                let subtype = &kind["query.".len()..];
                if actual_kind != "control_request"
                    || actual["request"]["subtype"] != json!(subtype)
                {
                    self.fail(format!("{label}: got {actual}, expected control {subtype}"));
                }
                let response = match subtype {
                    "set_model" => {
                        if actual["request"]["model"] != expected["model"] {
                            self.fail(format!("{label}: got {actual}"));
                        }
                        json!({"model": expected["model"]})
                    }
                    "set_permission_mode" => {
                        if actual["request"]["mode"] != expected["mode"] {
                            self.fail(format!("{label}: got {actual}"));
                        }
                        json!({"mode": expected["mode"]})
                    }
                    _ => {
                        // The CLI withdraws its open permission prompts when a turn stops.
                        let open = std::mem::take(&mut self.open_permissions);
                        for id in open {
                            self.write(
                                &json!({"type": "control_cancel_request", "request_id": id}),
                            );
                        }
                        json!({})
                    }
                };
                self.reply_success(&actual, response);
            }
            "permission.response" => {
                let id = actual["response"]["request_id"]
                    .as_str()
                    .unwrap_or_default();
                if actual_kind != "control_response"
                    || !self.open_permissions.iter().any(|p| p == id)
                {
                    self.fail(format!(
                        "{label}: got {actual}, expected a can_use_tool answer"
                    ));
                }
                self.open_permissions.retain(|p| p != id);
                let got = &actual["response"]["response"];
                let want = &expected["result"];
                for key in ["behavior", "updatedInput", "message", "interrupt"] {
                    if let Some(value) = want.get(key)
                        && got.get(key) != Some(value)
                    {
                        self.fail(format!(
                            "{label}: {key} {:?}, expected {value}",
                            got.get(key)
                        ));
                    }
                }
            }
            _ => self.fail(format!("unknown expected frame type {kind}")),
        }
    }

    fn emit(&mut self, frame: &Value) {
        if frame.get("type").and_then(Value::as_str) == Some("permission.request") {
            self.next_permission += 1;
            let id = format!("fake_perm_{}", self.next_permission);
            let options = &frame["options"];
            let mut request = json!({
                "subtype": "can_use_tool",
                "tool_name": frame["toolName"],
                "input": frame["input"],
                "tool_use_id": options["toolUseID"],
            });
            for (from, to) in [
                ("suggestions", "permission_suggestions"),
                ("blockedPath", "blocked_path"),
                ("decisionReason", "decision_reason"),
                ("title", "title"),
                ("displayName", "display_name"),
                ("description", "description"),
                ("agentID", "agent_id"),
                ("suppressAlwaysAllowRule", "suppress_always_allow_rule"),
            ] {
                if let Some(value) = options.get(from) {
                    request[to] = value.clone();
                }
            }
            self.open_permissions.push(id.clone());
            self.write(&json!({"type": "control_request", "request_id": id, "request": request}));
            return;
        }
        let frame = self.localize(frame);
        self.write(&frame);
    }

    fn drain_to_eof(&mut self) {
        if let Some(frame) = self.next_frame() {
            self.fail(format!(
                "unexpected frame after the transcript ended: {frame}"
            ));
        }
        self.log(json!({"kind": "done"}));
        exit(0);
    }

    fn run(&mut self) {
        while self.cursor < self.entries.len() {
            let entry = self.entries[self.cursor].clone();
            let label = entry["label"].as_str().unwrap_or_default().to_string();
            match entry["type"].as_str().unwrap_or("") {
                "transcript_start" => {}
                "emit_inbound" => {
                    if let Some(ms) = entry.get("afterMs").and_then(Value::as_u64) {
                        std::thread::sleep(Duration::from_millis(ms));
                    }
                    self.emit(&entry["frame"]);
                }
                "emit_wire" => {
                    if let Some(ms) = entry.get("afterMs").and_then(Value::as_u64) {
                        std::thread::sleep(Duration::from_millis(ms));
                    }
                    let frame = self.localize(&entry["frame"]);
                    self.write(&frame);
                }
                "expect_outbound" => self.expect(&label, &entry["frame"]),
                "close_stdin" => {
                    let before = entry["before"]
                        .as_str()
                        .unwrap_or("mcp_set_servers")
                        .to_string();
                    if let Some(frame) = self.next_frame_closing(Some(&before)) {
                        self.fail(format!("{label}: unexpected frame {frame}"));
                    }
                }
                "sleep" => {
                    let ms = entry["ms"].as_u64().unwrap_or(0);
                    std::thread::sleep(Duration::from_millis(ms));
                }
                "close_stdout" => {
                    // The process stays alive with stdin and stderr open.
                    let _ = std::io::stdout().lock().flush();
                    #[cfg(unix)]
                    // SAFETY: closes this process's own stdout; nothing writes to it afterwards.
                    unsafe {
                        libc::close(1);
                    }
                    self.log(json!({"kind": "stdout_closed"}));
                }
                "expect_wire" => {
                    let Some(actual) = self.next_frame() else {
                        self.fail(format!("stdin closed while expecting {label}"));
                    };
                    if !subset(&entry["frame"], &actual) {
                        self.fail(format!(
                            "{label}: got {actual}, expected {}",
                            entry["frame"]
                        ));
                    }
                    if let Some(reply) = entry.get("reply") {
                        self.reply_success(&actual, reply.clone());
                    }
                    if let Some(error) = entry.get("replyError").and_then(Value::as_str) {
                        let id = actual["request_id"].clone();
                        self.write(&json!({"type": "control_response", "response": {
                            "subtype": "error", "request_id": id, "error": error}}));
                    }
                    if entry.get("defer") == Some(&json!(true)) {
                        self.deferred = Some(actual.clone());
                    }
                    if let (Some(recorded), Some(live)) =
                        (entry["recordUuid"].as_str(), actual["uuid"].as_str())
                    {
                        self.uuids.insert(recorded.to_string(), live.to_string());
                    }
                }
                "reply_deferred" => {
                    if let Some(ms) = entry.get("afterMs").and_then(Value::as_u64) {
                        std::thread::sleep(Duration::from_millis(ms));
                    }
                    let Some(frame) = self.deferred.take() else {
                        self.fail(format!("{label}: nothing deferred"));
                    };
                    match entry.get("error").and_then(Value::as_str) {
                        Some(error) => {
                            let id = frame["request_id"].clone();
                            self.write(&json!({"type": "control_response", "response": {
                                "subtype": "error", "request_id": id, "error": error}}));
                        }
                        None => self.reply_success(&frame, json!({})),
                    }
                }
                "expect_argv" => {
                    for word in entry["contains"].as_array().cloned().unwrap_or_default() {
                        let word = word.as_str().unwrap_or_default();
                        if !self.args.iter().any(|a| a == word) {
                            self.fail(format!("argv lacks {word}: {:?}", self.args));
                        }
                    }
                    for word in entry["lacks"].as_array().cloned().unwrap_or_default() {
                        let word = word.as_str().unwrap_or_default();
                        if self.args.iter().any(|a| a.starts_with(word)) {
                            self.fail(format!("argv has {word}: {:?}", self.args));
                        }
                    }
                }
                "runtime_exit" => {
                    self.cursor += 1;
                    let status = entry["status"].as_str().unwrap_or("success");
                    if status == "success" {
                        self.drain_to_eof();
                    }
                    let error = entry["error"].as_str().unwrap_or("runtime exit");
                    eprintln!("{error}");
                    self.log(json!({"kind": "exit", "status": status}));
                    exit(1);
                }
                other => self.fail(format!("unknown entry type {other}")),
            }
            self.cursor += 1;
        }
        self.drain_to_eof();
    }
}

/// `expected` is contained in `actual` (objects by key, arrays element-wise, scalars equal).
fn subset(expected: &Value, actual: &Value) -> bool {
    match (expected, actual) {
        (Value::Object(want), Value::Object(got)) => want
            .iter()
            .all(|(key, value)| got.get(key).is_some_and(|g| subset(value, g))),
        (Value::Array(want), Value::Array(got)) => {
            want.len() == got.len() && want.iter().zip(got).all(|(w, g)| subset(w, g))
        }
        _ => expected == actual,
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let log = std::env::var_os("GOAT2_FAKE_CLAUDE_LOG")
        .and_then(|path| OpenOptions::new().create(true).append(true).open(path).ok());
    let Some(script) = std::env::var_os("GOAT2_FAKE_CLAUDE_SCRIPT") else {
        // `--version` and `auth status` for probe tests.
        if args.first().map(String::as_str) == Some("--version") {
            println!("2.1.332 (Claude Code)");
            exit(0);
        }
        if args.first().map(String::as_str) == Some("auth") {
            let logged_in = std::env::var("GOAT2_FAKE_CLAUDE_LOGGED_IN").is_ok();
            println!(
                "{}",
                json!({"loggedIn": logged_in, "authMethod": if logged_in {"claude.ai"} else {"none"}, "apiProvider": "firstParty"})
            );
            exit(0);
        }
        eprintln!("GOAT2_FAKE_CLAUDE_SCRIPT is not set");
        exit(2);
    };
    let text = std::fs::read_to_string(&script).unwrap_or_else(|error| {
        eprintln!("cannot read {}: {error}", script.to_string_lossy());
        exit(2);
    });
    let entries: Vec<Value> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            serde_json::from_str(line).unwrap_or_else(|error| {
                eprintln!("bad transcript line: {error}");
                exit(2);
            })
        })
        .collect();
    // A transcript can span processes (v1 multi_turn_restart): each runtime_exit ends one. A
    // resumed launch replays the first segment that opens with `resume`, a new one the first other.
    let args_now: Vec<String> = std::env::args().skip(1).collect();
    let resuming = args_now.iter().any(|a| a.starts_with("--resume="));
    let head: Vec<Value> = entries
        .iter()
        .take_while(|e| e["type"] != "expect_outbound")
        .cloned()
        .collect();
    let mut segments: Vec<Vec<Value>> = vec![Vec::new()];
    for entry in entries.iter().skip(head.len()) {
        if let Some(segment) = segments.last_mut() {
            segment.push(entry.clone());
        }
        if entry["type"] == "runtime_exit" {
            segments.push(Vec::new());
        }
    }
    segments.retain(|s| !s.is_empty());
    let chosen = std::env::var("GOAT2_FAKE_CLAUDE_SEGMENT")
        .ok()
        .and_then(|n| n.parse::<usize>().ok())
        .or_else(|| {
            segments.iter().position(|segment| {
                let opens_resume = segment
                    .iter()
                    .find(|e| e["frame"]["type"] == "query.open")
                    .is_some_and(|e| e["frame"]["options"].get("resume").is_some());
                opens_resume == resuming
            })
        })
        .unwrap_or(0);
    let mut entries = head;
    entries.extend(segments.into_iter().nth(chosen).unwrap_or_default());
    let scenario = entries
        .first()
        .and_then(|e| e["scenario"].as_str())
        .unwrap_or("transcript")
        .to_string();
    let stdin = BufReader::new(std::io::stdin()).lines();
    let mut fake = Fake {
        entries,
        cursor: 0,
        scenario,
        log,
        args,
        stdin: Box::new(stdin),
        session: None,
        uuids: HashMap::new(),
        open_permissions: Vec::new(),
        next_permission: 0,
        deferred: None,
    };
    let env: serde_json::Map<String, Value> = LOGGED_ENV
        .iter()
        .filter_map(|key| std::env::var(key).ok().map(|v| (key.to_string(), json!(v))))
        .collect();
    let cwd = std::env::current_dir()
        .map(|d| d.display().to_string())
        .unwrap_or_default();
    let args = fake.args.clone();
    fake.log(json!({"kind": "start", "args": args, "env": env, "cwd": cwd}));
    fake.run();
}
