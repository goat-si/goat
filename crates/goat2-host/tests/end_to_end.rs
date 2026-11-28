//! End to end through the real server: UI WebSocket (token, command, subscription, streamed
//! text) and agent MCP over HTTP with the thread's per-process token.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use goat2_host::config::{EngineChoice, HostConfig};
use goat2_host::engine::fake::{FakeCall, FakeEngine, FakeScript};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;

async fn next_json(
    ws: &mut (impl StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin),
) -> Value {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("frame in time")
            .expect("open")
            .expect("ok");
        if let Message::Text(text) = msg {
            return serde_json::from_str(&text).unwrap();
        }
    }
}

async fn until(
    ws: &mut (impl StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin),
    pred: impl Fn(&Value) -> bool,
) -> (Value, Vec<Value>) {
    let mut seen = Vec::new();
    loop {
        let frame = next_json(ws).await;
        if pred(&frame) {
            return (frame, seen);
        }
        seen.push(frame);
    }
}

async fn mcp(url: &str, token: &str, method: &str, params: Value) -> (u16, Value) {
    let res = reqwest::Client::new()
        .post(url)
        .bearer_auth(token)
        .header("accept", "application/json, text/event-stream")
        .json(&json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}))
        .send()
        .await
        .unwrap();
    let status = res.status().as_u16();
    let text = res.text().await.unwrap();
    (status, serde_json::from_str(&text).unwrap_or(Value::Null))
}

#[tokio::test]
async fn ui_and_agent_paths_through_the_real_server() {
    let dir = tempfile::tempdir().unwrap();
    let fake = FakeEngine::new(FakeScript {
        auto_finish: false,
        ..FakeScript::default()
    });
    let cfg = HostConfig {
        data_dir: dir.path().to_path_buf(),
        port: 0,
        ui_token: Some("ui-secret".into()),
        engine: EngineChoice::Fake,
        exit_on_stdin_close: false,
    };
    let running = goat2_host::server::start_with_engine(cfg, Some(Arc::new(fake.clone())))
        .await
        .unwrap();
    let ready = running.ready.clone();
    let health = reqwest::get(format!("http://127.0.0.1:{}/health", ready.port))
        .await
        .unwrap();
    assert_eq!(health.status(), 200);

    let (mut ws, _) = tokio_tungstenite::connect_async(format!("{}?token=ui-secret", ready.ws_url))
        .await
        .unwrap();
    ws.send(Message::text(
        json!({"type":"subscribe_cards","subId":"cards"}).to_string(),
    ))
    .await
    .unwrap();
    let (_, before) = until(&mut ws, |f| f["type"] == "cards_caught_up").await;
    assert!(
        before
            .iter()
            .any(|f| f["type"] == "bot_changed" && f["bot"]["role"] == "main"),
        "main bot GOAT exists"
    );

    ws.send(Message::text(json!({
        "type":"start_thread","reqId":"r1","clientRequestId":"c1","kind":"user","title":"hello",
        "modelSelection":{"instanceId":"codex","model":"m"},"runtimeMode":"full-access","cwd":"/tmp","text":"hi there"
    }).to_string())).await.unwrap();
    let (result, _) = until(&mut ws, |f| {
        f["type"] == "command_result" && f["reqId"] == "r1"
    })
    .await;
    assert_eq!(result["ok"], true, "{result}");
    let thread_id = result["value"]["threadId"].as_str().unwrap().to_owned();

    ws.send(Message::text(
        json!({"type":"subscribe_thread","subId":"t","threadId":thread_id}).to_string(),
    ))
    .await
    .unwrap();
    until(&mut ws, |f| {
        f["type"] == "thread_caught_up" && f["subId"] == "t"
    })
    .await;

    // Wait for the engine turn, then act as the agent over MCP with the thread's token.
    let token = loop {
        if let Some(token) = fake.calls().into_iter().find_map(|c| match c {
            FakeCall::Start { mcp_token, .. } => Some(mcp_token),
            _ => None,
        }) && fake.active_turn(&thread_id.as_str().into()).is_some()
        {
            break token;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    let (status, _) = mcp(&ready.mcp_url, "wrong", "tools/list", json!({})).await;
    assert_eq!(status, 401);
    let (status, list) = mcp(&ready.mcp_url, &token, "tools/list", json!({})).await;
    assert_eq!(status, 200);
    let names: Vec<_> = list["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(names, vec!["goat_describe", "goat_call"]);
    let (_, sent) = mcp(&ready.mcp_url, &token, "tools/call", json!({"name":"goat_call","arguments":{"path":"user.send","args":{"kind":"ack","text":"on it"}}})).await;
    assert_eq!(
        sent["result"]["structuredContent"]["status"], "ok",
        "{sent}"
    );
    let (_, child) = mcp(
        &ready.mcp_url,
        &token,
        "tools/call",
        json!({"name":"goat_call","arguments":{"path":"thread.start","args":{"task":"x"}}}),
    )
    .await;
    assert_eq!(
        child["result"]["structuredContent"]["status"], "ok",
        "a user thread may start a worker: {child}"
    );

    // Streamed text then the finished item and run end reach the subscriber.
    fake.finish_turn(&thread_id.as_str().into(), "hello back");
    let (append, mut lines) = until(&mut ws, |f| f["type"] == "text_append").await;
    assert_eq!(append["text"], "hello back");
    assert_eq!(append["offset"], 0);
    let (_, rest) = until(&mut ws, |f| {
        f["type"] == "thread_event" && f["line"]["type"] == "run.finished"
    })
    .await;
    lines.extend(rest);
    assert!(
        lines
            .iter()
            .any(|f| f["type"] == "thread_event" && f["line"]["type"] == "user.notified")
    );
    assert!(
        lines
            .iter()
            .any(|f| f["type"] == "thread_event" && f["line"]["type"] == "item.completed")
    );

    // After the run the token no longer names an active run: refused, nothing written.
    tokio::time::sleep(Duration::from_millis(50)).await;
    let (_, refused) = mcp(&ready.mcp_url, &token, "tools/call", json!({"name":"goat_call","arguments":{"path":"user.send","args":{"kind":"result","text":"late"}}})).await;
    assert_eq!(
        refused["result"]["structuredContent"]["status"], "error",
        "{refused}"
    );
    assert_eq!(
        refused["result"]["structuredContent"]["error"]["reason"],
        "no_active_run"
    );
    ws.close(None).await.unwrap();
    drop(ws);
    running.shutdown().await;

    // The next start on the same folder is a new generation, and the GOAT bot is not duplicated.
    // Connection tasks wind down after the client closed; the store lock goes with them.
    let started = std::time::Instant::now();
    let again = loop {
        let cfg = HostConfig {
            data_dir: dir.path().to_path_buf(),
            port: 0,
            ui_token: Some("ui-secret".into()),
            engine: EngineChoice::Fake,
            exit_on_stdin_close: false,
        };
        match goat2_host::server::start_with_engine(cfg, Some(Arc::new(fake.clone()))).await {
            Ok(running) => break running,
            Err(err) if err.contains("locked") && started.elapsed() < Duration::from_secs(5) => {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Err(err) => panic!("{err}"),
        }
    };
    assert_eq!(again.ready.generation, ready.generation + 1);
    assert_eq!(
        again
            .host
            .store()
            .cards()
            .iter()
            .filter(|c| c.kind == goat2_contracts::ThreadKind::Bot)
            .count(),
        1
    );
    again.shutdown().await;
}
