//! Grok flavor exercised against the offline ACP mock.
use goat2_contracts::{EngineConfig, ModelSelection, RuntimeMode};
use goat2_engine_acp::{AcpEngineFactory, agents::grok::Grok};
use goat2_engine_api::{
    EngineEvent, EngineFactory, EngineInput, LaunchSpec, McpEndpoint, SessionSpec, TurnOutcome,
    TurnSettings,
};
use std::{collections::BTreeMap, sync::Arc, time::Duration};

#[tokio::test]
async fn prompt_complete_settles_without_rpc_response() {
    let dir = tempfile::tempdir().unwrap();
    let selection = ModelSelection {
        instance_id: "grok".into(),
        model: "grok-build".into(),
        options: None,
    };
    let mode = RuntimeMode::ApprovalRequired;
    let spec = SessionSpec {
        thread_id: "t".into(),
        engine: EngineConfig {
            provider_instance_id: "grok".into(),
            model_selection: selection.clone(),
            runtime_mode: mode,
            cwd: dir.path().to_string_lossy().into_owned(),
        },
        resume: None,
        mcp: McpEndpoint {
            url: "http://127.0.0.1:9/mcp".into(),
            bearer_token: "fake".into(),
        },
        host_generation: 1,
        process_generation: 1,
        instructions: None,
        launch: Some(LaunchSpec {
            binary: Some(env!("CARGO_BIN_EXE_goat2-acp-mock-agent").into()),
            args: vec![],
            env: BTreeMap::from([(
                "GOAT_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG".into(),
                "1".into(),
            )]),
        }),
    };
    let mut h = AcpEngineFactory::new(Arc::new(Grok::default()))
        .start(spec)
        .await
        .unwrap();
    h.session
        .start_turn(
            vec![EngineInput {
                input_id: "i".into(),
                text: "hello".into(),
                attachments: vec![],
            }],
            &TurnSettings {
                model_selection: selection,
                runtime_mode: mode,
            },
        )
        .await;
    let outcome = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Some(EngineEvent::TurnFinished { outcome, .. }) = h.events.recv().await {
                break outcome;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(outcome, TurnOutcome::Done);
    h.session.shutdown().await;
}
