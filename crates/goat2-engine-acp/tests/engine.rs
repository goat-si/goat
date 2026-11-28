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
