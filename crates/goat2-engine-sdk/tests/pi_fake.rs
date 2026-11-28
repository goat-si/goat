//! Pi RPC integration tests. The fake binary uses only local stdio and dummy credentials.
use goat2_contracts::{
    ChatAttachment, ChatAttachmentType, ContentStreamKind, EngineConfig, EngineDriver, EngineRef,
    InputId, ModelSelection, ProviderInstanceId, ProviderOptionSelection,
    ProviderOptionSelectionValue, RequestKind, RequestOutcome, RuntimeMode, ThreadId, TurnItemBody,
};
use goat2_engine_api::{
    EngineEvent, EngineFactory, EngineHandle, EngineInput, LaunchSpec, McpEndpoint, RequestAnswer,
    SessionSpec, SteerResult, SteerStatus, TurnOutcome, TurnSettings, TurnStartResult,
};
use goat2_engine_sdk::pi::{PiFactory, PiProfile};
use std::future::Future;
use std::sync::Arc;
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

async fn check_steer_settlement(message: &str, interrupt: bool, completed: bool) {
    let mut h = start("pi-steer-settlement").await;
    let turn = accepted(h.session.start_turn(input("hang"), &settings()).await);
    let mut inputs = input(message);
    inputs[0].input_id = InputId::from("steer-1");
    let mut second = input("second").remove(0);
    second.input_id = InputId::from("steer-2");
    // A single input for fake command selection; interrupt case verifies multiple IDs.
    if interrupt {
        inputs.push(second);
    }
    assert_eq!(h.session.steer(&turn, inputs).await, SteerResult::Accepted);
    if interrupt {
        h.session.interrupt(&turn).await.unwrap();
    }
    let events = finished(&mut h).await;
    let ids = if interrupt {
        vec![InputId::from("steer-1"), InputId::from("steer-2")]
    } else {
        vec![InputId::from("steer-1")]
    };
    assert!(events.iter().any(|event| matches!(event, EngineEvent::SteerUpdated { turn_id, input_ids, status } if turn_id == &turn && input_ids == &ids && if completed { matches!(status, SteerStatus::Completed) } else { matches!(status, SteerStatus::Cancelled { .. }) })), "{events:?}");
    assert!(matches!(
        events.last(),
        Some(EngineEvent::TurnFinished { .. })
    ));
    h.session.shutdown().await;
}

#[tokio::test]
async fn steer_read_is_completed_before_finish() {
    check_steer_settlement("read-steer", false, true).await;
}
#[tokio::test]
async fn steer_unread_is_cancelled_before_interrupt_finish() {
    check_steer_settlement("queued", true, false).await;
}
#[tokio::test]
async fn steer_unread_is_cancelled_before_normal_finish() {
    check_steer_settlement("finish-unread", false, false).await;
}

#[tokio::test]
async fn compact_start_and_steer_use_rpc_and_complete() {
    let mut h = start("pi-compact").await;
    for (command, summary) in [
        ("/compact", "none"),
        (" /compact  keep decisions  ", "keep decisions"),
        ("/compact ack-first", "ack-first"),
    ] {
        accepted(h.session.start_turn(input(command), &settings()).await);
        let events = finished(&mut h).await;
        assert!(events.iter().any(|e| matches!(e, EngineEvent::ItemCompleted { item, .. } if matches!(&item.body, TurnItemBody::Compaction { summary: Some(value), .. } if value == summary))));
        assert!(matches!(
            events.last(),
            Some(EngineEvent::TurnFinished {
                outcome: TurnOutcome::Done,
                ..
            })
        ));
    }
    let turn = accepted(h.session.start_turn(input("hang"), &settings()).await);
    assert_eq!(
        h.session.steer(&turn, input("/compact steer notes")).await,
        SteerResult::Accepted
    );
    let events = finished(&mut h).await;
    assert!(events.iter().any(|e| matches!(e, EngineEvent::ItemCompleted { item, .. } if matches!(&item.body, TurnItemBody::Compaction { summary: Some(value), .. } if value == "steer notes"))));
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
async fn compact_rejection_and_interrupt_are_visible() {
    let mut h = start("pi-compact-negative").await;
    accepted(
        h.session
            .start_turn(input("/compact reject"), &settings())
            .await,
    );
    assert!(
        matches!(finished(&mut h).await.last(), Some(EngineEvent::TurnFinished { outcome: TurnOutcome::Failed { reason }, .. }) if reason.contains("compact rejected"))
    );
    let turn = accepted(h.session.start_turn(input("hang"), &settings()).await);
    assert!(
        matches!(h.session.steer(&turn, input("/compact reject")).await, SteerResult::Declined { reason } if reason.contains("compact rejected"))
    );
    h.session.interrupt(&turn).await.unwrap();
    assert!(matches!(
        finished(&mut h).await.last(),
        Some(EngineEvent::TurnFinished {
            outcome: TurnOutcome::Interrupted,
            ..
        })
    ));
    h.session.shutdown().await;

    let mut h = start("pi-compact-interrupt").await;
    let turn = accepted(
        h.session
            .start_turn(input("/compact wait"), &settings())
            .await,
    );
    h.session.interrupt(&turn).await.unwrap();
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
async fn interrupt_compact_steer_while_ack_pending() {
    let mut h = start("pi-compact-steer-interrupt").await;
    let turn = accepted(h.session.start_turn(input("hang"), &settings()).await);
    {
        let session = &h.session;
        let steer = session.steer(&turn, input("/compact wait"));
        tokio::pin!(steer);
        loop {
            tokio::select! {
                result = &mut steer => panic!("steer completed early: {result:?}"),
                event = h.events.recv() => match event.unwrap() {
                    EngineEvent::RequestOpened { key, .. } => { assert_eq!(key, "compact-wait"); break; },
                    EngineEvent::TurnFinished { .. } => panic!("settled before interrupt"),
                    _ => {}
                }
            }
        }
        session.interrupt(&turn).await.unwrap();
        assert!(matches!(steer.await, SteerResult::Unknown { .. }));
    }
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
async fn compact_waits_for_ack_after_settlement_and_dialog() {
    let mut h = start("pi-compact-late").await;
    accepted(
        h.session
            .start_turn(input("/compact late"), &settings())
            .await,
    );
    assert_eq!(opened(&mut h).await, "compact-ack");
    assert!(h.events.try_recv().is_err());
    reply(&h, "compact-ack", "ok").await.unwrap();
    assert!(matches!(
        finished(&mut h).await.last(),
        Some(EngineEvent::TurnFinished {
            outcome: TurnOutcome::Done,
            ..
        })
    ));

    let turn = accepted(h.session.start_turn(input("hang"), &settings()).await);
    {
        let session = &h.session;
        let steer = session.steer(&turn, input("/compact late"));
        tokio::pin!(steer);
        loop {
            tokio::select! {
                result = &mut steer => panic!("steer returned before ACK: {result:?}"),
                event = h.events.recv() => match event.unwrap() {
                    EngineEvent::RequestOpened { key, .. } => { assert_eq!(key, "compact-ack"); break; },
                    EngineEvent::TurnFinished { .. } => panic!("settled before compact ACK"),
                    _ => {}
                }
            }
        }
        session
            .answer_request(
                "compact-ack",
                RequestAnswer {
                    outcome: RequestOutcome::Answered,
                    text: Some("ok".into()),
                    answers: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(steer.await, SteerResult::Accepted);
    }
    assert!(matches!(
        finished(&mut h).await.last(),
        Some(EngineEvent::TurnFinished {
            outcome: TurnOutcome::Done,
            ..
        })
    ));
    h.session.shutdown().await;
}

#[tokio::test]
async fn changed_session_file_exits_before_settlement() {
    let mut h = start("pi-session-drift").await;
    accepted(
        h.session
            .start_turn(input("change-session"), &settings())
            .await,
    );
    assert!(
        matches!(finished(&mut h).await.last(), Some(EngineEvent::Exited { reason }) if reason.contains("session file"))
    );
    h.session.shutdown().await;
}
async fn start(id: &str) -> EngineHandle {
    factory(PiProfile::Pi)
        .start(spec(id))
        .await
        .expect("fake starts")
}

async fn assert_stream_kind(kind: ContentStreamKind, expected: &[&str]) {
    let mut h = start("pi-stream-kinds").await;
    let turn = accepted(
        h.session
            .start_turn(input("stream-kinds"), &settings())
            .await,
    );
    let events = finished(&mut h).await;
    let deltas: Vec<_> = events
        .iter()
        .enumerate()
        .filter_map(|(i, e)| match e {
            EngineEvent::ContentDelta {
                turn_id,
                item_id,
                stream_kind,
                text,
            } if *stream_kind == kind => {
                assert_eq!(turn_id, &turn);
                Some((i, item_id, text.as_str()))
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        deltas.iter().map(|(_, _, text)| *text).collect::<Vec<_>>(),
        expected,
        "{events:?}"
    );
    let id = deltas[0].1;
    assert!(deltas.iter().all(|(_, other, _)| *other == id));
    assert!(events.iter().enumerate().any(|(i, e)| i > deltas.last().unwrap().0 && matches!(e, EngineEvent::ItemCompleted { turn_id, item, .. } if turn_id == &turn && &item.id == id)), "{events:?}");
    h.session.shutdown().await;
}

#[tokio::test]
async fn thinking_deltas_complete_on_same_item() {
    assert_stream_kind(ContentStreamKind::ReasoningText, &["think ", "more"]).await;
}

#[tokio::test]
async fn command_output_deltas_complete_on_same_item() {
    assert_stream_kind(ContentStreamKind::CommandOutput, &["hé", "llo", "x"]).await;
}

#[tokio::test]
async fn usage_is_emitted_before_turn_finished() {
    let mut h = start("pi-usage").await;
    let turn = accepted(h.session.start_turn(input("usage"), &settings()).await);
    let events = finished(&mut h).await;
    assert_eq!(events.iter().filter(|event| matches!(event, EngineEvent::TokenUsage { turn_id: Some(id), usage } if id == &turn && usage.used_tokens == 80 && usage.max_tokens == Some(1000) && usage.input_tokens == Some(65) && usage.cached_input_tokens == Some(10) && usage.output_tokens == Some(15))).count(), 1, "{events:?}");
    assert!(events.iter().any(|event| matches!(event, EngineEvent::TokenUsage { turn_id: Some(id), usage } if id == &turn && usage.used_tokens == 90 && usage.max_tokens == Some(1000) && usage.input_tokens == Some(65) && usage.cached_input_tokens == Some(10) && usage.output_tokens == Some(15) && usage.cost.is_none())), "{events:?}");
    assert!(matches!(
        events.last(),
        Some(EngineEvent::TurnFinished { .. })
    ));
    h.session.shutdown().await;
}

#[tokio::test]
async fn malformed_usage_does_not_fail_turn() {
    let mut h = start("pi-bad-usage").await;
    accepted(h.session.start_turn(input("bad-usage"), &settings()).await);
    let events = finished(&mut h).await;
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, EngineEvent::TokenUsage { .. }))
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

fn attachment(id: &str, kind: ChatAttachmentType, mime: &str) -> ChatAttachment {
    ChatAttachment {
        kind,
        id: id.into(),
        name: format!("{id}.dat"),
        mime_type: mime.into(),
        size_bytes: 4,
        blob: None,
    }
}

#[tokio::test]
async fn attachments_round_trip_prompt_and_steer() {
    let path = std::env::temp_dir().join(format!("goat2-pi-attachment-{}", std::process::id()));
    tokio::fs::write(&path, [0, 1, 2, 255]).await.unwrap();
    let resolved = path.clone();
    let resolver = Arc::new(move |thread: &ThreadId, a: &ChatAttachment| {
        assert_eq!(thread, &ThreadId::from("pi-attachments"));
        match a.id.as_str() {
            "image" => Some(resolved.file_name().unwrap().into()),
            "file" => Some(resolved.clone()),
            _ => None,
        }
    });
    let mut h = factory(PiProfile::Pi)
        .with_attachment_resolver(resolver)
        .start(spec("pi-attachments"))
        .await
        .unwrap();
    let mut inputs = input("inspect-attachments");
    inputs[0].attachments = vec![
        attachment("image", ChatAttachmentType::Image, "image/png"),
        attachment("file", ChatAttachmentType::File, "text/plain"),
        attachment("missing", ChatAttachmentType::File, "text/plain"),
    ];
    accepted(h.session.start_turn(inputs, &settings()).await);
    let payload: serde_json::Value = serde_json::from_str(&text(&finished(&mut h).await)).unwrap();
    assert_eq!(
        payload["images"],
        serde_json::json!([{"type":"image","data":"AAEC/w==","mimeType":"image/png"}])
    );
    let message = payload["message"].as_str().unwrap();
    assert!(message.contains(&format!(
        "[Attached image \"image.dat\" is saved at: {}]",
        path.display()
    )));
    assert!(message.contains(&format!(
        "[Attached file \"file.dat\" is saved at: {}]",
        path.display()
    )));
    assert!(message.contains("[Attached file \"missing.dat\" is unavailable: could not resolve a saved path for attachment 'missing'.]"));
    let turn = accepted(h.session.start_turn(input("hang"), &settings()).await);
    let mut steer = input("inspect-steer");
    steer[0]
        .attachments
        .push(attachment("image", ChatAttachmentType::Image, "image/png"));
    assert!(matches!(
        h.session.steer(&turn, steer).await,
        SteerResult::Accepted
    ));
    h.session.shutdown().await;
}

#[tokio::test]
async fn empty_resolved_path_is_unavailable() {
    let mut h = factory(PiProfile::Pi)
        .with_attachment_resolver(Arc::new(|_, _| Some(std::path::PathBuf::new())))
        .start(spec("pi-empty-attachment"))
        .await
        .unwrap();
    let mut inputs = input("inspect-attachments");
    inputs[0]
        .attachments
        .push(attachment("empty", ChatAttachmentType::Image, "image/png"));
    accepted(h.session.start_turn(inputs, &settings()).await);
    let payload: serde_json::Value = serde_json::from_str(&text(&finished(&mut h).await)).unwrap();
    assert_eq!(payload["images"], serde_json::json!([]));
    assert!(
        payload["message"]
            .as_str()
            .unwrap()
            .contains("[Attached image \"empty.dat\" is unavailable:")
    );
    h.session.shutdown().await;
}

#[tokio::test]
async fn unreadable_image_is_declined() {
    let path = std::env::temp_dir()
        .join(format!("goat2-pi-nonexistent-{}", std::process::id()))
        .join("image.png");
    let h = factory(PiProfile::Pi)
        .with_attachment_resolver(Arc::new(move |_, _| Some(path.clone())))
        .start(spec("pi-unreadable"))
        .await
        .unwrap();
    let mut inputs = input("hello");
    inputs[0]
        .attachments
        .push(attachment("image", ChatAttachmentType::Image, "image/png"));
    assert!(
        matches!(h.session.start_turn(inputs.clone(), &settings()).await, TurnStartResult::Declined { reason } if reason.contains("Unable to read attachment"))
    );
    let turn = accepted(h.session.start_turn(input("hang"), &settings()).await);
    assert!(
        matches!(h.session.steer(&turn, inputs).await, SteerResult::Declined { reason } if reason.contains("Unable to read attachment"))
    );
    h.session.shutdown().await;
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
async fn expired_dialog_sends_cancel_and_rejects_late_answer() {
    let mut h = start("pi-expiry").await;
    accepted(
        h.session
            .start_turn(input("approval-expire"), &settings())
            .await,
    );
    let events = finished(&mut h).await;
    assert!(
        events
            .iter()
            .any(|e| matches!(e, EngineEvent::RequestClosed { key } if key == "dialog-1"))
    );
    assert_eq!(text(&events), "answer: cancelled");
    assert!(
        h.session
            .answer_request(
                "dialog-1",
                RequestAnswer {
                    outcome: RequestOutcome::Accept,
                    text: None,
                    answers: None
                }
            )
            .await
            .is_err()
    );
    h.session.shutdown().await;
}

#[tokio::test]
async fn structured_numeric_answer_uses_custom_followup() {
    let mut h = start("pi-structured").await;
    accepted(h.session.start_turn(input("structured"), &settings()).await);
    let key = loop {
        if let EngineEvent::RequestOpened {
            key,
            item: Some(item),
            ..
        } = next(&mut h).await
        {
            let TurnItemBody::UserInputRequest { questions, .. } = &item.body else {
                panic!("expected question")
            };
            assert_eq!(questions[0].header, "H");
            assert_eq!(questions[0].options[0].label, "A");
            break key;
        }
    };
    h.session
        .answer_request(
            &key,
            RequestAnswer {
                outcome: RequestOutcome::Answered,
                text: Some("42".into()),
                answers: None,
            },
        )
        .await
        .unwrap();
    let events = finished(&mut h).await;
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, EngineEvent::RequestOpened { key, .. } if key == "custom-1"))
    );
    assert_eq!(text(&events), "custom: 42");
    h.session.shutdown().await;
}

async fn opened(h: &mut EngineHandle) -> String {
    loop {
        match next(h).await {
            EngineEvent::RequestOpened { key, .. } => return key,
            EngineEvent::TurnFinished { .. } | EngineEvent::Exited { .. } => {
                panic!("turn ended before request")
            }
            _ => {}
        }
    }
}

async fn reply(
    h: &EngineHandle,
    key: &str,
    value: &str,
) -> Result<(), goat2_engine_api::EngineError> {
    h.session
        .answer_request(
            key,
            RequestAnswer {
                outcome: RequestOutcome::Answered,
                text: Some(value.into()),
                answers: None,
            },
        )
        .await
}

#[tokio::test]
async fn identical_parallel_custom_answers_are_fifo_and_capacity_is_retryable() {
    let mut h = start("pi-custom-batch").await;
    accepted(
        h.session
            .start_turn(input("structured-batch"), &settings())
            .await,
    );
    for n in 0..9 {
        assert_eq!(opened(&mut h).await, format!("select-{n}"));
    }
    assert_eq!(opened(&mut h).await, "release");
    for n in 0..8 {
        reply(&h, &format!("select-{n}"), &format!("value-{n}"))
            .await
            .unwrap();
    }
    assert!(reply(&h, "select-8", "value-8").await.is_err());
    reply(&h, "release", "go").await.unwrap();
    for key in ["other-placeholder", "other-method", "missing-placeholder"] {
        assert_eq!(opened(&mut h).await, key);
        reply(&h, key, "unrelated").await.unwrap();
    }
    assert_eq!(opened(&mut h).await, "checkpoint");
    reply(&h, "select-8", "value-8")
        .await
        .expect("request remains open after capacity error");
    reply(&h, "checkpoint", "go").await.unwrap();
    let events = finished(&mut h).await;
    assert!(!events.iter().any(
        |e| matches!(e, EngineEvent::RequestOpened { key, .. } if key.starts_with("follow-"))
    ));
    assert_eq!(
        text(&events),
        "batch: value-0,value-1,value-2,value-3,value-4,value-5,value-6,value-7,value-8"
    );
    h.session.shutdown().await;
}

#[tokio::test]
async fn ordinary_approval_and_decline_are_not_cached_and_cache_is_session_local() {
    let mut h = start("pi-approval-ordinary").await;
    for outcome in [
        RequestOutcome::Accept,
        RequestOutcome::Decline,
        RequestOutcome::AcceptForSession,
    ] {
        accepted(h.session.start_turn(input("approval"), &settings()).await);
        let key = opened(&mut h).await;
        h.session
            .answer_request(
                &key,
                RequestAnswer {
                    outcome,
                    text: None,
                    answers: None,
                },
            )
            .await
            .unwrap();
        finished(&mut h).await;
    }
    let mut other = start("pi-approval-other-session").await;
    accepted(
        other
            .session
            .start_turn(input("approval"), &settings())
            .await,
    );
    let key = opened(&mut other).await;
    other
        .session
        .answer_request(
            &key,
            RequestAnswer {
                outcome: RequestOutcome::Decline,
                text: None,
                answers: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(text(&finished(&mut other).await), "answer: false");
    other.session.shutdown().await;
    h.session.shutdown().await;
}

#[tokio::test]
async fn approval_for_session_is_reused() {
    let mut h = start("pi-approval-cache").await;
    accepted(h.session.start_turn(input("approval"), &settings()).await);
    let key = loop {
        if let EngineEvent::RequestOpened { key, .. } = next(&mut h).await {
            break key;
        }
    };
    h.session
        .answer_request(
            &key,
            RequestAnswer {
                outcome: RequestOutcome::AcceptForSession,
                text: None,
                answers: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(text(&finished(&mut h).await), "answer: true");
    accepted(h.session.start_turn(input("approval"), &settings()).await);
    let events = finished(&mut h).await;
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, EngineEvent::RequestOpened { .. }))
    );
    assert_eq!(text(&events), "answer: true");
    h.session.shutdown().await;
}

#[tokio::test]
async fn factory_for_driver_starts_both_profiles() {
    for driver in [EngineDriver::Pi, EngineDriver::Omo] {
        let factory = PiFactory::for_driver(driver).unwrap();
        let mut h = factory.start(spec("pi-driver-factory")).await.unwrap();
        accepted(h.session.start_turn(input("hello"), &settings()).await);
        assert_eq!(text(&finished(&mut h).await), "echo: hello");
        h.session.shutdown().await;
    }
    assert!(PiFactory::for_driver(EngineDriver::Codex).is_none());
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
        h.session.steer(&turn, input("decline-steer")).await,
        SteerResult::Declined { .. }
    ));
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
async fn steer_returns_unknown_when_process_dies_before_ack() {
    let mut h = start("pi-steer-crash").await;
    let turn = accepted(h.session.start_turn(input("hang"), &settings()).await);
    let steer = h.session.steer(&turn, input("crash-steer"));
    tokio::pin!(steer);
    let result = tokio::select! {
        result = &mut steer => result,
        event = h.events.recv() => {
            assert!(matches!(event, Some(EngineEvent::Exited { .. })));
            std::future::poll_fn(|cx| match steer.as_mut().poll(cx) {
                std::task::Poll::Ready(result) => std::task::Poll::Ready(result),
                std::task::Poll::Pending => panic!("steer remained pending after EOF"),
            }).await
        }
    };
    assert!(matches!(result, SteerResult::Unknown { .. }));
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
    let mut config = spec("pi-mcp");
    config
        .launch
        .as_mut()
        .unwrap()
        .env
        .insert("GOAT_MCP_URL".into(), "http://wrong.invalid".into());
    config
        .launch
        .as_mut()
        .unwrap()
        .env
        .insert("GOAT_MCP_BEARER_TOKEN".into(), "wrong".into());
    let mut h = factory(PiProfile::Pi)
        .start(config)
        .await
        .expect("fake starts");
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
    let mut config = spec("omo-env");
    config
        .launch
        .as_mut()
        .unwrap()
        .env
        .insert("SENPI_RPC_HOST_IDLE_EXIT_MS".into(), "999".into());
    config
        .launch
        .as_mut()
        .unwrap()
        .env
        .insert("SENPI_RPC_HOST_EMPTY_EXIT_MS".into(), "999".into());
    let mut h = factory(PiProfile::Omo)
        .start(config)
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
    selected.model_selection.model = "vendor/nested/custom/model".into();
    selected.model_selection.options = Some(vec![
        ProviderOptionSelection {
            id: "thinking".into(),
            value: ProviderOptionSelectionValue::Text("high".into()),
        },
        ProviderOptionSelection {
            id: "serviceTier".into(),
            value: ProviderOptionSelectionValue::Text("priority".into()),
        },
    ]);
    h.session.set_config(&selected).await.expect("configure");
    accepted(
        h.session
            .start_turn(input("inspect-config"), &selected)
            .await,
    );
    assert_eq!(
        text(&finished(&mut h).await),
        "vendor/nested|custom/model:high:priority"
    );
    h.session.shutdown().await;
}

#[tokio::test]
async fn prompt_dialog_can_open_before_acknowledgment() {
    let mut h = start("pi-dialog-before-ack").await;
    let turn = tokio::time::timeout(
        Duration::from_secs(2),
        h.session
            .start_turn(input("dialog-before-ack"), &settings()),
    )
    .await
    .expect("start must not wait for dialog ACK");
    accepted(turn);
    let key = match next(&mut h).await {
        EngineEvent::RequestOpened { key, .. } => key,
        other => panic!("expected dialog: {other:?}"),
    };
    h.session
        .answer_request(
            &key,
            RequestAnswer {
                outcome: RequestOutcome::Answered,
                text: Some("yes".into()),
                answers: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(text(&finished(&mut h).await), "answer: yes");
    h.session.shutdown().await;
}

#[tokio::test]
async fn command_only_and_late_ack_both_settle_once() {
    let mut h = start("pi-ack-order").await;
    accepted(
        h.session
            .start_turn(input("command-only"), &settings())
            .await,
    );
    assert!(matches!(
        finished(&mut h).await.last(),
        Some(EngineEvent::TurnFinished {
            outcome: TurnOutcome::Done,
            ..
        })
    ));
    accepted(h.session.start_turn(input("late-ack"), &settings()).await);
    let events = finished(&mut h).await;
    assert_eq!(text(&events), "late");
    assert_eq!(
        events
            .iter()
            .filter(|e| matches!(e, EngineEvent::TurnFinished { .. }))
            .count(),
        1
    );
    h.session.shutdown().await;
}

#[tokio::test]
async fn slash_command_without_disposition_settles() {
    let mut h = start("pi-consumed-command").await;
    accepted(
        h.session
            .start_turn(input("/consumed-no-disposition"), &settings())
            .await,
    );
    let events = finished(&mut h).await;
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
async fn settled_before_compaction_recovery_keeps_turn_open() {
    for scenario in [
        "compaction-recovery",
        "pending-recovery",
        "stale-recovery",
        "stale-agent-recovery",
    ] {
        let mut h = start(scenario).await;
        accepted(h.session.start_turn(input(scenario), &settings()).await);
        let events = finished(&mut h).await;
        assert_eq!(text(&events), "recovered", "{scenario}");
        assert!(matches!(
            events.last(),
            Some(EngineEvent::TurnFinished {
                outcome: TurnOutcome::Done,
                ..
            })
        ));
        h.session.shutdown().await;
    }
}

#[tokio::test]
async fn concurrent_dialog_responses_are_sent_only_once() {
    let mut h = start("pi-concurrent-dialog").await;
    accepted(h.session.start_turn(input("question"), &settings()).await);
    let key = match next(&mut h).await {
        EngineEvent::RequestOpened { key, .. } => key,
        other => panic!("expected dialog: {other:?}"),
    };
    let answer = RequestAnswer {
        outcome: RequestOutcome::Answered,
        text: Some("yes".into()),
        answers: None,
    };
    let (a, b) = tokio::join!(
        h.session.answer_request(&key, answer.clone()),
        h.session.answer_request(&key, answer)
    );
    assert_ne!(a.is_ok(), b.is_ok());
    assert_eq!(text(&finished(&mut h).await), "answer: yes");
    h.session.shutdown().await;
}

#[tokio::test]
async fn background_subagent_update_is_projected_after_turn_settles() {
    let mut h = start("pi-background").await;
    accepted(
        h.session
            .start_turn(input("async-subagent"), &settings())
            .await,
    );
    assert_eq!(text(&finished(&mut h).await), "spawned");
    assert!(matches!(
        next(&mut h).await,
        EngineEvent::SubagentUpdate { .. }
    ));
    assert!(
        matches!(next(&mut h).await, EngineEvent::ItemCompleted { item, .. } if matches!(item.body, TurnItemBody::Subagent { .. }))
    );
    h.session.shutdown().await;
}

#[tokio::test]
async fn rejected_abort_does_not_claim_interruption() {
    let mut h = start("pi-rejected-abort").await;
    let turn = accepted(
        h.session
            .start_turn(input("hang-reject-abort"), &settings())
            .await,
    );
    assert!(h.session.interrupt(&turn).await.is_err());
    assert!(matches!(
        finished(&mut h).await.last(),
        Some(EngineEvent::TurnFinished {
            outcome: TurnOutcome::Done,
            ..
        })
    ));
    h.session.shutdown().await;
}

#[tokio::test]
async fn background_dialog_fails_visibly_when_there_is_no_owned_turn() {
    let mut h = start("pi-background-dialog").await;
    accepted(
        h.session
            .start_turn(input("background-dialog"), &settings())
            .await,
    );
    assert_eq!(text(&finished(&mut h).await), "done");
    assert!(
        matches!(next(&mut h).await, EngineEvent::Exited { reason } if reason.contains("outside a host-owned turn"))
    );
    h.session.shutdown().await;
}
