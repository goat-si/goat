//! Muse adapter through the actual JSONL helper and a scripted, offline SDK.
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
async fn muse_fake_turn_crosses_helper_and_validates_items() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let launch = HelperLaunch::new("node", root.join("apps/engine-helper/src/main.ts")).with_env(
        "GOAT2_ENGINE_HELPER_SDK_MUSE",
        root.join("apps/engine-helper/test/fakes/muse-sdk.ts"),
    );
    let factory = HelperFactory::new(EngineDriver::Muse, launch).expect("Muse helper");
    let model = ModelSelection {
        instance_id: ProviderInstanceId::from("muse"),
        model: "muse-example".into(),
        options: None,
    };
    let spec = SessionSpec {
        thread_id: ThreadId::from("muse-thread"),
        engine: EngineConfig {
            provider_instance_id: ProviderInstanceId::from("muse"),
            model_selection: model.clone(),
            runtime_mode: RuntimeMode::FullAccess,
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
        },
        resume: None,
        mcp: McpEndpoint {
            url: "http://127.0.0.1:9/mcp".into(),
            bearer_token: "fake".into(),
        },
        host_generation: 1,
        process_generation: 1,
        instructions: None,
        launch: None,
    };
    let mut handle = factory.start(spec).await.expect("Muse starts");
    let result = handle
        .session
        .start_turn(
            vec![EngineInput {
                input_id: InputId::from("input"),
                text: "hello".into(),
                attachments: Vec::new(),
            }],
            &TurnSettings {
                model_selection: model,
                runtime_mode: RuntimeMode::FullAccess,
            },
        )
        .await;
    assert!(matches!(result, TurnStartResult::Accepted { .. }));
    let mut reasoning_delta = false;
    let mut delta = String::new();
    let mut message = false;
    let mut tool = false;
    loop {
        let event = tokio::time::timeout(Duration::from_secs(10), handle.events.recv())
            .await
            .expect("event timeout")
            .expect("event stream");
        match event {
            EngineEvent::TextDelta { text, .. } => delta.push_str(&text),
            EngineEvent::ContentDelta {
                stream_kind: goat2_contracts::ContentStreamKind::ReasoningText,
                text,
                ..
            } => {
                reasoning_delta |= text == "think";
            }
            EngineEvent::ItemCompleted { item, .. } => match item.body {
                TurnItemBody::AssistantMessage { text, .. } => message = text == "hello",
                TurnItemBody::DynamicTool { tool_name, .. } => {
                    tool = tool_name.as_deref() == Some("goat_call");
                }
                _ => {}
            },
            EngineEvent::TurnFinished { outcome, .. } => {
                assert!(matches!(outcome, TurnOutcome::Done));
                break;
            }
            EngineEvent::Exited { reason } => panic!("unexpected exit: {reason}"),
            _ => {}
        }
    }
    assert!(reasoning_delta, "reasoning must stream to Rust");
    assert_eq!(delta, "hello");
    assert!(message && tool, "both items must deserialize through Rust");
    handle.session.shutdown().await;
}
