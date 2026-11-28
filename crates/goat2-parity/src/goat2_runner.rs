//! Pure scenario-to-host translation and replay preparation for the GOAT 2 runner.
use std::collections::BTreeMap;

use goat2_contracts::{
    card::ThreadKind,
    ids::{InputId, ThreadId},
    log::InputMode,
    model::{ModelSelection, RuntimeMode},
    subscribe::ClientFrame,
};
use serde_json::Value;

use crate::scenario::{SendMode, Step};

/// Replace placeholders in JSON frame values only, retaining all other record metadata.
pub fn materialize_transcript(bytes: &[u8], workspace: &str) -> Result<Vec<u8>, String> {
    fn replace(value: &mut Value, workspace: &str) {
        match value {
            Value::String(s) => *s = s.replace("<workspace>", workspace),
            Value::Array(values) => values.iter_mut().for_each(|v| replace(v, workspace)),
            Value::Object(values) => values.values_mut().for_each(|v| replace(v, workspace)),
            _ => {}
        }
    }
    crate::transcript::parse(bytes).map_err(|e| e.to_string())?;
    let text = std::str::from_utf8(bytes).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for line in text.lines() {
        let mut record: Value = serde_json::from_str(line).map_err(|e| e.to_string())?;
        if let Some(frame) = record.get_mut("frame") {
            replace(frame, workspace);
        }
        serde_json::to_writer(&mut out, &record).map_err(|e| e.to_string())?;
        out.push(b'\n');
    }
    Ok(out)
}

/// Translate a command step using IDs previously observed in the host log.
/// Await and unsupported control steps are handled by the driver, not this function.
pub fn command_for_step(
    step: &Step,
    thread_id: Option<&ThreadId>,
    inputs: &BTreeMap<String, InputId>,
    workspace: &str,
    model: &str,
) -> Result<Option<ClientFrame>, String> {
    let thread = || {
        thread_id
            .cloned()
            .ok_or_else(|| "thread has not started".to_owned())
    };
    let input_id = |alias: &str| {
        inputs
            .get(alias)
            .cloned()
            .ok_or_else(|| format!("input {alias} has not been accepted"))
    };
    let frame = match step {
        Step::Send {
            id,
            input,
            text,
            mode,
            ..
        } => {
            if let Some(thread_id) = thread_id {
                ClientFrame::SendInput {
                    req_id: id.clone(),
                    client_request_id: input.clone(),
                    thread_id: thread_id.clone(),
                    text: text.clone(),
                    mode: match mode {
                        SendMode::Start | SendMode::Queue => InputMode::Followup,
                        SendMode::Steer => InputMode::Steer,
                        SendMode::Interrupt => InputMode::Interrupt,
                    },
                    attachments: None,
                }
            } else {
                ClientFrame::StartThread {
                    req_id: id.clone(),
                    client_request_id: input.clone(),
                    kind: ThreadKind::User,
                    title: None,
                    bot_id: None,
                    parent: None,
                    model_selection: ModelSelection {
                        instance_id: "codex".into(),
                        model: model.into(),
                        options: None,
                    },
                    runtime_mode: Some(RuntimeMode::FullAccess),
                    cwd: Some(workspace.into()),
                    text: Some(text.clone()),
                    mode: None,
                }
            }
        }
        Step::Interrupt { id, .. } => ClientFrame::StopThread {
            req_id: id.clone(),
            client_request_id: id.clone(),
            thread_id: thread()?,
        },
        Step::QueueEdit {
            id, input, text, ..
        } => ClientFrame::EditQueued {
            req_id: id.clone(),
            client_request_id: id.clone(),
            thread_id: thread()?,
            input_id: input_id(input)?,
            text: text.clone(),
        },
        Step::QueueCancel { id, input, .. } => ClientFrame::CancelQueued {
            req_id: id.clone(),
            client_request_id: id.clone(),
            thread_id: thread()?,
            input_id: input_id(input)?,
        },
        Step::QueuePromote { id, input, .. } => ClientFrame::PromoteToSteer {
            req_id: id.clone(),
            client_request_id: id.clone(),
            thread_id: thread()?,
            input_id: input_id(input)?,
        },
        Step::QueueReorder { id, order, .. } => ClientFrame::ReorderQueued {
            req_id: id.clone(),
            client_request_id: id.clone(),
            thread_id: thread()?,
            input_ids: order
                .iter()
                .map(|s| input_id(s))
                .collect::<Result<_, _>>()?,
        },
        Step::Await { .. } => return Ok(None),
        Step::Mcp { .. }
        | Step::AwaitCall { .. }
        | Step::RestartHost { .. }
        | Step::AdvanceClock { .. }
        | Step::ReleaseGate { .. } => {
            return Err("step is not supported by the GOAT 2 runner".into());
        }
    };
    Ok(Some(frame))
}

/// Drives one scenario through a real goat2-host process with the fake codex (see README).
pub mod drive {
    use super::{command_for_step, materialize_transcript};
    use crate::{
        goat2_map::AliasMap,
        scenario::{AwaitCond, LoadedScenario, Step},
        trace::{ObservedEvent, ObservedTrace, Outcome, StreamReport, TraceEvent},
    };
    use goat2_contracts::{
        ParsedLine,
        ids::{InputId, ThreadId},
        log::{LogEvent, RunOutcome},
        subscribe::ClientFrame,
    };
    use serde_json::Value;
    use std::{
        collections::BTreeMap,
        io::{BufRead, BufReader},
        net::TcpStream,
        path::{Path, PathBuf},
        process::{Child, Command, Stdio},
        time::{Duration, Instant},
    };
    use tungstenite::{Message, WebSocket, stream::MaybeTlsStream};

    const STEP_TIMEOUT: Duration = Duration::from_secs(60);

    /// What the runner saw, in arrival order: log lines and command refusals of sends.
    enum Seen {
        /// A log line by its per-thread sequence.
        Line(u64, String),
        /// A refused send, after the latest line seen when the refusal arrived.
        Refused {
            after: u64,
            input: String,
            code: String,
        },
        /// The runner restarted the host, after the latest line seen before it.
        Restarted { after: u64 },
    }

    #[derive(Default)]
    struct Fold {
        /// Runs in start order: (run id, finished outcome).
        runs: Vec<(String, Option<RunOutcome>)>,
        accepted_runs: Vec<String>,
        inputs: BTreeMap<String, InputId>,
        /// Inputs accepted but not yet in a started run.
        waiting: Vec<InputId>,
        last_change: Option<Instant>,
        /// Reasons of failed runs, for the outcome when no engine session started.
        failures: Vec<String>,
    }
    impl Fold {
        fn apply(&mut self, event: &LogEvent) {
            self.last_change = Some(Instant::now());
            match event {
                LogEvent::InputAccepted(e) => {
                    self.inputs
                        .insert(e.client_request_id.clone(), e.input_id.clone());
                    self.waiting.push(e.input_id.clone());
                }
                LogEvent::InputChanged(e) if e.cancelled == Some(true) => {
                    self.waiting.retain(|i| i != &e.input_id)
                }
                LogEvent::InputDelivered(e) => self.waiting.retain(|i| i != &e.input_id),
                LogEvent::RunStarted(e) => {
                    self.waiting.retain(|i| !e.input_ids.contains(i));
                    if !self.runs.iter().any(|(id, _)| id == e.run_id.as_str()) {
                        self.runs.push((e.run_id.to_string(), None));
                    }
                }
                LogEvent::RunAccepted(e) => self.accepted_runs.push(e.run_id.to_string()),
                LogEvent::RunFinished(e) => {
                    if e.outcome == RunOutcome::Failed {
                        self.failures
                            .push(e.reason.clone().unwrap_or_else(|| "run failed".into()));
                    }
                    if let Some(run) = self.runs.iter_mut().find(|(id, _)| id == e.run_id.as_str())
                    {
                        run.1 = Some(e.outcome);
                    }
                }
                _ => {}
            }
        }
        fn run(&self, alias: &str) -> Option<&(String, Option<RunOutcome>)> {
            let n: usize = alias.strip_prefix('r')?.parse().ok()?;
            self.runs.get(n.checked_sub(1)?)
        }
        fn idle(&self) -> bool {
            !self.runs.is_empty()
                && self.runs.iter().all(|(_, o)| o.is_some())
                && self.waiting.is_empty()
        }
        fn holds(&self, cond: &AwaitCond) -> bool {
            match cond {
                AwaitCond::Idle => self.idle(),
                AwaitCond::Steerable { run } => self
                    .run(run)
                    .is_some_and(|(id, o)| o.is_none() && self.accepted_runs.contains(id)),
                AwaitCond::RunStatus { run, status } => self.run(run).is_some_and(|(_, o)| {
                    matches!(
                        (status.as_str(), o),
                        ("running", None)
                            | ("completed", Some(RunOutcome::Completed))
                            | ("interrupted", Some(RunOutcome::Interrupted))
                            | ("failed", Some(RunOutcome::Failed))
                    )
                }),
            }
        }
    }

    struct Host {
        child: Child,
        ws: WebSocket<MaybeTlsStream<TcpStream>>,
    }
    impl Drop for Host {
        fn drop(&mut self) {
            let _ = self.ws.close(None);
            drop(self.child.stdin.take());
            let deadline = Instant::now() + Duration::from_secs(5);
            while Instant::now() < deadline {
                if matches!(self.child.try_wait(), Ok(Some(_))) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    struct Session {
        /// None only while the host restarts.
        host: Option<Host>,
        fold: Fold,
        seen: Vec<Seen>,
        results: BTreeMap<String, Value>,
        thread: Option<ThreadId>,
        latest: u64,
    }
    impl Session {
        fn ws(&mut self) -> &mut WebSocket<MaybeTlsStream<TcpStream>> {
            &mut self.host.as_mut().expect("host is running").ws
        }
        fn send(&mut self, frame: &ClientFrame) -> Result<(), String> {
            let text = serde_json::to_string(frame).map_err(|e| e.to_string())?;
            self.ws()
                .send(Message::text(text))
                .map_err(|e| e.to_string())
        }
        /// Read frames until pred holds or the deadline passes.
        fn pump(&mut self, deadline: Instant, mut pred: impl FnMut(&Self) -> bool) -> bool {
            loop {
                if pred(self) {
                    return true;
                }
                if Instant::now() >= deadline {
                    return false;
                }
                match self.ws().read() {
                    Ok(Message::Text(text)) => self.frame(text.as_str()),
                    Ok(_) => {}
                    Err(tungstenite::Error::Io(e))
                        if matches!(
                            e.kind(),
                            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                        ) => {}
                    Err(_) => return pred(self),
                }
            }
        }
        fn frame(&mut self, text: &str) {
            let Ok(frame) = serde_json::from_str::<Value>(text) else {
                return;
            };
            if std::env::var_os("GOAT2_PARITY_TRACE_FRAMES").is_some() {
                eprintln!("host frame: {}", text.chars().take(400).collect::<String>());
            }
            match frame["type"].as_str() {
                Some("thread_event") => self.line(&frame["line"]),
                // Subscribing replays from the latest checkpoint; read the lines before it.
                Some("thread_caught_up") => {
                    if let (Some(thread), Some(seq)) =
                        (self.thread.clone(), frame["cursor"]["seq"].as_u64())
                    {
                        let _ = self.send(&ClientFrame::ReadPage {
                            req_id: "parity-page".into(),
                            thread_id: thread,
                            before: seq + 1,
                            limit: 500,
                        });
                    }
                }
                Some("page") => {
                    for line in frame["lines"].as_array().into_iter().flatten() {
                        self.line(line);
                    }
                }
                Some("command_result") => {
                    if let Some(id) = frame["reqId"].as_str() {
                        self.results.insert(id.to_owned(), frame.clone());
                    }
                }
                _ => {}
            }
        }
        fn line(&mut self, line: &Value) {
            let Some(seq) = line["seq"].as_u64() else {
                return;
            };
            if self
                .seen
                .iter()
                .any(|s| matches!(s, Seen::Line(n, _) if *n == seq))
            {
                return;
            }
            self.latest = self.latest.max(seq);
            let text = line.to_string();
            if let Ok(ParsedLine::Known(parsed)) = goat2_contracts::parse_log_line(&text) {
                self.fold.apply(&parsed.event);
            }
            self.seen.push(Seen::Line(seq, text));
        }
        fn command(&mut self, req_id: &str, frame: &ClientFrame) -> Result<Value, String> {
            self.send(frame)?;
            let deadline = Instant::now() + STEP_TIMEOUT;
            if !self.pump(deadline, |s| s.results.contains_key(req_id)) {
                return Err(format!("no command_result for {req_id}"));
            }
            Ok(self.results[req_id].clone())
        }
    }

    fn sibling(name: &str) -> PathBuf {
        let exe = std::env::current_exe().unwrap_or_default();
        let dir = exe.parent().map(Path::to_path_buf).unwrap_or_default();
        // Test binaries live in target/<profile>/deps; the bins one level up.
        let direct = dir.join(name);
        if direct.is_file() {
            direct
        } else {
            dir.parent().map(|p| p.join(name)).unwrap_or(direct)
        }
    }

    fn token() -> String {
        use std::hash::{BuildHasher, Hasher};
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos(),
        );
        h.write_u32(std::process::id());
        format!("{:016x}{:08x}", h.finish(), std::process::id())
    }

    fn start_host(base: &Path, transcript: &Path) -> Result<Host, String> {
        let host_bin = std::env::var_os("GOAT2_HOST_BIN")
            .map(PathBuf::from)
            .unwrap_or_else(|| sibling("goat2-host"));
        let fake = std::env::var_os("GOAT2_PARITY_FAKE_BIN")
            .map(PathBuf::from)
            .unwrap_or_else(|| sibling("goat2-parity-fake-codex"));
        for (what, path) in [
            ("goat2-host", &host_bin),
            ("goat2-parity-fake-codex", &fake),
        ] {
            if !path.is_file() {
                return Err(format!(
                    "{what} not found at {} (build the workspace first)",
                    path.display()
                ));
            }
        }
        let token = token();
        let stderr = std::fs::File::options()
            .create(true)
            .append(true)
            .open(base.join("host.stderr"))
            .map_err(|e| e.to_string())?;
        let mut child = Command::new(&host_bin)
            .env("GOAT2_DATA_DIR", base.join("data"))
            .env("GOAT2_HOST_PORT", "0")
            .env("GOAT2_HOST_TOKEN", &token)
            .env("GOAT2_ENGINE", "codex")
            .env("GOAT2_CODEX_BIN", &fake)
            .env("GOAT2_PARITY_FAKE_TRANSCRIPT", transcript)
            .env("GOAT2_PARITY_FAKE_DIR", base.join("fake"))
            .env("GOAT2_PARITY_FAKE_HOLD", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(stderr)
            .spawn()
            .map_err(|e| format!("spawn {}: {e}", host_bin.display()))?;
        let mut line = String::new();
        BufReader::new(child.stdout.take().ok_or("no host stdout")?)
            .read_line(&mut line)
            .map_err(|e| e.to_string())?;
        let ready: Value = serde_json::from_str(line.trim())
            .map_err(|e| format!("host ready line {line:?}: {e}"))?;
        let url = ready["wsUrl"].as_str().ok_or("ready line has no wsUrl")?;
        let (ws, _) =
            tungstenite::connect(format!("{url}?token={token}")).map_err(|e| e.to_string())?;
        if let MaybeTlsStream::Plain(stream) = ws.get_ref() {
            stream
                .set_read_timeout(Some(Duration::from_millis(100)))
                .map_err(|e| e.to_string())?;
        }
        Ok(Host { child, ws })
    }

    /// Every claim the recording needs (crate::fake_codex::claim_count) must have reported and
    /// consumed its significant requests; a recorded thread GOAT 2 never opened is a mismatch.
    fn fake_reports(dir: &Path, expected: usize) -> StreamReport {
        let mut report = StreamReport {
            consumed_all: false,
            outbound_checked: 0,
            outbound_mismatches: Vec::new(),
        };
        let mut found = false;
        let mut all = true;
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !(name.starts_with("report-") && name.ends_with(".json")) {
                continue;
            }
            let Ok(r) = std::fs::read(entry.path())
                .map_err(|_| ())
                .and_then(|b| serde_json::from_slice::<Value>(&b).map_err(|_| ()))
            else {
                report
                    .outbound_mismatches
                    .push(format!("unreadable fake report {name}"));
                all = false;
                continue;
            };
            found = true;
            all &= r["significantConsumed"] == r["significantTotal"];
            report.outbound_checked += r["outboundChecked"].as_u64().unwrap_or(0) as u32;
            for m in r["mismatches"].as_array().into_iter().flatten() {
                report
                    .outbound_mismatches
                    .push(format!("{name}: {}", m.as_str().unwrap_or_default()));
            }
        }
        if !found {
            report
                .outbound_mismatches
                .push("the fake codex never started (no session reached the engine)".into());
        } else {
            for claim in 0..expected {
                if !dir.join(format!("report-{claim}.json")).is_file() {
                    report.outbound_mismatches.push(format!(
                        "recorded thread session {claim} was never opened by GOAT 2"
                    ));
                }
            }
            if dir.join(format!("report-{expected}.json")).is_file() {
                report
                    .outbound_mismatches
                    .push("more engine sessions than the recording has".into());
            }
        }
        report.consumed_all = found && all && report.outbound_mismatches.is_empty();
        report
    }

    fn trace(
        scenario: &LoadedScenario,
        outcome: Outcome,
        events: Vec<TraceEvent>,
        streams: BTreeMap<String, StreamReport>,
        incomplete: bool,
    ) -> ObservedTrace {
        ObservedTrace {
            v: 1,
            target: "goat2".into(),
            scenario: scenario.scenario.name.clone(),
            outcome,
            events: events
                .into_iter()
                .enumerate()
                .map(|(i, event)| ObservedEvent {
                    seq: i as u64 + 1,
                    event,
                })
                .collect(),
            streams,
            incomplete,
        }
    }

    /// Why this runner cannot drive the scenario, if it cannot.
    pub fn unsupported(scenario: &LoadedScenario) -> Option<String> {
        let s = &scenario.scenario;
        if s.threads.len() != 1 || s.streams.len() != 1 {
            return Some(
                "the GOAT 2 runner drives single-thread, single-stream scenarios only so far"
                    .into(),
            );
        }
        s.steps.iter().find_map(|step| match step {
            Step::Mcp { .. } | Step::AwaitCall { .. } => {
                Some("MCP steps through the GOAT 2 host are not driven yet".to_owned())
            }
            Step::AdvanceClock { .. } | Step::ReleaseGate { .. } => {
                Some("v1 replay clock/gate steps have no GOAT 2 counterpart".to_owned())
            }
            _ => None,
        })
    }

    pub fn run(scenario_dir: &Path) -> Result<ObservedTrace, String> {
        let scenario = LoadedScenario::load(scenario_dir)?;
        let (stream_name, stream) = scenario.scenario.streams.iter().next().ok_or("no stream")?;
        let empty = BTreeMap::new();
        if let Some(reason) = unsupported(&scenario) {
            return Ok(trace(
                &scenario,
                Outcome::Unsupported { reason },
                Vec::new(),
                empty,
                false,
            ));
        }
        let base = std::env::temp_dir().join(format!(
            "goat2-parity-goat2-{}-{}",
            std::process::id(),
            token()
        ));
        std::fs::create_dir_all(base.join("workspace")).map_err(|e| e.to_string())?;
        std::fs::create_dir_all(base.join("fake")).map_err(|e| e.to_string())?;
        let result = run_in(
            &scenario,
            stream_name,
            &scenario.dir.join(&stream.transcript),
            &base,
        );
        let _ = std::fs::remove_dir_all(&base);
        result
    }

    fn run_in(
        scenario: &LoadedScenario,
        stream_name: &str,
        source: &Path,
        base: &Path,
    ) -> Result<ObservedTrace, String> {
        let workspace = base.join("workspace");
        let bytes = std::fs::read(source).map_err(|e| e.to_string())?;
        let transcript = base.join("transcript.ndjson");
        std::fs::write(
            &transcript,
            materialize_transcript(&bytes, &workspace.to_string_lossy())?,
        )
        .map_err(|e| e.to_string())?;
        let model = crate::transcript::parse(&bytes)
            .ok()
            .and_then(|records| {
                records.into_iter().find_map(|r| match r {
                    crate::transcript::Record::Start { metadata, .. } => {
                        metadata?.get("model")?.as_str().map(str::to_owned)
                    }
                    _ => None,
                })
            })
            .unwrap_or_else(|| "gpt-5.4".into());
        let thread_alias = scenario
            .scenario
            .threads
            .keys()
            .next()
            .cloned()
            .unwrap_or_default();
        let mut aliases = AliasMap::default();
        let mut failure: Option<String> = None;
        let mut session = Session {
            host: Some(start_host(base, &transcript)?),
            fold: Fold::default(),
            seen: Vec::new(),
            results: BTreeMap::new(),
            thread: None,
            latest: 0,
        };
        let mut released: u64 = 0;
        let release = |n: u64| {
            let tmp = base.join("fake/.release.tmp");
            let _ = std::fs::write(&tmp, n.to_string());
            let _ = std::fs::rename(&tmp, base.join("fake/release"));
        };
        for step in &scenario.scenario.steps {
            if let Step::RestartHost { .. } = step {
                // Stop the host (its engines with it), then start it again on the same data dir.
                session.host = None;
                session.host = Some(start_host(base, &transcript)?);
                let after = session.latest;
                session.seen.push(Seen::Restarted { after });
                if let Some(thread_id) = session.thread.clone() {
                    session.send(&ClientFrame::SubscribeThread {
                        sub_id: "parity".into(),
                        thread_id,
                        after: None,
                    })?;
                }
                continue;
            }
            if let Step::Await { id, until, .. } = step {
                let cond = until.clone();
                // A wait for a run to end lets the fake finish one more turn.
                let ends = match &cond {
                    AwaitCond::Idle => true,
                    AwaitCond::RunStatus { status, .. } => status != "running",
                    AwaitCond::Steerable { .. } => false,
                };
                if ends {
                    released += 1;
                    release(released);
                }
                if !session.pump(Instant::now() + STEP_TIMEOUT, |s| s.fold.holds(&cond)) {
                    failure = Some(format!("timed out at {id}"));
                    break;
                }
                continue;
            }
            // A queue command names an input the host may not have logged yet.
            let named: Vec<String> = match step {
                Step::QueueEdit { input, .. }
                | Step::QueueCancel { input, .. }
                | Step::QueuePromote { input, .. } => vec![input.clone()],
                Step::QueueReorder { order, .. } => order.clone(),
                _ => Vec::new(),
            };
            if !named.is_empty()
                && !session.pump(Instant::now() + STEP_TIMEOUT, |s| {
                    named.iter().all(|a| s.fold.inputs.contains_key(a))
                })
            {
                failure = Some(format!("inputs {named:?} were never accepted"));
                break;
            }
            let frame = match command_for_step(
                step,
                session.thread.as_ref(),
                &session.fold.inputs,
                &workspace.to_string_lossy(),
                &model,
            ) {
                Ok(Some(frame)) => frame,
                Ok(None) => continue,
                Err(e) => {
                    failure = Some(e);
                    break;
                }
            };
            if let Step::Send { input, mode, .. } = step {
                aliases.register_request_mode(input.clone(), input.clone(), mode.clone());
            }
            let req_id = match &frame {
                ClientFrame::SendInput { req_id, .. }
                | ClientFrame::StartThread { req_id, .. }
                | ClientFrame::StopThread { req_id, .. }
                | ClientFrame::EditQueued { req_id, .. }
                | ClientFrame::CancelQueued { req_id, .. }
                | ClientFrame::PromoteToSteer { req_id, .. }
                | ClientFrame::ReorderQueued { req_id, .. } => req_id.clone(),
                _ => unreachable!("command_for_step returns commands only"),
            };
            let result = match session.command(&req_id, &frame) {
                Ok(r) => r,
                Err(e) => {
                    failure = Some(e);
                    break;
                }
            };
            if result["ok"] != true {
                let code = result["error"]["reason"]
                    .as_str()
                    .unwrap_or("error")
                    .to_owned();
                match step {
                    Step::Send { input, .. } if session.thread.is_some() => {
                        let after = session.latest;
                        session.seen.push(Seen::Refused {
                            after,
                            input: input.clone(),
                            code,
                        })
                    }
                    _ => {
                        failure = Some(format!("{req_id} refused: {}", result["error"]));
                        break;
                    }
                }
                continue;
            }
            if session.thread.is_none() {
                let Some(id) = result["value"]["threadId"].as_str() else {
                    failure = Some("start_thread returned no threadId".into());
                    break;
                };
                let thread_id: ThreadId = id.into();
                session.thread = Some(thread_id.clone());
                session.send(&ClientFrame::SubscribeThread {
                    sub_id: "parity".into(),
                    thread_id,
                    after: None,
                })?;
            }
        }
        release(u64::MAX);
        // Let the host finish: idle and quiet for a moment, or give up after the step timeout.
        let quiet = Duration::from_millis(800);
        session.pump(Instant::now() + STEP_TIMEOUT, |s| {
            s.fold.idle() && s.fold.last_change.is_some_and(|t| t.elapsed() > quiet)
        });
        let failures = session.fold.failures.clone();
        let mut seen = std::mem::take(&mut session.seen);
        // Lines in log order; a refusal right after the line it followed.
        seen.sort_by_key(|s| match s {
            Seen::Line(seq, _) => (*seq, 0),
            Seen::Refused { after, .. } | Seen::Restarted { after } => (*after, 1),
        });
        drop(session);
        let report = fake_reports(
            &base.join("fake"),
            crate::fake_codex::claim_count(&transcript)?,
        );
        let mut events = Vec::new();
        let mut incomplete = false;
        for item in seen {
            match item {
                Seen::Line(_, line) => {
                    match aliases.map_line(&thread_alias, &line, &mut incomplete) {
                        Ok(mapped) => events.extend(mapped),
                        Err(e) => {
                            failure.get_or_insert(format!("mapping: {e}"));
                        }
                    }
                }
                Seen::Refused { input, code, .. } => events.push(TraceEvent::InputRefused {
                    thread: thread_alias.clone(),
                    input,
                    code,
                }),
                Seen::Restarted { .. } => events.push(TraceEvent::HostRestarted {
                    thread: thread_alias.clone(),
                }),
            }
        }
        let host_err = std::fs::read_to_string(base.join("host.stderr")).unwrap_or_default();
        if failure.is_none()
            && report
                .outbound_mismatches
                .iter()
                .any(|m| m.contains("never started"))
        {
            let refusal: Vec<&str> = host_err
                .lines()
                .filter(|l| l.contains("ERROR") || l.contains("WARN") || l.contains("refus"))
                .collect();
            let said = if failures.is_empty() {
                refusal.join(" | ")
            } else {
                failures.join(" | ")
            };
            failure = Some(format!("no engine session started: {said}"));
        }
        let outcome = match failure {
            Some(reason) => Outcome::Error { reason },
            None => Outcome::Ok,
        };
        let mut streams = BTreeMap::new();
        streams.insert(stream_name.to_owned(), report);
        Ok(trace(scenario, outcome, events, streams, incomplete))
    }

    /// Process entry point: --scenario DIR --out FILE.
    pub fn main_with_args(args: &[String]) -> Result<(), String> {
        let value = |flag: &str| {
            args.iter()
                .position(|a| a == flag)
                .and_then(|i| args.get(i + 1))
                .cloned()
                .ok_or(format!("expected {flag}"))
        };
        let dir = PathBuf::from(value("--scenario")?);
        let out = PathBuf::from(value("--out")?);
        let trace = run(&dir)?;
        let tmp = out.with_extension(format!("{}.tmp", std::process::id()));
        std::fs::write(
            &tmp,
            serde_json::to_vec_pretty(&trace).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &out).map_err(|e| e.to_string())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// r13: a recorded thread session GOAT 2 never opened leaves the stream unconsumed.
        #[test]
        fn a_missing_claim_report_is_a_mismatch() {
            let dir =
                std::env::temp_dir().join(format!("goat2-parity-reports-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
            dir.join("report-0.json"),
            r#"{"consumed":3,"significantTotal":2,"significantConsumed":2,"outboundChecked":5,"mismatches":[],"synthesized":[]}"#,
        )
        .unwrap();
            let one = fake_reports(&dir, 1);
            let two = fake_reports(&dir, 2);
            let _ = std::fs::remove_dir_all(&dir);
            assert!(one.consumed_all, "{one:?}");
            assert!(!two.consumed_all);
            assert!(
                two.outbound_mismatches
                    .iter()
                    .any(|m| m.contains("session 1 was never opened"))
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn materializes_nested_frames_without_touching_metadata() {
        let source = b"{\"type\":\"transcript_start\",\"provider\":\"codex\",\"protocol\":\"p\",\"version\":\"1\",\"scenario\":\"s\",\"metadata\":{\"description\":\"<workspace>\"}}\n{\"type\":\"expect_outbound\",\"frame\":{\"a\":[\"<workspace>/x\",{\"b\":\"<workspace>\"}]}}\n{\"type\":\"runtime_exit\",\"status\":\"success\"}\n";
        let result = materialize_transcript(source, "/tmp/a\"b").unwrap();
        let lines: Vec<Value> = std::str::from_utf8(&result)
            .unwrap()
            .lines()
            .map(|s| serde_json::from_str(s).unwrap())
            .collect();
        assert_eq!(lines[0]["metadata"]["description"], "<workspace>");
        assert_eq!(
            lines[1]["frame"],
            json!({"a":["/tmp/a\"b/x",{"b":"/tmp/a\"b"}]})
        );
        crate::transcript::parse(&result).unwrap();
    }

    #[test]
    fn translates_start_followup_and_queue_actions() {
        let send = Step::Send {
            id: "s".into(),
            thread: "t".into(),
            input: "i".into(),
            text: "hi".into(),
            mode: SendMode::Queue,
            run: None,
        };
        let start = command_for_step(&send, None, &BTreeMap::new(), "/work", "model")
            .unwrap()
            .unwrap();
        let wire = serde_json::to_value(start).unwrap();
        assert_eq!(wire["type"], "start_thread");
        assert_eq!(wire["clientRequestId"], "i");
        assert_eq!(
            wire["modelSelection"],
            json!({"instanceId":"codex", "model":"model"})
        );
        assert_eq!(wire["runtimeMode"], "full-access");
        let thread = ThreadId::from("thread");
        let followup = command_for_step(&send, Some(&thread), &BTreeMap::new(), "/work", "model")
            .unwrap()
            .unwrap();
        assert_eq!(serde_json::to_value(followup).unwrap()["mode"], "followup");
        let edit = Step::QueueEdit {
            id: "e".into(),
            thread: "t".into(),
            input: "i".into(),
            text: "new".into(),
        };
        assert!(
            command_for_step(&edit, Some(&thread), &BTreeMap::new(), "/work", "model").is_err()
        );
        let inputs = BTreeMap::from([("i".into(), InputId::from("host-input"))]);
        let wire = serde_json::to_value(
            command_for_step(&edit, Some(&thread), &inputs, "/work", "model")
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(wire["inputId"], "host-input");
        assert_eq!(wire["text"], "new");
    }
}
