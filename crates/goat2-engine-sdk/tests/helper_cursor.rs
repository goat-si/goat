//! Cursor SDK helper against the offline SDK double; no Cursor login or network.
use std::path::PathBuf;
use std::time::Duration;

use goat2_contracts::{
    EngineConfig, EngineDriver, InputId, ModelSelection, PlanStepStatus, ProviderInstanceId,
    RuntimeMode, SubagentOrigin, ThreadId, TurnItemBody, TurnItemStatus,
};
use goat2_engine_api::{
    EngineEvent, EngineFactory, EngineInput, McpEndpoint, SessionSpec, TurnOutcome, TurnSettings,
    TurnStartResult,
};
use goat2_engine_sdk::{HelperFactory, HelperLaunch};

fn setup(thread: &str) -> (HelperFactory, SessionSpec, TurnSettings) {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    // Resolve the real Node executable before isolating HOME: a version-manager shim may
    // otherwise try to install Node into the disposable test home.
    let node = std::process::Command::new("node")
        .args(["-p", "process.execPath"])
        .output()
        .expect("resolve node");
    assert!(node.status.success(), "node executable must resolve");
    let node = String::from_utf8(node.stdout).expect("node path");
    let node_dir = std::path::Path::new(node.trim())
        .parent()
        .expect("node directory");
    let mut paths = vec![node_dir.to_path_buf()];
    paths.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    let path = std::env::join_paths(paths).expect("test PATH");
    let launch = HelperLaunch::new("node", root.join("apps/engine-helper/src/main.ts"))
        .with_env("PATH", path)
        .with_env(
            "GOAT2_ENGINE_HELPER_SDK_CURSOR",
            root.join("apps/engine-helper/test/fakes/cursor-sdk.ts"),
        )
        .with_env("HOME", "/nonexistent")
        .with_env("CURSOR_API_KEY", "fake-key");
    let factory = HelperFactory::new(EngineDriver::Cursor, launch).expect("cursor factory");
    let model = ModelSelection {
        instance_id: ProviderInstanceId::from("cursor"),
        model: "auto".into(),
        options: None,
    };
    let spec = SessionSpec {
        thread_id: ThreadId::from(thread),
        engine: EngineConfig {
            provider_instance_id: ProviderInstanceId::from("cursor"),
            model_selection: model.clone(),
            runtime_mode: RuntimeMode::FullAccess,
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
        },
        resume: None,
        mcp: McpEndpoint {
            url: "http://127.0.0.1:9/mcp".into(),
            bearer_token: "fake-mcp".into(),
        },
        host_generation: 1,
        process_generation: 1,
        instructions: None,
        launch: None,
    };
    let settings = TurnSettings {
        model_selection: model,
        runtime_mode: RuntimeMode::FullAccess,
    };
    (factory, spec, settings)
}

fn input(text: &str) -> Vec<EngineInput> {
    vec![EngineInput {
        input_id: InputId::from("input"),
        text: text.into(),
        attachments: Vec::new(),
    }]
}

#[tokio::test]
async fn cursor_helper_turn_validates_items() {
    let (factory, spec, settings) = setup("cursor-thread");
    let mut handle = factory.start(spec).await.expect("helper starts");
    assert_eq!(handle.engine_ref.id, "cursor-new");
    assert!(matches!(
        handle.session.start_turn(input("hello"), &settings).await,
        TurnStartResult::Accepted { .. }
    ));
    let (mut message, mut tool, mut done) = (false, false, false);
    while !done {
        let event = tokio::time::timeout(Duration::from_secs(10), handle.events.recv())
            .await
            .expect("event timeout")
            .expect("event stream");
        match event {
            EngineEvent::ItemCompleted { item, .. } => match &item.body {
                TurnItemBody::AssistantMessage { text, .. } => {
                    assert_eq!(text, "hello world");
                    message = true;
                }
                TurnItemBody::DynamicTool { tool_name, .. } => {
                    assert_eq!(tool_name.as_deref(), Some("mcp__goat__goat_describe"));
                    tool = true;
                }
                _ => {}
            },
            EngineEvent::TurnFinished {
                outcome: TurnOutcome::Done,
                ..
            } => done = true,
            EngineEvent::Exited { reason } => panic!("helper exited: {reason}"),
            _ => {}
        }
    }
    assert!(message && tool, "both validated items must reach Rust");
    handle.session.shutdown().await;
}

#[tokio::test]
async fn cursor_projects_validated_items_and_subagent_lifecycle() {
    let (factory, spec, settings) = setup("cursor-projects");
    let mut handle = factory.start(spec).await.expect("helper starts");
    assert!(matches!(
        handle
            .session
            .start_turn(input("projects"), &settings)
            .await,
        TurnStartResult::Accepted { .. }
    ));
    let (mut command, mut edit, mut todos, mut subagent, mut message) =
        (false, false, false, false, false);
    let mut lifecycle = Vec::new();
    loop {
        let event = tokio::time::timeout(Duration::from_secs(10), handle.events.recv())
            .await
            .expect("event timeout")
            .expect("event stream");
        match event {
            EngineEvent::SubagentUpdate {
                subagent_id,
                status,
                title,
                ..
            } => {
                assert_eq!(subagent_id, "task");
                assert_eq!(title.as_deref(), Some("research"));
                lifecycle.push(status);
            }
            EngineEvent::ItemCompleted { item, .. } => match &item.body {
                TurnItemBody::AssistantMessage { text, .. } => {
                    assert_eq!(text, "hello world");
                    message = true;
                }
                TurnItemBody::CommandExecution {
                    input,
                    output,
                    exit_code,
                    ..
                } => {
                    assert_eq!(input, "ls");
                    assert_eq!(output.as_deref(), Some("file"));
                    assert_eq!(*exit_code, Some(0));
                    command = true;
                }
                TurnItemBody::FileChange {
                    file_name,
                    diff_str,
                    additions,
                    deletions,
                    ..
                } => {
                    assert_eq!(file_name, "a.ts");
                    assert_eq!(diff_str.as_deref(), Some("+x"));
                    assert_eq!(*additions, Some(1));
                    assert_eq!(*deletions, Some(0));
                    edit = true;
                }
                TurnItemBody::TodoList { steps, .. } => {
                    assert_eq!(steps.len(), 1);
                    assert_eq!(steps[0].text, "work");
                    assert_eq!(steps[0].status, PlanStepStatus::Completed);
                    todos = true;
                }
                TurnItemBody::Subagent {
                    subagent_id,
                    origin,
                    driver,
                    prompt,
                    result,
                    ..
                } => {
                    assert_eq!(subagent_id, "task");
                    assert_eq!(*origin, SubagentOrigin::ProviderNative);
                    assert_eq!(driver, "cursor");
                    assert_eq!(prompt, "inspect");
                    assert_eq!(result.as_deref(), Some("done"));
                    subagent = true;
                }
                _ => {}
            },
            EngineEvent::TurnFinished { outcome, .. } => {
                assert!(matches!(outcome, TurnOutcome::Done), "{outcome:?}");
                break;
            }
            EngineEvent::Exited { reason } => panic!("helper exited: {reason}"),
            _ => {}
        }
    }
    assert!(
        command && edit && todos && subagent && message,
        "all projected items must reach Rust"
    );
    assert_eq!(
        lifecycle,
        vec![TurnItemStatus::Running, TurnItemStatus::Completed]
    );
    handle.session.shutdown().await;
}

#[tokio::test]
async fn cursor_crash_is_isolated_from_another_session() {
    let (factory, spec, settings) = setup("cursor-crashing");
    let mut crashing = factory.start(spec).await.expect("crashing helper starts");
    let (_, spec, _) = setup("cursor-healthy");
    let mut healthy = factory.start(spec).await.expect("healthy helper starts");
    assert!(matches!(
        crashing.session.start_turn(input("crash"), &settings).await,
        TurnStartResult::Accepted { .. }
    ));
    loop {
        let event = tokio::time::timeout(Duration::from_secs(10), crashing.events.recv())
            .await
            .expect("crash timeout")
            .expect("crash event stream");
        if matches!(event, EngineEvent::Exited { .. }) {
            break;
        }
        assert!(
            !matches!(
                event,
                EngineEvent::TurnFinished {
                    outcome: TurnOutcome::Done,
                    ..
                }
            ),
            "crashing turn completed"
        );
    }
    assert!(matches!(
        healthy.session.start_turn(input("hello"), &settings).await,
        TurnStartResult::Accepted { .. }
    ));
    let mut message = false;
    loop {
        let event = tokio::time::timeout(Duration::from_secs(10), healthy.events.recv())
            .await
            .expect("healthy timeout")
            .expect("healthy event stream");
        match event {
            EngineEvent::ItemCompleted { item, .. } => {
                if let TurnItemBody::AssistantMessage { text, .. } = &item.body {
                    assert_eq!(text, "hello world");
                    message = true;
                }
            }
            EngineEvent::TurnFinished { outcome, .. } => {
                assert!(matches!(outcome, TurnOutcome::Done), "{outcome:?}");
                break;
            }
            EngineEvent::Exited { reason } => panic!("healthy helper exited: {reason}"),
            _ => {}
        }
    }
    assert!(message, "healthy session must produce its message");
    healthy.session.shutdown().await;
}

#[tokio::test]
async fn cursor_set_config_reaches_next_send() {
    let (factory, spec, mut settings) = setup("cursor-switch-model");
    let mut handle = factory.start(spec).await.expect("helper starts");
    let original = settings.clone();
    settings.model_selection.model = "new-model".into();
    handle
        .session
        .set_config(&settings)
        .await
        .expect("set model");
    assert!(matches!(
        handle
            .session
            .start_turn(input("switch-model"), &original)
            .await,
        TurnStartResult::Accepted { .. }
    ));
    loop {
        let event = tokio::time::timeout(Duration::from_secs(10), handle.events.recv())
            .await
            .expect("event timeout")
            .expect("event stream");
        match event {
            EngineEvent::TurnFinished {
                outcome: TurnOutcome::Done,
                ..
            } => break,
            EngineEvent::Exited { reason } => panic!("helper exited: {reason}"),
            _ => {}
        }
    }
    handle.session.shutdown().await;
}
