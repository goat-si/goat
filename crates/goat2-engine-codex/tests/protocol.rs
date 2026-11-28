use goat2_engine_codex::protocol::client::{
    ThreadOpenResponse, ThreadStatusWire, TurnStartResponse,
};
use goat2_engine_codex::protocol::server::{
    CommandDecision, Notification, ParsedRequest, ServerRequest, ThreadItem, parse_notification,
    parse_server_request,
};
use goat2_engine_codex::protocol::{
    Incoming, RpcId, notification_frame, parse_incoming, request_frame,
};
use serde_json::json;

#[test]
fn classifies_the_four_frame_kinds() {
    assert!(matches!(
        parse_incoming(r#"{"id":1,"result":{"ok":true}}"#).unwrap(),
        Incoming::Response {
            id: RpcId::Int(1),
            ..
        }
    ));
    assert!(matches!(
        parse_incoming(r#"{"id":"a","error":{"code":-1,"message":"no"}}"#).unwrap(),
        Incoming::Error {
            id: RpcId::Str(_),
            ..
        }
    ));
    assert!(matches!(
        parse_incoming(r#"{"method":"turn/started","params":{}}"#).unwrap(),
        Incoming::Notification { .. }
    ));
    assert!(matches!(
        parse_incoming(r#"{"id":0,"method":"item/tool/call","params":{}}"#).unwrap(),
        Incoming::Request {
            id: RpcId::Int(0),
            ..
        }
    ));
    assert!(parse_incoming("{not json").is_err());
    assert!(parse_incoming("[1]").is_err());
}

#[test]
fn frames_carry_no_jsonrpc_member() {
    let request = request_frame(&RpcId::Int(3), "turn/start", json!({"threadId": "t"}));
    let notification = notification_frame("initialized", serde_json::Value::Null);
    assert!(request.get("jsonrpc").is_none());
    assert_eq!(notification, json!({"method": "initialized"}));
}

#[test]
fn unknown_notifications_and_bad_params_are_skippable() {
    assert_eq!(
        parse_notification("account/rateLimits/updated", json!({})),
        Notification::Unknown {
            method: "account/rateLimits/updated".into()
        }
    );
    assert!(matches!(
        parse_notification("turn/started", json!({"threadId": 5})),
        Notification::Malformed { .. }
    ));
}

#[test]
fn unknown_item_types_and_extra_fields_decode() {
    let item: ThreadItem = serde_json::from_value(json!({"type": "hologram", "id": "x"})).unwrap();
    assert_eq!(item, ThreadItem::Unknown);
    let item: ThreadItem = serde_json::from_value(json!({
        "type": "agentMessage", "id": "msg_1", "text": "hi", "phase": "final_answer", "brandNew": {"a": 1}
    }))
    .unwrap();
    assert_eq!(item.id(), Some("msg_1"));
    let opened: ThreadOpenResponse = serde_json::from_value(json!({
        "thread": {"id": "t1", "status": {"type": "active", "activeFlags": ["waitingOnApproval"]}, "future": true},
        "model": "m", "somethingNew": [1, 2]
    }))
    .unwrap();
    assert!(opened.thread.status.unwrap().is_active());
    let other: ThreadStatusWire = serde_json::from_value(json!({"type": "hibernating"})).unwrap();
    assert_eq!(other, ThreadStatusWire::Other);
    let turn: TurnStartResponse =
        serde_json::from_value(json!({"turn": {"id": "u1", "status": "inProgress", "items": []}}))
            .unwrap();
    assert_eq!(turn.turn.id, "u1");
}

#[test]
fn server_requests_decode_or_are_unknown() {
    let parsed = parse_server_request(
        "item/commandExecution/requestApproval",
        json!({
            "threadId": "t", "turnId": "u", "itemId": "exec-1", "startedAtMs": 1,
            "command": "touch x",
            "availableDecisions": ["accept", {"acceptWithExecpolicyAmendment": {"execpolicy_amendment": ["touch"]}}, {"futureShape": 1}, "cancel"]
        }),
    );
    let ParsedRequest::Known(ServerRequest::CommandApproval(params)) = parsed else {
        panic!("expected a command approval, got {parsed:?}")
    };
    let decisions = params.available_decisions.unwrap();
    assert_eq!(decisions[0], CommandDecision::Accept);
    assert_eq!(
        decisions[1],
        CommandDecision::AcceptWithExecpolicyAmendment {
            execpolicy_amendment: vec!["touch".into()]
        }
    );
    assert!(matches!(decisions[2], CommandDecision::Other(_)));
    assert_eq!(
        decisions[1].to_value(),
        json!({"acceptWithExecpolicyAmendment": {"execpolicy_amendment": ["touch"]}})
    );
    assert_eq!(
        parse_server_request("item/tool/call", json!({})),
        ParsedRequest::Unknown
    );
    assert!(matches!(
        parse_server_request("item/fileChange/requestApproval", json!({"threadId": 1})),
        ParsedRequest::Malformed(_)
    ));
}
