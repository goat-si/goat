//! Cursor SDK helper against the offline SDK double; no Cursor login or network.
use std::path::PathBuf;
use std::time::Duration;

use goat2_contracts::{
    EngineConfig, EngineDriver, InputId, ModelSelection, ProviderInstanceId, RuntimeMode, ThreadId,
    TurnItemBody,
};
use goat2_engine_api::{
    EngineEvent, EngineFactory, EngineInput, McpEndpoint, SessionSpec, TurnOutcome, TurnSettings,
    TurnStartResult,
};
use goat2_engine_sdk::{HelperFactory, HelperLaunch};

#[tokio::test]
async fn cursor_helper_turn_validates_items() {
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
        thread_id: ThreadId::from("cursor-thread"),
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
    let mut handle = factory.start(spec).await.expect("helper starts");
    assert_eq!(handle.engine_ref.id, "cursor-new");
    let input = vec![EngineInput {
        input_id: InputId::from("input"),
        text: "hello".into(),
        attachments: Vec::new(),
    }];
    let settings = TurnSettings {
        model_selection: model,
        runtime_mode: RuntimeMode::FullAccess,
    };
    assert!(matches!(
        handle.session.start_turn(input, &settings).await,
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
