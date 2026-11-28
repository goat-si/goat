//! Grok flavor exercised against the offline ACP mock.
use goat2_contracts::{EngineConfig, ModelSelection, RuntimeMode};
use goat2_engine_acp::{AcpEngineFactory, agents::grok::Grok};
use goat2_engine_api::{
    EngineEvent, EngineFactory, EngineInput, LaunchSpec, McpEndpoint, SessionSpec, TurnOutcome,
    TurnSettings,
};
use std::{collections::BTreeMap, sync::Arc, time::Duration};

/// One Grok turn against the fake agent's xAI completion, with extra fake-agent env.
async fn grok_turn(extra: &[(&str, &str)]) -> TurnOutcome {
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
            env: [("GOAT_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG", "1")]
                .iter()
                .chain(extra)
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect::<BTreeMap<_, _>>(),
        }),
    };
    let mut h = AcpEngineFactory::new(Arc::new(Grok::default()))
        .with_mcp_bridge(goat2_engine_acp::McpBridgeCommand::new(
            "/goat2-test/bin/goat2-acp-mcp-bridge",
            Vec::<String>::new(),
        ))
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
    h.session.shutdown().await;
    outcome
}

#[tokio::test]
async fn prompt_complete_settles_without_rpc_response() {
    assert_eq!(grok_turn(&[]).await, TurnOutcome::Done);
}

/// v1 xAiPromptFailure (xaiAcpExtension.ts:1283-1301): a rate-limit completion fails the turn
/// instead of leaving it waiting for a prompt answer that never comes.
#[tokio::test]
async fn rate_limit_completion_fails_the_turn() {
    assert_eq!(
        grok_turn(&[("GOAT_ACP_XAI_STOP_REASON", "rate_limit")]).await,
        TurnOutcome::Failed {
            reason: "Grok usage limit reached. Try again later.".into()
        }
    );
}

/// An error completion fails the turn with the agent's own result text, else v1's fallback.
#[tokio::test]
async fn error_completion_fails_the_turn_with_agent_result() {
    assert_eq!(
        grok_turn(&[
            ("GOAT_ACP_XAI_STOP_REASON", "error"),
            ("GOAT_ACP_XAI_AGENT_RESULT", "model overloaded"),
        ])
        .await,
        TurnOutcome::Failed {
            reason: "model overloaded".into()
        }
    );
    assert_eq!(
        grok_turn(&[("GOAT_ACP_XAI_STOP_REASON", "error")]).await,
        TurnOutcome::Failed {
            reason: "Grok ended the turn with an error.".into()
        }
    );
}
