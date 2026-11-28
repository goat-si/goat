//! The helper driver against the scripted fake engine (apps/engine-helper/src/engines/fake.ts).
//! Needs `node` (>= 22.18) on PATH; no SDK, login or network.

use std::path::PathBuf;
use std::time::Duration;

use goat2_contracts::{
    EngineConfig, EngineDriver, InputId, ModelSelection, ProviderInstanceId, RequestKind,
    RequestOutcome, RuntimeMode, ThreadId, TurnItemBody,
};
use goat2_engine_api::{
    EngineError, EngineEvent, EngineFactory, EngineHandle, EngineInput, McpEndpoint, RequestAnswer,
    SessionSpec, SteerResult, SteerStatus, TurnOutcome, TurnSettings, TurnStartResult,
};
use goat2_engine_sdk::{HelperFactory, HelperLaunch};

fn entry() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/engine-helper/src/main.ts")
}

fn launch() -> HelperLaunch {
    HelperLaunch::new("node", entry())
}

fn model() -> ModelSelection {
    ModelSelection {
        instance_id: ProviderInstanceId::from("cursor"),
        model: "fake-model".into(),
        options: None,
    }
}

fn spec(thread: &str) -> SessionSpec {
    SessionSpec {
        thread_id: ThreadId::from(thread),
        engine: EngineConfig {
            provider_instance_id: ProviderInstanceId::from("cursor"),
            model_selection: model(),
            runtime_mode: RuntimeMode::FullAccess,
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
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

fn settings() -> TurnSettings {
    TurnSettings {
        model_selection: model(),
        runtime_mode: RuntimeMode::FullAccess,
    }
}

fn input(text: &str) -> Vec<EngineInput> {
    vec![EngineInput {
        input_id: InputId::from(format!("in-{text}")),
        text: text.into(),
        attachments: Vec::new(),
    }]
}

async fn start(thread: &str) -> EngineHandle {
    HelperFactory::fake(EngineDriver::Cursor, launch())
        .start(spec(thread))
        .await
        .expect("fake engine starts")
}

async fn next(handle: &mut EngineHandle) -> EngineEvent {
    tokio::time::timeout(Duration::from_secs(10), handle.events.recv())
        .await
        .expect("event within 10s")
        .expect("event stream open")
}

/// Events up to and including the turn's end (or the process's).
async fn until_finished(handle: &mut EngineHandle) -> Vec<EngineEvent> {
    let mut seen = Vec::new();
    loop {
        let event = next(handle).await;
        let last = matches!(
            event,
            EngineEvent::TurnFinished { .. } | EngineEvent::Exited { .. }
        );
        seen.push(event);
        if last {
            return seen;
        }
    }
}

fn accepted(result: TurnStartResult) -> String {
    match result {
        TurnStartResult::Accepted { turn_id } => turn_id,
        other => panic!("turn not accepted: {other:?}"),
    }
}

fn final_text(events: &[EngineEvent]) -> String {
    events
        .iter()
        .find_map(|event| match event {
            EngineEvent::ItemCompleted { item, .. } => match &item.body {
                TurnItemBody::AssistantMessage { text, .. } => Some(text.clone()),
                _ => None,
            },
            _ => None,
        })
        .expect("an assistant message")
}

#[tokio::test]
async fn echo_turn_streams_completes_and_fills_item_fields() {
    let mut handle = start("thread-echo").await;
    assert_eq!(handle.engine_ref.id, "fake-thread-echo");
    assert_eq!(handle.engine_ref.driver, EngineDriver::Cursor);
    let turn = accepted(handle.session.start_turn(input("hello"), &settings()).await);
    let events = until_finished(&mut handle).await;
    let deltas: String = events
        .iter()
        .filter_map(|event| match event {
            EngineEvent::TextDelta { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(deltas, "echo: hello");
    let item = events
        .iter()
        .find_map(|event| match event {
            EngineEvent::ItemCompleted { item, locator, .. } => {
                Some((item.clone(), locator.clone()))
            }
            _ => None,
        })
        .expect("item");
    assert_eq!(item.0.thread_id, ThreadId::from("thread-echo"));
    assert_eq!(
        item.0.provider_thread_id.as_deref(),
        Some("fake-thread-echo")
    );
    assert_eq!(item.0.ordinal, 0);
    assert_eq!(item.1.expect("locator").turn_id, turn);
    assert_eq!(final_text(&events), "echo: hello");
    // token_usage reaches the host as EngineEvent::TokenUsage for the turn.
    let usage = events
        .iter()
        .find_map(|event| match event {
            EngineEvent::TokenUsage { turn_id, usage } => Some((turn_id.clone(), usage.clone())),
            _ => None,
        })
        .expect("token usage");
    assert_eq!(usage.0.as_deref(), Some(turn.as_str()));
    assert_eq!(usage.1.used_tokens, "echo: hello".len() as u64);
    assert_eq!(usage.1.input_tokens, Some("hello".len() as u64));
    assert!(matches!(
        events.last(),
        Some(EngineEvent::TurnFinished {
            outcome: TurnOutcome::Done,
            ..
        })
    ));
    assert!(handle.session.process_group_id().is_some());
    assert!(handle.session.group_rss_bytes().unwrap_or(0) > 0);
    handle.session.shutdown().await;
}

#[tokio::test]
async fn question_round_trip() {
    let mut handle = start("thread-ask").await;
    accepted(handle.session.start_turn(input("ask"), &settings()).await);
    let key = match next(&mut handle).await {
        EngineEvent::RequestOpened {
            key, kind, item, ..
        } => {
            assert_eq!(kind, RequestKind::Question);
            assert!(matches!(
                item.as_deref().map(|item| &item.body),
                Some(TurnItemBody::UserInputRequest { .. })
            ));
            key
        }
        other => panic!("expected a request, got {other:?}"),
    };
    handle
        .session
        .answer_request(
            &key,
            RequestAnswer {
                outcome: RequestOutcome::Answered,
                text: Some("blue".into()),
                answers: None,
            },
        )
        .await
        .expect("answer delivered");
    let events = until_finished(&mut handle).await;
    assert_eq!(final_text(&events), "answer: blue");
    handle.session.shutdown().await;
}

#[tokio::test]
async fn steer_then_interrupt() {
    let mut handle = start("thread-hang").await;
    let turn = accepted(handle.session.start_turn(input("hang"), &settings()).await);
    assert!(matches!(
        handle
            .session
            .start_turn(input("second"), &settings())
            .await,
        TurnStartResult::Declined { .. }
    ));
    assert_eq!(
        handle.session.steer(&turn, input("more")).await,
        SteerResult::Accepted
    );
    assert!(matches!(
        handle.session.steer("turn-nope", input("x")).await,
        SteerResult::Declined { .. }
    ));
    handle.session.interrupt(&turn).await.expect("interrupt");
    let events = until_finished(&mut handle).await;
    assert!(matches!(
        events.last(),
        Some(EngineEvent::TurnFinished {
            outcome: TurnOutcome::Interrupted,
            ..
        })
    ));
    handle.session.shutdown().await;
}

/// `set_config` reaches an engine that can switch in session and applies to the next turn; an
/// engine without the switch answers `EngineError::Unsupported` instead of a transport error.
#[tokio::test]
async fn set_config_applies_or_reports_unsupported() {
    let mut handle = start("thread-config").await;
    let switched = TurnSettings {
        model_selection: ModelSelection {
            model: "other-model".into(),
            ..model()
        },
        runtime_mode: RuntimeMode::ApprovalRequired,
    };
    handle
        .session
        .set_config(&switched)
        .await
        .expect("set_config accepted");
    accepted(handle.session.start_turn(input("hi"), &switched).await);
    let events = until_finished(&mut handle).await;
    let text = final_text(&events);
    assert!(
        text.starts_with("echo: hi [model: other-model, mode: "),
        "{text}"
    );
    handle.session.shutdown().await;

    let mut fixed = spec("thread-config-fixed");
    fixed.launch = Some(goat2_engine_api::LaunchSpec {
        binary: None,
        args: Vec::new(),
        env: [("GOAT2_FAKE_NO_SET_CONFIG".to_string(), "1".to_string())].into(),
    });
    let handle = HelperFactory::fake(EngineDriver::Cursor, launch())
        .start(fixed)
        .await
        .expect("fake engine starts");
    match handle.session.set_config(&settings()).await {
        Err(EngineError::Unsupported(message)) => assert!(message.contains("cannot change")),
        other => panic!("expected Unsupported, got {other:?}"),
    }
    handle.session.shutdown().await;
}

/// A steer the engine read into a finished turn is reported Completed; a steer still unread when
/// the turn is interrupted is reported Cancelled. Both carry the steer's input ids.
#[tokio::test]
async fn steer_settlement_is_reported_with_input_ids() {
    let steer_updates = |events: &[EngineEvent]| -> Vec<(Vec<InputId>, SteerStatus)> {
        events
            .iter()
            .filter_map(|event| match event {
                EngineEvent::SteerUpdated {
                    input_ids, status, ..
                } => Some((input_ids.clone(), status.clone())),
                _ => None,
            })
            .collect()
    };

    // "ask" waits for an answer, so the steer lands before the turn can finish.
    let mut handle = start("thread-steer-read").await;
    let turn = accepted(handle.session.start_turn(input("ask"), &settings()).await);
    let key = loop {
        if let EngineEvent::RequestOpened { key, .. } = next(&mut handle).await {
            break key;
        }
    };
    assert_eq!(
        handle.session.steer(&turn, input("also this")).await,
        SteerResult::Accepted
    );
    handle
        .session
        .answer_request(
            &key,
            RequestAnswer {
                outcome: RequestOutcome::Answered,
                text: Some("blue".into()),
                answers: None,
            },
        )
        .await
        .expect("answer delivered");
    let events = until_finished(&mut handle).await;
    assert_eq!(
        steer_updates(&events),
        vec![(vec![InputId::from("in-also this")], SteerStatus::Completed)]
    );
    handle.session.shutdown().await;

    // "hang" ends only by interrupt, so the steer is never read.
    let mut handle = start("thread-steer-cancelled").await;
    let turn = accepted(handle.session.start_turn(input("hang"), &settings()).await);
    assert_eq!(
        handle.session.steer(&turn, input("too late")).await,
        SteerResult::Accepted
    );
    handle.session.interrupt(&turn).await.expect("interrupt");
    let events = until_finished(&mut handle).await;
    match steer_updates(&events).as_slice() {
        [(ids, SteerStatus::Cancelled { reason })] => {
            assert_eq!(ids, &vec![InputId::from("in-too late")]);
            assert!(reason.contains("interrupted"), "{reason}");
        }
        other => panic!("expected one cancelled steer update, got {other:?}"),
    }
    handle.session.shutdown().await;
}

#[tokio::test]
async fn start_failure_and_missing_engine_map_to_engine_errors() {
    let mut failing = spec("thread-fail");
    failing.launch = Some(goat2_engine_api::LaunchSpec {
        binary: None,
        args: Vec::new(),
        env: [("GOAT2_FAKE_START_FAIL".to_string(), "1".to_string())].into(),
    });
    let error = HelperFactory::fake(EngineDriver::Cursor, launch())
        .start(failing)
        .await
        .expect_err("start fails");
    assert_eq!(error, EngineError::StartFailed("fake start failure".into()));

    let missing_node = HelperFactory::fake(
        EngineDriver::Cursor,
        HelperLaunch::new("/nonexistent/node", entry()),
    )
    .start(spec("thread-node"))
    .await
    .expect_err("no node");
    assert!(
        matches!(missing_node, EngineError::Unavailable(_)),
        "{missing_node:?}"
    );

    let bad_entry = HelperFactory::fake(
        EngineDriver::Cursor,
        HelperLaunch::new("node", "/nonexistent/main.ts"),
    )
    .start(spec("thread-entry"))
    .await
    .expect_err("bad entry");
    assert!(
        matches!(bad_entry, EngineError::StartFailed(_)),
        "{bad_entry:?}"
    );
}

/// One helper crashing mid-turn ends only its own thread: the other session keeps working and
/// the crashed one's process group is gone.
#[tokio::test]
async fn one_crash_does_not_take_down_another_session() {
    let mut crashing = start("thread-crash").await;
    let mut healthy = start("thread-healthy").await;
    let crashed_group = crashing.session.process_group_id().expect("pgid");

    let healthy_turn = accepted(healthy.session.start_turn(input("hang"), &settings()).await);
    accepted(
        crashing
            .session
            .start_turn(input("crash"), &settings())
            .await,
    );
    let events = until_finished(&mut crashing).await;
    assert!(
        matches!(events.last(), Some(EngineEvent::Exited { .. })),
        "{events:?}"
    );
    assert!(matches!(
        crashing
            .session
            .start_turn(input("again"), &settings())
            .await,
        TurnStartResult::Unknown { .. }
    ));

    // The healthy session's running turn and its process are untouched.
    assert_eq!(
        healthy
            .session
            .steer(&healthy_turn, input("still here"))
            .await,
        SteerResult::Accepted
    );
    healthy
        .session
        .interrupt(&healthy_turn)
        .await
        .expect("interrupt");
    until_finished(&mut healthy).await;
    accepted(
        healthy
            .session
            .start_turn(input("after"), &settings())
            .await,
    );
    assert_eq!(
        final_text(&until_finished(&mut healthy).await),
        "echo: after"
    );

    crashing.session.shutdown().await;
    healthy.session.shutdown().await;
    assert!(!group_alive(crashed_group));
}

#[tokio::test]
async fn shutdown_ends_the_process_group() {
    let mut handle = start("thread-stop").await;
    let group = handle.session.process_group_id().expect("pgid");
    accepted(handle.session.start_turn(input("hang"), &settings()).await);
    handle.session.shutdown().await;
    assert!(!group_alive(group));
    // The stream ends with Exited and nothing after it.
    let mut last = None;
    while let Ok(Some(event)) =
        tokio::time::timeout(Duration::from_secs(5), handle.events.recv()).await
    {
        last = Some(event);
    }
    assert!(matches!(last, Some(EngineEvent::Exited { .. })), "{last:?}");
}

fn group_alive(pgid: i32) -> bool {
    std::process::Command::new("/bin/ps")
        .args(["-A", "-o", "pgid="])
        .output()
        .map(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .any(|line| line.trim().parse::<i32>().ok() == Some(pgid))
        })
        .unwrap_or(false)
}

#[tokio::test]
async fn probe_answers_from_a_short_lived_helper() {
    let factory = HelperFactory::fake(EngineDriver::Cursor, launch());
    let probe = factory.probe().await.expect("probe");
    assert!(probe.installed);
    assert_eq!(probe.version.as_deref(), Some("0.0.0-fake"));
    assert_eq!(probe.models.len(), 1);
    assert!(factory.capabilities().turns.supports_active_steering);
}

/// Reasoning streams as ContentDelta (reasoning_text) on its own item id, then completes under that
/// same id; assistant text still arrives as TextDelta.
#[tokio::test]
async fn reasoning_streams_as_content_delta_on_its_item() {
    let mut handle = start("thread-think").await;
    accepted(handle.session.start_turn(input("think"), &settings()).await);
    let events = until_finished(&mut handle).await;
    let reasoning: Vec<(String, String)> = events
        .iter()
        .filter_map(|event| match event {
            EngineEvent::ContentDelta {
                item_id,
                stream_kind: goat2_contracts::ContentStreamKind::ReasoningText,
                text,
                ..
            } => Some((item_id.to_string(), text.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(reasoning.len(), 2);
    let reasoning_id = reasoning[0].0.clone();
    assert!(reasoning.iter().all(|(id, _)| *id == reasoning_id));
    assert_eq!(
        reasoning
            .iter()
            .map(|(_, t)| t.as_str())
            .collect::<String>(),
        "weighing options"
    );
    let completed = events.iter().position(|event| {
        matches!(event, EngineEvent::ItemCompleted { item, .. }
            if item.id.to_string() == reasoning_id
                && matches!(item.body, TurnItemBody::Reasoning { .. }))
    });
    let last_delta = events
        .iter()
        .rposition(|event| matches!(event, EngineEvent::ContentDelta { .. }))
        .expect("delta");
    assert!(completed.expect("reasoning item completed") > last_delta);
    assert_eq!(final_text(&events), "echo: think");
    handle.session.shutdown().await;
}

/// Capabilities reported with a probe replace the static ones until the next probe; a probe
/// without them goes back to the static set.
#[tokio::test]
async fn probe_reported_capabilities_replace_the_static_ones() {
    let fixed = goat2_engine_sdk::capabilities::for_driver(&EngineDriver::Cursor).expect("cursor");
    let selected = goat2_engine_sdk::capabilities::for_driver(&EngineDriver::Muse).expect("muse");
    assert_ne!(fixed, selected);
    let reporting = HelperFactory::fake(
        EngineDriver::Cursor,
        launch().with_env(
            "GOAT2_FAKE_PROBE_CAPABILITIES",
            serde_json::to_string(&selected).expect("json"),
        ),
    );
    assert_eq!(reporting.capabilities(), fixed);
    reporting.probe().await.expect("probe");
    assert_eq!(reporting.capabilities(), selected);

    let plain = HelperFactory::fake(EngineDriver::Cursor, launch());
    plain.probe().await.expect("probe");
    assert_eq!(plain.capabilities(), fixed);
}

/// A probe that answers status error (v1 OpenCode: version, server or catalog failure) keeps the
/// capabilities of the last successful probe instead of falling back to the static set.
#[tokio::test]
async fn failed_probe_keeps_the_last_successful_capabilities() {
    let fixed = goat2_engine_sdk::capabilities::for_driver(&EngineDriver::Cursor).expect("cursor");
    let selected = goat2_engine_sdk::capabilities::for_driver(&EngineDriver::Muse).expect("muse");
    let script = std::env::temp_dir().join(format!("goat2-fake-probe-{}.json", std::process::id()));
    let factory = HelperFactory::fake(
        EngineDriver::Cursor,
        launch().with_env("GOAT2_FAKE_PROBE_FILE", &script),
    );
    std::fs::write(
        &script,
        serde_json::json!({"status": "ready", "capabilities": selected}).to_string(),
    )
    .expect("write script");
    factory.probe().await.expect("probe");
    assert_eq!(factory.capabilities(), selected);

    std::fs::write(&script, r#"{"status":"error"}"#).expect("write script");
    let failed = factory.probe().await.expect("probe answers");
    assert_eq!(failed.status, goat2_contracts::ServerProviderState::Error);
    assert_eq!(
        factory.capabilities(),
        selected,
        "error probe keeps the selected set"
    );

    std::fs::write(&script, r#"{"status":"ready"}"#).expect("write script");
    factory.probe().await.expect("probe");
    assert_eq!(
        factory.capabilities(),
        fixed,
        "a successful probe without capabilities resets"
    );
    let _ = std::fs::remove_file(&script);
}

#[tokio::test]
async fn attachments_reach_the_helper_with_resolved_paths() {
    use goat2_contracts::{ChatAttachment, ChatAttachmentType};
    use std::sync::Arc;
    let factory = HelperFactory::fake(EngineDriver::Cursor, launch()).with_attachment_resolver(
        Arc::new(|thread: &ThreadId, attachment: &ChatAttachment| {
            (attachment.id == "a1")
                .then(|| PathBuf::from(format!("/data/{}/{}", thread, attachment.name)))
        }),
    );
    let mut handle = factory.start(spec("thread-files")).await.expect("start");
    let attachment = |id: &str| ChatAttachment {
        kind: ChatAttachmentType::File,
        id: id.into(),
        name: format!("{id}.txt"),
        mime_type: "text/plain".into(),
        size_bytes: 1,
        blob: None,
    };
    let inputs = vec![EngineInput {
        input_id: InputId::from("in-files"),
        text: "see".into(),
        attachments: vec![attachment("a1"), attachment("a2")],
    }];
    accepted(handle.session.start_turn(inputs, &settings()).await);
    assert_eq!(
        final_text(&until_finished(&mut handle).await),
        "echo: see [files: /data/thread-files/a1.txt, missing]"
    );
    handle.session.shutdown().await;
}
