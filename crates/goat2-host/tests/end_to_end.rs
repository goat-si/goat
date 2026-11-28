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
        codex_bin: None,
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

    // Provider subscriptions are refused with their subId until the providers module lands.
    ws.send(Message::text(
        json!({"type":"subscribe_providers","subId":"providers"}).to_string(),
    ))
    .await
    .unwrap();
    let (refusal, _) = until(&mut ws, |f| {
        f["type"] == "error" && f["subId"] == "providers"
    })
    .await;
    assert_eq!(refusal["code"], "not_available");

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

    // Reasoning streams live, survives a mid-stream join, and is never persisted as a delta.
    let tid = goat2_contracts::ThreadId::from(thread_id.as_str());
    let turn = fake.active_turn(&tid).unwrap();
    let item_id = goat2_contracts::ItemId::from("reasoning-item");
    let log_path = dir
        .path()
        .join("threads")
        .join(&thread_id)
        .join("goat.jsonl");
    let before_delta = std::fs::read(&log_path).unwrap();
    assert!(fake.emit(
        &tid,
        goat2_engine_api::EngineEvent::ContentDelta {
            turn_id: turn.clone(),
            item_id: item_id.clone(),
            stream_kind: goat2_contracts::ContentStreamKind::ReasoningText,
            text: "thinking".into(),
        }
    ));
    let (reasoning, mut earlier_lines) = until(&mut ws, |f| {
        f["type"] == "text_append" && f["itemId"] == "reasoning-item"
    })
    .await;
    assert_eq!(reasoning["streamKind"], "reasoning_text");
    assert_eq!(reasoning["text"], "thinking");
    assert!(fake.content_delta(
        &tid,
        item_id.clone(),
        goat2_contracts::ContentStreamKind::PlanText,
        " again"
    ));
    let (next, _) = until(&mut ws, |f| {
        f["type"] == "text_append" && f["itemId"] == "reasoning-item"
    })
    .await;
    assert_eq!(next["offset"], 8);
    assert_eq!(next["streamKind"], "reasoning_text");
    assert_eq!(next["text"], " again");
    assert_eq!(std::fs::read(&log_path).unwrap(), before_delta);
    let (mut joined, _) =
        tokio_tungstenite::connect_async(format!("{}?token=ui-secret", ready.ws_url))
            .await
            .unwrap();
    joined
        .send(Message::text(
            json!({"type":"subscribe_thread","subId":"join","threadId":thread_id}).to_string(),
        ))
        .await
        .unwrap();
    let (snapshot, _) = until(&mut joined, |f| f["type"] == "text_append").await;
    assert_eq!(snapshot["streamKind"], "reasoning_text");
    assert_eq!(snapshot["offset"], 0);
    assert_eq!(snapshot["text"], "thinking again");
    let mut item = goat2_host::engine::fake::assistant_item(&tid, &item_id, &turn, "thinking");
    item.body = goat2_contracts::TurnItemBody::Reasoning {
        text: "thinking".into(),
        streaming: false,
    };
    assert!(fake.emit(
        &tid,
        goat2_engine_api::EngineEvent::ItemCompleted {
            turn_id: turn,
            item: Box::new(item),
            locator: None
        }
    ));
    let (completed, _) = until(&mut ws, |f| {
        f["type"] == "thread_event" && f["line"]["type"] == "item.completed"
    })
    .await;
    assert_eq!(completed["line"]["item"]["id"], "reasoning-item");
    joined.close(None).await.unwrap();

    // Streamed text then the finished item and run end reach the subscriber.
    fake.finish_turn(&thread_id.as_str().into(), "hello back");
    let (append, mut lines) = until(&mut ws, |f| f["type"] == "text_append").await;
    assert_eq!(append["text"], "hello back");
    assert_eq!(append["offset"], 0);
    assert!(append.get("streamKind").is_none());
    let (_, rest) = until(&mut ws, |f| {
        f["type"] == "thread_event" && f["line"]["type"] == "run.finished"
    })
    .await;
    lines.append(&mut earlier_lines);
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
            codex_bin: None,
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

/// A real Codex turn through the host: the UI WebSocket starts a thread, lane B's driver runs
/// it on the installed `codex` (0.167.0), and the run ends with the agent's answer stored.
/// Needs `codex` signed in; run with
/// `cargo test -p goat2-host --test end_to_end -- --ignored real_codex` (model via
/// `GOAT2_E2E_CODEX_MODEL`, default gpt-6.1-terra; gpt-5.5 is refused on a ChatGPT account).
#[tokio::test]
#[ignore = "runs the real codex CLI; needs a signed-in codex"]
async fn real_codex_turn_through_the_host() {
    let model = std::env::var("GOAT2_E2E_CODEX_MODEL").unwrap_or_else(|_| "gpt-6.1-terra".into());
    let dir = tempfile::tempdir().unwrap();
    let cfg = HostConfig {
        data_dir: dir.path().to_path_buf(),
        port: 0,
        ui_token: Some("ui-secret".into()),
        engine: EngineChoice::Codex,
        codex_bin: None,
        exit_on_stdin_close: false,
    };
    let running = goat2_host::server::start_with_engine(cfg, None)
        .await
        .unwrap();
    let (mut ws, _) =
        tokio_tungstenite::connect_async(format!("{}?token=ui-secret", running.ready.ws_url))
            .await
            .unwrap();
    let cwd = dir.path().join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    ws.send(Message::text(json!({
        "type":"start_thread","reqId":"r1","clientRequestId":"real-1","kind":"user","title":"real codex",
        "modelSelection":{"instanceId":"codex","model":model},"runtimeMode":"full-access",
        "cwd":cwd,"text":"Reply with exactly the word pong and nothing else. Do not run any tools."
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
    let mut answer = None;
    let finished = tokio::time::timeout(Duration::from_secs(180), async {
        loop {
            let Some(Ok(Message::Text(text))) = ws.next().await else {
                panic!("socket closed");
            };
            let f: Value = serde_json::from_str(&text).unwrap();
            if f["type"] != "thread_event" {
                continue;
            }
            let line = &f["line"];
            if line["type"] == "item.completed" && line["item"]["type"] == "assistant_message" {
                answer = line["item"]["text"].as_str().map(str::to_owned);
            }
            if line["type"] == "run.finished" {
                return line.clone();
            }
        }
    })
    .await
    .expect("the real turn finished within 180 s");
    assert_eq!(finished["outcome"], "completed", "{finished}");
    let answer = answer.expect("an assistant answer was stored");
    assert!(answer.to_lowercase().contains("pong"), "answer: {answer}");
    ws.close(None).await.unwrap();
    running.shutdown().await;
}
