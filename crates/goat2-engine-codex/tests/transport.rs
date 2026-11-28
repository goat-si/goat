mod support;

use std::sync::Arc;
use std::time::Duration;

use goat2_engine_codex::protocol::server::Notification;
use goat2_engine_codex::transport::{CallError, Inbound, TransportConfig};
use serde_json::{Value, json};
use support::fake::{fake_exit_of, spawn_fake, transcript};

fn out(frame: Value) -> Value {
    json!({"type": "expect_outbound", "frame": frame})
}
fn inb(frame: Value) -> Value {
    json!({"type": "emit_inbound", "frame": frame})
}
fn inb_after(frame: Value, ms: u64) -> Value {
    json!({"type": "emit_inbound", "frame": frame, "afterMs": ms})
}

fn short(deadline: Duration, window: Duration) -> TransportConfig {
    TransportConfig {
        deadline_for: Arc::new(move |method| (method != "config/read").then_some(deadline)),
        liveness_window: window,
    }
}

async fn next(inbound: &mut tokio::sync::mpsc::UnboundedReceiver<Inbound>) -> Inbound {
    tokio::time::timeout(Duration::from_secs(5), inbound.recv())
        .await
        .expect("an inbound frame")
        .expect("channel open")
}

#[tokio::test]
async fn answers_correlate_by_id_even_out_of_order() {
    let t = transcript(
        "order",
        vec![
            out(json!({"id": 1, "method": "a/one", "params": {}})),
            out(json!({"id": 2, "method": "a/two", "params": {}})),
            inb(json!({"id": 2, "result": {"n": 2}})),
            inb(json!({"id": 1, "result": {"n": 1}})),
        ],
    );
    let mut s = spawn_fake(&t, false, TransportConfig::default());
    let empty = json!({});
    let (one, two) = tokio::join!(
        s.conn.request_value("a/one", &empty),
        async {
            tokio::time::sleep(Duration::from_millis(30)).await;
            s.conn.request_value("a/two", &empty).await
        }
    );
    assert_eq!(one.unwrap(), json!({"n": 1}));
    assert_eq!(two.unwrap(), json!({"n": 2}));
    let (code, stderr) = fake_exit_of(&mut s).await;
    assert_eq!(code, Some(0), "{stderr}");
}

#[tokio::test]
async fn error_answers_are_rpc_errors() {
    let t = transcript(
        "rpc-error",
        vec![
            out(json!({"id": 1, "method": "turn/steer", "params": {}})),
            inb(json!({"id": 1, "error": {"code": -32600, "message": "expectedTurnId mismatch"}})),
        ],
    );
    let mut s = spawn_fake(&t, false, TransportConfig::default());
    match s.conn.request_value("turn/steer", &json!({})).await {
        Err(CallError::Rpc(error)) => assert_eq!(error.message, "expectedTurnId mismatch"),
        other => panic!("expected an rpc error, got {other:?}"),
    }
    fake_exit_of(&mut s).await;
}

#[tokio::test]
async fn unknown_server_requests_get_method_not_found() {
    let t = transcript(
        "unknown-request",
        vec![
            inb(json!({"id": 7, "method": "item/tool/call", "params": {"x": 1}})),
            out(json!({"id": 7, "error": {"code": -32601, "message": "GOAT does not handle item/tool/call"}})),
            inb(json!({"method": "turn/started", "params": {"threadId": "t", "turn": {"id": "u"}}})),
        ],
    );
    let mut s = spawn_fake(&t, false, TransportConfig::default());
    assert!(matches!(next(&mut s.inbound).await, Inbound::Diagnostic(d) if d.contains("-32601")));
    assert!(matches!(next(&mut s.inbound).await, Inbound::Notification(Notification::TurnStarted(_))));
    let (code, stderr) = fake_exit_of(&mut s).await;
    assert_eq!(code, Some(0), "{stderr}");
}

#[tokio::test]
async fn malformed_lines_are_skipped() {
    let t = transcript(
        "malformed",
        vec![
            inb(json!("{not json")),
            inb(json!({"method": "thread/closed", "params": {"threadId": "t"}})),
        ],
    );
    let mut s = spawn_fake(&t, false, TransportConfig::default());
    // The fake writes the JSON string literal; the transport sees a non-object line.
    assert!(matches!(next(&mut s.inbound).await, Inbound::Diagnostic(_)));
    assert!(matches!(
        next(&mut s.inbound).await,
        Inbound::Notification(Notification::ThreadClosed { .. })
    ));
    fake_exit_of(&mut s).await;
}

#[tokio::test]
async fn eof_while_waiting_is_closed() {
    let t = transcript(
        "eof",
        vec![
            out(json!({"id": 1, "method": "turn/start", "params": {}})),
            json!({"type": "runtime_exit", "status": "error"}),
        ],
    );
    let mut s = spawn_fake(&t, false, TransportConfig::default());
    assert_eq!(s.conn.request_value("turn/start", &json!({})).await, Err(CallError::Closed));
    s.conn.closed().await;
    assert_eq!(s.conn.request_value("turn/start", &json!({})).await, Err(CallError::Closed));
    fake_exit_of(&mut s).await;
}

#[tokio::test]
async fn slow_answers_within_the_deadline_arrive() {
    let t = transcript(
        "slow",
        vec![
            out(json!({"id": 1, "method": "turn/start", "params": {}})),
            inb_after(json!({"id": 1, "result": {"turn": {"id": "u"}}}), 1500),
        ],
    );
    let mut s = spawn_fake(&t, true, TransportConfig::default());
    let answer = s.conn.request_value("turn/start", &json!({})).await.unwrap();
    assert_eq!(answer["turn"]["id"], "u");
    fake_exit_of(&mut s).await;
}

#[tokio::test]
async fn late_answers_after_a_deadline_are_delivered() {
    // v1 CodexRequestDeadline: the call fails at its deadline, the answer still arrives later.
    let t = transcript(
        "late",
        vec![
            out(json!({"id": 1, "method": "turn/start", "params": {}})),
            inb_after(json!({"method": "turn/started", "params": {"threadId": "t", "turn": {"id": "u"}}}), 50),
            inb_after(json!({"id": 1, "result": {"turn": {"id": "u"}}}), 400),
        ],
    );
    let mut s = spawn_fake(&t, true, short(Duration::from_millis(200), Duration::from_secs(5)));
    assert_eq!(
        s.conn.request_value("turn/start", &json!({})).await,
        Err(CallError::Deadline { method: "turn/start".into() })
    );
    assert!(matches!(next(&mut s.inbound).await, Inbound::Notification(Notification::TurnStarted(_))));
    match next(&mut s.inbound).await {
        Inbound::LateResponse { method, result, .. } => {
            assert_eq!(method, "turn/start");
            assert_eq!(result.unwrap()["turn"]["id"], "u");
        }
        other => panic!("expected a late response, got {other:?}"),
    }
    fake_exit_of(&mut s).await;
}

#[tokio::test]
async fn a_silent_server_is_probed_then_retired() {
    let t = transcript(
        "silent",
        vec![
            out(json!({"id": 1, "method": "turn/steer", "params": {}})),
            out(json!({"id": 2, "method": "config/read", "params": {"cwd": null, "includeLayers": false}})),
        ],
    );
    let mut s = spawn_fake(&t, true, short(Duration::from_millis(100), Duration::from_millis(300)));
    assert!(matches!(
        s.conn.request_value("turn/steer", &json!({})).await,
        Err(CallError::Deadline { .. })
    ));
    assert_eq!(next(&mut s.inbound).await, Inbound::Retired { method: "turn/steer".into() });
    assert!(s.conn.is_closed());
    // The fake saw the probe frame (exit 0 after stdin closes).
    let (code, stderr) = fake_exit_of(&mut s).await;
    assert_eq!(code, Some(0), "{stderr}");
}

#[tokio::test]
async fn a_server_that_answers_the_probe_stays() {
    let t = transcript(
        "probe-answered",
        vec![
            out(json!({"id": 1, "method": "turn/steer", "params": {}})),
            out(json!({"id": 2, "method": "config/read", "params": {"cwd": null, "includeLayers": false}})),
            inb(json!({"id": 2, "result": {"config": {}}})),
            out(json!({"id": 3, "method": "turn/interrupt", "params": {}})),
            inb(json!({"id": 3, "result": {}})),
        ],
    );
    let mut s = spawn_fake(&t, true, short(Duration::from_millis(100), Duration::from_millis(2000)));
    assert!(matches!(
        s.conn.request_value("turn/steer", &json!({})).await,
        Err(CallError::Deadline { .. })
    ));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!s.conn.is_closed(), "a live server is not retired");
    assert_eq!(s.conn.request_value("turn/interrupt", &json!({})).await.unwrap(), json!({}));
    fake_exit_of(&mut s).await;
}

#[tokio::test]
async fn an_initialize_deadline_retires_at_once() {
    let t = transcript("init-deadline", vec![out(json!({"id": 1, "method": "initialize", "params": {}}))]);
    let mut s = spawn_fake(&t, true, short(Duration::from_millis(100), Duration::from_secs(30)));
    assert!(matches!(
        s.conn.request_value("initialize", &json!({})).await,
        Err(CallError::Deadline { .. })
    ));
    assert_eq!(next(&mut s.inbound).await, Inbound::Retired { method: "initialize".into() });
    fake_exit_of(&mut s).await;
}

#[tokio::test]
async fn undecodable_success_bodies_are_decode_errors() {
    let t = transcript(
        "decode",
        vec![
            out(json!({"id": 1, "method": "turn/start", "params": {}})),
            inb(json!({"id": 1, "result": {"unexpected": true}})),
        ],
    );
    let mut s = spawn_fake(&t, false, TransportConfig::default());
    let result: Result<goat2_engine_codex::protocol::client::TurnStartResponse, _> =
        s.conn.request("turn/start", &json!({})).await;
    assert!(matches!(result, Err(CallError::Decode(_))));
    fake_exit_of(&mut s).await;
}
