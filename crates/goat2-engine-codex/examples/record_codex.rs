//! Record real `codex app-server` sessions, driven through the GOAT driver itself
//! ([CodexEngineFactory] with a recording tap), as replay transcripts for the fake codex.
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

use goat2_contracts::{
    EngineConfig, InputId, ModelSelection, ProviderInstanceId, RequestOutcome, RuntimeMode,
    ThreadId,
};
use goat2_engine_api::{
    EngineEvent, EngineFactory, EngineHandle, EngineInput, McpEndpoint, RequestAnswer, SessionSpec,
    TurnSettings, TurnStartResult,
};
use goat2_engine_codex::transcript::{Recorder, Redactor, Transcript, privacy_scan};
use goat2_engine_codex::{CodexEngineFactory, CodexEngineOptions};
use serde_json::json;

const WAIT: Duration = Duration::from_secs(180);
/// A loopback MCP URL nothing listens on; Codex reports the server as failed, which is fine for
/// recording the injection frames.
const MCP_URL: &str = "http://127.0.0.1:9/mcp";
const MCP_TOKEN: &str = "recordingtoken0123456789";

fn spec(
    cwd: &Path,
    model: &str,
    mode: RuntimeMode,
    resume: Option<goat2_contracts::EngineRef>,
) -> SessionSpec {
    SessionSpec {
        thread_id: ThreadId::new("goat-thread-1"),
        engine: EngineConfig {
            provider_instance_id: ProviderInstanceId::new("codex"),
            model_selection: selection(model),
            runtime_mode: mode,
            cwd: cwd.to_string_lossy().into_owned(),
        },
        resume,
        mcp: McpEndpoint {
            url: MCP_URL.into(),
            bearer_token: MCP_TOKEN.into(),
        },
        host_generation: 1,
        process_generation: 1,
        instructions: None,
        instance: None,
    }
}

fn selection(model: &str) -> ModelSelection {
    serde_json::from_value(json!({
        "instanceId": "codex",
        "model": model,
        "options": [{"id": "reasoningEffort", "value": "low"}]
    }))
    .expect("model selection")
}

fn settings(model: &str, mode: RuntimeMode) -> TurnSettings {
    TurnSettings {
        model_selection: selection(model),
        runtime_mode: mode,
    }
}

fn input(id: &str, text: &str) -> Vec<EngineInput> {
    vec![EngineInput {
        input_id: InputId::new(id),
        text: text.into(),
        attachments: Vec::new(),
    }]
}

async fn start(recorder: &Recorder, spec: SessionSpec) -> EngineHandle {
    let factory = CodexEngineFactory::new(CodexEngineOptions {
        tap: Some(recorder.tap()),
        extra_args: [
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
        ]
        .into_iter()
        .map(Into::into)
        .collect(),
        client_version: "0.0.0".into(),
        ..CodexEngineOptions::default()
    });
    factory.start(spec).await.expect("start codex session")
}

/// Wait for an event, answering approval requests with `decide`.
async fn wait_for(
    handle: &mut EngineHandle,
    what: &str,
    mut done: impl FnMut(&EngineEvent) -> bool,
    decide: Option<RequestOutcome>,
) -> EngineEvent {
    let deadline = tokio::time::Instant::now() + WAIT;
    loop {
        let event = tokio::time::timeout_at(deadline, handle.events.recv())
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for {what}"))
            .unwrap_or_else(|| panic!("events ended while waiting for {what}"));
        if let EngineEvent::RequestOpened { key, .. } = &event {
            let outcome =
                decide.unwrap_or_else(|| panic!("unexpected request while waiting for {what}"));
            handle
                .session
                .answer_request(
                    key,
                    RequestAnswer {
                        outcome,
                        text: None,
                        answers: None,
                    },
                )
                .await
                .expect("answer request");
        }
        if let EngineEvent::Exited { reason } = &event {
            panic!("codex exited while waiting for {what}: {reason}");
        }
        if done(&event) {
            return event;
        }
    }
}

fn finished(event: &EngineEvent) -> bool {
    matches!(event, EngineEvent::TurnFinished { .. })
}

async fn accepted(handle: &EngineHandle, text: &str, model: &str, mode: RuntimeMode) -> String {
    match handle
        .session
        .start_turn(input("goat-input-1", text), &settings(model, mode))
        .await
    {
        TurnStartResult::Accepted { turn_id } => turn_id,
        other => panic!("turn not accepted: {other:?}"),
    }
}

async fn record(scenario: &str, model: &str, root: &Path) -> Transcript {
    let cwd = root.join(scenario);
    std::fs::create_dir_all(&cwd).expect("scenario dir");
    let recorder = Recorder::new();
    match scenario {
        "basic" => {
            let mode = RuntimeMode::ApprovalRequired;
            let mut h = start(&recorder, spec(&cwd, model, mode, None)).await;
            accepted(&h, "Reply with exactly: GOAT2-OK", model, mode).await;
            wait_for(&mut h, "turn end", finished, None).await;
            h.session.shutdown().await;
        }
        "steer" => {
            let mode = RuntimeMode::AutoAcceptEdits;
            let mut h = start(&recorder, spec(&cwd, model, mode, None)).await;
            let turn = accepted(
                &h,
                "Run the shell command `sleep 6` exactly once, then reply with exactly: DONE",
                model,
                mode,
            )
            .await;
            let steered = h
                .session
                .steer(
                    &turn,
                    input(
                        "goat-input-2",
                        "After that, reply with exactly: DONE STEERED",
                    ),
                )
                .await;
            assert_eq!(steered, goat2_engine_api::SteerResult::Accepted, "steer");
            wait_for(&mut h, "turn end", finished, None).await;
            h.session.shutdown().await;
        }
        "interrupt" => {
            let mode = RuntimeMode::AutoAcceptEdits;
            let mut h = start(&recorder, spec(&cwd, model, mode, None)).await;
            let turn = accepted(
                &h,
                "Run the shell command `sleep 30` exactly once, then reply with exactly: DONE",
                model,
                mode,
            )
            .await;
            tokio::time::sleep(Duration::from_millis(1500)).await;
            h.session.interrupt(&turn).await.expect("interrupt");
            wait_for(&mut h, "turn end", finished, None).await;
            h.session.shutdown().await;
        }
        "approval" => {
            let mode = RuntimeMode::ApprovalRequired;
            let mut h = start(&recorder, spec(&cwd, model, mode, None)).await;
            accepted(&h, "Run exactly this shell command once: touch approved.txt  Then reply with exactly: DONE", model, mode).await;
            wait_for(&mut h, "turn end", finished, Some(RequestOutcome::Accept)).await;
            h.session.shutdown().await;
        }
        "resume" => {
            // First process: create the thread (not recorded). Second process: resume + one turn.
            let mode = RuntimeMode::ApprovalRequired;
            let first_recorder = Recorder::new();
            let mut first = start(&first_recorder, spec(&cwd, model, mode, None)).await;
            accepted(&first, "Reply with exactly: FIRST", model, mode).await;
            wait_for(&mut first, "turn end", finished, None).await;
            first.session.shutdown().await;
            let resume = first.engine_ref.clone();
            let mut h = start(&recorder, spec(&cwd, model, mode, Some(resume))).await;
            accepted(&h, "Reply with exactly: RESUMED", model, mode).await;
            wait_for(&mut h, "turn end", finished, None).await;
            h.session.shutdown().await;
        }
        other => panic!("unknown scenario {other}"),
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    recorder.finish(scenario, None)
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
            json!({
                "recordedWith": format!("codex 0.167.0 via goat2-engine-codex CodexEngineFactory, model {model}"),
                "redaction": "goat2 Redactor (fail-closed)"
            })
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
}
