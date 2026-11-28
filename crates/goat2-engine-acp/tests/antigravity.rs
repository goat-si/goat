//! Antigravity flavor against the offline ACP mock (`GOAT_ACP_ANTIGRAVITY=1` profile, ported from
//! v1 `apps/server/scripts/acp-mock-agent.ts`). Each test pins one v1 behaviour; the v1 source is
//! named on the test.
use goat2_contracts::{
    ChatAttachment, ChatAttachmentType, EngineConfig, ModelSelection, ProviderOptionSelection,
    ProviderOptionSelectionValue, RequestKind, RequestOutcome, RuntimeMode, TurnItem, TurnItemBody,
    TurnItemStatus,
};
use goat2_engine_acp::agents::antigravity::Antigravity;
use goat2_engine_acp::agents::antigravity_auth::{
    ANTIGRAVITY_AUTH_BROWSER_MARKER, ANTIGRAVITY_AUTH_STDOUT_PREFIX,
    ANTIGRAVITY_HARNESS_FAILURE_MESSAGE, ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE,
    AntigravityAuthConfig, AntigravityAuthMethod,
};
use goat2_engine_acp::{AcpEngineFactory, AcpFlavor};
use goat2_engine_api::{
    EngineEvent, EngineFactory, EngineHandle, EngineInput, Instructions, LaunchSpec, McpEndpoint,
    RequestAnswer, SessionSpec, TurnOutcome, TurnSettings, TurnStartResult,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

const TEST_BRIDGE: &str = "/goat2-test/bin/goat2-acp-mcp-bridge";

struct Run {
    handle: EngineHandle,
    log: PathBuf,
    _dir: tempfile::TempDir,
}

fn selection(model: &str, options: Option<Vec<ProviderOptionSelection>>) -> ModelSelection {
    ModelSelection {
        instance_id: "agent".into(),
        model: model.into(),
        options,
    }
}

fn spec(
    cwd: &Path,
    log: &Path,
    mode: RuntimeMode,
    model: &ModelSelection,
    env: &[(&str, &str)],
    instructions: Option<Instructions>,
) -> SessionSpec {
    let mut vars: BTreeMap<String, String> = env
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    vars.insert(
        "GOAT_ACP_REQUEST_LOG_PATH".into(),
        log.to_string_lossy().into_owned(),
    );
    SessionSpec {
        thread_id: "t".into(),
        engine: EngineConfig {
            provider_instance_id: "agent".into(),
            model_selection: model.clone(),
            runtime_mode: mode,
            cwd: cwd.to_string_lossy().into_owned(),
        },
        resume: None,
        mcp: McpEndpoint {
            url: "http://127.0.0.1:9/mcp".into(),
            bearer_token: "fake".into(),
        },
        host_generation: 1,
        process_generation: 1,
        instructions,
        launch: Some(LaunchSpec {
            binary: Some(env!("CARGO_BIN_EXE_goat2-acp-mock-agent").into()),
            args: vec![],
            env: vars,
        }),
    }
}

async fn start_with(
    flavor: Arc<dyn AcpFlavor>,
    mode: RuntimeMode,
    model: &ModelSelection,
    env: &[(&str, &str)],
    instructions: Option<Instructions>,
    resolver: Option<goat2_engine_acp::AttachmentResolver>,
) -> Result<Run, goat2_engine_api::EngineError> {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    let log = dir.path().join("log.jsonl");
    let mut factory = AcpEngineFactory::new(flavor).with_mcp_bridge(
        goat2_engine_acp::McpBridgeCommand::new(TEST_BRIDGE, Vec::<String>::new()),
    );
    if let Some(resolver) = resolver {
        factory = factory.with_attachment_resolver(resolver);
    }
    let handle = factory
        .start(spec(&cwd, &log, mode, model, env, instructions))
        .await?;
    Ok(Run {
        handle,
        log,
        _dir: dir,
    })
}

fn input(text: &str) -> Vec<EngineInput> {
    vec![EngineInput {
        input_id: "i".into(),
        text: text.into(),
        attachments: vec![],
    }]
}

/// Run one turn, answering each opened request with `answer`; every event until it finishes.
async fn turn(
    run: &mut Run,
    inputs: Vec<EngineInput>,
    mode: RuntimeMode,
    model: &ModelSelection,
    answer: impl Fn(&EngineEvent) -> Option<(String, RequestAnswer)>,
) -> (Vec<EngineEvent>, TurnOutcome) {
    let started = run
        .handle
        .session
        .start_turn(
            inputs,
            &TurnSettings {
                model_selection: model.clone(),
                runtime_mode: mode,
            },
        )
        .await;
    assert!(
        matches!(started, TurnStartResult::Accepted { .. }),
        "{started:?}"
    );
    let mut events = Vec::new();
    let outcome = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let event = run.handle.events.recv().await.expect("event");
            if let Some((key, reply)) = answer(&event) {
                run.handle
                    .session
                    .answer_request(&key, reply)
                    .await
                    .unwrap();
            }
            if let EngineEvent::TurnFinished { outcome, .. } = &event {
                let outcome = outcome.clone();
                events.push(event);
                break outcome;
            }
            events.push(event);
        }
    })
    .await
    .expect("turn finishes");
    (events, outcome)
}

fn answer_text(events: &[EngineEvent]) -> String {
    events
        .iter()
        .filter_map(|e| match e {
            EngineEvent::ItemCompleted { item, .. } => match &item.body {
                TurnItemBody::AssistantMessage { text, .. } => Some(text.clone()),
                _ => None,
            },
            _ => None,
        })
        .collect()
}

fn completed(events: &[EngineEvent]) -> Vec<TurnItem> {
    events
        .iter()
        .filter_map(|e| match e {
            EngineEvent::ItemCompleted { item, .. } => Some((**item).clone()),
            _ => None,
        })
        .collect()
}

fn read_log(path: &Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

fn logged(log: &[Value], method: &str) -> Vec<Value> {
    log.iter()
        .filter(|m| m["method"] == method)
        .map(|m| m["params"].clone())
        .collect()
}

/// The `session/set_config_option` writes, as `(configId, value)`.
fn config_writes(log: &[Value]) -> Vec<(String, Value)> {
    logged(log, "session/set_config_option")
        .into_iter()
        .map(|p| {
            (
                p["configId"].as_str().unwrap().to_owned(),
                p["value"].clone(),
            )
        })
        .collect()
}

fn answered(
    key: &str,
    outcome: RequestOutcome,
    answers: Option<Value>,
) -> Option<(String, RequestAnswer)> {
    Some((
        key.to_owned(),
        RequestAnswer {
            outcome,
            text: None,
            answers: answers.map(|a| a.as_object().unwrap().clone()),
        },
    ))
}

const LOGIN_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&response_type=code&state=s1&redirect_uri=http%3A%2F%2F127.0.0.1%3A43123%2F";

fn low() -> ModelSelection {
    selection("gemini-test-low", None)
}

async fn start(env: &[(&str, &str)], mode: RuntimeMode) -> Run {
    start_with(
        Arc::new(Antigravity::default()),
        mode,
        &low(),
        &[&[("GOAT_ACP_ANTIGRAVITY", "1")], env].concat(),
        None,
        None,
    )
    .await
    .expect("start")
}

async fn simple_turn(run: &mut Run, mode: RuntimeMode) -> (Vec<EngineEvent>, TurnOutcome) {
    turn(run, input("go"), mode, &low(), |_| None).await
}

/// v1 antigravityAuthSupport.ts:628-692: the ACP server's sign-in link on stdout becomes a sign-in
/// request with the URL, and the session still opens.
#[tokio::test]
async fn login_link_on_stdout_asks_the_person_to_sign_in() {
    let line = format!("{ANTIGRAVITY_AUTH_STDOUT_PREFIX}{LOGIN_URL}");
    let mut run = start(
        &[("GOAT_ACP_STDOUT_LINE", &line)],
        RuntimeMode::ApprovalRequired,
    )
    .await;
    let (events, outcome) = simple_turn(&mut run, RuntimeMode::ApprovalRequired).await;
    assert_eq!(outcome, TurnOutcome::Done);
    let mut all = Vec::new();
    while let Ok(event) = run.handle.events.try_recv() {
        all.push(event);
    }
    all.extend(events);
    assert!(
        all.iter().any(
            |e| matches!(e, EngineEvent::AuthRequired { url: Some(url), .. } if url == LOGIN_URL)
        ),
        "{all:?}"
    );
    run.handle.session.shutdown().await;
}

/// v1 antigravityAuthSupport.ts:640-647: a sign-in link that is not Google's loopback page ends the
/// connection instead of being shown.
#[tokio::test]
async fn invalid_login_link_ends_the_connection() {
    let line =
        format!("{ANTIGRAVITY_AUTH_STDOUT_PREFIX}https://evil.example/o/oauth2/v2/auth?state=s");
    let result = start_with(
        Arc::new(Antigravity::default()),
        RuntimeMode::ApprovalRequired,
        &low(),
        &[
            ("GOAT_ACP_ANTIGRAVITY", "1"),
            ("GOAT_ACP_STDOUT_LINE", &line),
        ],
        None,
        None,
    )
    .await;
    let Err(error) = result else {
        panic!("the session must not open");
    };
    assert!(
        error
            .to_string()
            .contains("Antigravity returned an invalid Google sign-in URL."),
        "{error}"
    );
}

/// v1 antigravityAuthSupport.ts:718-733: the browser helper's marker on stderr carries the URL
/// Python tried to open.
#[tokio::test]
async fn browser_helper_link_on_stderr_asks_to_sign_in() {
    let line = format!("{ANTIGRAVITY_AUTH_BROWSER_MARKER}\"{LOGIN_URL}\"");
    let mut run = start(
        &[("GOAT_ACP_STDERR_LINE", &line)],
        RuntimeMode::ApprovalRequired,
    )
    .await;
    let (events, _) = simple_turn(&mut run, RuntimeMode::ApprovalRequired).await;
    let mut all = Vec::new();
    while let Ok(event) = run.handle.events.try_recv() {
        all.push(event);
    }
    all.extend(events);
    assert!(all.iter().any(
        |e| matches!(e, EngineEvent::AuthRequired { url: Some(url), .. } if url == LOGIN_URL)
    ));
    run.handle.session.shutdown().await;
}

/// v1 antigravityAuthSupport.ts:694-717 + acpMockHarnessFailure.ts: the harness's "Agent run
/// failed" log fails the turn (it would otherwise wait forever) and ends the process.
#[tokio::test]
async fn harness_failure_on_stderr_fails_the_turn() {
    let mut run = start(
        &[("GOAT_ACP_ANTIGRAVITY_HARNESS_FAILURE", "pending")],
        RuntimeMode::ApprovalRequired,
    )
    .await;
    let (_, outcome) = simple_turn(&mut run, RuntimeMode::ApprovalRequired).await;
    assert_eq!(
        outcome,
        TurnOutcome::Failed {
            reason: ANTIGRAVITY_HARNESS_FAILURE_MESSAGE.into()
        }
    );
    let exited = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let EngineEvent::Exited { reason } = run.handle.events.recv().await.expect("event") {
                break reason;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(exited, ANTIGRAVITY_HARNESS_FAILURE_MESSAGE);
}

/// v1 antigravityAuthSupport.ts:171-181 (isAntigravitySignInRequiredError): the 1.5 CLI's
/// "No browser is available here" on authenticate means the person must sign in in Settings.
#[tokio::test]
async fn no_browser_authenticate_error_means_sign_in() {
    let result = start_with(
        Arc::new(Antigravity::default()),
        RuntimeMode::ApprovalRequired,
        &low(),
        &[
            ("GOAT_ACP_ANTIGRAVITY", "1"),
            ("GOAT_ACP_ANTIGRAVITY_AUTH_ERROR", "no-browser"),
        ],
        None,
        None,
    )
    .await;
    let Err(error) = result else {
        panic!("the session must not open");
    };
    assert_eq!(
        error,
        goat2_engine_api::EngineError::StartFailed(ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE.into())
    );
}

/// v1 AntigravityAcpSupport.ts:157 + antigravityAuthSupport.ts:217-223: the configured method is
/// authenticated eagerly and the API key reaches the agent only through its environment.
#[tokio::test]
async fn api_key_method_authenticates_with_its_credential() {
    let flavor = Antigravity {
        auth: AntigravityAuthConfig {
            auth_method: AntigravityAuthMethod::GeminiApiKey,
            api_key: "test-key".into(),
            ..Default::default()
        },
        ..Default::default()
    };
    let run = start_with(
        Arc::new(flavor),
        RuntimeMode::ApprovalRequired,
        &low(),
        &[("GOAT_ACP_ANTIGRAVITY", "1")],
        None,
        None,
    )
    .await
    .expect("the mock takes gemini-api-key only with GEMINI_API_KEY set");
    let log = read_log(&run.log);
    assert_eq!(
        logged(&log, "authenticate")[0]["methodId"],
        "gemini-api-key"
    );
    assert!(
        !std::fs::read_to_string(&run.log)
            .unwrap()
            .contains("test-key")
    );
    run.handle.session.shutdown().await;

    let missing = Antigravity {
        auth: AntigravityAuthConfig {
            auth_method: AntigravityAuthMethod::GeminiApiKey,
            ..Default::default()
        },
        ..Default::default()
    };
    let error = start_with(
        Arc::new(missing),
        RuntimeMode::ApprovalRequired,
        &low(),
        &[("GOAT_ACP_ANTIGRAVITY", "1")],
        None,
        None,
    )
    .await
    .err()
    .unwrap();
    assert!(
        error.to_string().contains("Enter a Gemini API key"),
        "{error}"
    );
}

/// v1 AntigravityAcpSupport.ts:189-200 + AcpSessionRuntime.ts:2068-2098: each runtime mode writes
/// the harness's permission mode through its `mode` option (AntigravityModePolicy.test.ts).
#[tokio::test]
async fn runtime_modes_write_permission_modes() {
    let mut run = start(&[], RuntimeMode::FullAccess).await;
    simple_turn(&mut run, RuntimeMode::AutoAcceptEdits).await;
    simple_turn(&mut run, RuntimeMode::ApprovalRequired).await;
    let writes = config_writes(&read_log(&run.log));
    assert_eq!(
        writes,
        [
            ("mode".to_owned(), json!("yolo")),
            ("mode".to_owned(), json!("auto_edit")),
            ("mode".to_owned(), json!("default"))
        ]
    );
    run.handle.session.shutdown().await;
}

/// v1 AntigravityAcpSupport.ts:311-354 + adapter.ts:6037-6113 + acpMockAntigravityThoughtLevel.ts:
/// a model change resets the thinking level, so the selection's level is written again after the
/// model, against the options the model write returned.
#[tokio::test]
async fn model_change_writes_model_then_thinking_level() {
    let mut run = start(
        &[("GOAT_ACP_ANTIGRAVITY_THOUGHT_LEVEL", "1")],
        RuntimeMode::ApprovalRequired,
    )
    .await;
    let high = selection(
        "gemini-test-high",
        Some(vec![ProviderOptionSelection {
            id: "thought_level".into(),
            value: ProviderOptionSelectionValue::Text("low".into()),
        }]),
    );
    turn(
        &mut run,
        input("go"),
        RuntimeMode::ApprovalRequired,
        &high,
        |_| None,
    )
    .await;
    // Extra Low is not offered for the high model: skipped, not failed.
    let xhigh = selection(
        "gemini-test-high",
        Some(vec![ProviderOptionSelection {
            id: "thought_level".into(),
            value: ProviderOptionSelectionValue::Text("xhigh".into()),
        }]),
    );
    let (_, outcome) = turn(
        &mut run,
        input("again"),
        RuntimeMode::ApprovalRequired,
        &xhigh,
        |_| None,
    )
    .await;
    assert_eq!(outcome, TurnOutcome::Done);
    let unavailable = run
        .handle
        .session
        .start_turn(
            input("x"),
            &TurnSettings {
                model_selection: selection("gemini-unknown", None),
                runtime_mode: RuntimeMode::ApprovalRequired,
            },
        )
        .await;
    assert!(
        matches!(&unavailable, TurnStartResult::Declined { reason } if reason == "Antigravity model 'gemini-unknown' is unavailable for this Google account. Select an available model."),
        "{unavailable:?}"
    );
    let writes = config_writes(&read_log(&run.log));
    assert_eq!(
        writes,
        [
            ("model".to_owned(), json!("gemini-test-high")),
            ("thought_level".to_owned(), json!("low")),
        ]
    );
    run.handle.session.shutdown().await;
}

/// v1 AntigravityProtocol.ts:241-288 + adapter.ts:5128-5147: an `interaction_` permission request
/// is a question held for the person; the chosen option answers it.
#[tokio::test]
async fn interaction_permission_is_a_question() {
    let mut run = start(
        &[("GOAT_ACP_ANTIGRAVITY_INTERACTION", "1")],
        RuntimeMode::FullAccess,
    )
    .await;
    let (events, outcome) = turn(
        &mut run,
        input("go"),
        RuntimeMode::FullAccess,
        &low(),
        |event| match event {
            EngineEvent::RequestOpened {
                key,
                kind,
                item,
                summary,
                ..
            } => {
                assert_eq!(*kind, RequestKind::Question);
                assert_eq!(summary, "Which file should I edit?");
                let Some(TurnItemBody::UserInputRequest { questions, .. }) =
                    item.as_ref().map(|i| i.body.clone())
                else {
                    panic!("question item");
                };
                assert_eq!(questions[0].id, "interaction_1");
                assert_eq!(questions[0].options[1].label, "src/b.rs");
                answered(
                    key,
                    RequestOutcome::Answered,
                    Some(json!({"interaction_1": "src/b.rs"})),
                )
            }
            _ => None,
        },
    )
    .await;
    assert_eq!(outcome, TurnOutcome::Done);
    assert!(
        answer_text(&events).contains(r#"interaction: {"outcome":"selected","optionId":"opt-b"}"#),
        "{}",
        answer_text(&events)
    );
    run.handle.session.shutdown().await;
}

/// v1 AntigravityAcpSupport.ts:213-248: GOAT's own MCP tools run without asking in the automatic
/// modes, where another `other` call asks.
#[tokio::test]
async fn goat_mcp_tools_are_approved_in_automatic_modes() {
    let mode = RuntimeMode::AutoAcceptEdits;
    let mut run = start(&[("GOAT_ACP_ANTIGRAVITY_GOAT_MCP", "1")], mode).await;
    let (events, outcome) = turn(&mut run, input("go"), mode, &low(), |event| {
        assert!(
            !matches!(event, EngineEvent::RequestOpened { .. }),
            "{event:?}"
        );
        None
    })
    .await;
    assert_eq!(outcome, TurnOutcome::Done);
    assert!(
        answer_text(&events).contains(r#"goat mcp: {"outcome":"selected","optionId":"once"}"#),
        "{}",
        answer_text(&events)
    );
    run.handle.session.shutdown().await;
}

/// v1 AntigravityDriver.ts:441-450 + AntigravityAcpSupport.ts:202-211: the `agy` CLI has no
/// `yolo`/`auto_edit` (and maybe no `auto`): its runtime takes them as `default`, where the
/// harness would refuse an unlisted mode (AcpSessionRuntime.ts:1023-1075).
#[tokio::test]
async fn agy_cli_maps_permission_modes_onto_its_own() {
    use goat2_engine_acp::agents::antigravity::{AntigravityInstallation, AntigravityLaunch};
    use goat2_engine_acp::agents::antigravity_auth::AntigravityProfile;
    let profile_dir = tempfile::tempdir().unwrap();
    let cli = Antigravity {
        launch: Some(AntigravityLaunch {
            installation: AntigravityInstallation {
                executable_path: "agy".into(),
                harness_path: None,
                version: Some("1.5.1".into()),
            },
            profile: AntigravityProfile::new(profile_dir.path(), "true".into()),
            runtime_temp_directory: None,
            base_env: Some(Default::default()),
        }),
        ..Default::default()
    };
    let mut run = start_with(
        Arc::new(cli),
        RuntimeMode::Auto,
        &low(),
        &[
            ("GOAT_ACP_ANTIGRAVITY", "1"),
            ("GOAT_ACP_INITIAL_MODE", "yolo"),
        ],
        None,
        None,
    )
    .await
    .expect("auto falls back to default on the CLI");
    simple_turn(&mut run, RuntimeMode::Auto).await;
    assert_eq!(
        config_writes(&read_log(&run.log)),
        [("mode".to_owned(), json!("default"))]
    );
    run.handle.session.shutdown().await;

    let harness = start_with(
        Arc::new(Antigravity::default()),
        RuntimeMode::Auto,
        &low(),
        &[("GOAT_ACP_ANTIGRAVITY", "1")],
        None,
        None,
    )
    .await;
    assert_eq!(
        harness.err().unwrap(),
        goat2_engine_api::EngineError::StartFailed(
            "Invalid value \"auto\" for session config option \"mode\": expected one of default, auto_edit, yolo".into()
        )
    );
}

/// v1 AntigravityProtocol.ts:148-195: Antigravity's choices, with the Allow Always security warning;
/// "for this thread" picks `allow_always`.
#[tokio::test]
async fn shell_approval_shows_the_security_warning() {
    let mut run = start(
        &[("GOAT_ACP_ANTIGRAVITY_SECURITY_WARNING", "1")],
        RuntimeMode::ApprovalRequired,
    )
    .await;
    let (events, outcome) = turn(
        &mut run,
        input("go"),
        RuntimeMode::ApprovalRequired,
        &low(),
        |event| match event {
            EngineEvent::RequestOpened {
                key, kind, item, ..
            } => {
                assert_eq!(*kind, RequestKind::Approval);
                let Some(TurnItemBody::ApprovalRequest {
                    options: Some(options),
                    ..
                }) = item.as_ref().map(|i| i.body.clone())
                else {
                    panic!("approval item");
                };
                let labels: Vec<_> = options.iter().map(|o| o.label.as_str()).collect();
                assert_eq!(
                    labels,
                    ["Allow once", "Allow for this thread", "Deny", "Cancel"]
                );
                assert_eq!(
                    options[1].warning.as_deref(),
                    Some("Allows any npm command in this conversation.")
                );
                answered(key, RequestOutcome::AcceptForSession, None)
            }
            _ => None,
        },
    )
    .await;
    assert_eq!(outcome, TurnOutcome::Done);
    assert!(answer_text(&events).contains(r#"shell: {"outcome":"selected","optionId":"always"}"#));
    run.handle.session.shutdown().await;
}

/// v1 AntigravityProtocol.ts:763-790: agy's `update_steps` checklist becomes the turn's plan.
#[tokio::test]
async fn update_steps_become_the_plan() {
    // The prompt stalls after the checklist (no later plan from the shared mock replaces it).
    let mut run = start(
        &[
            ("GOAT_ACP_ANTIGRAVITY_UPDATE_STEPS", "1"),
            ("GOAT_ACP_HANG_PROMPT_FOREVER", "1"),
        ],
        RuntimeMode::FullAccess,
    )
    .await;
    run.handle
        .session
        .start_turn(
            input("go"),
            &TurnSettings {
                model_selection: low(),
                runtime_mode: RuntimeMode::FullAccess,
            },
        )
        .await;
    let turn_id = loop {
        if let EngineEvent::TextDelta { turn_id, .. } = run.handle.events.recv().await.unwrap() {
            break turn_id;
        }
    };
    run.handle.session.interrupt(&turn_id).await.unwrap();
    let mut steps = None;
    let mut tools = Vec::new();
    while let Ok(Some(event)) =
        tokio::time::timeout(Duration::from_secs(10), run.handle.events.recv()).await
    {
        if let EngineEvent::ItemCompleted { item, .. } = &event {
            match &item.body {
                TurnItemBody::TodoList { steps: s, .. } => {
                    steps = Some(s.iter().map(|s| s.text.clone()).collect::<Vec<_>>());
                }
                TurnItemBody::DynamicTool { tool_name, .. } => tools.push(tool_name.clone()),
                _ => {}
            }
        }
        if matches!(event, EngineEvent::TurnFinished { .. }) {
            break;
        }
    }
    assert_eq!(steps.unwrap(), ["Read the code", "Fix it"]);
    // The update_steps call itself is not a tool row.
    assert!(
        !tools.contains(&Some("Run update_steps".to_owned())),
        "{tools:?}"
    );
    run.handle.session.shutdown().await;
}

/// v1 AntigravityClientFiles.ts:78-133 + AntigravityProtocol.ts:418-480: GOAT serves
/// `fs/read_text_file` inside the thread's folder, and the read it served is reported done even
/// though the agent fails the call with an unrelated step error.
#[tokio::test]
async fn served_client_read_completes_its_call() {
    let dir = tempfile::tempdir().unwrap();
    // Placeholder path: the real one is inside the run's folder, created below.
    let mut run = start_with(
        Arc::new(Antigravity::default()),
        RuntimeMode::FullAccess,
        &low(),
        &[
            ("GOAT_ACP_ANTIGRAVITY", "1"),
            (
                "GOAT_ACP_ANTIGRAVITY_CLIENT_READ",
                &dir.path().join("x").to_string_lossy(),
            ),
        ],
        None,
        None,
    )
    .await
    .unwrap();
    // Outside the thread's folder: refused, and the failure stands.
    std::fs::write(dir.path().join("x"), "a\nb").unwrap();
    let (events, _) = simple_turn(&mut run, RuntimeMode::FullAccess).await;
    assert!(
        answer_text(&events).contains("is outside the session workspace"),
        "{}",
        answer_text(&events)
    );
    assert!(
        completed(&events)
            .iter()
            .any(|i| i.status == TurnItemStatus::Failed)
    );
    run.handle.session.shutdown().await;

    // Inside the attachments folder: served.
    let attachments = tempfile::tempdir().unwrap();
    let file = attachments.path().join("notes.txt");
    std::fs::write(&file, "one\ntwo\nthree").unwrap();
    let flavor = Antigravity {
        attachments_dir: Some(attachments.path().to_path_buf()),
        ..Default::default()
    };
    let mut run = start_with(
        Arc::new(flavor),
        RuntimeMode::FullAccess,
        &low(),
        &[
            ("GOAT_ACP_ANTIGRAVITY", "1"),
            ("GOAT_ACP_ANTIGRAVITY_CLIENT_READ", &file.to_string_lossy()),
        ],
        None,
        None,
    )
    .await
    .unwrap();
    let (events, outcome) = simple_turn(&mut run, RuntimeMode::FullAccess).await;
    assert_eq!(outcome, TurnOutcome::Done);
    assert!(
        answer_text(&events).contains(r#"read: {"content":"two"}"#),
        "{}",
        answer_text(&events)
    );
    assert!(
        completed(&events)
            .iter()
            .all(|i| i.status != TurnItemStatus::Failed)
    );
    let init = logged(&read_log(&run.log), "initialize");
    assert_eq!(init[0]["clientCapabilities"]["fs"]["readTextFile"], true);
    assert_eq!(init[0]["clientCapabilities"]["fs"]["writeTextFile"], false);
    run.handle.session.shutdown().await;
}

/// v1 AntigravityProtocol.ts:620-688: agy's `CommandLine` is the command GOAT shows.
#[tokio::test]
async fn command_line_is_the_command() {
    let mut run = start(
        &[("GOAT_ACP_ANTIGRAVITY_COMMAND", "1")],
        RuntimeMode::FullAccess,
    )
    .await;
    let (events, _) = simple_turn(&mut run, RuntimeMode::FullAccess).await;
    assert!(completed(&events).iter().any(|i| matches!(&i.body, TurnItemBody::CommandExecution { input, exit_code: Some(0), .. } if input == "cargo test")), "{:?}", completed(&events));
    run.handle.session.shutdown().await;
}

/// v1 AntigravityAcpSupport.ts:118-145: GOAT's instructions go in `_meta.antigravity.systemPrompt`
/// when the runtime advertises it, not in front of the first prompt.
#[tokio::test]
async fn instructions_ride_in_session_meta() {
    let mut run = start_with(
        Arc::new(Antigravity::default()),
        RuntimeMode::ApprovalRequired,
        &low(),
        &[
            ("GOAT_ACP_ANTIGRAVITY", "1"),
            ("GOAT_ACP_ANTIGRAVITY_APPEND", "1"),
        ],
        Some(Instructions {
            append_system_prompt: Some("You are GOAT.".into()),
            first_message_preamble: None,
        }),
        None,
    )
    .await
    .unwrap();
    simple_turn(&mut run, RuntimeMode::ApprovalRequired).await;
    let log = read_log(&run.log);
    assert_eq!(
        logged(&log, "session/new")[0]["_meta"]["antigravity"]["systemPrompt"]["append"],
        "You are GOAT."
    );
    assert!(
        !logged(&log, "session/prompt")[0]
            .to_string()
            .contains("You are GOAT.")
    );
    run.handle.session.shutdown().await;
}

/// v1 buildAntigravityPrompt (AntigravityAcpSupport.ts:445-597): images inline, text files as
/// embedded resources, PDFs as links, GIF path-only.
#[tokio::test]
async fn attachments_follow_antigravitys_rules() {
    let files = tempfile::tempdir().unwrap();
    let root = files.path().to_path_buf();
    std::fs::write(root.join("a.png"), [1u8, 2, 3]).unwrap();
    std::fs::write(root.join("notes.md"), "# notes").unwrap();
    std::fs::write(root.join("doc.pdf"), b"%PDF-1").unwrap();
    std::fs::write(root.join("a.gif"), b"GIF8").unwrap();
    let resolver: goat2_engine_acp::AttachmentResolver =
        Arc::new(move |_, a: &ChatAttachment| Some(root.join(&a.name)));
    let mut run = start_with(
        Arc::new(Antigravity::default()),
        RuntimeMode::ApprovalRequired,
        &low(),
        &[("GOAT_ACP_ANTIGRAVITY", "1")],
        None,
        Some(resolver),
    )
    .await
    .unwrap();
    let attachment = |kind, name: &str, mime: &str| ChatAttachment {
        kind,
        id: name.into(),
        name: name.into(),
        mime_type: mime.into(),
        size_bytes: 1,
        blob: None,
    };
    let inputs = vec![EngineInput {
        input_id: "i".into(),
        text: "look".into(),
        attachments: vec![
            attachment(ChatAttachmentType::Image, "a.png", "image/png"),
            attachment(ChatAttachmentType::File, "notes.md", "text/markdown"),
            attachment(ChatAttachmentType::File, "doc.pdf", "application/pdf"),
            attachment(ChatAttachmentType::Image, "a.gif", "image/gif"),
        ],
    }];
    let (_, outcome) = turn(
        &mut run,
        inputs,
        RuntimeMode::ApprovalRequired,
        &low(),
        |_| None,
    )
    .await;
    assert_eq!(outcome, TurnOutcome::Done);
    let prompt = &logged(&read_log(&run.log), "session/prompt")[0]["prompt"];
    let kinds: Vec<&str> = prompt
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b["type"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["text", "image", "resource", "resource_link"]);
    assert_eq!(prompt[2]["resource"]["text"], "# notes");
    assert!(prompt[0]["text"].as_str().unwrap().contains("a.gif"));
    run.handle.session.shutdown().await;
}
