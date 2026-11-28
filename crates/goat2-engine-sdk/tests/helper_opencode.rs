//! Offline OpenCode SDK replay through the real helper and Rust driver.
use goat2_contracts::{
    EngineConfig, EngineDriver, InputId, ModelSelection, ProviderInstanceId, RuntimeMode, ThreadId,
    TurnItemBody,
};
use goat2_engine_api::{
    EngineEvent, EngineFactory, EngineInput, McpEndpoint, SessionSpec, TurnOutcome, TurnSettings,
    TurnStartResult,
};
use goat2_engine_sdk::{HelperFactory, HelperLaunch};
use std::{path::PathBuf, time::Duration};

#[tokio::test]
async fn opencode_turn_projects_valid_items() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let launch = HelperLaunch::new("node", root.join("apps/engine-helper/src/main.ts")).with_env(
        "GOAT2_ENGINE_HELPER_SDK_OPENCODE",
        root.join("apps/engine-helper/test/fakes/opencode-sdk.ts")
            .to_string_lossy()
            .into_owned(),
    );
    let factory = HelperFactory::new(EngineDriver::Opencode, launch).expect("OpenCode driver");
    let model = ModelSelection {
        instance_id: ProviderInstanceId::from("opencode"),
        model: "test/model".into(),
        options: None,
    };
    let spec = SessionSpec {
        thread_id: ThreadId::from("opencode-test"),
        engine: EngineConfig {
            provider_instance_id: ProviderInstanceId::from("opencode"),
            model_selection: model.clone(),
            runtime_mode: RuntimeMode::FullAccess,
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
        },
        resume: None,
        mcp: McpEndpoint {
            url: "http://127.0.0.1:1/mcp".into(),
            bearer_token: format!("{}", std::process::id()),
        },
        host_generation: 1,
        process_generation: 1,
        instructions: None,
        launch: None,
    };
    let mut handle = factory.start(spec).await.expect("session starts");
    let input = vec![EngineInput {
        input_id: InputId::from("input"),
        text: "hello".into(),
        attachments: vec![],
    }];
    let settings = TurnSettings {
        model_selection: model,
        runtime_mode: RuntimeMode::FullAccess,
    };
    assert!(matches!(
        handle.session.start_turn(input, &settings).await,
        TurnStartResult::Accepted { .. }
    ));
    let mut text = false;
    let mut tool = false;
    let mut usage_received = false;
    loop {
        let event = tokio::time::timeout(Duration::from_secs(10), handle.events.recv())
            .await
            .expect("event timeout")
            .expect("event stream closed");
        match event {
            EngineEvent::ItemCompleted { item, .. } => match item.body {
                TurnItemBody::AssistantMessage { text: body, .. } => {
                    assert_eq!(body, "Hello world");
                    text = true;
                }
                TurnItemBody::CommandExecution { .. } => tool = true,
                _ => {}
            },
            EngineEvent::TurnFinished { outcome, .. } => {
                assert!(matches!(outcome, TurnOutcome::Done));
                assert!(usage_received, "usage precedes the turn terminal");
                break;
            }
            EngineEvent::TokenUsage { usage, .. } => {
                assert_eq!(usage.used_tokens, 22);
                assert_eq!(usage.input_tokens, Some(14));
                assert_eq!(usage.cached_input_tokens, Some(3));
                assert_eq!(usage.output_tokens, Some(8));
                assert_eq!(usage.reasoning_output_tokens, Some(2));
                usage_received = true;
            }
            EngineEvent::Exited { reason } => panic!("helper exited: {reason}"),
            _ => {}
        }
    }
    assert!(text && tool, "validated message and tool items received");
    handle.session.shutdown().await;
}
