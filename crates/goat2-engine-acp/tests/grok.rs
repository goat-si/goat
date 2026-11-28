//! Grok flavor exercised against the offline ACP mock (`goat2-acp-mock-agent`). Each test is one
//! distinctive v1 Grok behavior; the fake agent's scenarios are listed in its module docs.
use goat2_contracts::{
    ApprovalDecision, EngineConfig, ModelSelection, ProviderOptionSelection,
    ProviderOptionSelectionValue, RequestKind, RequestOutcome, RuntimeMode, TurnItem, TurnItemBody,
    TurnItemStatus,
};
use goat2_engine_acp::{AcpEngineFactory, agents::grok::Grok, agents::grok_tools};
use goat2_engine_api::{
    EngineEvent, EngineFactory, EngineHandle, EngineInput, LaunchSpec, McpEndpoint, RequestAnswer,
    SessionSpec, TurnOutcome, TurnSettings, TurnStartResult,
};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path, sync::Arc, time::Duration};

const TASK: &str = "11111111-2222-3333-4444-555555555555";

struct Session {
    handle: EngineHandle,
    settings: TurnSettings,
    _dir: tempfile::TempDir,
    log: std::path::PathBuf,
}

fn selection(effort: Option<&str>) -> ModelSelection {
    ModelSelection {
        instance_id: "grok".into(),
        model: "grok-build".into(),
        options: effort.map(|e| {
            vec![ProviderOptionSelection {
                id: "reasoningEffort".into(),
                value: ProviderOptionSelectionValue::Text(e.into()),
            }]
        }),
    }
}

/// Start Grok on the fake agent. `debounce` is the deferred-finalize debounce (v1 3 s).
async fn start_with(
    env: &[(&str, &str)],
    mode: RuntimeMode,
    selection: ModelSelection,
    debounce: Duration,
) -> Session {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("requests.jsonl");
    let mut launch_env: BTreeMap<String, String> = env
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    launch_env.insert(
        "GOAT_ACP_REQUEST_LOG_PATH".into(),
        log.to_string_lossy().into_owned(),
    );
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
            env: launch_env,
        }),
    };
    let handle = AcpEngineFactory::new(Arc::new(Grok::default()))
        .with_mcp_bridge(goat2_engine_acp::McpBridgeCommand::new(
            "/goat2-test/bin/goat2-acp-mcp-bridge",
            Vec::<String>::new(),
        ))
        .with_deferred_finalize(debounce)
        .start(spec)
        .await
        .unwrap();
    Session {
        handle,
        settings: TurnSettings {
            model_selection: selection,
            runtime_mode: mode,
        },
        _dir: dir,
        log,
    }
}

async fn start(env: &[(&str, &str)]) -> Session {
    start_with(
        env,
        RuntimeMode::ApprovalRequired,
        selection(None),
        Duration::ZERO,
    )
    .await
}

async fn send(session: &Session, text: &str) {
    let started = session
        .handle
        .session
        .start_turn(
            vec![EngineInput {
                input_id: "i".into(),
                text: text.into(),
                attachments: vec![],
            }],
            &session.settings,
        )
        .await;
    assert!(
        matches!(started, TurnStartResult::Accepted { .. }),
        "{started:?}"
    );
}

async fn next(session: &mut Session) -> EngineEvent {
    tokio::time::timeout(Duration::from_secs(10), session.handle.events.recv())
        .await
        .expect("event in time")
        .expect("event")
}

/// Events until the turn finishes, answering each opened request with `answer`.
async fn until_finished(
    session: &mut Session,
    answer: impl Fn(&EngineEvent) -> Option<(String, RequestAnswer)>,
) -> (Vec<EngineEvent>, TurnOutcome) {
    let mut events = Vec::new();
    loop {
        let event = next(session).await;
        if let Some((key, reply)) = answer(&event) {
            session
                .handle
                .session
                .answer_request(&key, reply)
                .await
                .unwrap();
        }
        if let EngineEvent::TurnFinished { outcome, .. } = &event {
            let outcome = outcome.clone();
            events.push(event);
            return (events, outcome);
        }
        events.push(event);
    }
}

/// Wait for streamed text containing `needle`.
async fn until_text(session: &mut Session, needle: &str) {
    loop {
        if let EngineEvent::TextDelta { text, .. } = next(session).await
            && text.contains(needle)
        {
            return;
        }
    }
}

/// One turn on a fresh session; returns the events and the outcome.
async fn grok_turn_events(
    env: &[(&str, &str)],
    answer: impl Fn(&EngineEvent) -> Option<(String, RequestAnswer)>,
) -> (Vec<EngineEvent>, TurnOutcome) {
    let mut session = start(env).await;
    send(&session, "hello").await;
    let result = until_finished(&mut session, answer).await;
    session.handle.session.shutdown().await;
    result
}

async fn scenario(name: &str) -> (Vec<EngineEvent>, TurnOutcome) {
    grok_turn_events(&[("GOAT_ACP_GROK_SCENARIO", name)], |_| None).await
}

/// One turn against the fake agent's xAI completion, with extra fake-agent env.
async fn grok_turn(extra: &[(&str, &str)]) -> TurnOutcome {
    let mut env = vec![("GOAT_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG", "1")];
    env.extend_from_slice(extra);
    grok_turn_events(&env, |_| None).await.1
}

fn items(events: &[EngineEvent]) -> Vec<&TurnItem> {
    events
        .iter()
        .filter_map(|e| match e {
            EngineEvent::ItemCompleted { item, .. } => Some(item.as_ref()),
            _ => None,
        })
        .collect()
}

fn native_item<'a>(events: &'a [EngineEvent], native_id: &str) -> Vec<&'a TurnItem> {
    items(events)
        .into_iter()
        .filter(|item| {
            item.native_item_ref
                .as_ref()
                .and_then(|r| r.native_id.as_deref())
                == Some(native_id)
        })
        .collect()
}

fn answer_text(events: &[EngineEvent]) -> String {
    items(events)
        .into_iter()
        .filter_map(|item| match &item.body {
            TurnItemBody::AssistantMessage { text, .. } => Some(text.clone()),
            _ => None,
        })
        .collect()
}

fn read_log(path: &Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

fn logged<'a>(log: &'a [Value], method: &str) -> Vec<&'a Value> {
    log.iter()
        .filter(|m| m.get("method").and_then(Value::as_str) == Some(method))
        .collect()
}

/// v1 grok adapter.ts:200-230: Grok's question stays open until the person answers, and the
/// answer goes back in xAI's shape.
#[tokio::test]
async fn ask_user_question_waits_for_the_answer() {
    let (events, outcome) = grok_turn_events(
        &[
            ("GOAT_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG", "1"),
            ("GOAT_ACP_EMIT_XAI_ASK_USER_QUESTION", "1"),
        ],
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
                        answers: Some(json!({"Which color?": "Blue"}).as_object().unwrap().clone()),
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
    let (events, outcome) = grok_turn_events(
        &[
            ("GOAT_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG", "1"),
            ("GOAT_ACP_EMIT_XAI_EXIT_PLAN_MODE", "1"),
        ],
        |_| None,
    )
    .await;
    assert_eq!(outcome, TurnOutcome::Done);
    assert!(items(&events).iter().any(|item| matches!(&item.body,
        TurnItemBody::ProposedPlan { markdown, .. } if markdown == "# Plan\n\n1. Do it")));
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

fn subagent_items(events: &[EngineEvent]) -> Vec<(TurnItemStatus, String, Option<String>)> {
    items(events)
        .into_iter()
        .filter_map(|item| match &item.body {
            TurnItemBody::Subagent { prompt, result, .. } => {
                Some((item.status, prompt.clone(), result.clone()))
            }
            _ => None,
        })
        .collect()
}

/// v1 extractXAiAcpSubagentUpdate (xaiAcpExtension.ts:792-859) through emitSubagent
/// (adapter.ts:1790-2020): the spawn ACK opens a running subagent, the get-output poll finishes
/// it, and neither call is shown as a plain tool.
#[tokio::test]
async fn spawn_ack_and_hydration_finish_the_subagent() {
    let (events, outcome) = scenario("subagent-hydrate").await;
    assert_eq!(outcome, TurnOutcome::Done);
    let updates: Vec<TurnItemStatus> = events
        .iter()
        .filter_map(|e| match e {
            EngineEvent::SubagentUpdate {
                subagent_id,
                status,
                title,
                ..
            } => {
                assert_eq!(subagent_id, "spawn-1");
                assert_eq!(title.as_deref(), Some("File counter"));
                Some(*status)
            }
            _ => None,
        })
        .collect();
    // v1 emitSubagent reports every spawn update while running, then the terminal once.
    assert_eq!(updates.first(), Some(&TurnItemStatus::Running));
    assert_eq!(updates.last(), Some(&TurnItemStatus::Completed));
    assert_eq!(
        updates
            .iter()
            .filter(|s| **s == TurnItemStatus::Completed)
            .count(),
        1
    );
    assert_eq!(
        subagent_items(&events),
        [(
            TurnItemStatus::Completed,
            "Count the files".to_string(),
            Some("42 files".to_string())
        )]
    );
    assert!(native_item(&events, "poll-1").is_empty());
    assert_eq!(native_item(&events, "spawn-1").len(), 1);
}

/// v1 registerXAiSubagentFinished (xaiAcpExtension.ts:487-524) with deferFinalizeForBackgroundWork
/// (adapter.ts:471): the prompt answers while the subagent runs, the turn stays open (text after
/// the answer still belongs to it) and `subagent_finished` ends it.
#[tokio::test]
async fn subagent_finished_notification_ends_the_deferred_turn() {
    let (events, outcome) = scenario("subagent-finished").await;
    assert_eq!(outcome, TurnOutcome::Done);
    assert!(
        answer_text(&events).contains("after answer"),
        "{}",
        answer_text(&events)
    );
    assert_eq!(
        subagent_items(&events),
        [(
            TurnItemStatus::Completed,
            "Count the files".to_string(),
            Some("done counting".to_string())
        )]
    );
}

/// v1 extractXAiAcpSubagentEndNotice (xaiAcpExtension.ts:674-689) as used in adapter.ts:4088-4111.
#[tokio::test]
async fn subagent_end_notice_in_user_text_finishes_the_subagent() {
    let (events, outcome) = scenario("subagent-notice").await;
    assert_eq!(outcome, TurnOutcome::Done);
    assert_eq!(
        subagent_items(&events),
        [(
            TurnItemStatus::Completed,
            "Count the files".to_string(),
            None
        )]
    );
}

/// v1 xAiBackgroundShellTaskId + normalizeXAiAcpToolCallState (xaiAcpExtension.ts:262-271,
/// 586-588) and registerXAiBackgroundTaskTracking (:467-485): a background command stays open
/// after its tool call completes; the turn waits for `x.ai/task_completed`.
#[tokio::test]
async fn background_command_holds_the_turn_until_the_task_completes() {
    let (events, outcome) = scenario("background").await;
    assert_eq!(outcome, TurnOutcome::Done);
    assert!(
        answer_text(&events).contains("after answer"),
        "{}",
        answer_text(&events)
    );
    let tool = native_item(&events, "bg-1");
    assert_eq!(tool.len(), 1);
    assert_eq!(tool[0].status, TurnItemStatus::Completed);
    assert!(
        matches!(&tool[0].body, TurnItemBody::CommandExecution { input, .. } if input == "npm run build")
    );
}

/// v1 isXAiTaskCompletedWakeNotification (xaiAcpExtension.ts:78-87) at adapter.ts:3882-3899: once
/// the background work ended, Grok's own wake turn finishes the run at once (well inside the
/// 60 s debounce here) and its frames are not part of it.
#[tokio::test]
async fn wake_turn_finishes_the_run_without_joining_it() {
    let mut session = start_with(
        &[("GOAT_ACP_GROK_SCENARIO", "wake")],
        RuntimeMode::ApprovalRequired,
        selection(None),
        Duration::from_secs(60),
    )
    .await;
    send(&session, "hello").await;
    let (events, outcome) = until_finished(&mut session, |_| None).await;
    session.handle.session.shutdown().await;
    assert_eq!(outcome, TurnOutcome::Done);
    assert!(!answer_text(&events).contains("wake report"));
    assert_eq!(
        native_item(&events, "bg-1")[0].status,
        TurnItemStatus::Completed
    );
}

/// v1 isXAiMonitorTool / extractXAiMonitorTaskId / extractXAiAcpBackgroundToolMutation
/// (xaiAcpExtension.ts:248-296, 602-657): a monitor holds the turn until its task completes; a
/// persistent one (isXAiPersistentMonitor, :298-307) does not.
#[tokio::test]
async fn monitors_hold_the_turn_unless_persistent() {
    let (events, outcome) = scenario("monitor").await;
    assert_eq!(outcome, TurnOutcome::Done);
    assert!(answer_text(&events).contains("after answer"));
    let monitor = native_item(&events, "monitor-1");
    assert_eq!(monitor[0].status, TurnItemStatus::Completed);
    assert_eq!(monitor[0].title.as_deref(), Some("Monitor: watch build"));

    let (events, outcome) = scenario("monitor-persistent").await;
    assert_eq!(outcome, TurnOutcome::Done);
    assert!(!answer_text(&events).contains("after answer"));
    assert_eq!(native_item(&events, "monitor-1").len(), 1);
}

/// v1 extractXAiKilledBackgroundTasks (xaiAcpExtension.ts:343-380) on every v1 kill shape
/// (acpMockGrokScenarios.ts): a finished kill ends the background command, so the turn is not
/// held; a task that already failed stays failed.
#[tokio::test]
async fn kill_ends_the_background_command_in_every_v1_shape() {
    for (shape, status) in [
        ("killed", TurnItemStatus::Completed),
        ("already_exited", TurnItemStatus::Completed),
        ("known_failure", TurnItemStatus::Failed),
        ("output_only", TurnItemStatus::Completed),
        ("variant_only", TurnItemStatus::Completed),
    ] {
        let (events, outcome) =
            grok_turn_events(&[("GOAT_ACP_GROK_KILL_TASK_SHAPE", shape)], |_| None).await;
        assert_eq!(outcome, TurnOutcome::Done, "{shape}");
        let target = native_item(&events, "kill-target-command");
        assert_eq!(target.len(), 1, "{shape}");
        assert_eq!(target[0].status, status, "{shape}");
        assert_eq!(
            native_item(&events, "kill-command")[0].status,
            TurnItemStatus::Completed
        );
    }
}

/// v1 GOAT_ACP_EMIT_GROK_MONITOR_POST_TURN_POLL: a structured Monitor holds the turn after the
/// prompt completes; its TaskOutput poll ends it and is not mistaken for a subagent (adapter.ts:
/// 2618-2621).
#[tokio::test]
async fn monitor_poll_after_the_answer_ends_the_monitor() {
    let (events, outcome) = grok_turn_events(
        &[("GOAT_ACP_EMIT_GROK_MONITOR_POST_TURN_POLL", "1")],
        |_| None,
    )
    .await;
    assert_eq!(outcome, TurnOutcome::Done);
    let monitor = native_item(&events, "call-monitor-1");
    assert_eq!(monitor[0].status, TurnItemStatus::Completed);
    assert_eq!(native_item(&events, "call-monitor-poll-1").len(), 1);
    assert!(subagent_items(&events).is_empty());
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, EngineEvent::SubagentUpdate { .. }))
    );
}

/// v1 GOAT_ACP_GROK_BACKGROUND_TASK_COMPLETION=poll: the command's TaskOutput poll completes it and
/// a `turn_completed` on `_x.ai/session/update` finishes the turn while `session/prompt` never
/// answers (the Grok incident).
#[tokio::test]
async fn polled_background_command_completes_and_turn_completed_settles() {
    let (events, outcome) = grok_turn_events(
        &[("GOAT_ACP_GROK_BACKGROUND_TASK_COMPLETION", "poll")],
        |_| None,
    )
    .await;
    assert_eq!(outcome, TurnOutcome::Done);
    assert!(answer_text(&events).contains("The background command finished."));
    let command = native_item(&events, "call-fb9d0000-0000-0000-0000-000000000026-29");
    assert_eq!(command[0].status, TurnItemStatus::Completed);
    assert!(subagent_items(&events).is_empty());
}

/// v1 preserveRuntimeOnSettledInterrupt (adapter.ts:359-360, 7874-8082): stopping a turn whose
/// prompt already answered sends no `session/cancel` and keeps the agent for the next turn.
#[tokio::test]
async fn interrupt_after_the_answer_keeps_grok_running() {
    let mut session = start(&[("GOAT_ACP_GROK_SCENARIO", "hold")]).await;
    send(&session, "hello").await;
    until_text(&mut session, "waiting").await;
    let turn_id = "acp-turn-mock-session-1-1";
    session.handle.session.interrupt(turn_id).await.unwrap();
    let (_, outcome) = until_finished(&mut session, |_| None).await;
    assert_eq!(outcome, TurnOutcome::Interrupted);
    send(&session, "again").await;
    until_text(&mut session, "waiting").await;
    session.handle.session.shutdown().await;
    let log = read_log(&session.log);
    assert!(logged(&log, "session/cancel").is_empty());
    assert_eq!(logged(&log, "session/prompt").len(), 2);
}

/// v1 extractGrokPlanMarkdownFromToolCallData (xaiAcpExtension.ts:1037-1086) feeding
/// lastProposedPlanMarkdown (adapter.ts:1252-1258): Grok's session plan file is the proposed plan
/// and the exit_plan_mode fallback, captured once.
#[tokio::test]
async fn plan_file_is_the_exit_plan_fallback() {
    let (events, outcome) = scenario("plan-file").await;
    assert_eq!(outcome, TurnOutcome::Done);
    let plans: Vec<&str> = items(&events)
        .into_iter()
        .filter_map(|item| match &item.body {
            TurnItemBody::ProposedPlan { markdown, .. } => Some(markdown.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(plans, ["# File plan\n\n- step one"]);
    assert!(answer_text(&events).contains(r#""outcome":"abandoned""#));
    assert_eq!(native_item(&events, "write-plan").len(), 1);
}

/// v1 auto mode (adapter.ts:429-431) and grokApprovalOptions (acpSupport.ts:199-215): in Auto the
/// permission request reaches the person, without the persistent always-allow choice.
#[tokio::test]
async fn auto_mode_permission_asks_with_grok_choices() {
    let mut session = start_with(
        &[("GOAT_ACP_PERMISSION_REQUEST_COUNT", "1")],
        RuntimeMode::Auto,
        selection(None),
        Duration::ZERO,
    )
    .await;
    send(&session, "hello").await;
    let (events, outcome) = until_finished(&mut session, |event| match event {
        EngineEvent::RequestOpened {
            key, kind, item, ..
        } => {
            assert_eq!(*kind, RequestKind::Approval);
            let Some(TurnItemBody::ApprovalRequest { options, .. }) =
                item.as_ref().map(|i| i.body.clone())
            else {
                panic!("approval item");
            };
            let decisions: Vec<ApprovalDecision> =
                options.unwrap().into_iter().map(|o| o.decision).collect();
            assert_eq!(
                decisions,
                [
                    ApprovalDecision::Cancel,
                    ApprovalDecision::Decline,
                    ApprovalDecision::Accept
                ]
            );
            Some((
                key.clone(),
                RequestAnswer {
                    outcome: RequestOutcome::Accept,
                    text: None,
                    answers: None,
                },
            ))
        }
        _ => None,
    })
    .await;
    session.handle.session.shutdown().await;
    assert_eq!(outcome, TurnOutcome::Done);
    assert!(answer_text(&events).contains(r#""optionId":"allow-once""#));
}

/// v1 applyGrokSessionModelSelection (adapter.ts:263-321): on protocol 1 the effort rides on
/// `session/set_model` metadata; when Grok refuses it, the model is set without it.
#[tokio::test]
async fn effort_rides_on_set_model_and_is_skipped_when_refused() {
    let session = start_with(
        &[("GOAT_ACP_GROK_MODELS", "1")],
        RuntimeMode::ApprovalRequired,
        selection(Some("high")),
        Duration::ZERO,
    )
    .await;
    session.handle.session.shutdown().await;
    let log = read_log(&session.log);
    let writes = logged(&log, "session/set_model");
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0]["params"]["modelId"], "grok-4.6");
    assert_eq!(
        writes[0]["params"]["_meta"],
        json!({"reasoningEffort": "high"})
    );

    // Refused on the current model: nothing else to write, the session still opens.
    let refused = [
        ("GOAT_ACP_GROK_MODELS", "1"),
        ("GOAT_ACP_REJECT_SET_MODEL_META", "1"),
    ];
    let session = start_with(
        &refused,
        RuntimeMode::ApprovalRequired,
        selection(Some("high")),
        Duration::ZERO,
    )
    .await;
    session.handle.session.shutdown().await;
    let log = read_log(&session.log);
    let writes = logged(&log, "session/set_model");
    assert_eq!(writes.len(), 1);
    assert!(writes[0]["params"].get("_meta").is_some());

    // Refused with a model change: the model is set again without the effort.
    let mut other = selection(Some("high"));
    other.model = "grok-fast".into();
    let session = start_with(
        &refused,
        RuntimeMode::ApprovalRequired,
        other,
        Duration::ZERO,
    )
    .await;
    session.handle.session.shutdown().await;
    let log = read_log(&session.log);
    let writes = logged(&log, "session/set_model");
    assert_eq!(writes.len(), 2);
    assert_eq!(
        writes[0]["params"]["_meta"],
        json!({"reasoningEffort": "high"})
    );
    assert!(writes[1]["params"].get("_meta").is_none());
    assert_eq!(writes[1]["params"]["modelId"], "grok-fast");

    // An effort the model does not offer is not sent at all.
    let session = start_with(
        &[("GOAT_ACP_GROK_MODELS", "1")],
        RuntimeMode::ApprovalRequired,
        selection(Some("max")),
        Duration::ZERO,
    )
    .await;
    session.handle.session.shutdown().await;
    assert!(logged(&read_log(&session.log), "session/set_model").is_empty());
}

/// v1 resolveXAiAcpToolTitle + truncateCommandTitle (xaiAcpExtension.ts:531-557, commandTitle.ts)
/// and normalizeXAiMcpToolCall on the merged tool state (adapter.ts:2486-2487): a generic title
/// becomes the cut command, and a `use_tool` call split over three updates is an MCP call.
#[tokio::test]
async fn command_titles_and_split_mcp_calls_are_normalized() {
    let (events, outcome) = scenario("tools").await;
    assert_eq!(outcome, TurnOutcome::Done);
    let command = format!("echo {}", "a".repeat(100));
    let long = native_item(&events, "long-1");
    assert_eq!(
        long[0].title,
        Some(grok_tools::truncate_command_title(&command))
    );
    assert!(long[0].title.as_deref().unwrap().ends_with("..."));
    let mcp = native_item(&events, "mcp-1");
    assert_eq!(mcp[0].status, TurnItemStatus::Completed);
    assert!(
        matches!(&mcp[0].body, TurnItemBody::DynamicTool { input, .. }
        if *input == json!({"server": "goat", "tool": "thread_read", "arguments": {"id": "t1"}}))
    );
}

/// v1 grok rewriteUserText (adapter.ts:365-383, skills.ts): a leading `$name` naming an enabled
/// skill from `grok inspect --json` is sent as `/name`; other text is left alone.
#[tokio::test]
async fn skill_mentions_become_slash_commands() {
    let inspect = r#"{"skills": [{"name": "deploy", "source": {"path": "/s/deploy"}},
        {"name": "hidden", "source": {"path": "/s/hidden"}, "userInvocable": false}]}"#;
    let mut session = start(&[
        ("GOAT_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG", "1"),
        ("GOAT_ACP_GROK_INSPECT_JSON", inspect),
    ])
    .await;
    for text in ["$deploy ship it", "$hidden now", "$25 please"] {
        send(&session, text).await;
        let (_, outcome) = until_finished(&mut session, |_| None).await;
        assert_eq!(outcome, TurnOutcome::Done);
    }
    session.handle.session.shutdown().await;
    let log = read_log(&session.log);
    let sent: Vec<&str> = logged(&log, "session/prompt")
        .iter()
        .map(|m| m["params"]["prompt"][0]["text"].as_str().unwrap())
        .collect();
    assert_eq!(sent, ["/deploy ship it", "$hidden now", "$25 please"]);
    let _ = TASK;
}
/// v1 xAI cancel (xaiAcpExtension.ts:1553-1560, abortPendingPromptCompletions :1323-1357): Stop
/// settles a prompt Grok never answers as cancelled at once, instead of waiting out the 15 s
/// cancel timeout.
#[tokio::test]
async fn stop_settles_a_wedged_prompt_at_once() {
    let mut session = start(&[
        ("GOAT_ACP_HANG_PROMPT_FOREVER", "1"),
        ("GOAT_ACP_IGNORE_CANCEL", "1"),
    ])
    .await;
    send(&session, "hello").await;
    until_text(&mut session, "partial before stall").await;
    tokio::time::timeout(
        Duration::from_secs(5),
        session
            .handle
            .session
            .interrupt("acp-turn-mock-session-1-1"),
    )
    .await
    .expect("interrupt returns without the cancel timeout")
    .unwrap();
    let (_, outcome) = until_finished(&mut session, |_| None).await;
    session.handle.session.shutdown().await;
    assert_eq!(outcome, TurnOutcome::Interrupted);
}
