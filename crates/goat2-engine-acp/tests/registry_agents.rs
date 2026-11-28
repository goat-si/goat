//! Registry agents (v1 `packages/provider-acp-registry/src/server/*Acp.ts@916b5ccc1b2`) through the
//! real [AcpEngineFactory] and the fake agent (`src/bin/acp_mock_agent.rs`, `GOAT_ACP_SCRIPT` steps
//! shaped like the traffic in v1's per-agent tests). No real agent, login or network.

use std::path::{Path, PathBuf};
use std::time::Duration;

use goat2_contracts::{
    EngineConfig, ModelSelection, ProviderInstanceId, RequestKind, RequestOutcome, RuntimeMode,
    ThreadId, TurnItem, TurnItemBody, TurnItemStatus,
};
use goat2_engine_acp::registry::RegistryAgentFlavor;
use goat2_engine_acp::{AcpEngineFactory, AcpFlavor, AcpTimeouts, LaunchCommand, McpBridgeCommand};
use goat2_engine_api::{
    EngineEvent, EngineFactory, EngineHandle, EngineInput, McpEndpoint, RequestAnswer, SessionSpec,
    TurnOutcome, TurnSettings,
};
use serde_json::{Value, json};
use std::sync::Arc;

const TEST_BRIDGE: &str = "/goat2-test/bin/goat2-acp-mcp-bridge";

fn command(env: &[(&str, &str)]) -> LaunchCommand {
    let mut command = LaunchCommand::new(
        env!("CARGO_BIN_EXE_goat2-acp-mock-agent"),
        Vec::<String>::new(),
    );
    for (name, value) in env {
        command = command.env(*name, *value);
    }
    command
}

fn script(dir: &Path, steps: &[Value]) -> PathBuf {
    let path = dir.join("script.jsonl");
    let lines: Vec<String> = steps.iter().map(Value::to_string).collect();
    std::fs::write(&path, lines.join("\n")).unwrap();
    path
}

fn selection(model: &str) -> ModelSelection {
    ModelSelection {
        instance_id: ProviderInstanceId::new("registry"),
        model: model.into(),
        options: None,
    }
}

fn spec_with(cwd: &Path, mode: RuntimeMode, model: &str) -> SessionSpec {
    SessionSpec {
        thread_id: ThreadId::new("thread-1"),
        engine: EngineConfig {
            provider_instance_id: ProviderInstanceId::new("registry"),
            model_selection: selection(model),
            runtime_mode: mode,
            cwd: cwd.to_string_lossy().into_owned(),
        },
        resume: None,
        mcp: McpEndpoint {
            url: "http://127.0.0.1:9/mcp".into(),
            bearer_token: "test-token".into(),
        },
        host_generation: 1,
        process_generation: 1,
        instructions: None,
        launch: None,
    }
}

fn spec(cwd: &Path, mode: RuntimeMode) -> SessionSpec {
    spec_with(cwd, mode, "mock-default")
}

fn factory(flavor: RegistryAgentFlavor) -> AcpEngineFactory {
    AcpEngineFactory::new(Arc::new(flavor))
        .with_mcp_bridge(McpBridgeCommand::new(TEST_BRIDGE, Vec::<String>::new()))
        .with_timeouts(AcpTimeouts {
            request: Duration::from_secs(10),
            session_load: Duration::from_secs(10),
            cancel: Duration::from_secs(2),
        })
}

async fn start(flavor: RegistryAgentFlavor, dir: &Path, mode: RuntimeMode) -> EngineHandle {
    factory(flavor).start(spec(dir, mode)).await.expect("start")
}

async fn next(handle: &mut EngineHandle) -> EngineEvent {
    tokio::time::timeout(Duration::from_secs(10), handle.events.recv())
        .await
        .expect("event in time")
        .expect("event")
}

async fn until_finished(handle: &mut EngineHandle) -> (Vec<EngineEvent>, TurnOutcome) {
    let mut events = Vec::new();
    loop {
        let event = next(handle).await;
        if let EngineEvent::TurnFinished { outcome, .. } = &event {
            let outcome = outcome.clone();
            events.push(event);
            return (events, outcome);
        }
        events.push(event);
    }
}

async fn turn(handle: &mut EngineHandle, mode: RuntimeMode) -> (Vec<EngineEvent>, TurnOutcome) {
    handle
        .session
        .start_turn(
            vec![EngineInput {
                input_id: goat2_contracts::InputId::new("in-1"),
                text: "go".into(),
                attachments: vec![],
            }],
            &TurnSettings {
                model_selection: selection("mock-default"),
                runtime_mode: mode,
            },
        )
        .await;
    until_finished(handle).await
}

fn items(events: &[EngineEvent]) -> Vec<TurnItem> {
    events
        .iter()
        .filter_map(|e| match e {
            EngineEvent::ItemCompleted { item, .. } => Some((**item).clone()),
            _ => None,
        })
        .collect()
}

fn answer_text(events: &[EngineEvent]) -> String {
    items(events)
        .into_iter()
        .filter_map(|item| match item.body {
            TurnItemBody::AssistantMessage { text, .. } => Some(text),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("|")
}

/// (subagent id, status, progress) of every SubagentUpdate.
fn subagent_updates(events: &[EngineEvent]) -> Vec<(String, TurnItemStatus, Option<String>)> {
    events
        .iter()
        .filter_map(|e| match e {
            EngineEvent::SubagentUpdate {
                subagent_id,
                status,
                progress,
                ..
            } => Some((subagent_id.clone(), *status, progress.clone())),
            _ => None,
        })
        .collect()
}

fn subagent_item(events: &[EngineEvent], id: &str) -> TurnItem {
    items(events)
        .into_iter()
        .find(|item| matches!(&item.body, TurnItemBody::Subagent { subagent_id, .. } if subagent_id == id))
        .unwrap_or_else(|| panic!("no subagent item {id}: {events:#?}"))
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

/// v1 devinAcp.ts + adapter.ts:3817-3879: Devin's child updates reach the subagent instead of
/// being dropped, the launch tool is the subagent, and a generic tool title takes Devin's name.
#[tokio::test]
async fn devin_child_session_updates_reach_the_subagent() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("log.jsonl");
    let steps = script(
        dir.path(),
        &[
            json!({"update": {"sessionUpdate": "tool_call", "toolCallId": "spawn-1", "title": "Tool", "kind": "other", "status": "in_progress",
            "_meta": {"cognition.ai/subagent_started": {"agentId": "child-1", "task": "look around", "title": "Explorer", "model": "swe-1"}}}}),
            json!({"update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "child says hi"},
            "_meta": {"cognition.ai/subagent_context": {"parentAgentId": "child-1"}, "cognition.ai/streamingMessageId": "m1"}}}),
            json!({"update": {"sessionUpdate": "tool_call", "toolCallId": "child-tool", "title": "grep", "kind": "search", "status": "completed",
            "_meta": {"cognition.ai/subagent_context": {"parentAgentId": "child-1"}}}}),
            json!({"update": {"sessionUpdate": "tool_call_update", "toolCallId": "spawn-1", "status": "completed",
            "_meta": {"cognition.ai/subagent_completed": {"agentId": "child-1", "summary": "done looking"}}}}),
            json!({"update": {"sessionUpdate": "tool_call", "toolCallId": "read-1", "title": "Tool", "kind": "read", "status": "completed",
            "_meta": {"cognition.ai/inferenceToolName": "read_file"}}}),
        ],
    );
    let flavor = RegistryAgentFlavor::new(
        "devin",
        command(&[
            ("GOAT_ACP_SCRIPT", steps.to_str().unwrap()),
            ("GOAT_ACP_REQUEST_LOG_PATH", log.to_str().unwrap()),
        ]),
        false,
    );
    let mut handle = start(flavor, dir.path(), RuntimeMode::FullAccess).await;
    let (events, outcome) = turn(&mut handle, RuntimeMode::FullAccess).await;
    assert_eq!(outcome, TurnOutcome::Done);
    let updates = subagent_updates(&events);
    assert!(
        updates.contains(&(
            "child-1".into(),
            TurnItemStatus::Running,
            Some("child says hi".into())
        )),
        "{updates:?}"
    );
    assert!(
        updates.contains(&(
            "child-1".into(),
            TurnItemStatus::Running,
            Some("grep".into())
        )),
        "{updates:?}"
    );
    let item = subagent_item(&events, "child-1");
    assert_eq!(item.status, TurnItemStatus::Completed);
    assert_eq!(item.title.as_deref(), Some("Explorer"));
    match item.body {
        TurnItemBody::Subagent {
            prompt,
            result,
            progress,
            driver,
            provider_instance_id,
            ..
        } => {
            assert_eq!(prompt, "look around");
            assert_eq!(result.as_deref(), Some("done looking"));
            assert_eq!(progress.as_deref(), Some("child says hi"));
            assert_eq!(driver, "acpRegistry");
            assert_eq!(provider_instance_id, "registry");
        }
        other => panic!("{other:?}"),
    }
    let all = items(&events);
    assert!(
        !all.iter().any(|i| i.id.as_str().ends_with(":tool:spawn-1")),
        "the launch is the subagent"
    );
    assert!(all.iter().any(|i| i.title.as_deref() == Some("read_file")));
    // The child's chunk is not the root's answer.
    assert_eq!(answer_text(&events), "hello from mock");
    let init = read_log(&log);
    let meta = &logged(&init, "initialize")[0]["params"]["clientCapabilities"]["_meta"];
    assert_eq!(meta["cognition.ai/subagentSupport"], true);
    assert_eq!(meta["cognition.ai/messageGrouping"], true);
    handle.session.shutdown().await;
}

/// v1 copilotAcp.ts: a background task agent is attributed through the raw feed, its chunks go to
/// `copilot-task:<id>`, it stays running when its tool settles, and `subagent.completed` ends it.
#[tokio::test]
async fn copilot_background_agent_is_routed_and_finished_by_the_raw_feed() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("log.jsonl");
    let event = |kind: &str, agent: Option<&str>, data: Value| {
        let mut params = json!({"sessionId": "$SESSION", "type": kind, "data": data});
        if let Some(agent) = agent {
            params["agentId"] = json!(agent);
        }
        json!({"notify": "github.com/copilot/sessionEvent", "params": params})
    };
    let steps = script(
        dir.path(),
        &[
            event(
                "subagent.started",
                Some("a1"),
                json!({"toolCallId": "task-1"}),
            ),
            json!({"update": {"sessionUpdate": "tool_call", "toolCallId": "task-1", "title": "Map", "kind": "other", "status": "in_progress",
            "rawInput": {"agent_type": "explore", "prompt": "map the repo", "description": "Map", "mode": "background"}}}),
            event(
                "assistant.message_delta",
                Some("a1"),
                json!({"deltaContent": "scanning"}),
            ),
            json!({"update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "scanning"}}}),
            json!({"update": {"sessionUpdate": "tool_call_update", "toolCallId": "task-1", "status": "completed", "rawOutput": {"content": "started"}}}),
            event(
                "subagent.completed",
                Some("a1"),
                json!({"toolCallId": "task-1"}),
            ),
        ],
    );
    let flavor = RegistryAgentFlavor::new(
        "github-copilot-cli",
        command(&[
            ("GOAT_ACP_SCRIPT", steps.to_str().unwrap()),
            ("GOAT_ACP_REQUEST_LOG_PATH", log.to_str().unwrap()),
        ]),
        false,
    );
    let mut handle = start(flavor, dir.path(), RuntimeMode::FullAccess).await;
    let (events, outcome) = turn(&mut handle, RuntimeMode::FullAccess).await;
    assert_eq!(outcome, TurnOutcome::Done);
    let updates = subagent_updates(&events);
    assert!(
        updates.contains(&(
            "task-1".into(),
            TurnItemStatus::Running,
            Some("scanning".into())
        )),
        "{updates:?}"
    );
    // The settled launch tool leaves a background agent running; only the raw feed finishes it.
    let first_terminal = updates
        .iter()
        .position(|u| u.1 == TurnItemStatus::Completed)
        .unwrap();
    assert_eq!(updates[first_terminal - 1].1, TurnItemStatus::Running);
    let item = subagent_item(&events, "task-1");
    assert_eq!(item.status, TurnItemStatus::Completed);
    match item.body {
        TurnItemBody::Subagent { prompt, result, .. } => {
            assert_eq!(prompt, "map the repo");
            assert_eq!(result.as_deref(), Some("scanning"));
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(answer_text(&events), "hello from mock");
    let init = read_log(&log);
    let events_meta = &logged(&init, "initialize")[0]["params"]["clientCapabilities"]["_meta"]["github.com/copilot"]
        ["events"];
    assert!(
        events_meta
            .as_array()
            .unwrap()
            .contains(&json!("assistant.idle"))
    );
    handle.session.shutdown().await;
}

/// v1 adapter.ts:5440-5478: Copilot holds session/prompt while an async shell runs; its idle after
/// a turn start settles the turn.
#[tokio::test]
async fn copilot_idle_after_turn_start_completes_a_held_prompt() {
    let dir = tempfile::tempdir().unwrap();
    let event = |kind: &str| json!({"notify": "github.com/copilot/sessionEvent", "params": {"sessionId": "$SESSION", "type": kind, "data": {}}});
    let steps = script(
        dir.path(),
        &[
            event("assistant.idle"),
            event("assistant.turn_start"),
            json!({"update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "working"}}}),
            event("assistant.idle"),
            json!({"hang": true}),
        ],
    );
    let flavor = RegistryAgentFlavor::new(
        "github-copilot-cli",
        command(&[("GOAT_ACP_SCRIPT", steps.to_str().unwrap())]),
        false,
    );
    let mut handle = start(flavor, dir.path(), RuntimeMode::FullAccess).await;
    let (events, outcome) = turn(&mut handle, RuntimeMode::FullAccess).await;
    assert_eq!(outcome, TurnOutcome::Done);
    assert_eq!(answer_text(&events), "working");
    handle.session.shutdown().await;
}

/// v1 copilotAcp.ts:33-49 + adapter.ts:6982-6989: a lost Copilot session fails the turn and
/// replaces the process.
#[tokio::test]
async fn copilot_lost_session_restarts_the_agent() {
    let dir = tempfile::tempdir().unwrap();
    let steps = script(
        dir.path(),
        &[
            json!({"error": {"code": -32603, "message": "session event delivery failed: session not found: s1"}}),
        ],
    );
    let flavor = RegistryAgentFlavor::new(
        "github-copilot-cli",
        command(&[("GOAT_ACP_SCRIPT", steps.to_str().unwrap())]),
        false,
    );
    let mut handle = start(flavor, dir.path(), RuntimeMode::FullAccess).await;
    let (_, outcome) = turn(&mut handle, RuntimeMode::FullAccess).await;
    assert!(matches!(outcome, TurnOutcome::Failed { .. }), "{outcome:?}");
    loop {
        if let EngineEvent::Exited { reason } = next(&mut handle).await {
            assert!(reason.contains("prompt error"), "{reason}");
            break;
        }
    }
}

/// Other prompt errors keep the Copilot process.
#[tokio::test]
async fn copilot_other_prompt_errors_keep_the_agent() {
    let dir = tempfile::tempdir().unwrap();
    let steps = script(
        dir.path(),
        &[json!({"error": {"code": -32603, "message": "model overloaded"}})],
    );
    let flavor = RegistryAgentFlavor::new(
        "github-copilot-cli",
        command(&[("GOAT_ACP_SCRIPT", steps.to_str().unwrap())]),
        false,
    );
    let mut handle = start(flavor, dir.path(), RuntimeMode::FullAccess).await;
    let (_, outcome) = turn(&mut handle, RuntimeMode::FullAccess).await;
    assert!(matches!(outcome, TurnOutcome::Failed { .. }));
    // The same process takes the next turn.
    let (_, outcome) = turn(&mut handle, RuntimeMode::FullAccess).await;
    assert!(matches!(outcome, TurnOutcome::Failed { .. }));
    handle.session.shutdown().await;
}

fn claude_script(dir: &Path) -> PathBuf {
    script(
        dir,
        &[
            json!({"update": {"sessionUpdate": "tool_call", "toolCallId": "toolu_1", "name": "Agent", "title": "Agent", "kind": "other", "status": "pending"}}),
            json!({"update": {"sessionUpdate": "tool_call_update", "toolCallId": "toolu_1", "status": "in_progress", "rawInput": {"prompt": "find bugs", "description": "Bug hunt"}}}),
            json!({"sessionId": "child-s", "update": {"sessionUpdate": "session_message", "messageId": "toolu_1", "senderSessionId": "$SESSION", "content": [{"type": "text", "text": "find bugs"}]}}),
            json!({"sessionId": "child-s", "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "found 2 bugs"}}}),
            json!({"update": {"sessionUpdate": "subagent_update", "sessionId": "child-s", "state": {"state": "idle", "stopReason": "end_turn"}}}),
            json!({"update": {"sessionUpdate": "tool_call_update", "toolCallId": "toolu_1", "status": "completed"}}),
        ],
    )
}

/// v1 adapter.ts:465-468: v1 follows Claude's child sessions only on negotiated ACP v2. GOAT 2's
/// driver speaks ACP v1 (the `agent-client-protocol` crate refuses a v2 peer), so Claude's Agent
/// call is an ordinary tool and the claude-agent-acp v2 switch is still set at launch (v1
/// sessionEnvironmentKey.ts:13-22). The v2 child-session path is covered in `subagents.rs` tests.
#[tokio::test]
async fn claude_acp_v1_keeps_agent_calls_as_tools() {
    let dir = tempfile::tempdir().unwrap();
    let steps = claude_script(dir.path());
    let flavor = RegistryAgentFlavor::new(
        "claude-acp",
        command(&[("GOAT_ACP_SCRIPT", steps.to_str().unwrap())]),
        false,
    );
    let launch = flavor
        .launch(&spec(dir.path(), RuntimeMode::FullAccess))
        .unwrap();
    if std::env::var_os("CLAUDE_AGENT_ACP_EXPERIMENTAL_V2").is_none() {
        assert!(
            launch
                .env
                .contains(&("CLAUDE_AGENT_ACP_EXPERIMENTAL_V2".into(), "1".into()))
        );
    }
    let mut handle = start(flavor, dir.path(), RuntimeMode::FullAccess).await;
    let (events, outcome) = turn(&mut handle, RuntimeMode::FullAccess).await;
    assert_eq!(outcome, TurnOutcome::Done);
    assert!(subagent_updates(&events).is_empty());
    assert!(
        items(&events)
            .iter()
            .any(|i| i.id.as_str().ends_with(":tool:toolu_1"))
    );
    handle.session.shutdown().await;
}

/// v1 droidAcp.ts / ompAcp.ts / opencodeAcp.ts: each agent's own question form is asked and
/// answered in its own shape.
#[tokio::test]
async fn agent_question_forms_round_trip() {
    let cases = [
        (
            "factory-droid",
            json!({"type": "object", "properties": {
                "question_1": {"type": "string", "title": "Color", "description": "Pick a color", "oneOf": [
                    {"const": "option_1", "title": "Red"}, {"const": "other", "title": "Other"}]},
                "question_1_other": {"type": "string"}}, "required": ["question_1"]}),
            json!({"question_1": "green"}),
            json!({"question_1": "other", "question_1_other": "green"}),
            "Color",
        ),
        (
            "omp-local",
            json!({"properties": {
                "q1": {"type": "string", "title": "Which file?", "description": "Scope", "oneOf": [{"const": "a", "title": "A"}]},
                "q1__other": {"type": "string", "title": "Other (type your own)"}}}),
            json!({"q1": "b.rs"}),
            json!({"q1__other": "b.rs"}),
            "Scope",
        ),
        (
            "opencode",
            json!({"properties": {
                "q1": {"type": "string", "title": "Pick", "description": "Which one?", "oneOf": [{"const": "a", "title": "A"}]},
                "q1_custom": {"type": "string", "description": "Type your own answer"}}}),
            json!({"q1": "a"}),
            json!({"q1": "a"}),
            "Pick",
        ),
    ];
    for (agent, schema, answers, content, header) in cases {
        let dir = tempfile::tempdir().unwrap();
        let answer_log = dir.path().join("answer.jsonl");
        let steps = script(
            dir.path(),
            &[
                json!({"request": "elicitation/create", "log": answer_log.to_str().unwrap(),
            "params": {"sessionId": "$SESSION", "mode": "form", "message": "Question", "requestedSchema": schema}}),
            ],
        );
        let env = [("GOAT_ACP_SCRIPT", steps.to_str().unwrap())];
        let flavor = if agent == "omp-local" {
            // omp is only a local preset (v1 localPresets.ts); name the executable `omp`.
            let bin = dir.path().join("omp");
            std::os::unix::fs::symlink(env!("CARGO_BIN_EXE_goat2-acp-mock-agent"), &bin).unwrap();
            let mut command = command(&env);
            command.program = bin;
            RegistryAgentFlavor::new("", command, true)
        } else {
            RegistryAgentFlavor::new(agent, command(&env), false)
        };
        let mut handle = start(flavor, dir.path(), RuntimeMode::ApprovalRequired).await;
        handle
            .session
            .start_turn(
                vec![EngineInput {
                    input_id: goat2_contracts::InputId::new("in-1"),
                    text: "ask".into(),
                    attachments: vec![],
                }],
                &TurnSettings {
                    model_selection: selection("mock-default"),
                    runtime_mode: RuntimeMode::ApprovalRequired,
                },
            )
            .await;
        let key = loop {
            if let EngineEvent::RequestOpened {
                key, kind, item, ..
            } = next(&mut handle).await
            {
                assert_eq!(kind, RequestKind::Question);
                match item.map(|i| i.body) {
                    Some(TurnItemBody::UserInputRequest { questions, .. }) => {
                        assert_eq!(questions.len(), 1, "{agent}: companion hidden");
                        assert_eq!(questions[0].header, header, "{agent}");
                    }
                    other => panic!("{agent}: {other:?}"),
                }
                break key;
            }
        };
        handle
            .session
            .answer_request(
                &key,
                RequestAnswer {
                    outcome: RequestOutcome::Answered,
                    text: None,
                    answers: answers.as_object().cloned(),
                },
            )
            .await
            .unwrap();
        let (_, outcome) = until_finished(&mut handle).await;
        assert_eq!(outcome, TurnOutcome::Done, "{agent}");
        assert_eq!(
            read_log(&answer_log),
            vec![json!({"action": "accept", "content": content})],
            "{agent}"
        );
        handle.session.shutdown().await;
    }
}

/// v1 kimiAcp.ts: an `end_turn` for a turn Kimi's log says failed fails the turn and restarts Kimi.
#[tokio::test]
async fn kimi_failed_turn_in_its_log_fails_the_turn() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("kimi-home");
    let main = home
        .join("sessions")
        .join("ws1")
        .join("mock-session-1")
        .join("agents")
        .join("main");
    std::fs::create_dir_all(&main).unwrap();
    let wire = main.join("wire.jsonl");
    let steps = script(
        dir.path(),
        &[json!({"appendFile": wire.to_str().unwrap(), "lines": [
            {"type": "turn.prompt", "agentId": "main", "turnId": 1},
            {"type": "turn.ended", "agentId": "main", "turnId": 1, "reason": "failed", "error": {"code": "provider.rate_limit", "message": "Kimi hit a rate limit", "retryable": true}},
        ]})],
    );
    let flavor = RegistryAgentFlavor::new(
        "kimi-code",
        command(&[
            ("GOAT_ACP_SCRIPT", steps.to_str().unwrap()),
            ("KIMI_CODE_HOME", home.to_str().unwrap()),
        ]),
        false,
    );
    let mut handle = start(flavor, dir.path(), RuntimeMode::FullAccess).await;
    let (events, outcome) = turn(&mut handle, RuntimeMode::FullAccess).await;
    assert_eq!(
        outcome,
        TurnOutcome::Failed {
            reason: "Kimi hit a rate limit".into()
        }
    );
    assert_eq!(answer_text(&events), "hello from mock");
    loop {
        if let EngineEvent::Exited { reason } = next(&mut handle).await {
            assert!(reason.contains("prompt outcome"), "{reason}");
            break;
        }
    }
}

/// A completed Kimi turn keeps its outcome and its process.
#[tokio::test]
async fn kimi_completed_turn_stays_done() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("kimi-home");
    let main = home
        .join("sessions")
        .join("ws1")
        .join("mock-session-1")
        .join("agents")
        .join("main");
    std::fs::create_dir_all(&main).unwrap();
    let wire = main.join("wire.jsonl");
    let steps = script(
        dir.path(),
        &[json!({"appendFile": wire.to_str().unwrap(), "lines": [
            {"type": "turn.prompt", "agentId": "main", "turnId": 1},
            {"type": "turn.ended", "agentId": "main", "turnId": 1, "reason": "completed"},
        ]})],
    );
    let flavor = RegistryAgentFlavor::new(
        "kimi-code",
        command(&[
            ("GOAT_ACP_SCRIPT", steps.to_str().unwrap()),
            ("KIMI_CODE_HOME", home.to_str().unwrap()),
        ]),
        false,
    );
    let mut handle = start(flavor, dir.path(), RuntimeMode::FullAccess).await;
    let (_, outcome) = turn(&mut handle, RuntimeMode::FullAccess).await;
    assert_eq!(outcome, TurnOutcome::Done);
    handle.session.shutdown().await;
}

/// v1 adapter.ts:100-129: Mistral Vibe's retry extension reaches the turn.
#[tokio::test]
async fn mistral_vibe_retry_is_shown() {
    let dir = tempfile::tempdir().unwrap();
    let steps = script(
        dir.path(),
        &[
            json!({"notify": "_session/retrying", "params": {"sessionId": "$SESSION", "category": "rate_limited", "detail": "Rate limited; retrying in 2s"}}),
        ],
    );
    let flavor = RegistryAgentFlavor::new(
        "mistral-vibe",
        command(&[("GOAT_ACP_SCRIPT", steps.to_str().unwrap())]),
        false,
    );
    let mut handle = start(flavor, dir.path(), RuntimeMode::FullAccess).await;
    let (events, outcome) = turn(&mut handle, RuntimeMode::FullAccess).await;
    assert_eq!(outcome, TurnOutcome::Done);
    assert!(items(&events).iter().any(|i| matches!(&i.body, TurnItemBody::SystemNotice { message, .. } if message == "Rate limited; retrying in 2s")));
    handle.session.shutdown().await;
}

/// Generic registry agents: the configured sign-in method (v1 settings `authMethodId`), custom
/// models written without the agent's list (v1 `customModels`), and Command Code's HTTP MCP.
#[tokio::test]
async fn generic_agent_auth_method_custom_models_and_command_code_mcp() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("log.jsonl");
    let env = [
        ("GOAT_ACP_AUTH_METHOD_ID", "agent-login"),
        ("GOAT_ACP_REQUEST_LOG_PATH", log.to_str().unwrap()),
    ];
    // A configured method the agent's list does not name is refused (final review finding 11).
    let wrong = RegistryAgentFlavor::new("some-agent", command(&env), false)
        .with_auth_method_id(Some("other".into()));
    let error = factory(wrong)
        .start(spec(dir.path(), RuntimeMode::FullAccess))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("authenticate other"), "{error}");

    std::fs::remove_file(&log).unwrap();
    let flavor = RegistryAgentFlavor::new("some-agent", command(&env), false)
        .with_auth_method_id(Some(" agent-login ".into()))
        .with_custom_models(vec!["my-custom".into()]);
    let handle = factory(flavor)
        .start(spec_with(dir.path(), RuntimeMode::FullAccess, "my-custom"))
        .await
        .expect("custom model starts");
    let requests = read_log(&log);
    assert_eq!(
        logged(&requests, "authenticate")[0]["params"]["methodId"],
        "agent-login"
    );
    assert!(
        logged(&requests, "session/set_config_option")
            .iter()
            .any(|r| r["params"]["value"] == "my-custom")
    );
    handle.session.shutdown().await;

    // Without the custom model the unlisted id is refused, as v1 validateModelSelection does.
    let plain = RegistryAgentFlavor::new("some-agent", command(&env), false);
    assert!(
        factory(plain)
            .start(spec_with(dir.path(), RuntimeMode::FullAccess, "my-custom"))
            .await
            .is_err()
    );

    let http_log = dir.path().join("http.jsonl");
    let mut command_code = command(&[
        ("GOAT_ACP_MCP_HTTP", "1"),
        ("GOAT_ACP_REQUEST_LOG_PATH", http_log.to_str().unwrap()),
    ]);
    command_code.args = vec!["/opt/node_modules/command-code/dist/cli.mjs".into()];
    let flavor = RegistryAgentFlavor::new("", command_code, true);
    let handle = start(flavor, dir.path(), RuntimeMode::FullAccess).await;
    assert_eq!(
        logged(&read_log(&http_log), "session/new")[0]["params"]["mcpServers"][0]["type"],
        "http"
    );
    handle.session.shutdown().await;
}

/// Final review finding 11 (v1 AcpSessionRuntime.ts:1514-1527): a configured sign-in method the
/// agent's advertised list does not name is refused without calling authenticate; without a list
/// the configured method is used.
#[tokio::test]
async fn configured_auth_method_must_be_in_an_advertised_list() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("log.jsonl");
    let listed = [
        (
            "GOAT_ACP_AUTH_METHODS",
            r#"[{"id": "agent-login", "name": "Agent"}]"#,
        ),
        ("GOAT_ACP_AUTH_REQUIRED", "1"),
        ("GOAT_ACP_REQUEST_LOG_PATH", log.to_str().unwrap()),
    ];
    let flavor = RegistryAgentFlavor::new("some-agent", command(&listed), false)
        .with_auth_method_id(Some("other".into()));
    let error = factory(flavor)
        .start(spec(dir.path(), RuntimeMode::FullAccess))
        .await
        .map(|_| ())
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains(r#"did not advertise configured authentication method "other""#),
        "{error}"
    );
    assert!(logged(&read_log(&log), "authenticate").is_empty());

    std::fs::remove_file(&log).unwrap();
    let unlisted = [
        ("GOAT_ACP_AUTH_METHODS", "null"),
        ("GOAT_ACP_AUTH_METHOD_ID", "agent-login"),
        ("GOAT_ACP_REQUEST_LOG_PATH", log.to_str().unwrap()),
    ];
    let flavor = RegistryAgentFlavor::new("some-agent", command(&unlisted), false)
        .with_auth_method_id(Some("agent-login".into()));
    let handle = start(flavor, dir.path(), RuntimeMode::FullAccess).await;
    assert_eq!(
        logged(&read_log(&log), "authenticate")[0]["params"]["methodId"],
        "agent-login"
    );
    handle.session.shutdown().await;
}
