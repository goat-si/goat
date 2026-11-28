//! Attachment resolution through the real Rust/helper transport and fake OpenCode SDK.
use std::{path::PathBuf, sync::Arc};

use goat2_contracts::{
    ChatAttachment, ChatAttachmentType, EngineConfig, EngineDriver, InputId, ModelSelection,
    ProviderInstanceId, RuntimeMode, ThreadId, TurnItemBody,
};
use goat2_engine_api::{
    EngineError, EngineEvent, EngineFactory, EngineInput, McpEndpoint, SessionSpec, SteerResult,
    SteerStatus, TurnOutcome, TurnSettings, TurnStartResult,
};
use goat2_engine_sdk::{HelperFactory, HelperLaunch};

#[tokio::test]
async fn resolved_and_missing_attachment_paths_reach_opencode() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let launch = HelperLaunch::new("node", root.join("apps/engine-helper/src/main.ts")).with_env(
        "GOAT2_ENGINE_HELPER_SDK_OPENCODE",
        root.join("apps/engine-helper/test/fakes/opencode-sdk.ts"),
    );
    let factory = HelperFactory::new(EngineDriver::Opencode, launch)
        .expect("OpenCode helper")
        .with_attachment_resolver(Arc::new(|_, attachment| {
            (attachment.id == "saved").then(|| PathBuf::from("/tmp/has space.txt"))
        }));
    let model = ModelSelection {
        instance_id: ProviderInstanceId::from("opencode"),
        model: "test/model".into(),
        options: None,
    };
    let spec = SessionSpec {
        thread_id: ThreadId::from("opencode-attachments"),
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
        instance: None,
    };
    let mut handle = factory.start(spec).await.expect("session starts");
    let mut model_b = model.clone();
    model_b.model = "test/model-b".into();
    handle
        .session
        .set_config(&TurnSettings {
            model_selection: model_b.clone(),
            runtime_mode: RuntimeMode::FullAccess,
        })
        .await
        .expect("model-only update");
    let mut model_c = model.clone();
    model_c.model = "test/model-c".into();
    assert!(matches!(
        handle
            .session
            .set_config(&TurnSettings {
                model_selection: model_c,
                runtime_mode: RuntimeMode::ApprovalRequired
            })
            .await,
        Err(EngineError::Unsupported(_))
    ));
    let attachment = |id: &str, name: &str| ChatAttachment {
        kind: ChatAttachmentType::File,
        id: id.into(),
        name: name.into(),
        mime_type: "text/plain".into(),
        size_bytes: 4,
        blob: None,
    };
    let result = handle
        .session
        .start_turn(
            vec![EngineInput {
                input_id: InputId::from("input"),
                text: "echo-attachment".into(),
                attachments: vec![
                    attachment("saved", "notes.txt"),
                    attachment("missing", "missing.txt"),
                ],
            }],
            &TurnSettings {
                model_selection: model_b.clone(),
                runtime_mode: RuntimeMode::FullAccess,
            },
        )
        .await;
    assert!(matches!(result, TurnStartResult::Accepted { .. }));
    let mut message = None;
    while let Some(event) = handle.events.recv().await {
        match event {
            EngineEvent::ItemCompleted { item, .. } => {
                if let TurnItemBody::AssistantMessage { text, .. } = item.body {
                    message = Some(text);
                }
            }
            EngineEvent::TurnFinished { outcome, .. } => {
                assert!(matches!(outcome, TurnOutcome::Done));
                break;
            }
            EngineEvent::Exited { reason } => panic!("helper exited: {reason}"),
            _ => {}
        }
    }
    let message = message.expect("assistant message");
    assert!(message.contains("[Attached file \"notes.txt\" is saved at: /tmp/has space.txt]"));
    assert!(message.contains("[Attached file \"missing.txt\" is unavailable: could not resolve a saved path for attachment 'missing'.]"));
    assert!(message.contains("FILE:file:///tmp/has%20space.txt"));
    assert!(message.contains("MODEL:test/model-b"));

    let next = handle
        .session
        .start_turn(
            vec![EngineInput {
                input_id: InputId::from("next"),
                text: "hold-for-steer".into(),
                attachments: vec![],
            }],
            &TurnSettings {
                model_selection: model_b,
                runtime_mode: RuntimeMode::FullAccess,
            },
        )
        .await;
    let TurnStartResult::Accepted { turn_id } = next else {
        panic!("second turn was not accepted")
    };
    loop {
        match handle.events.recv().await.expect("event stream") {
            EngineEvent::ItemCompleted { item, .. }
                if matches!(item.body, TurnItemBody::AssistantMessage { .. }) =>
            {
                break;
            }
            EngineEvent::Exited { reason } => panic!("helper exited: {reason}"),
            _ => {}
        }
    }
    assert!(matches!(
        handle
            .session
            .steer(
                &turn_id,
                vec![EngineInput {
                    input_id: InputId::from("steer-one"),
                    text: "unread-steer".into(),
                    attachments: vec![]
                }]
            )
            .await,
        SteerResult::Accepted
    ));
    handle.session.interrupt(&turn_id).await.expect("interrupt");
    let mut cancelled = false;
    loop {
        match handle.events.recv().await.expect("event stream") {
            EngineEvent::SteerUpdated {
                input_ids,
                status: SteerStatus::Cancelled { .. },
                ..
            } => {
                assert_eq!(input_ids, vec![InputId::from("steer-one")]);
                cancelled = true;
            }
            EngineEvent::TurnFinished { outcome, .. } => {
                assert!(
                    cancelled,
                    "steer settlement must precede the terminal event"
                );
                assert!(matches!(outcome, TurnOutcome::Interrupted));
                break;
            }
            EngineEvent::Exited { reason } => panic!("helper exited: {reason}"),
            _ => {}
        }
    }
    handle.session.shutdown().await;
}
