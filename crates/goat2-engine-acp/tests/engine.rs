//! The ACP driver against the fake agent (`src/bin/acp_mock_agent.rs`, ported from v1
//! `apps/server/scripts/acp-mock-agent.ts`). No real agent, no login, no network.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use goat2_contracts::{
    EngineConfig, EngineDriver, EngineRef, ModelSelection, ProviderInstanceId, RequestKind,
    RequestOutcome, RuntimeMode, ThreadId, TurnItemBody, TurnItemStatus,
};
use goat2_engine_acp::{AcpEngineFactory, AcpFlavor, AcpTimeouts, LaunchCommand, McpBridgeCommand};
use goat2_engine_api::{
    EngineError, EngineEvent, EngineFactory, EngineHandle, EngineInput, Instructions, McpEndpoint,
    RequestAnswer, SessionSpec, SteerResult, TurnOutcome, TurnSettings, TurnStartResult,
};
use serde_json::Value;

struct MockFlavor {
    env: Vec<(String, String)>,
    steers: bool,
    restart_after_interrupt: bool,
    prefers_http_mcp: bool,
    /// Treat stderr lines starting "LOGIN " as sign-in URLs.
    stderr_url: bool,
    /// (longest line, total bytes) handed to the stderr hook.
    stderr_seen: Arc<std::sync::Mutex<(usize, usize)>>,
}

impl MockFlavor {
    fn new(env: &[(&str, &str)]) -> Self {
        Self {
            env: env
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            steers: false,
            restart_after_interrupt: false,
            prefers_http_mcp: false,
            stderr_url: false,
            stderr_seen: Arc::default(),
        }
    }
}

impl AcpFlavor for MockFlavor {
    fn driver(&self) -> &str {
        "acpRegistry"
    }
    fn engine_driver(&self) -> EngineDriver {
        EngineDriver::AcpRegistry {
            agent_id: "mock".into(),
        }
    }
    fn launch(&self, _spec: &SessionSpec) -> Result<LaunchCommand, EngineError> {
        let mut command = LaunchCommand::new(
            env!("CARGO_BIN_EXE_goat2-acp-mock-agent"),
            Vec::<String>::new(),
        );
        command.env = self.env.clone();
        Ok(command)
    }
    fn steers_with_prompt(&self, _init: &goat2_engine_acp::wire::InitializeInfo) -> bool {
        self.steers
    }
    fn restart_after_interrupt(&self) -> bool {
        self.restart_after_interrupt
    }
    fn prefers_http_mcp(&self) -> bool {
        self.prefers_http_mcp
    }
    fn stderr_auth_url(&self, line: &str) -> Option<String> {
        {
            let mut seen = self.stderr_seen.lock().unwrap();
            seen.0 = seen.0.max(line.len());
            seen.1 += line.len();
        }
        self.stderr_url
            .then(|| line.strip_prefix("LOGIN ").map(str::to_owned))
            .flatten()
    }
    fn session_mode_for(
        &self,
        mode: RuntimeMode,
        _modes: Option<&goat2_engine_acp::wire::ModeState>,
    ) -> Option<String> {
        Some(
            match mode {
                RuntimeMode::ApprovalRequired => "ask",
                _ => "code",
            }
            .into(),
        )
    }
}

fn selection(model: &str) -> ModelSelection {
    ModelSelection {
        instance_id: ProviderInstanceId::new("mock"),
        model: model.into(),
        options: None,
    }
}

fn spec(cwd: &std::path::Path, mode: RuntimeMode) -> SessionSpec {
    SessionSpec {
        thread_id: ThreadId::new("thread-1"),
        engine: EngineConfig {
            provider_instance_id: ProviderInstanceId::new("mock"),
            model_selection: selection("mock-default"),
            runtime_mode: mode,
            cwd: cwd.to_string_lossy().into_owned(),
        },
        resume: None,
        mcp: McpEndpoint {
            url: "http://127.0.0.1:9/mcp".into(),
            bearer_token: "test-token".into(),
        },
        host_generation: 1,
        process_generation: 1,
        instructions: None,
        launch: None,
    }
}

fn settings(mode: RuntimeMode) -> TurnSettings {
    TurnSettings {
        model_selection: selection("mock-default"),
        runtime_mode: mode,
    }
}

fn input(text: &str) -> Vec<EngineInput> {
    vec![EngineInput {
        input_id: goat2_contracts::InputId::new("in-1"),
        text: text.into(),
        attachments: vec![],
    }]
}

/// The bridge command the tests hand the driver; the fake agent records it without running it.
const TEST_BRIDGE: &str = "/goat2-test/bin/goat2-acp-mcp-bridge";

fn factory(flavor: MockFlavor) -> AcpEngineFactory {
    AcpEngineFactory::new(Arc::new(flavor))
        .with_mcp_bridge(McpBridgeCommand::new(TEST_BRIDGE, Vec::<String>::new()))
}

async fn start(flavor: MockFlavor, spec: SessionSpec) -> EngineHandle {
    factory(flavor)
        .with_timeouts(AcpTimeouts {
            request: Duration::from_secs(10),
            session_load: Duration::from_secs(10),
            cancel: Duration::from_secs(2),
        })
        .start(spec)
        .await
        .expect("start")
}

async fn next(handle: &mut EngineHandle) -> EngineEvent {
    tokio::time::timeout(Duration::from_secs(10), handle.events.recv())
        .await
        .expect("event in time")
        .expect("event")
}

/// Events until the turn finishes.
async fn until_finished(handle: &mut EngineHandle) -> (Vec<EngineEvent>, TurnOutcome) {
    let mut events = Vec::new();
    loop {
        let event = next(handle).await;
        if let EngineEvent::TurnFinished { outcome, .. } = &event {
            let outcome = outcome.clone();
            events.push(event);
            return (events, outcome);
        }
        events.push(event);
    }
}

fn completed(events: &[EngineEvent]) -> Vec<TurnItemBody> {
    events
        .iter()
        .filter_map(|e| match e {
            EngineEvent::ItemCompleted { item, .. } => Some(item.body.clone()),
            _ => None,
        })
        .collect()
}

fn answer_text(events: &[EngineEvent]) -> String {
    completed(events)
        .into_iter()
        .filter_map(|b| match b {
            TurnItemBody::AssistantMessage { text, .. } => Some(text),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("|")
}

fn read_log(path: &std::path::Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

fn logged<'a>(log: &'a [Value], method: &str) -> Vec<&'a Value> {
    log.iter()
        .filter(|m| m.get("method").and_then(Value::as_str) == Some(method))
        .collect()
}

#[tokio::test]
async fn one_turn_streams_and_finishes() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("log.jsonl");
    let flavor = MockFlavor::new(&[
        ("GOAT_ACP_EMIT_TOOL_CALLS", "1"),
        ("GOAT_ACP_REQUEST_LOG_PATH", log.to_str().unwrap()),
        ("GOAT_ACP_MCP_HTTP", "1"),
    ]);
    let mut handle = start(flavor, spec(dir.path(), RuntimeMode::FullAccess)).await;
    assert_eq!(handle.engine_ref.id, "mock-session-1");
    let result = handle
        .session
        .start_turn(input("hi"), &settings(RuntimeMode::FullAccess))
        .await;
    assert!(
        matches!(result, TurnStartResult::Accepted { .. }),
        "{result:?}"
    );
    let (events, outcome) = until_finished(&mut handle).await;
    assert_eq!(outcome, TurnOutcome::Done);
    assert!(
        events
            .iter()
            .any(|e| matches!(e, EngineEvent::TextDelta { .. }))
    );
    assert_eq!(
        answer_text(&events),
        "before tool|after toolhello from mock"
    );
    let bodies = completed(&events);
    assert!(bodies.iter().any(|b| matches!(b, TurnItemBody::CommandExecution { input, exit_code: Some(0), .. } if input == "echo hello")));
    assert!(
        bodies
            .iter()
            .any(|b| matches!(b, TurnItemBody::TodoList { .. }))
    );
    // Advertising HTTP MCP alone still gets the stdio bridge (v1 sessionMcpServers).
    let log = read_log(&log);
    let server = &session_new_mcp_servers(&log)[0];
    assert_eq!(server["command"], TEST_BRIDGE);
    assert_eq!(server["env"][1]["value"], "Bearer test-token");
    // Full access maps to the "code" mode through the flavor.
    assert_eq!(
        logged(&log, "session/set_mode")[0]["params"]["modeId"],
        "code"
    );
    let init = logged(&log, "initialize");
    assert_eq!(init[0]["params"]["clientInfo"]["name"], "goat");
    assert!(init[0]["params"]["clientCapabilities"]["session"]["notices"].is_object());
    handle.session.shutdown().await;
}

#[tokio::test]
async fn permission_is_asked_and_answered() {
    let dir = tempfile::tempdir().unwrap();
    let flavor = MockFlavor::new(&[("GOAT_ACP_PERMISSION_REQUEST_COUNT", "1")]);
    let mut handle = start(flavor, spec(dir.path(), RuntimeMode::ApprovalRequired)).await;
    handle
        .session
        .start_turn(input("read it"), &settings(RuntimeMode::ApprovalRequired))
        .await;
    let key = loop {
        if let EngineEvent::RequestOpened {
            key,
            kind,
            item,
            summary,
            ..
        } = next(&mut handle).await
        {
            assert_eq!(kind, RequestKind::Approval);
            assert_eq!(summary, "`cat server/package.json`");
            match item.as_ref().map(|i| &i.body) {
                Some(TurnItemBody::ApprovalRequest {
                    options: Some(options),
                    ..
                }) => {
                    assert_eq!(options.len(), 4, "cancel, decline, always, approve");
                }
                other => panic!("{other:?}"),
            }
            break key;
        }
    };
    handle
        .session
        .answer_request(
            &key,
            RequestAnswer {
                outcome: RequestOutcome::Accept,
                text: None,
                answers: None,
            },
        )
        .await
        .unwrap();
    let (events, outcome) = until_finished(&mut handle).await;
    assert_eq!(outcome, TurnOutcome::Done);
    assert!(answer_text(&events).contains("allow-once"));
    handle.session.shutdown().await;
}

#[tokio::test]
async fn devin_never_auto_selects_plan_bypass() {
    use goat2_engine_acp::registry::RegistryAgentFlavor;
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("log.jsonl");
    let command = LaunchCommand::new(
        env!("CARGO_BIN_EXE_goat2-acp-mock-agent"),
        Vec::<String>::new(),
    )
    .env("GOAT_ACP_PERMISSION_REQUEST_COUNT", "1")
    .env("GOAT_ACP_DEVIN_PLAN_BYPASS", "1")
    .env("GOAT_ACP_REQUEST_LOG_PATH", log.to_str().unwrap());
    let flavor = RegistryAgentFlavor::new("devin", command, false);
    let mut handle = AcpEngineFactory::new(Arc::new(flavor))
        .with_mcp_bridge(McpBridgeCommand::new(TEST_BRIDGE, Vec::<String>::new()))
        .start(spec(dir.path(), RuntimeMode::FullAccess))
        .await
        .unwrap();
    handle
        .session
        .start_turn(input("go"), &settings(RuntimeMode::FullAccess))
        .await;
    let (events, outcome) = until_finished(&mut handle).await;
    assert_eq!(outcome, TurnOutcome::Done);
    assert!(answer_text(&events).contains("allow-once"));
    assert!(!answer_text(&events).contains("plan_bypass"));
    handle.session.shutdown().await;
}

#[tokio::test]
async fn copilot_resends_the_reported_current_model() {
    use goat2_engine_acp::registry::RegistryAgentFlavor;
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("copilot.jsonl");
    let command = LaunchCommand::new(
        env!("CARGO_BIN_EXE_goat2-acp-mock-agent"),
        Vec::<String>::new(),
    )
    .env("GOAT_ACP_REQUEST_LOG_PATH", log.to_str().unwrap());
    let flavor = RegistryAgentFlavor::new("github-copilot-cli", command, false);
    let mut handle = AcpEngineFactory::new(Arc::new(flavor))
        .with_mcp_bridge(McpBridgeCommand::new(TEST_BRIDGE, Vec::<String>::new()))
        .start(spec(dir.path(), RuntimeMode::FullAccess))
        .await
        .unwrap();
    handle
        .session
        .start_turn(input("go"), &settings(RuntimeMode::FullAccess))
        .await;
    let (_, outcome) = until_finished(&mut handle).await;
    assert_eq!(outcome, TurnOutcome::Done);
    let requests = read_log(&log);
    assert!(
        logged(&requests, "session/set_config_option")
            .iter()
            .any(|request| request["params"]["value"] == "mock-default")
    );
    handle.session.shutdown().await;
}

#[tokio::test]
async fn auto_mode_approves_without_asking() {
    let dir = tempfile::tempdir().unwrap();
    let flavor = MockFlavor::new(&[("GOAT_ACP_PERMISSION_REQUEST_COUNT", "2")]);
    let mut handle = start(flavor, spec(dir.path(), RuntimeMode::FullAccess)).await;
    handle
        .session
        .start_turn(input("go"), &settings(RuntimeMode::FullAccess))
        .await;
    let (events, outcome) = until_finished(&mut handle).await;
    assert_eq!(outcome, TurnOutcome::Done);
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, EngineEvent::RequestOpened { .. }))
    );
    assert_eq!(answer_text(&events).matches("allow-once").count(), 2);
    handle.session.shutdown().await;
}

#[tokio::test]
async fn elicitation_form_round_trips() {
    let dir = tempfile::tempdir().unwrap();
    let answer_log = dir.path().join("answer.json");
    let flavor = MockFlavor::new(&[
        ("GOAT_ACP_EMIT_ELICITATION", "1"),
        (
            "GOAT_ACP_ELICITATION_RESPONSE_LOG_PATH",
            answer_log.to_str().unwrap(),
        ),
    ]);
    let mut handle = start(flavor, spec(dir.path(), RuntimeMode::FullAccess)).await;
    handle
        .session
        .start_turn(input("ask me"), &settings(RuntimeMode::FullAccess))
        .await;
    let key = loop {
        if let EngineEvent::RequestOpened {
            key, kind, item, ..
        } = next(&mut handle).await
        {
            assert_eq!(kind, RequestKind::Question);
            match item.as_ref().map(|i| &i.body) {
                Some(TurnItemBody::UserInputRequest { questions, .. }) => {
                    assert_eq!(questions[0].id, "choice");
                    assert_eq!(questions[0].options.len(), 2);
                }
                other => panic!("{other:?}"),
            }
            break key;
        }
    };
    let mut answers = serde_json::Map::new();
    answers.insert("choice".into(), Value::String("beta".into()));
    handle
        .session
        .answer_request(
            &key,
            RequestAnswer {
                outcome: RequestOutcome::Answered,
                text: None,
                answers: Some(answers),
            },
        )
        .await
        .unwrap();
    let (_events, outcome) = until_finished(&mut handle).await;
    assert_eq!(outcome, TurnOutcome::Done);
    let logged: Value =
        serde_json::from_str(&std::fs::read_to_string(&answer_log).unwrap()).unwrap();
    assert_eq!(
        logged,
        serde_json::json!({"action": "accept", "content": {"choice": "beta"}})
    );
    handle.session.shutdown().await;
}

#[tokio::test]
async fn interrupt_cancels_the_prompt() {
    let dir = tempfile::tempdir().unwrap();
    let flavor = MockFlavor::new(&[("GOAT_ACP_HANG_PROMPT_FOREVER", "1")]);
    let mut handle = start(flavor, spec(dir.path(), RuntimeMode::FullAccess)).await;
    let TurnStartResult::Accepted { turn_id } = handle
        .session
        .start_turn(input("long"), &settings(RuntimeMode::FullAccess))
        .await
    else {
        panic!("not accepted")
    };
    // Wait until the agent is working.
    loop {
        if matches!(next(&mut handle).await, EngineEvent::TextDelta { .. }) {
            break;
        }
    }
    // A second start while running is declined; steering is interrupt-restart for ACP.
    assert!(matches!(
        handle
            .session
            .start_turn(input("again"), &settings(RuntimeMode::FullAccess))
            .await,
        TurnStartResult::Declined { .. }
    ));
    assert!(matches!(
        handle.session.steer(&turn_id, input("more")).await,
        SteerResult::Declined { .. }
    ));
    handle.session.interrupt(&turn_id).await.unwrap();
    let (events, outcome) = until_finished(&mut handle).await;
    assert_eq!(outcome, TurnOutcome::Interrupted);
    let tool_status = events.iter().find_map(|e| match e {
        EngineEvent::ItemCompleted { item, .. }
            if matches!(item.body, TurnItemBody::CommandExecution { .. }) =>
        {
            Some(item.status)
        }
        _ => None,
    });
    assert_eq!(tool_status, Some(TurnItemStatus::Interrupted));
    // The process stays and takes the next turn (restart = interrupt then start).
    let second = handle
        .session
        .start_turn(input("hi"), &settings(RuntimeMode::FullAccess))
        .await;
    assert!(matches!(second, TurnStartResult::Accepted { .. }));
    handle.session.shutdown().await;
}

#[tokio::test]
async fn wedged_cancel_ends_turn_and_replaces_process() {
    let dir = tempfile::tempdir().unwrap();
    let flavor = MockFlavor::new(&[
        ("GOAT_ACP_HANG_PROMPT_FOREVER", "1"),
        ("GOAT_ACP_IGNORE_CANCEL", "1"),
    ]);
    let mut handle = start(flavor, spec(dir.path(), RuntimeMode::FullAccess)).await;
    let TurnStartResult::Accepted { turn_id } = handle
        .session
        .start_turn(input("long"), &settings(RuntimeMode::FullAccess))
        .await
    else {
        panic!()
    };
    handle.session.interrupt(&turn_id).await.unwrap();
    let (_events, outcome) = until_finished(&mut handle).await;
    assert_eq!(outcome, TurnOutcome::Interrupted);
    loop {
        if let EngineEvent::Exited { .. } = next(&mut handle).await {
            break;
        }
    }
}

#[tokio::test]
async fn crash_fails_the_turn_and_exits() {
    let dir = tempfile::tempdir().unwrap();
    let flavor = MockFlavor::new(&[("GOAT_ACP_CRASH_PROMPT", "1")]);
    let mut handle = start(flavor, spec(dir.path(), RuntimeMode::FullAccess)).await;
    handle
        .session
        .start_turn(input("boom"), &settings(RuntimeMode::FullAccess))
        .await;
    let (_events, outcome) = until_finished(&mut handle).await;
    assert!(matches!(outcome, TurnOutcome::Failed { .. }), "{outcome:?}");
    loop {
        if let EngineEvent::Exited { .. } = next(&mut handle).await {
            break;
        }
    }
}

#[tokio::test]
async fn prompt_error_and_refusal_fail_the_turn() {
    let dir = tempfile::tempdir().unwrap();
    let mut handle = start(
        MockFlavor::new(&[("GOAT_ACP_FAIL_PROMPT", "1")]),
        spec(dir.path(), RuntimeMode::FullAccess),
    )
    .await;
    handle
        .session
        .start_turn(input("x"), &settings(RuntimeMode::FullAccess))
        .await;
    let (_e, outcome) = until_finished(&mut handle).await;
    assert!(
        matches!(outcome, TurnOutcome::Failed { reason } if reason.contains("Mock prompt failure"))
    );
    handle.session.shutdown().await;

    let mut handle = start(
        MockFlavor::new(&[("GOAT_ACP_STOP_REASON", "refusal")]),
        spec(dir.path(), RuntimeMode::FullAccess),
    )
    .await;
    handle
        .session
        .start_turn(input("x"), &settings(RuntimeMode::FullAccess))
        .await;
    let (events, outcome) = until_finished(&mut handle).await;
    assert!(matches!(outcome, TurnOutcome::Failed { .. }));
    assert!(completed(&events).iter().any(
        |b| matches!(b, TurnItemBody::SystemNotice { message, .. } if message.contains("refused"))
    ));
    handle.session.shutdown().await;
}

#[tokio::test]
async fn auth_required_authenticates_then_opens() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("log.jsonl");
    let flavor = MockFlavor::new(&[
        ("GOAT_ACP_AUTH_METHOD_ID", "mock-login"),
        ("GOAT_ACP_REQUEST_LOG_PATH", log.to_str().unwrap()),
    ]);
    let handle = start(flavor, spec(dir.path(), RuntimeMode::FullAccess)).await;
    let log = read_log(&log);
    assert_eq!(logged(&log, "session/new").len(), 2);
    assert_eq!(
        logged(&log, "authenticate")[0]["params"]["methodId"],
        "mock-login"
    );
    handle.session.shutdown().await;
}

#[tokio::test]
async fn instructions_use_system_prompt_or_preamble() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("a.jsonl");
    let mut with_instructions = spec(dir.path(), RuntimeMode::FullAccess);
    with_instructions.instructions = Some(Instructions {
        append_system_prompt: Some("GOAT RULES".into()),
        first_message_preamble: Some("BOT BRIEF".into()),
    });
    // Agent with the ACP system prompt capability.
    let mut handle = start(
        MockFlavor::new(&[
            ("GOAT_ACP_SYSTEM_PROMPT", "1"),
            ("GOAT_ACP_REQUEST_LOG_PATH", log.to_str().unwrap()),
        ]),
        with_instructions.clone(),
    )
    .await;
    handle
        .session
        .start_turn(input("hi"), &settings(RuntimeMode::FullAccess))
        .await;
    until_finished(&mut handle).await;
    handle
        .session
        .start_turn(input("again"), &settings(RuntimeMode::FullAccess))
        .await;
    until_finished(&mut handle).await;
    handle.session.shutdown().await;
    let entries = read_log(&log);
    let new = logged(&entries, "session/new");
    assert_eq!(new[0]["params"]["systemPrompt"]["mode"], "append");
    assert_eq!(
        new[0]["params"]["systemPrompt"]["content"][0]["text"],
        "GOAT RULES"
    );
    let prompts = logged(&entries, "session/prompt");
    assert_eq!(prompts[0]["params"]["prompt"][0]["text"], "BOT BRIEF");
    assert_eq!(prompts[0]["params"]["prompt"][1]["text"], "hi");
    assert_eq!(
        prompts[1]["params"]["prompt"][0]["text"], "again",
        "preamble goes once"
    );

    // Agent without it: both go in front of the first prompt.
    let log2 = dir.path().join("b.jsonl");
    let mut handle = start(
        MockFlavor::new(&[("GOAT_ACP_REQUEST_LOG_PATH", log2.to_str().unwrap())]),
        with_instructions,
    )
    .await;
    handle
        .session
        .start_turn(input("hi"), &settings(RuntimeMode::FullAccess))
        .await;
    until_finished(&mut handle).await;
    handle.session.shutdown().await;
    let entries = read_log(&log2);
    assert!(
        logged(&entries, "session/new")[0]["params"]
            .get("systemPrompt")
            .is_none()
    );
    assert_eq!(
        logged(&entries, "session/prompt")[0]["params"]["prompt"][0]["text"],
        "GOAT RULES\n\nBOT BRIEF"
    );
}

#[tokio::test]
async fn resume_loads_the_saved_session_and_switches_model() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("log.jsonl");
    let mut resume = spec(dir.path(), RuntimeMode::ApprovalRequired);
    resume.resume = Some(EngineRef {
        driver: EngineDriver::AcpRegistry {
            agent_id: "mock".into(),
        },
        id: "saved-session".into(),
    });
    resume.engine.model_selection = selection("mock-fast");
    let mut handle = start(
        MockFlavor::new(&[
            ("GOAT_ACP_EMIT_LOAD_REPLAY", "1"),
            ("GOAT_ACP_REQUEST_LOG_PATH", log.to_str().unwrap()),
        ]),
        resume,
    )
    .await;
    assert_eq!(handle.engine_ref.id, "saved-session");
    let mut settings = settings(RuntimeMode::ApprovalRequired);
    settings.model_selection = selection("mock-fast");
    handle.session.start_turn(input("hi"), &settings).await;
    let (events, _) = until_finished(&mut handle).await;
    // History replayed by session/load is not a new answer.
    assert!(!answer_text(&events).contains("replay"));
    handle.session.shutdown().await;
    let entries = read_log(&log);
    assert_eq!(
        logged(&entries, "session/load")[0]["params"]["sessionId"],
        "saved-session"
    );
    assert!(logged(&entries, "session/new").is_empty());
    let set = logged(&entries, "session/set_config_option");
    assert_eq!(set.len(), 1, "model written once");
    assert_eq!(set[0]["params"]["value"], "mock-fast");
}

#[tokio::test]
async fn resume_without_load_or_resume_support_fails_closed() {
    let dir = tempfile::tempdir().unwrap();
    let mut resume = spec(dir.path(), RuntimeMode::FullAccess);
    resume.resume = Some(EngineRef {
        driver: EngineDriver::AcpRegistry {
            agent_id: "mock".into(),
        },
        id: "saved".into(),
    });
    let result = factory(MockFlavor::new(&[("GOAT_ACP_LOAD_SESSION", "0")]))
        .start(resume)
        .await;
    assert!(matches!(result, Err(EngineError::StartFailed(m)) if m.contains("session/load")));
}

#[tokio::test]
async fn steering_flavor_sends_a_second_prompt() {
    let dir = tempfile::tempdir().unwrap();
    let mut flavor = MockFlavor::new(&[
        ("GOAT_ACP_HANG_PROMPT_FOREVER", "1"),
        ("GOAT_ACP_STEERS_WITH_PROMPT", "1"),
    ]);
    flavor.steers = true;
    let mut handle = start(flavor, spec(dir.path(), RuntimeMode::FullAccess)).await;
    let TurnStartResult::Accepted { turn_id } = handle
        .session
        .start_turn(input("long"), &settings(RuntimeMode::FullAccess))
        .await
    else {
        panic!()
    };
    loop {
        if matches!(next(&mut handle).await, EngineEvent::TextDelta { .. }) {
            break;
        }
    }
    assert_eq!(
        handle.session.steer(&turn_id, input("faster")).await,
        SteerResult::Accepted
    );
    let (events, outcome) = until_finished(&mut handle).await;
    assert_eq!(outcome, TurnOutcome::Done);
    assert!(answer_text(&events).contains("steered: faster"));
    handle.session.shutdown().await;
}

#[tokio::test]
async fn non_json_stdout_lines_are_skipped_and_notices_kept() {
    let dir = tempfile::tempdir().unwrap();
    let mut handle = start(
        MockFlavor::new(&[
            ("GOAT_ACP_STDOUT_LINE", "Starting agent v1.0 ..."),
            ("GOAT_ACP_EMIT_NOTICE", "1"),
        ]),
        spec(dir.path(), RuntimeMode::FullAccess),
    )
    .await;
    handle
        .session
        .start_turn(input("hi"), &settings(RuntimeMode::FullAccess))
        .await;
    let (events, outcome) = until_finished(&mut handle).await;
    assert_eq!(outcome, TurnOutcome::Done);
    let notices: Vec<String> = completed(&events)
        .into_iter()
        .filter_map(|b| match b {
            TurnItemBody::SystemNotice { message, .. } => Some(message),
            _ => None,
        })
        .collect();
    // Malformed and blank notices are dropped (v1 normalizeV1SessionUpdate).
    assert_eq!(
        notices,
        vec!["Optional integration unavailable\n\nContinuing without the integration.".to_string()]
    );
    handle.session.shutdown().await;
}

#[tokio::test]
async fn launch_overrides_apply() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("log.jsonl");
    let mut with_launch = spec(dir.path(), RuntimeMode::FullAccess);
    let mut env = BTreeMap::new();
    env.insert(
        "GOAT_ACP_REQUEST_LOG_PATH".to_string(),
        log.to_string_lossy().into_owned(),
    );
    env.insert("GOAT_ACP_AGENT_VERSION".to_string(), "9.9.9".to_string());
    with_launch.launch = Some(goat2_engine_api::LaunchSpec {
        binary: None,
        args: vec![],
        env,
    });
    let factory = factory(MockFlavor::new(&[]));
    let started = factory.start_acp(with_launch).await.unwrap();
    assert_eq!(
        started.session.initialize_info().agent_version.as_deref(),
        Some("9.9.9")
    );
    assert!(
        started
            .session
            .negotiated_capabilities()
            .sessions
            .supports_model_switch_in_session
    );
    assert!(!read_log(&log).is_empty());
    goat2_engine_api::EngineSession::shutdown(&started.session).await;
}

/// The `mcpServers` the fake agent received in `session/new`.
fn session_new_mcp_servers(log: &[Value]) -> Value {
    logged(log, "session/new")[0]["params"]["mcpServers"].clone()
}

/// v1 `AcpSessionRuntime.ts:1475-1494`: an agent without HTTP MCP gets GOAT through the stdio bridge,
/// with the credential in the server's environment and never on its command line.
#[tokio::test]
async fn stdio_agent_gets_goat_through_the_bridge() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("log.jsonl");
    let flavor = MockFlavor::new(&[("GOAT_ACP_REQUEST_LOG_PATH", log.to_str().unwrap())]);
    let handle = start(flavor, spec(dir.path(), RuntimeMode::FullAccess)).await;
    let servers = session_new_mcp_servers(&read_log(&log));
    assert_eq!(
        servers,
        serde_json::json!([{
            "name": "goat",
            "command": TEST_BRIDGE,
            "args": [],
            "env": [
                {"name": "GOAT_ACP_MCP_ENDPOINT", "value": "http://127.0.0.1:9/mcp"},
                {"name": "GOAT_ACP_MCP_AUTHORIZATION", "value": "Bearer test-token"},
            ],
        }])
    );
    handle.session.shutdown().await;
}

/// v1 passes HTTP servers only for flavors with `preferHttpMcp`: advertising HTTP alone still gets
/// the bridge (agents that advertise HTTP routinely drop injected HTTP servers, `mcpContext.ts:39-44`).
#[tokio::test]
async fn http_mcp_only_when_advertised_and_preferred() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("advertised.jsonl");
    let flavor = MockFlavor::new(&[
        ("GOAT_ACP_REQUEST_LOG_PATH", log.to_str().unwrap()),
        ("GOAT_ACP_MCP_HTTP", "1"),
    ]);
    let handle = start(flavor, spec(dir.path(), RuntimeMode::FullAccess)).await;
    assert_eq!(
        session_new_mcp_servers(&read_log(&log))[0]["command"],
        TEST_BRIDGE
    );
    handle.session.shutdown().await;

    let log = dir.path().join("preferred.jsonl");
    let mut flavor = MockFlavor::new(&[
        ("GOAT_ACP_REQUEST_LOG_PATH", log.to_str().unwrap()),
        ("GOAT_ACP_MCP_HTTP", "1"),
    ]);
    flavor.prefers_http_mcp = true;
    let handle = start(flavor, spec(dir.path(), RuntimeMode::FullAccess)).await;
    assert_eq!(
        session_new_mcp_servers(&read_log(&log)),
        serde_json::json!([{
            "type": "http",
            "name": "goat",
            "url": "http://127.0.0.1:9/mcp",
            "headers": [{"name": "Authorization", "value": "Bearer test-token"}],
        }])
    );
    handle.session.shutdown().await;

    let log = dir.path().join("preferred-unadvertised.jsonl");
    let mut flavor = MockFlavor::new(&[("GOAT_ACP_REQUEST_LOG_PATH", log.to_str().unwrap())]);
    flavor.prefers_http_mcp = true;
    let handle = start(flavor, spec(dir.path(), RuntimeMode::FullAccess)).await;
    assert_eq!(
        session_new_mcp_servers(&read_log(&log))[0]["command"],
        TEST_BRIDGE
    );
    handle.session.shutdown().await;
}

/// An agent never starts without GOAT tools: no bridge and no HTTP route fails session setup.
#[tokio::test]
async fn missing_bridge_fails_closed() {
    let dir = tempfile::tempdir().unwrap();
    let factory = AcpEngineFactory::new(Arc::new(MockFlavor::new(&[]))).without_mcp_bridge();
    let error = match factory
        .start(spec(dir.path(), RuntimeMode::FullAccess))
        .await
    {
        Ok(_) => panic!("started without GOAT tools"),
        Err(error) => error.to_string(),
    };
    assert!(error.contains("MCP bridge"), "{error}");
}

/// A sign-in page during a turn reaches the host only through AuthRequired (kept in memory, never
/// in the thread log), tied to its turn (the host declines it when the run ends), and the agent's
/// request stays open until the person answers through the sign-in's key (engine-api step 3a; v1
/// registry onUrlElicitation, adapter.ts:5329-5362).
#[tokio::test]
async fn url_elicitation_waits_for_the_persons_answer_without_logging_the_link() {
    for (outcome, expected) in [
        (RequestOutcome::Accept, r#"{"action":"accept"}"#),
        (RequestOutcome::Decline, r#"{"action":"decline"}"#),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let flavor = MockFlavor::new(&[("GOAT_ACP_EMIT_URL_ELICITATION", "1")]);
        let mut handle = start(flavor, spec(dir.path(), RuntimeMode::FullAccess)).await;
        handle
            .session
            .start_turn(input("go"), &settings(RuntimeMode::FullAccess))
            .await;
        let mut events = Vec::new();
        let finished = loop {
            let event = next(&mut handle).await;
            if let EngineEvent::AuthRequired {
                turn_id, url, key, ..
            } = &event
            {
                assert!(turn_id.is_some(), "tied to the turn that raised it");
                assert_eq!(url.as_deref(), Some("https://example.invalid/sign-in"));
                let key = key.clone().expect("the agent's request is answerable");
                // Nothing reached the agent yet: it is waiting for the person.
                assert!(!answer_text(&events).contains("url elicitation"));
                handle
                    .session
                    .answer_request(
                        &key,
                        RequestAnswer {
                            outcome,
                            text: None,
                            answers: None,
                        },
                    )
                    .await
                    .unwrap();
            }
            if let EngineEvent::TurnFinished { outcome, .. } = &event {
                break outcome.clone();
            }
            events.push(event);
        };
        assert_eq!(finished, TurnOutcome::Done);
        for event in &events {
            if matches!(event, EngineEvent::AuthRequired { .. }) {
                continue;
            }
            assert!(
                !format!("{event:?}").contains("example.invalid/sign-in"),
                "link leaked into {event:?}"
            );
        }
        assert!(
            answer_text(&events).contains(&format!("url elicitation: {expected}")),
            "{}",
            answer_text(&events)
        );
        handle.session.shutdown().await;
    }
}

/// A sign-in URL the agent prints on stderr reaches the host after startup (the stderr hook keeps
/// pointing at the live session state; review 1 finding 4).
#[tokio::test]
async fn stderr_signin_url_reaches_the_host() {
    let dir = tempfile::tempdir().unwrap();
    let mut flavor = MockFlavor::new(&[(
        "GOAT_ACP_STDERR_LINE",
        "LOGIN https://example.invalid/device",
    )]);
    flavor.stderr_url = true;
    let mut handle = start(flavor, spec(dir.path(), RuntimeMode::FullAccess)).await;
    loop {
        if let EngineEvent::AuthRequired { url, .. } = next(&mut handle).await {
            assert_eq!(url.as_deref(), Some("https://example.invalid/device"));
            break;
        }
    }
    handle.session.shutdown().await;
}

const SECRET_LINE: &str = "Invalid project config\nAuthorization: Bearer secret-token-value";

/// Startup errors carry sanitized stderr: the host stores the reason in the thread log (final
/// review 3 finding 1; v1 AcpJsonRpcConnection.test.ts:1071-1093).
#[tokio::test]
async fn startup_failure_reason_has_no_credentials() {
    let dir = tempfile::tempdir().unwrap();
    let flavor = MockFlavor::new(&[
        ("GOAT_ACP_STDERR_LINE", SECRET_LINE),
        ("GOAT_ACP_EXIT_AT_START", "1"),
    ]);
    let error = match factory(flavor)
        .start(spec(dir.path(), RuntimeMode::FullAccess))
        .await
    {
        Ok(_) => panic!("started"),
        Err(error) => error.to_string(),
    };
    assert!(!error.contains("secret-token-value"), "{error}");
    assert!(error.contains("Bearer [redacted]"), "{error}");
}

/// An exit during a turn: the turn's failure reason and the exit reason are sanitized too.
#[tokio::test]
async fn exit_during_a_turn_has_no_credentials() {
    let dir = tempfile::tempdir().unwrap();
    let flavor = MockFlavor::new(&[
        ("GOAT_ACP_CRASH_PROMPT", "1"),
        (
            "GOAT_ACP_CRASH_STDERR",
            "Authorization: Bearer secret-token-value",
        ),
    ]);
    let mut handle = start(flavor, spec(dir.path(), RuntimeMode::FullAccess)).await;
    handle
        .session
        .start_turn(input("go"), &settings(RuntimeMode::FullAccess))
        .await;
    let mut reasons = Vec::new();
    let mut exited = false;
    while !exited {
        match next(&mut handle).await {
            EngineEvent::TurnFinished {
                outcome: TurnOutcome::Failed { reason },
                ..
            } => reasons.push(reason),
            EngineEvent::Exited { reason } => {
                reasons.push(reason);
                exited = true;
            }
            _ => {}
        }
    }
    for reason in &reasons {
        assert!(!reason.contains("secret-token-value"), "{reason}");
    }
    assert!(
        reasons.iter().any(|r| r.contains("[redacted]")),
        "{reasons:?}"
    );
}

/// Megabytes of stderr without a newline neither stall the agent nor end up whole in a reason
/// (final review 3 finding 2).
#[tokio::test]
async fn newline_free_stderr_flood_is_drained_and_bounded() {
    let dir = tempfile::tempdir().unwrap();
    let flavor = MockFlavor::new(&[("GOAT_ACP_FLOOD_STDERR", "4194304")]);
    let seen = Arc::clone(&flavor.stderr_seen);
    let mut handle = start(flavor, spec(dir.path(), RuntimeMode::FullAccess)).await;
    handle
        .session
        .start_turn(input("go"), &settings(RuntimeMode::FullAccess))
        .await;
    let (_, outcome) = until_finished(&mut handle).await;
    assert_eq!(outcome, TurnOutcome::Done);
    // While the agent is still alive, the newline-free run was handed on in bounded pieces.
    let (longest, total) = *seen.lock().unwrap();
    assert!(
        total >= 1024 * 1024,
        "only {total} bytes read while the agent runs"
    );
    assert!(longest <= 32 * 1024, "a {longest}-byte piece");
    handle.session.shutdown().await;

    let flavor = MockFlavor::new(&[
        ("GOAT_ACP_FLOOD_STDERR", "4194304"),
        ("GOAT_ACP_EXIT_AT_START", "1"),
    ]);
    let error = match factory(flavor)
        .start(spec(dir.path(), RuntimeMode::FullAccess))
        .await
    {
        Ok(_) => panic!("started"),
        Err(error) => error.to_string(),
    };
    assert!(error.len() < 8 * 1024, "reason is {} bytes", error.len());
}

// ---- final review (engine slice) -----------------------------------------------------------

/// Run one turn of a fake-agent script in the given mode; returns whether the person was asked,
/// and the answer text. Asked approvals are declined.
async fn scripted_turn(
    dir: &std::path::Path,
    mode: RuntimeMode,
    lines: &[serde_json::Value],
) -> (bool, String) {
    let script = dir.join(format!("script-{}.jsonl", lines.len()));
    std::fs::write(
        &script,
        lines
            .iter()
            .map(|l| l.to_string())
            .collect::<Vec<_>>()
            .join("\n"),
    )
    .unwrap();
    let flavor = MockFlavor::new(&[("GOAT_ACP_SCRIPT", script.to_str().unwrap())]);
    let mut handle = start(flavor, spec(dir, mode)).await;
    let started = handle
        .session
        .start_turn(input("go"), &settings(mode))
        .await;
    assert!(
        matches!(started, TurnStartResult::Accepted { .. }),
        "{started:?}"
    );
    let mut asked = false;
    let mut events = Vec::new();
    loop {
        let event = next(&mut handle).await;
        if let EngineEvent::RequestOpened {
            key,
            kind: RequestKind::Approval,
            ..
        } = &event
        {
            asked = true;
            handle
                .session
                .answer_request(
                    key,
                    RequestAnswer {
                        outcome: RequestOutcome::Decline,
                        text: None,
                        answers: None,
                    },
                )
                .await
                .unwrap();
        }
        let done = matches!(event, EngineEvent::TurnFinished { .. });
        events.push(event);
        if done {
            break;
        }
    }
    handle.session.shutdown().await;
    (asked, answer_text(&events))
}

/// Final review finding 2 (v1 autoAcceptEdits.ts:21-32,148-160): auto-accept reads every path the
/// tool call named so far, and a tool update it could not read leaves the paths unknown.
#[tokio::test]
async fn auto_accept_edits_counts_paths_named_by_earlier_updates() {
    let dir = tempfile::tempdir().unwrap();
    let inside = dir.path().join("inside.txt");
    let inside = inside.to_str().unwrap();
    let options = serde_json::json!([
        {"optionId": "allow-once", "name": "Allow", "kind": "allow_once"},
        {"optionId": "reject-once", "name": "Reject", "kind": "reject_once"}
    ]);
    let update = |path: &str| {
        serde_json::json!({"update": {"sessionUpdate": "tool_call", "toolCallId": "edit-1",
            "kind": "edit", "title": "Edit", "status": "pending", "locations": [{"path": path}]}})
    };
    let request = serde_json::json!({"request": "session/request_permission", "params": {
        "sessionId": "$SESSION",
        "toolCall": {"toolCallId": "edit-1", "kind": "edit", "locations": [{"path": inside}]},
        "options": options}});
    // An earlier update named a file outside the workspace: the person decides.
    let (asked, text) = scripted_turn(
        dir.path(),
        RuntimeMode::AutoAcceptEdits,
        &[update("/etc/goat2-outside.txt"), request.clone()],
    )
    .await;
    assert!(
        asked,
        "auto-approved an edit that also touches /etc: {text}"
    );
    assert!(text.contains("reject-once"), "{text}");
    // Only workspace paths, before and in the request: approved without asking.
    let (asked, text) = scripted_turn(
        dir.path(),
        RuntimeMode::AutoAcceptEdits,
        &[update(inside), request.clone()],
    )
    .await;
    assert!(!asked, "{text}");
    assert!(text.contains("allow-once"), "{text}");
    // A tool update without a readable tool call id may have named any path: unknown.
    let (asked, text) = scripted_turn(
        dir.path(),
        RuntimeMode::AutoAcceptEdits,
        &[
            update(inside),
            serde_json::json!({"update": {"sessionUpdate": "tool_call_update", "toolCallId": 7,
                "locations": [{"path": "/etc/goat2-outside.txt"}]}}),
            request,
        ],
    )
    .await;
    assert!(
        asked,
        "auto-approved after an unreadable tool update: {text}"
    );
}

/// Final review finding 4: the stderr kept for errors is cleaned before it is cut, so a cut
/// after "Bearer " never leaves the token behind (both the 4096-character tail and the bounded
/// line pieces).
#[tokio::test]
async fn stderr_cuts_never_reveal_a_secret() {
    let dir = tempfile::tempdir().unwrap();
    for length in [5_000usize, 70_000] {
        let line = format!("Authorization: Bearer {}", "S".repeat(length));
        let flavor = MockFlavor::new(&[
            ("GOAT_ACP_STDERR_LINE", line.as_str()),
            ("GOAT_ACP_EXIT_AT_START", "1"),
        ]);
        let error = match factory(flavor)
            .start(spec(dir.path(), RuntimeMode::FullAccess))
            .await
        {
            Ok(_) => panic!("started"),
            Err(error) => error.to_string(),
        };
        assert!(
            !error.contains(&"S".repeat(16)),
            "{length}-character token in: {}",
            &error[..error.len().min(300)]
        );
    }
}

/// Final review finding 5 (v1 strictParser.ts:18-30): a stdout line longer than 16 Mi
/// characters ends the connection instead of growing host memory.
#[tokio::test]
async fn endless_stdout_line_fails_the_connection() {
    let dir = tempfile::tempdir().unwrap();
    let flood = (17 * 1024 * 1024).to_string();
    let flavor = MockFlavor::new(&[("GOAT_ACP_FLOOD_STDOUT", flood.as_str())]);
    let error = match factory(flavor)
        .with_timeouts(AcpTimeouts {
            request: Duration::from_secs(10),
            session_load: Duration::from_secs(10),
            cancel: Duration::from_secs(2),
        })
        .start(spec(dir.path(), RuntimeMode::FullAccess))
        .await
    {
        Ok(_) => panic!("started"),
        Err(error) => error.to_string(),
    };
    assert!(
        error.contains("ACP frame exceeds the maximum size"),
        "{error}"
    );
}

/// Final review finding 7 (v1 probe.ts:461-487, registry onUrlElicitation): a sign-in link the
/// agent sent during session setup reaches the host even though setup then failed, and the next
/// turn starts the agent again.
#[tokio::test]
async fn setup_signin_link_survives_a_failed_start() {
    let dir = tempfile::tempdir().unwrap();
    let once = dir.path().join("asked");
    let answer = dir.path().join("answer.json");
    let flavor = MockFlavor::new(&[
        ("GOAT_ACP_URL_ELICITATION_ON_NEW", "1"),
        ("GOAT_ACP_URL_ELICITATION_ONCE_PATH", once.to_str().unwrap()),
        (
            "GOAT_ACP_ELICITATION_RESPONSE_LOG_PATH",
            answer.to_str().unwrap(),
        ),
    ]);
    let mut handle = factory(flavor)
        .start(spec(dir.path(), RuntimeMode::FullAccess))
        .await
        .expect("a start that asked for a sign-in hands its link over");
    match next(&mut handle).await {
        EngineEvent::AuthRequired { turn_id, url, .. } => {
            assert_eq!(turn_id, None);
            assert_eq!(url.as_deref(), Some("https://example.invalid/login"));
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(
        std::fs::read_to_string(&answer).unwrap(),
        r#"{"action":"accept"}"#
    );
    // The run that triggered the start fails with the start error; the link stays open.
    let first = handle
        .session
        .start_turn(input("hi"), &settings(RuntimeMode::FullAccess))
        .await;
    assert!(
        matches!(&first, TurnStartResult::Declined { reason } if reason.contains("authentication required")),
        "{first:?}"
    );
    assert!(
        handle.events.try_recv().is_err(),
        "no second sign-in event replaces the link"
    );
    // After the sign-in the next turn starts the agent and runs.
    let second = handle
        .session
        .start_turn(input("hi"), &settings(RuntimeMode::FullAccess))
        .await;
    assert!(
        matches!(second, TurnStartResult::Accepted { .. }),
        "{second:?}"
    );
    let (events, outcome) = until_finished(&mut handle).await;
    assert_eq!(outcome, TurnOutcome::Done);
    assert_eq!(answer_text(&events), "hello from mock");
    handle.session.shutdown().await;
}

/// Final review finding 10 (v1 acpAppContext.ts:63-64): a slash command sent first does not
/// consume the preamble; the next prompt carries it.
#[tokio::test]
async fn slash_command_first_keeps_the_preamble() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("log.jsonl");
    let mut with_preamble = spec(dir.path(), RuntimeMode::FullAccess);
    with_preamble.instructions = Some(Instructions {
        append_system_prompt: None,
        first_message_preamble: Some("BOT BRIEF".into()),
    });
    let mut handle = start(
        MockFlavor::new(&[("GOAT_ACP_REQUEST_LOG_PATH", log.to_str().unwrap())]),
        with_preamble,
    )
    .await;
    for text in ["/review", "hello"] {
        handle
            .session
            .start_turn(input(text), &settings(RuntimeMode::FullAccess))
            .await;
        let (_, outcome) = until_finished(&mut handle).await;
        assert_eq!(outcome, TurnOutcome::Done);
    }
    handle.session.shutdown().await;
    let log = read_log(&log);
    let prompts: Vec<Vec<String>> = logged(&log, "session/prompt")
        .iter()
        .map(|m| {
            m["params"]["prompt"]
                .as_array()
                .unwrap()
                .iter()
                .map(|b| b["text"].as_str().unwrap_or_default().to_owned())
                .collect()
        })
        .collect();
    assert_eq!(prompts, [vec!["/review"], vec!["BOT BRIEF", "hello"]]);
}

/// Final review finding 21 (v1 AcpSessionRuntime.ts:835): stderr without a newline reaches the
/// exit reason even when a child of the agent keeps stderr open after the agent exits.
#[tokio::test]
async fn short_stderr_without_newline_reaches_the_exit_reason() {
    let dir = tempfile::tempdir().unwrap();
    let flavor = MockFlavor::new(&[
        ("GOAT_ACP_CRASH_PROMPT", "1"),
        ("GOAT_ACP_CRASH_STDERR", "fatal: config missing"),
        ("GOAT_ACP_CRASH_STDERR_PARTIAL", "1"),
        ("GOAT_ACP_STDERR_HOLDER", "1"),
    ]);
    let mut handle = start(flavor, spec(dir.path(), RuntimeMode::FullAccess)).await;
    handle
        .session
        .start_turn(input("go"), &settings(RuntimeMode::FullAccess))
        .await;
    let mut reasons = Vec::new();
    loop {
        match next(&mut handle).await {
            EngineEvent::TurnFinished {
                outcome: TurnOutcome::Failed { reason },
                ..
            } => reasons.push(reason),
            EngineEvent::Exited { reason } => {
                reasons.push(reason);
                break;
            }
            _ => {}
        }
    }
    assert!(
        reasons.iter().any(|r| r.contains("fatal: config missing")),
        "{reasons:?}"
    );
}
