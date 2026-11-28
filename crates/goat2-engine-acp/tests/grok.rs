//! Grok flavor exercised against the offline ACP mock.
use goat2_contracts::{
    EngineConfig, ModelSelection, RequestKind, RequestOutcome, RuntimeMode, TurnItemBody,
};
use goat2_engine_acp::{AcpEngineFactory, agents::grok::Grok};
use goat2_engine_api::{
    EngineEvent, EngineFactory, EngineInput, LaunchSpec, McpEndpoint, RequestAnswer, SessionSpec,
    TurnOutcome, TurnSettings,
};
use std::{collections::BTreeMap, sync::Arc, time::Duration};

/// One Grok turn against the fake agent's xAI completion, with extra fake-agent env.
async fn grok_turn(extra: &[(&str, &str)]) -> TurnOutcome {
    grok_turn_events(extra, |_| None).await.1
}

/// A Grok turn that answers each opened request with `answer`; returns all events and the outcome.
async fn grok_turn_events(
    extra: &[(&str, &str)],
    answer: impl Fn(&EngineEvent) -> Option<(String, RequestAnswer)>,
) -> (Vec<EngineEvent>, TurnOutcome) {
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
    let mut events = Vec::new();
    let outcome = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let event = h.events.recv().await.expect("event");
            if let Some((key, reply)) = answer(&event) {
                h.session.answer_request(&key, reply).await.unwrap();
            }
            if let EngineEvent::TurnFinished { outcome, .. } = &event {
                let outcome = outcome.clone();
                events.push(event);
                break outcome;
            }
            events.push(event);
        }
    })
    .await
    .unwrap();
    h.session.shutdown().await;
    (events, outcome)
}

fn answer_text(events: &[EngineEvent]) -> String {
    events
        .iter()
        .filter_map(|e| match e {
            EngineEvent::ItemCompleted { item, .. } => match &item.body {
                TurnItemBody::AssistantMessage { text, .. } => Some(text.clone()),
                _ => None,
            },
            _ => None,
        })
        .collect()
}

/// v1 grok adapter.ts:200-230: Grok's question stays open until the person answers, and the
/// answer goes back in xAI's shape.
#[tokio::test]
async fn ask_user_question_waits_for_the_answer() {
    let (events, outcome) = grok_turn_events(
        &[("GOAT_ACP_EMIT_XAI_ASK_USER_QUESTION", "1")],
        |event| match event {
            EngineEvent::RequestOpened {
                key, kind, item, ..
            } => {
                assert_eq!(*kind, RequestKind::Question);
                let Some(TurnItemBody::UserInputRequest { questions, .. }) =
                    item.as_ref().map(|i| i.body.clone())
                else {
                    panic!("question item");
                };
                assert_eq!(questions[0].question, "Which color?");
                Some((
                    key.clone(),
                    RequestAnswer {
                        outcome: RequestOutcome::Answered,
                        text: None,
                        answers: Some(
                            serde_json::json!({"Which color?": "Blue"})
                                .as_object()
                                .unwrap()
                                .clone(),
                        ),
                    },
                ))
            }
            _ => None,
        },
    )
    .await;
    assert_eq!(outcome, TurnOutcome::Done);
    assert!(
        answer_text(&events).contains(
            r#"xai question: {"outcome":"accepted","answers":{"Which color?":["Blue"]}}"#
        ),
        "{}",
        answer_text(&events)
    );
}

/// v1 grok adapter.ts:171-197: the plan becomes a proposed-plan item and Grok's own gate is
/// abandoned so the turn does not hang.
#[tokio::test]
async fn exit_plan_mode_captures_the_plan() {
    let (events, outcome) =
        grok_turn_events(&[("GOAT_ACP_EMIT_XAI_EXIT_PLAN_MODE", "1")], |_| None).await;
    assert_eq!(outcome, TurnOutcome::Done);
    assert!(events.iter().any(|e| matches!(e,
        EngineEvent::ItemCompleted { item, .. }
            if matches!(&item.body, TurnItemBody::ProposedPlan { markdown, .. } if markdown == "# Plan\n\n1. Do it"))));
    assert!(answer_text(&events).contains("xai plan: {"));
    assert!(answer_text(&events).contains("The client captured your proposed plan."));
    assert!(answer_text(&events).contains(r#""outcome":"abandoned""#));
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
