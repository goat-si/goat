//! Pi RPC integration tests. The fake binary uses only local stdio and dummy credentials.
use goat2_contracts::{
    EngineConfig, EngineDriver, EngineRef, InputId, ModelSelection, ProviderInstanceId,
    ProviderOptionSelection, ProviderOptionSelectionValue, RequestKind, RequestOutcome, RuntimeMode, ThreadId, TurnItemBody,
};
use goat2_engine_api::{
    EngineEvent, EngineFactory, EngineHandle, EngineInput, LaunchSpec, McpEndpoint, RequestAnswer,
    SessionSpec, SteerResult, TurnOutcome, TurnSettings, TurnStartResult,
};
use goat2_engine_sdk::pi::{PiFactory, PiProfile};
use std::time::Duration;

fn model() -> ModelSelection {
    ModelSelection {
        instance_id: ProviderInstanceId::from("pi"),
        model: "fake/fake-model".into(),
        options: None,
    }
}
fn factory(profile: PiProfile) -> PiFactory {
    PiFactory::new(profile)
        .with_cache_dir(std::env::temp_dir().join(format!("goat2-pi-fake-{}", std::process::id())))
}
fn settings() -> TurnSettings {
    TurnSettings {
        model_selection: model(),
        runtime_mode: RuntimeMode::FullAccess,
    }
}
fn spec(id: &str) -> SessionSpec {
    SessionSpec {
        thread_id: ThreadId::from(id),
        engine: EngineConfig {
            provider_instance_id: ProviderInstanceId::from("pi"),
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
        launch: Some(LaunchSpec {
            binary: Some(env!("CARGO_BIN_EXE_goat2-fake-pi").into()),
            args: vec![],
            env: Default::default(),
        }),
    }
}
fn input(text: &str) -> Vec<EngineInput> {
    vec![EngineInput {
        input_id: InputId::from("input"),
        text: text.into(),
        attachments: vec![],
    }]
}
async fn start(id: &str) -> EngineHandle {
    factory(PiProfile::Pi)
        .start(spec(id))
        .await
        .expect("fake starts")
}
async fn next(h: &mut EngineHandle) -> EngineEvent {
    tokio::time::timeout(Duration::from_secs(5), h.events.recv())
        .await
        .expect("event timeout")
        .expect("event stream closed")
}
async fn finished(h: &mut EngineHandle) -> Vec<EngineEvent> {
    let mut events = vec![];
    loop {
        let event = next(h).await;
        let done = matches!(
            event,
            EngineEvent::TurnFinished { .. } | EngineEvent::Exited { .. }
        );
        events.push(event);
        if done {
            return events;
        }
    }
}
fn accepted(result: TurnStartResult) -> String {
    match result {
        TurnStartResult::Accepted { turn_id } => turn_id,
        other => panic!("turn not accepted: {other:?}"),
    }
}
fn text(events: &[EngineEvent]) -> String {
    events
        .iter()
        .find_map(|event| match event {
            EngineEvent::ItemCompleted { item, .. } => match &item.body {
                TurnItemBody::AssistantMessage { text, .. } => Some(text.clone()),
                _ => None,
            },
            _ => None,
        })
        .expect("assistant item")
}

#[tokio::test]
async fn plain_turn_streams_and_finishes() {
    let mut h = start("pi-plain").await;
    accepted(h.session.start_turn(input("hello"), &settings()).await);
    let events = finished(&mut h).await;
    assert_eq!(text(&events), "echo: hello");
    assert!(
        events
            .iter()
            .any(|e| matches!(e, EngineEvent::TextDelta { text, .. } if text == "echo: hello"))
    );
    assert!(matches!(
        events.last(),
        Some(EngineEvent::TurnFinished {
            outcome: TurnOutcome::Done,
            ..
        })
    ));
    h.session.shutdown().await;
}

#[tokio::test]
async fn tool_call_is_completed() {
    let mut h = start("pi-tool").await;
    accepted(h.session.start_turn(input("tool"), &settings()).await);
    let events = finished(&mut h).await;
    assert!(events.iter().any(|e| matches!(e, EngineEvent::ItemCompleted { item, .. } if matches!(item.body, TurnItemBody::DynamicTool { .. }))));
    assert_eq!(text(&events), "tool complete");
    h.session.shutdown().await;
}

async fn dialog(prompt: &str, expected: RequestKind, answer: RequestAnswer, result: &str) {
    let mut h = start(prompt).await;
    accepted(h.session.start_turn(input(prompt), &settings()).await);
    let key = loop {
        if let EngineEvent::RequestOpened { key, kind, .. } = next(&mut h).await {
            assert_eq!(kind, expected);
            break key;
        }
    };
    h.session
        .answer_request(&key, answer)
        .await
        .expect("answer");
    assert_eq!(text(&finished(&mut h).await), result);
    h.session.shutdown().await;
}
#[tokio::test]
async fn question_and_approval_round_trip() {
    dialog(
        "question",
        RequestKind::Question,
        RequestAnswer {
            outcome: RequestOutcome::Answered,
            text: Some("blue".into()),
            answers: None,
        },
        "answer: blue",
    )
    .await;
    dialog(
        "approval",
        RequestKind::Approval,
        RequestAnswer {
            outcome: RequestOutcome::Accept,
            text: None,
            answers: None,
        },
        "answer: true",
    )
    .await;
}

#[tokio::test]
async fn steer_and_abort() {
    let mut h = start("pi-abort").await;
    let turn = accepted(h.session.start_turn(input("hang"), &settings()).await);
    assert_eq!(
        h.session.steer(&turn, input("more")).await,
        SteerResult::Accepted
    );
    assert!(matches!(
        h.session.steer("wrong", input("other")).await,
        SteerResult::Declined { .. }
    ));
    h.session.interrupt(&turn).await.expect("abort");
    assert!(matches!(
        finished(&mut h).await.last(),
        Some(EngineEvent::TurnFinished {
            outcome: TurnOutcome::Interrupted,
            ..
        })
    ));
    h.session.shutdown().await;
}

#[tokio::test]
async fn resume_uses_persisted_session_path() {
    let mut s = spec("pi-resume");
    s.resume = Some(EngineRef {
        driver: EngineDriver::Pi,
        id: "/tmp/fake-resume.jsonl".into(),
    });
    let mut h = factory(PiProfile::Pi).start(s).await.expect("resume");
    assert_eq!(h.engine_ref.id, "/tmp/fake-resume.jsonl");
    accepted(h.session.start_turn(input("hello"), &settings()).await);
    assert_eq!(text(&finished(&mut h).await), "echo: hello");
    h.session.shutdown().await;
}

#[tokio::test]
async fn reserved_args_rejected_and_mcp_extension_materialized() {
    for arg in ["--mode", "--session=bad", "--no-session"] {
        let mut s = spec("pi-reserved");
        s.launch.as_mut().unwrap().args.push(arg.into());
        assert!(
            factory(PiProfile::Pi).start(s).await.is_err(),
            "accepted {arg}"
        );
    }
    let mut h = start("pi-mcp").await;
    accepted(
        h.session
            .start_turn(input("inspect-launch"), &settings())
            .await,
    );
    assert_eq!(text(&finished(&mut h).await), "launch-ok");
    h.session.shutdown().await;
}

#[tokio::test]
async fn crash_is_isolated() {
    let mut dead = start("pi-crash").await;
    let mut live = start("pi-live").await;
    let _ = dead.session.start_turn(input("crash"), &settings()).await;
    assert!(matches!(
        finished(&mut dead).await.last(),
        Some(EngineEvent::Exited { .. })
    ));
    accepted(live.session.start_turn(input("alive"), &settings()).await);
    assert_eq!(text(&finished(&mut live).await), "echo: alive");
    dead.session.shutdown().await;
    live.session.shutdown().await;
}

#[test]
fn fake_version_probe() {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_goat2-fake-pi"))
        .arg("--version")
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        "0.0.0-fake"
    );
}

#[tokio::test]
async fn omo_profile_supplies_its_rpc_environment() {
    let mut h = factory(PiProfile::Omo)
        .start(spec("omo-env"))
        .await
        .expect("omo starts");
    accepted(
        h.session
            .start_turn(input("inspect-omo"), &settings())
            .await,
    );
    assert_eq!(text(&finished(&mut h).await), "omo-ok");
    h.session.shutdown().await;
}

#[tokio::test]
async fn factory_probe_uses_fake_binary() {
    let factory = PiFactory::new(PiProfile::Pi).with_binary(env!("CARGO_BIN_EXE_goat2-fake-pi"));
    let probe = factory.probe().await.expect("probe");
    assert!(probe.installed);
    assert_eq!(probe.version.as_deref(), Some("0.0.0-fake"));
    assert!(!probe.models.is_empty());
}

#[tokio::test]
async fn model_and_thinking_selection_reach_the_runtime() {
    let mut h = start("pi-config").await;
    let mut selected = settings();
    selected.model_selection.model = "vendor/custom/model".into();
    selected.model_selection.options = Some(vec![ProviderOptionSelection { id: "thinking".into(), value: ProviderOptionSelectionValue::Text("high".into()) }]);
    h.session.set_config(&selected).await.expect("configure");
    accepted(h.session.start_turn(input("inspect-config"), &selected).await);
    assert_eq!(text(&finished(&mut h).await), "vendor/custom/model:high");
    h.session.shutdown().await;
}
