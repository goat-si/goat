//! Record real `codex app-server` sessions as replay transcripts for the fake codex.
//!
//! cargo run -p goat2-engine-codex --example record_codex -- --scenario <name|all> --out <dir> [--model <m>]
//!
//! Scenarios: basic, steer, interrupt, approval, resume. Prompts are synthetic. Every transcript is
//! redacted (fail-closed), validated against the pinned schema and privacy-scanned before it is
//! written; any failure aborts and nothing is written for that scenario.

#[path = "../tests/support/schema.rs"]
mod schema;

use std::path::{Path, PathBuf};
use std::time::Duration;

use goat2_engine_codex::process::{ChildProcess, Launch};
use goat2_engine_codex::protocol::client::{
    InitializeParams, ThreadOpenResponse, ThreadOptions, TurnInterruptParams, TurnStartResponse,
    TurnSteerResponse, turn_start_params, turn_steer_params,
};
use goat2_engine_codex::protocol::methods;
use goat2_engine_codex::protocol::server::{
    CommandApprovalResponse, CommandDecision, Notification, ServerRequest,
};
use goat2_engine_codex::transcript::{ExitKind, Recorder, Redactor, Transcript, privacy_scan};
use goat2_engine_codex::transport::{Connection, Inbound};
use serde_json::{Value, json};
use tokio::sync::mpsc::UnboundedReceiver;

const WAIT: Duration = Duration::from_secs(180);
/// A loopback MCP URL nothing listens on; Codex reports the server as failed, which is fine for
/// recording the injection frames.
const MCP_URL: &str = "http://127.0.0.1:9/mcp";
const MCP_TOKEN: &str = "recordingtoken0123456789";

struct Session {
    child: ChildProcess,
    conn: Connection,
    inbound: UnboundedReceiver<Inbound>,
    recorder: Recorder,
}

impl Session {
    async fn spawn(cwd: &Path) -> Session {
        let mut launch = Launch::new("codex").without_host_identity();
        for arg in [
            "app-server",
            "-c",
            "mcp_servers={}",
            "--disable",
            "apps",
            "--disable",
            "plugins",
            "--disable",
            "browser_use",
            "--disable",
            "computer_use",
            "--disable",
            "in_app_browser",
            "--disable",
            "memories",
            "--disable",
            "image_generation",
        ] {
            launch = launch.arg(arg);
        }
        launch.cwd = Some(cwd.to_path_buf());
        let mut child = ChildProcess::spawn(&launch).expect("spawn codex app-server");
        let recorder = Recorder::new();
        let (conn, inbound) = Connection::start(
            child.take_stdin().expect("stdin"),
            child.take_stdout().expect("stdout"),
            Some(recorder.tap()),
        );
        let session = Session {
            child,
            conn,
            inbound,
            recorder,
        };
        let _: Value = session
            .conn
            .request(methods::INITIALIZE, &InitializeParams::goat("0.0.0"))
            .await
            .expect("initialize");
        session
            .conn
            .notify(methods::INITIALIZED, &Value::Null)
            .expect("initialized");
        session
    }

    /// Wait for a notification (answering server requests with `decide`).
    async fn wait_for(
        &mut self,
        what: &str,
        mut done: impl FnMut(&Notification) -> bool,
        decide: &mut dyn FnMut(&ServerRequest) -> Value,
    ) -> Notification {
        let deadline = tokio::time::Instant::now() + WAIT;
        loop {
            let next = tokio::time::timeout_at(deadline, self.inbound.recv())
                .await
                .unwrap_or_else(|_| {
                    panic!(
                        "timed out waiting for {what}; stderr:\n{}",
                        self.child.stderr_tail()
                    )
                });
            match next {
                Some(Inbound::Notification(n)) => {
                    if done(&n) {
                        return n;
                    }
                }
                Some(Inbound::Request { id, request }) => {
                    let answer = decide(&request);
                    self.conn.respond(&id, answer).expect("respond");
                }
                Some(Inbound::Diagnostic(d)) => eprintln!("  diagnostic: {d}"),
                Some(Inbound::LateResponse { method, .. }) => {
                    eprintln!("  late answer to {method}")
                }
                Some(Inbound::Retired { method }) => panic!("codex went silent after {method}"),
                None => panic!(
                    "codex exited while waiting for {what}; stderr:\n{}",
                    self.child.stderr_tail()
                ),
            }
        }
    }

    async fn finish(mut self, scenario: &str) -> Transcript {
        self.conn.close_input();
        self.child.shutdown().await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        self.recorder.finish(scenario, None)
    }
}

fn no_requests(request: &ServerRequest) -> Value {
    panic!("unexpected server request {}", request.method())
}

fn options(cwd: &Path, model: &str, approval: &str, sandbox: &str) -> ThreadOptions {
    ThreadOptions {
        model: Some(model.into()),
        cwd: cwd.to_string_lossy().into_owned(),
        approval_policy: Some(approval.into()),
        sandbox: Some(sandbox.into()),
        developer_instructions: None,
        goat_mcp: Some((MCP_URL.into(), MCP_TOKEN.into())),
    }
}

async fn start_thread(session: &Session, opts: &ThreadOptions) -> String {
    let opened: ThreadOpenResponse = session
        .conn
        .request(methods::THREAD_START, &opts.start_params())
        .await
        .expect("thread/start");
    opened.thread.id
}

async fn start_turn(session: &Session, thread: &str, text: &str, effort: &str) -> String {
    let started = std::time::Instant::now();
    let response: TurnStartResponse = session
        .conn
        .request(
            methods::TURN_START,
            &turn_start_params(thread, text, &[], Some("goat-msg-1"), None, Some(effort)),
        )
        .await
        .expect("turn/start");
    eprintln!(
        "  turn/start answered in {} ms",
        started.elapsed().as_millis()
    );
    response.turn.id
}

fn turn_completed(n: &Notification) -> bool {
    matches!(n, Notification::TurnCompleted(_))
}

async fn record(scenario: &str, model: &str, root: &Path) -> Transcript {
    let cwd = root.join(scenario);
    std::fs::create_dir_all(&cwd).expect("scenario dir");
    match scenario {
        "basic" => {
            let mut s = Session::spawn(&cwd).await;
            let thread = start_thread(&s, &options(&cwd, model, "never", "read-only")).await;
            start_turn(&s, &thread, "Reply with exactly: GOAT2-OK", "low").await;
            s.wait_for("turn/completed", turn_completed, &mut no_requests)
                .await;
            s.finish(scenario).await
        }
        "steer" => {
            let mut s = Session::spawn(&cwd).await;
            let thread = start_thread(&s, &options(&cwd, model, "never", "read-only")).await;
            let turn = start_turn(
                &s,
                &thread,
                "Run the shell command `sleep 6` exactly once, then reply with exactly: DONE",
                "low",
            )
            .await;
            s.wait_for(
                "item/started",
                |n| matches!(n, Notification::ItemStarted(_)),
                &mut no_requests,
            )
            .await;
            let steered: TurnSteerResponse = s
                .conn
                .request(
                    methods::TURN_STEER,
                    &turn_steer_params(
                        &thread,
                        &turn,
                        "After that, reply with exactly: DONE STEERED",
                        &[],
                        Some("goat-msg-2"),
                    ),
                )
                .await
                .expect("turn/steer");
            assert_eq!(steered.turn_id, turn);
            s.wait_for("turn/completed", turn_completed, &mut no_requests)
                .await;
            s.finish(scenario).await
        }
        "interrupt" => {
            let mut s = Session::spawn(&cwd).await;
            let thread = start_thread(&s, &options(&cwd, model, "never", "read-only")).await;
            let turn = start_turn(
                &s,
                &thread,
                "Run the shell command `sleep 30` exactly once, then reply with exactly: DONE",
                "low",
            )
            .await;
            s.wait_for(
                "item/started",
                |n| matches!(n, Notification::ItemStarted(_)),
                &mut no_requests,
            )
            .await;
            let _: Value = s
                .conn
                .request(
                    methods::TURN_INTERRUPT,
                    &TurnInterruptParams {
                        thread_id: thread.clone(),
                        turn_id: turn,
                    },
                )
                .await
                .expect("turn/interrupt");
            s.wait_for("turn/completed", turn_completed, &mut no_requests)
                .await;
            s.finish(scenario).await
        }
        "approval" => {
            let mut s = Session::spawn(&cwd).await;
            let thread =
                start_thread(&s, &options(&cwd, model, "untrusted", "workspace-write")).await;
            start_turn(
                &s,
                &thread,
                "Run exactly this shell command once: touch approved.txt  Then reply with exactly: DONE",
                "low",
            )
            .await;
            let mut approve = |request: &ServerRequest| match request {
                ServerRequest::CommandApproval(_) => {
                    serde_json::to_value(CommandApprovalResponse {
                        decision: CommandDecision::Accept,
                    })
                    .unwrap()
                }
                other => panic!("unexpected server request {}", other.method()),
            };
            s.wait_for("turn/completed", turn_completed, &mut approve)
                .await;
            s.finish(scenario).await
        }
        "resume" => {
            // First process: create the thread (not recorded). Second process: resume + one turn.
            let mut first = Session::spawn(&cwd).await;
            let opts = options(&cwd, model, "never", "read-only");
            let thread = start_thread(&first, &opts).await;
            start_turn(&first, &thread, "Reply with exactly: FIRST", "low").await;
            first
                .wait_for("turn/completed", turn_completed, &mut no_requests)
                .await;
            first.conn.close_input();
            first.child.shutdown().await;

            let mut s = Session::spawn(&cwd).await;
            let resumed: ThreadOpenResponse = s
                .conn
                .request(methods::THREAD_RESUME, &opts.resume_params(&thread))
                .await
                .expect("thread/resume");
            assert_eq!(resumed.thread.id, thread);
            start_turn(&s, &thread, "Reply with exactly: RESUMED", "low").await;
            s.wait_for("turn/completed", turn_completed, &mut no_requests)
                .await;
            s.finish(scenario).await
        }
        other => panic!("unknown scenario {other}"),
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let flag = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let scenario = flag("--scenario").unwrap_or_else(|| "all".into());
    let out = PathBuf::from(flag("--out").expect("--out <dir>"));
    let model = flag("--model").unwrap_or_else(|| "gpt-6-luna".into());
    let scenarios: Vec<&str> = if scenario == "all" {
        vec!["basic", "steer", "interrupt", "approval", "resume"]
    } else {
        vec![scenario.as_str()]
    };
    let root = std::env::temp_dir().join(format!("goat2-record-{}", std::process::id()));
    let home = std::env::var("HOME").map(PathBuf::from).unwrap_or_default();
    let user = std::env::var("USER").unwrap_or_default();
    let mut book = schema::SchemaBook::load();
    std::fs::create_dir_all(&out).expect("out dir");
    let mut failed = false;
    for name in scenarios {
        eprintln!("recording {name} with {model}");
        let raw = record(name, &model, &root).await;
        if let Ok(dir) = std::env::var("GOAT2_RECORD_RAW_DIR") {
            // Debug only: the unredacted session, for a local look. Never commit these.
            let _ = std::fs::create_dir_all(&dir);
            let _ = std::fs::write(
                Path::new(&dir).join(format!("{name}.raw.json")),
                serde_json::to_string_pretty(&raw).unwrap(),
            );
        }
        let mut transcript = match Redactor::new().redact(&raw) {
            Ok(t) => t,
            Err(error) => {
                eprintln!("  ABORT {name}: {error}");
                failed = true;
                continue;
            }
        };
        transcript.metadata = Some(
            json!({ "recordedWith": format!("codex 0.167.0, model {model}"), "redaction": "goat2 Redactor (fail-closed)" })
                .as_object()
                .cloned()
                .unwrap(),
        );
        let (failures, counts) = schema::check_transcript(&mut book, &transcript);
        if !failures.is_empty() {
            eprintln!("  ABORT {name}: {} schema failures:", failures.len());
            for f in failures.iter().take(20) {
                eprintln!("    {f}");
            }
            failed = true;
            continue;
        }
        let text = serde_json::to_string_pretty(&transcript).unwrap();
        let findings = privacy_scan(&text, &home, &user);
        if !findings.is_empty() {
            eprintln!("  ABORT {name}: privacy findings: {findings:?}");
            failed = true;
            continue;
        }
        let path = out.join(format!("{name}.json"));
        std::fs::write(&path, text + "\n").expect("write transcript");
        eprintln!(
            "  wrote {} ({} entries, {counts:?})",
            path.display(),
            transcript.entries.len()
        );
    }
    let _ = std::fs::remove_dir_all(&root);
    if failed {
        std::process::exit(1);
    }
    let _ = ExitKind::Success;
}
