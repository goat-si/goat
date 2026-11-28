//! OpenCode 2 fake HTTP/SSE runtime through the real helper and Rust driver.
use goat2_contracts::{
    ContentStreamKind, EngineConfig, EngineDriver, InputId, ModelSelection, ProviderCapabilities,
    ProviderInstanceId, RuntimeMode, ThreadId, TurnItemBody,
};
use goat2_engine_api::{
    EngineError, EngineEvent, EngineFactory, EngineInput, LaunchSpec, McpEndpoint, ProviderTarget,
    SessionSpec, TurnOutcome, TurnSettings, TurnStartResult,
};
use goat2_engine_sdk::{HelperFactory, HelperLaunch};
use std::{path::PathBuf, time::Duration};

fn spec(model: &ModelSelection, launch: Option<LaunchSpec>) -> SessionSpec {
    SessionSpec {
        thread_id: ThreadId::from("opencode2-test"),
        engine: EngineConfig {
            provider_instance_id: ProviderInstanceId::from("opencode"),
            model_selection: model.clone(),
            runtime_mode: RuntimeMode::FullAccess,
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
        },
        resume: None,
        mcp: McpEndpoint {
            url: "http://127.0.0.1:1/mcp".into(),
            bearer_token: "synthetic-token".into(),
        },
        host_generation: 1,
        process_generation: 1,
        instructions: None,
        instance: launch.map(|launch| ProviderTarget {
            instance_id: model.instance_id.clone(),
            launch: Some(launch),
            home: None,
            shared_home: None,
        }),
    }
}

#[tokio::test]
async fn v2_probe_capabilities_and_turn_cross_the_helper() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let launch = HelperLaunch::new("node", root.join("apps/engine-helper/src/main.ts"))
        .with_env(
            "GOAT2_ENGINE_HELPER_SDK_OPENCODE2",
            root.join("apps/engine-helper/test/fakes/opencode2-helper.ts"),
        )
        .with_env(
            "GOAT2_ENGINE_HELPER_SDK_OPENCODE",
            root.join("apps/engine-helper/test/fakes/opencode-sdk.ts"),
        )
        .with_env("GOAT2_ENGINE_HELPER_FAKE_OPENCODE2_VERSION", "2.2.6");
    let factory = HelperFactory::new(EngineDriver::Opencode, launch).expect("OpenCode driver");
    assert!(
        !factory
            .capabilities()
            .sessions
            .supports_runtime_mode_switch_in_session
    );
    let probe = factory.probe().await.expect("v2 probe");
    assert_eq!(probe.version.as_deref(), Some("2.2.6"));
    let mut expected: ProviderCapabilities =
        serde_json::from_str(include_str!("../src/capabilities/opencode2.json"))
            .expect("capabilities");
    expected.turns.supports_native_goals = Some(true);
    assert_eq!(factory.capabilities(), expected);
    let model = ModelSelection {
        instance_id: ProviderInstanceId::from("opencode"),
        model: "test/model".into(),
        options: None,
    };
    let v1_spec = spec(
        &model,
        Some(LaunchSpec {
            env: [("GOAT2_ENGINE_HELPER_SDK_OPENCODE2".into(), "".into())].into(),
            ..LaunchSpec::default()
        }),
    );
    let mut handle = factory
        .start(spec(&model, None))
        .await
        .expect("session starts");
    let result = handle
        .session
        .start_turn(
            vec![EngineInput {
                input_id: InputId::from("input"),
                text: "hello".into(),
                attachments: vec![],
            }],
            &TurnSettings {
                model_selection: model.clone(),
                runtime_mode: RuntimeMode::FullAccess,
            },
        )
        .await;
    assert!(matches!(result, TurnStartResult::Accepted { .. }));
    let mut text = String::new();
    let mut reasoning = String::new();
    let mut reasoning_id = None;
    let mut tool = false;
    let mut usage = false;
    loop {
        let event = tokio::time::timeout(Duration::from_secs(10), handle.events.recv())
            .await
            .expect("event timeout")
            .expect("stream closed");
        match event {
            EngineEvent::TextDelta { text: delta, .. } => text.push_str(&delta),
            EngineEvent::ContentDelta {
                item_id,
                stream_kind: ContentStreamKind::ReasoningText,
                text: delta,
                ..
            } => {
                reasoning_id = Some(item_id);
                reasoning.push_str(&delta);
            }
            EngineEvent::ItemCompleted { item, .. } => match item.body {
                TurnItemBody::Reasoning { .. } => assert_eq!(reasoning_id.as_ref(), Some(&item.id)),
                TurnItemBody::CommandExecution { .. } => tool = true,
                _ => {}
            },
            EngineEvent::TokenUsage {
                usage: snapshot, ..
            } => {
                assert_eq!(snapshot.used_tokens, 22);
                usage = true;
            }
            EngineEvent::TurnFinished { outcome, .. } => {
                assert!(matches!(outcome, TurnOutcome::Done));
                break;
            }
            EngineEvent::Exited { reason } => panic!("helper exited: {reason}"),
            _ => {}
        }
    }
    assert_eq!(text, "Hello world");
    assert_eq!(reasoning, "Think");
    assert!(tool && usage);
    handle.session.shutdown().await;
    let v1 = factory
        .start(v1_spec)
        .await
        .expect("1.x session after v2 probe");
    assert!(matches!(
        v1.session
            .set_config(&TurnSettings {
                model_selection: model,
                runtime_mode: RuntimeMode::ApprovalRequired
            })
            .await,
        Err(EngineError::Unsupported(_))
    ));
    assert_eq!(factory.capabilities(), expected);
    v1.session.shutdown().await;
}

#[tokio::test]
async fn instance_probe_uses_its_launch_environment() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let factory = HelperFactory::new(
        EngineDriver::Opencode,
        HelperLaunch::new("node", root.join("apps/engine-helper/src/main.ts")),
    )
    .expect("OpenCode driver");
    let target = ProviderTarget {
        instance_id: ProviderInstanceId::from("opencode-instance"),
        launch: Some(LaunchSpec {
            env: [
                (
                    "GOAT2_ENGINE_HELPER_SDK_OPENCODE2".into(),
                    root.join("apps/engine-helper/test/fakes/opencode2-helper.ts")
                        .to_string_lossy()
                        .into_owned(),
                ),
                (
                    "GOAT2_ENGINE_HELPER_FAKE_OPENCODE2_VERSION".into(),
                    "2.2.5".into(),
                ),
            ]
            .into(),
            ..LaunchSpec::default()
        }),
        home: None,
        shared_home: None,
    };
    let probe = factory
        .probe_instance(&target)
        .await
        .expect("instance probe");
    assert_eq!(probe.version.as_deref(), Some("2.2.5"));
    assert!(probe.installed);
    assert!(
        factory
            .capabilities()
            .sessions
            .supports_runtime_mode_switch_in_session
    );
    assert_eq!(
        factory.capabilities().turns.supports_native_goals,
        Some(true)
    );
}
