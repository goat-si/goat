//! MCP-over-ACP (v1 mcpOverAcpBridge.ts): an agent advertising `mcpCapabilities.acp` reaches GOAT's MCP
//! endpoint through the ACP connection. The endpoint is a fake HTTP MCP server inside the test.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use goat2_contracts::{
    EngineConfig, EngineDriver, InputId, ModelSelection, ProviderInstanceId, RuntimeMode,
    TurnItemBody,
};
use goat2_engine_acp::{AcpEngineFactory, AcpFlavor, LaunchCommand};
use goat2_engine_api::{
    EngineError, EngineEvent, EngineFactory, EngineInput, McpEndpoint, SessionSpec, TurnOutcome,
    TurnSettings,
};
use serde_json::{Value, json};

struct Mock(Vec<(String, String)>);

impl AcpFlavor for Mock {
    fn driver(&self) -> &str {
        "acpRegistry"
    }
    fn engine_driver(&self) -> EngineDriver {
        EngineDriver::AcpRegistry {
            agent_id: "mock".into(),
        }
    }
    fn launch(&self, _spec: &SessionSpec) -> Result<LaunchCommand, EngineError> {
        let mut command = LaunchCommand::new(
            env!("CARGO_BIN_EXE_goat2-acp-mock-agent"),
            Vec::<String>::new(),
        );
        command.env = self.0.clone();
        Ok(command)
    }
}

/// What the fake endpoint saw: (method or "DELETE", authorization, mcp-session-id).
type Seen = Arc<Mutex<Vec<(String, String, String)>>>;

fn fake_mcp_endpoint() -> (String, Seen) {
    fake_mcp_endpoint_with(None)
}

/// The fake endpoint; with `hold`, a tools/call is never answered and the sender is told it came.
fn fake_mcp_endpoint_with(hold: Option<std::sync::mpsc::Sender<()>>) -> (String, Seen) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    let seen: Seen = Arc::default();
    let log = Arc::clone(&seen);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request_line = String::new();
            if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
                continue;
            }
            let (mut length, mut auth, mut session) = (0usize, String::new(), String::new());
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let line = line.trim_end().to_owned();
                if line.is_empty() {
                    break;
                }
                let (name, value) = line.split_once(':').unwrap();
                match name.to_ascii_lowercase().as_str() {
                    "content-length" => length = value.trim().parse().unwrap(),
                    "authorization" => auth = value.trim().to_owned(),
                    "mcp-session-id" => session = value.trim().to_owned(),
                    _ => {}
                }
            }
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            if request_line.starts_with("DELETE") {
                log.lock().unwrap().push(("DELETE".into(), auth, session));
                let _ = stream.write_all(
                    b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
                );
                continue;
            }
            let message: Value = serde_json::from_slice(&body).unwrap();
            let method = message["method"].as_str().unwrap_or_default().to_owned();
            log.lock().unwrap().push((method.clone(), auth, session));
            if method == "tools/call"
                && let Some(hold) = &hold
            {
                let _ = hold.send(());
                // Keep the connection open without answering, as a long-running tool would.
                std::mem::forget(stream);
                continue;
            }
            let reply = match method.as_str() {
                "initialize" => {
                    json!({"jsonrpc": "2.0", "id": message["id"], "result": {"protocolVersion": "2025-06-18", "capabilities": {}, "serverInfo": {"name": "goat", "version": "0"}}})
                }
                "tools/list" => {
                    json!({"jsonrpc": "2.0", "id": message["id"], "result": {"tools": [{"name": "goat_call", "inputSchema": {"type": "object"}}]}})
                }
                _ => Value::Null,
            };
            let body = if reply.is_null() {
                String::new()
            } else {
                reply.to_string()
            };
            let status = if reply.is_null() {
                "202 Accepted"
            } else {
                "200 OK"
            };
            let _ = write!(
                stream,
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\nmcp-session-id: s-1\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });
    (url, seen)
}

#[tokio::test]
async fn agent_reaches_goat_mcp_over_acp() {
    let dir = tempfile::tempdir().unwrap();
    let (url, seen) = fake_mcp_endpoint();
    let factory = AcpEngineFactory::new(Arc::new(Mock(vec![
        ("GOAT_ACP_MCP_ACP".into(), "1".into()),
        ("GOAT_ACP_EMIT_MCP_OVER_ACP".into(), "1".into()),
    ])))
    // No stdio bridge: the ACP route must not need one.
    .without_mcp_bridge();
    let selection = ModelSelection {
        instance_id: ProviderInstanceId::new("mock"),
        model: "default".into(),
        options: None,
    };
    let mut handle = factory
        .start(SessionSpec {
            thread_id: "t".into(),
            engine: EngineConfig {
                provider_instance_id: ProviderInstanceId::new("mock"),
                model_selection: selection.clone(),
                runtime_mode: RuntimeMode::FullAccess,
                cwd: dir.path().to_string_lossy().into_owned(),
            },
            resume: None,
            mcp: McpEndpoint {
                url,
                bearer_token: "secret".into(),
            },
            host_generation: 1,
            process_generation: 1,
            instructions: None,
            launch: None,
        })
        .await
        .expect("start");
    handle
        .session
        .start_turn(
            vec![EngineInput {
                input_id: InputId::new("i"),
                text: "go".into(),
                attachments: vec![],
            }],
            &TurnSettings {
                model_selection: selection,
                runtime_mode: RuntimeMode::FullAccess,
            },
        )
        .await;
    let mut text = String::new();
    let outcome = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match handle.events.recv().await.expect("event") {
                EngineEvent::ItemCompleted { item, .. } => {
                    if let TurnItemBody::AssistantMessage { text: t, .. } = item.body {
                        text.push_str(&t);
                    }
                }
                EngineEvent::TurnFinished { outcome, .. } => break outcome,
                _ => {}
            }
        }
    })
    .await
    .unwrap();
    handle.session.shutdown().await;
    assert_eq!(outcome, TurnOutcome::Done);
    assert!(text.contains("mcp tools: goat_call"), "{text}");
    let seen = seen.lock().unwrap().clone();
    let methods: Vec<&str> = seen.iter().map(|(m, _, _)| m.as_str()).collect();
    assert_eq!(methods, ["initialize", "tools/list", "DELETE"]);
    assert!(seen.iter().all(|(_, auth, _)| auth == "Bearer secret"));
    // The session id from initialize is sent on later requests.
    assert_eq!(seen[1].2, "s-1");
    assert_eq!(seen[2].2, "s-1");
}

/// v1 stopCalls (mcpOverAcpBridge.ts:158-165, adapter.ts:4459-4466): interrupting the turn fails a
/// tool call still waiting on GOAT's endpoint instead of leaving it running (review 1 finding 2).
#[tokio::test]
async fn interrupt_stops_mcp_calls_in_flight() {
    let dir = tempfile::tempdir().unwrap();
    let result = dir.path().join("call.json");
    let (held_tx, held_rx) = std::sync::mpsc::channel();
    let (url, _seen) = fake_mcp_endpoint_with(Some(held_tx));
    let factory = AcpEngineFactory::new(Arc::new(Mock(vec![
        ("GOAT_ACP_MCP_ACP".into(), "1".into()),
        ("GOAT_ACP_EMIT_MCP_OVER_ACP".into(), "1".into()),
        (
            "GOAT_ACP_MCP_CALL_RESULT_PATH".into(),
            result.to_string_lossy().into_owned(),
        ),
    ])))
    .without_mcp_bridge();
    let selection = ModelSelection {
        instance_id: ProviderInstanceId::new("mock"),
        model: "default".into(),
        options: None,
    };
    let mut handle = factory
        .start(SessionSpec {
            thread_id: "t".into(),
            engine: EngineConfig {
                provider_instance_id: ProviderInstanceId::new("mock"),
                model_selection: selection.clone(),
                runtime_mode: RuntimeMode::FullAccess,
                cwd: dir.path().to_string_lossy().into_owned(),
            },
            resume: None,
            mcp: McpEndpoint {
                url,
                bearer_token: "secret".into(),
            },
            host_generation: 1,
            process_generation: 1,
            instructions: None,
            launch: None,
        })
        .await
        .expect("start");
    let turn_id = match handle
        .session
        .start_turn(
            vec![EngineInput {
                input_id: InputId::new("i"),
                text: "go".into(),
                attachments: vec![],
            }],
            &TurnSettings {
                model_selection: selection,
                runtime_mode: RuntimeMode::FullAccess,
            },
        )
        .await
    {
        goat2_engine_api::TurnStartResult::Accepted { turn_id } => turn_id,
        other => panic!("{other:?}"),
    };
    // The tool call reached the endpoint and is waiting there.
    tokio::task::spawn_blocking(move || held_rx.recv_timeout(Duration::from_secs(10)).unwrap())
        .await
        .unwrap();
    handle.session.interrupt(&turn_id).await.unwrap();
    let outcome = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let EngineEvent::TurnFinished { outcome, .. } =
                handle.events.recv().await.expect("event")
            {
                break outcome;
            }
        }
    })
    .await
    .unwrap();
    handle.session.shutdown().await;
    assert_eq!(outcome, TurnOutcome::Interrupted);
    let answer = std::fs::read_to_string(&result).expect("the agent got an answer to its call");
    assert!(answer.contains("The MCP call was stopped."), "{answer}");
}
