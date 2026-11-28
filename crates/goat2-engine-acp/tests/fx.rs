//! fx flavor against the offline ACP mock (`GOAT_ACP_FX=1` profile: fx 0.0.13's `ask`/`code`
//! modes reported as `ask`, `model` and `effort` options). The v1 source is named on each test.
use goat2_contracts::{
    EngineConfig, ModelSelection, ProviderOptionSelection, ProviderOptionSelectionValue,
    RuntimeMode, TurnItemStatus,
};
use goat2_engine_acp::agents::fx::Fx;
use goat2_engine_acp::{AcpEngineFactory, AcpFlavor};
use goat2_engine_api::{
    EngineEvent, EngineFactory, EngineHandle, EngineInput, Instructions, LaunchSpec, McpEndpoint,
    RequestAnswer, SessionSpec, TurnOutcome, TurnSettings, TurnStartResult,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

const TEST_BRIDGE: &str = "/goat2-test/bin/goat2-acp-mcp-bridge";

struct Run {
    handle: EngineHandle,
    log: PathBuf,
    _dir: tempfile::TempDir,
}

fn selection(model: &str, options: Option<Vec<ProviderOptionSelection>>) -> ModelSelection {
    ModelSelection {
        instance_id: "agent".into(),
        model: model.into(),
        options,
    }
}

fn spec(
    cwd: &Path,
    log: &Path,
    mode: RuntimeMode,
    model: &ModelSelection,
    env: &[(&str, &str)],
    instructions: Option<Instructions>,
) -> SessionSpec {
    let mut vars: BTreeMap<String, String> = env
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    vars.insert(
        "GOAT_ACP_REQUEST_LOG_PATH".into(),
        log.to_string_lossy().into_owned(),
    );
    SessionSpec {
        thread_id: "t".into(),
        engine: EngineConfig {
            provider_instance_id: "agent".into(),
            model_selection: model.clone(),
            runtime_mode: mode,
            cwd: cwd.to_string_lossy().into_owned(),
        },
        resume: None,
        mcp: McpEndpoint {
            url: "http://127.0.0.1:9/mcp".into(),
            bearer_token: "fake".into(),
        },
        host_generation: 1,
        process_generation: 1,
        instructions,
        launch: Some(LaunchSpec {
            binary: Some(env!("CARGO_BIN_EXE_goat2-acp-mock-agent").into()),
            args: vec![],
            env: vars,
        }),
    }
}

async fn start_with(
    flavor: Arc<dyn AcpFlavor>,
    mode: RuntimeMode,
    model: &ModelSelection,
    env: &[(&str, &str)],
    instructions: Option<Instructions>,
    resolver: Option<goat2_engine_acp::AttachmentResolver>,
) -> Result<Run, goat2_engine_api::EngineError> {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    let log = dir.path().join("log.jsonl");
    let mut factory = AcpEngineFactory::new(flavor).with_mcp_bridge(
        goat2_engine_acp::McpBridgeCommand::new(TEST_BRIDGE, Vec::<String>::new()),
    );
    if let Some(resolver) = resolver {
        factory = factory.with_attachment_resolver(resolver);
    }
    let handle = factory
        .start(spec(&cwd, &log, mode, model, env, instructions))
        .await?;
    Ok(Run {
        handle,
        log,
        _dir: dir,
    })
}

fn input(text: &str) -> Vec<EngineInput> {
    vec![EngineInput {
        input_id: "i".into(),
        text: text.into(),
        attachments: vec![],
    }]
}

/// Run one turn, answering each opened request with `answer`; every event until it finishes.
async fn turn(
    run: &mut Run,
    inputs: Vec<EngineInput>,
    mode: RuntimeMode,
    model: &ModelSelection,
    answer: impl Fn(&EngineEvent) -> Option<(String, RequestAnswer)>,
) -> (Vec<EngineEvent>, TurnOutcome) {
    let started = run
        .handle
        .session
        .start_turn(
            inputs,
            &TurnSettings {
                model_selection: model.clone(),
                runtime_mode: mode,
            },
        )
        .await;
    assert!(
        matches!(started, TurnStartResult::Accepted { .. }),
        "{started:?}"
    );
    let mut events = Vec::new();
    let outcome = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let event = run.handle.events.recv().await.expect("event");
            if let Some((key, reply)) = answer(&event) {
                run.handle
                    .session
                    .answer_request(&key, reply)
                    .await
                    .unwrap();
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
    .expect("turn finishes");
    (events, outcome)
}

fn read_log(path: &Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

fn logged(log: &[Value], method: &str) -> Vec<Value> {
    log.iter()
        .filter(|m| m["method"] == method)
        .map(|m| m["params"].clone())
        .collect()
}

/// The `session/set_config_option` writes, as `(configId, value)`.
fn config_writes(log: &[Value]) -> Vec<(String, Value)> {
    logged(log, "session/set_config_option")
        .into_iter()
        .map(|p| {
            (
                p["configId"].as_str().unwrap().to_owned(),
                p["value"].clone(),
            )
        })
        .collect()
}

fn fx_model(model: &str) -> ModelSelection {
    selection(model, None)
}

async fn start(
    flavor: Fx,
    mode: RuntimeMode,
    model: &ModelSelection,
    env: &[(&str, &str)],
) -> Result<Run, goat2_engine_api::EngineError> {
    start_with(
        Arc::new(flavor),
        mode,
        model,
        &[&[("GOAT_ACP_FX", "1")], env].concat(),
        None,
        None,
    )
    .await
}

/// v1 withFxSessionMode (acpSupport.ts:100-157): fx 0.0.13 reports `ask` but enforces its saved
/// default until a client writes the mode, so the first write goes out even though `ask` is
/// already reported; later writes that match are skipped, and `code` serves automatic review.
#[tokio::test]
async fn first_mode_write_goes_out_even_when_reported() {
    let model = fx_model("fx-default");
    let mut run = start(Fx::default(), RuntimeMode::ApprovalRequired, &model, &[])
        .await
        .unwrap();
    let (_, outcome) = turn(&mut run, input("go"), RuntimeMode::Auto, &model, |_| None).await;
    assert_eq!(outcome, TurnOutcome::Done);
    run.handle
        .session
        .set_config(&TurnSettings {
            model_selection: model.clone(),
            runtime_mode: RuntimeMode::ApprovalRequired,
        })
        .await
        .unwrap();
    let log = read_log(&run.log);
    let mode_writes: Vec<(String, Value)> = config_writes(&log)
        .into_iter()
        .filter(|(id, _)| id == "mode")
        .collect();
    assert_eq!(mode_writes, [("mode".to_owned(), json!("ask"))]);
    let set_modes: Vec<Value> = logged(&log, "session/set_mode")
        .iter()
        .map(|p| p["modeId"].clone())
        .collect();
    assert_eq!(set_modes, [json!("code"), json!("ask")]);
    run.handle.session.shutdown().await;
}

/// v1 fxModeId (acpSupport.ts:84-98): after vercel-labs/fx#1189 automatic review is `auto`.
#[tokio::test]
async fn newer_fx_takes_auto() {
    let model = fx_model("fx-default");
    let run = start(
        Fx::default(),
        RuntimeMode::Auto,
        &model,
        &[("GOAT_ACP_FX_MODES", "ask,auto,code")],
    )
    .await
    .unwrap();
    let log = read_log(&run.log);
    assert_eq!(logged(&log, "session/set_mode")[0]["modeId"], "auto");
    run.handle.session.shutdown().await;
}

/// v1 withFxSessionMode (acpSupport.ts:130-140): a mode fx does not advertise fails before anything
/// is sent.
#[tokio::test]
async fn unadvertised_mode_fails_session_setup() {
    let model = fx_model("fx-default");
    let error = start(Fx::default(), RuntimeMode::FullAccess, &model, &[])
        .await
        .err()
        .unwrap();
    assert_eq!(
        error,
        goat2_engine_api::EngineError::StartFailed(
            "fx cannot run in mode \"full-access\"; it advertises ask, code.".into()
        )
    );
}

/// v1 applyFxModelSelection + applyFxEffortDefault (acpSupport.ts:159-206): a picked model is sent
/// even unlisted; a thread without an effort starts at medium; a stored effort is written by the
/// option loop and the owned `mode` option never is.
#[tokio::test]
async fn model_and_effort_writes() {
    let unlisted = fx_model("fx-experimental");
    let mut run = start(Fx::default(), RuntimeMode::ApprovalRequired, &unlisted, &[])
        .await
        .unwrap();
    let with_effort = selection(
        "fx-fast",
        Some(vec![
            ProviderOptionSelection {
                id: "effort".into(),
                value: ProviderOptionSelectionValue::Text("xhigh".into()),
            },
            ProviderOptionSelection {
                id: "mode".into(),
                value: ProviderOptionSelectionValue::Text("code".into()),
            },
        ]),
    );
    let (_, outcome) = turn(
        &mut run,
        input("go"),
        RuntimeMode::ApprovalRequired,
        &with_effort,
        |_| None,
    )
    .await;
    assert_eq!(outcome, TurnOutcome::Done);
    assert_eq!(
        config_writes(&read_log(&run.log)),
        [
            ("mode".to_owned(), json!("ask")),
            ("model".to_owned(), json!("fx-experimental")),
            ("effort".to_owned(), json!("medium")),
            ("model".to_owned(), json!("fx-fast")),
            ("effort".to_owned(), json!("xhigh")),
        ]
    );
    run.handle.session.shutdown().await;
}

/// v1 applyFxModelSelection (acpSupport.ts:176-186): "Default" picks fx's status model only when
/// the session lists it; otherwise the session's own model stands.
#[tokio::test]
async fn default_model_needs_to_be_listed() {
    let default = fx_model("default");
    let listed = Fx {
        default_model: Some("fx-fast".into()),
        ..Default::default()
    };
    let run = start(listed, RuntimeMode::ApprovalRequired, &default, &[])
        .await
        .unwrap();
    assert!(config_writes(&read_log(&run.log)).contains(&("model".to_owned(), json!("fx-fast"))));
    run.handle.session.shutdown().await;
    let other_backend = Fx {
        default_model: Some("other-backend-model".into()),
        ..Default::default()
    };
    let run = start(other_backend, RuntimeMode::ApprovalRequired, &default, &[])
        .await
        .unwrap();
    assert!(
        !config_writes(&read_log(&run.log))
            .iter()
            .any(|(id, _)| id == "model")
    );
    run.handle.session.shutdown().await;
}

/// v1 extractFxSubagentUpdate + fxSubagentOutcome (adapter.ts:105-152): a `subagent` call is child
/// work; fx's clipped `{"ok":false,…` reply marks it failed with the readable prefix.
#[tokio::test]
async fn subagent_call_reports_child_progress() {
    let model = fx_model("fx-default");
    let mut run = start(
        Fx::default(),
        RuntimeMode::ApprovalRequired,
        &model,
        &[("GOAT_ACP_FX_SUBAGENT", "1")],
    )
    .await
    .unwrap();
    let (events, outcome) = turn(
        &mut run,
        input("go"),
        RuntimeMode::ApprovalRequired,
        &model,
        |_| None,
    )
    .await;
    assert_eq!(outcome, TurnOutcome::Done);
    let updates: Vec<(TurnItemStatus, Option<String>, Option<String>)> = events
        .iter()
        .filter_map(|e| match e {
            EngineEvent::SubagentUpdate {
                subagent_id,
                status,
                title,
                progress,
                ..
            } if subagent_id == "sub-1" => Some((*status, title.clone(), progress.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(
        updates,
        [
            (
                TurnItemStatus::Running,
                Some("Review the diff".into()),
                None
            ),
            (
                TurnItemStatus::Failed,
                Some("Review the diff".into()),
                Some("the review found two prob…".into())
            ),
        ]
    );
    run.handle.session.shutdown().await;
}
