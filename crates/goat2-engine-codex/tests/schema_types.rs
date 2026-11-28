//! The hand-written types serialize to frames the pinned codex 0.167.0 schema accepts, and
//! deliberately wrong frames fail (so the validator and the definition paths are live).

mod support;

use std::path::PathBuf;

use goat2_engine_codex::protocol::client::{
    InitializeParams, ThreadOptions, ThreadTurnsListParams, TurnInterruptParams, turn_start_params,
    turn_steer_params,
};
use goat2_engine_codex::protocol::server::{
    CommandApprovalResponse, CommandDecision, ElicitationAction, ElicitationResponse,
    FileChangeApprovalResponse, FileChangeDecision, NetworkPolicyAmendment,
    PermissionsApprovalResponse, UserInputResponse,
};
use goat2_engine_codex::protocol::{RpcId, methods, notification_frame, request_frame};
use serde_json::{Value, json};
use support::schema::SchemaBook;

fn as_request(method: &str, params: impl serde::Serialize) -> Value {
    request_frame(
        &RpcId::Int(1),
        method,
        serde_json::to_value(params).unwrap(),
    )
}

fn options(mcp: bool) -> ThreadOptions {
    ThreadOptions {
        model: Some("gpt-6-luna".into()),
        cwd: "/tmp/goat2".into(),
        approval_policy: Some("on-request".into()),
        sandbox: Some("workspace-write".into()),
        developer_instructions: Some("Be brief.".into()),
        goat_mcp: mcp.then(|| {
            (
                "http://127.0.0.1:3873/mcp".into(),
                "token0123456789abcdef".into(),
            )
        }),
    }
}

#[test]
fn every_outbound_request_type_is_schema_valid() {
    let mut book = SchemaBook::load();
    let frames = vec![
        as_request(methods::INITIALIZE, InitializeParams::goat("0.0.0")),
        as_request(methods::THREAD_START, options(true).start_params()),
        as_request(methods::THREAD_START, options(false).start_params()),
        as_request(
            methods::THREAD_RESUME,
            options(true).resume_params("01a22232-ada4-7c81-9bb6-b71d391de842"),
        ),
        as_request(
            methods::THREAD_TURNS_LIST,
            ThreadTurnsListParams::recent("t"),
        ),
        as_request(
            methods::TURN_START,
            turn_start_params(
                "t",
                "hello",
                &[PathBuf::from("/tmp/a.png")],
                Some("goat-msg-1"),
                Some("gpt-6-luna"),
                Some("low"),
            ),
        ),
        as_request(
            methods::TURN_STEER,
            turn_steer_params("t", "u", "more", &[], Some("goat-msg-2")),
        ),
        as_request(
            methods::TURN_INTERRUPT,
            TurnInterruptParams {
                thread_id: "t".into(),
                turn_id: "u".into(),
            },
        ),
        as_request("config/read", json!({"cwd": null, "includeLayers": false})),
    ];
    for frame in frames {
        book.validate("ClientRequest", &frame)
            .unwrap_or_else(|e| panic!("{} rejected: {e}\n{frame}", frame["method"]));
    }
    book.validate(
        "ClientNotification",
        &notification_frame(methods::INITIALIZED, Value::Null),
    )
    .unwrap();
}

#[test]
fn every_response_body_is_schema_valid() {
    let mut book = SchemaBook::load();
    let command_decisions = [
        CommandDecision::Accept,
        CommandDecision::AcceptForSession,
        CommandDecision::AcceptWithExecpolicyAmendment {
            execpolicy_amendment: vec!["touch".into()],
        },
        CommandDecision::ApplyNetworkPolicyAmendment {
            network_policy_amendment: NetworkPolicyAmendment {
                host: "example.com".into(),
                action: "allow".into(),
            },
        },
        CommandDecision::Decline,
        CommandDecision::Cancel,
    ];
    for decision in command_decisions {
        let body = serde_json::to_value(CommandApprovalResponse { decision }).unwrap();
        book.validate("CommandExecutionRequestApprovalResponse", &body)
            .unwrap_or_else(|e| panic!("{body}: {e}"));
    }
    for decision in [
        FileChangeDecision::Accept,
        FileChangeDecision::AcceptForSession,
        FileChangeDecision::Decline,
        FileChangeDecision::Cancel,
    ] {
        let body = serde_json::to_value(FileChangeApprovalResponse { decision }).unwrap();
        book.validate("FileChangeRequestApprovalResponse", &body)
            .unwrap_or_else(|e| panic!("{body}: {e}"));
    }
    let requested = json!({"fileSystem": {"write": ["/tmp/x"]}, "network": null});
    for body in [
        PermissionsApprovalResponse::grant(&requested, false),
        PermissionsApprovalResponse::grant(&requested, true),
        PermissionsApprovalResponse::decline(),
    ] {
        let body = serde_json::to_value(body).unwrap();
        book.validate("PermissionsRequestApprovalResponse", &body)
            .unwrap_or_else(|e| panic!("{body}: {e}"));
    }
    let answers = serde_json::to_value(UserInputResponse::new([(
        "q1".to_string(),
        vec!["Yes".to_string()],
    )]))
    .unwrap();
    book.validate("ToolRequestUserInputResponse", &answers)
        .unwrap();
    for (action, content) in [
        (ElicitationAction::Accept, Some(json!({"approval": "once"}))),
        (ElicitationAction::Decline, None),
        (ElicitationAction::Cancel, None),
    ] {
        let body = serde_json::to_value(ElicitationResponse { action, content }).unwrap();
        book.validate("McpServerElicitationRequestResponse", &body)
            .unwrap_or_else(|e| panic!("{body}: {e}"));
    }
}

#[test]
fn negative_controls_fail() {
    let mut book = SchemaBook::load();
    let steer_without_expected =
        json!({"id": 1, "method": "turn/steer", "params": {"threadId": "t", "input": []}});
    assert!(
        book.validate("ClientRequest", &steer_without_expected)
            .is_err()
    );
    let bad_decision = json!({"decision": "approve"});
    assert!(
        book.validate("CommandExecutionRequestApprovalResponse", &bad_decision)
            .is_err()
    );
    let unknown_method = json!({"id": 1, "method": "thread/explode", "params": {}});
    assert!(book.validate("ClientRequest", &unknown_method).is_err());
    assert!(book.validate("v2/NoSuchType", &json!({})).is_err());
}

#[test]
fn consumed_inbound_shapes_decode_from_schema_valid_samples() {
    use goat2_engine_codex::protocol::server::{
        Notification, ParsedRequest, parse_notification, parse_server_request,
    };
    let mut book = SchemaBook::load();
    let samples = [
        json!({"method": "turn/started", "params": {"threadId": "t", "turn": {"id": "u", "items": [], "status": "inProgress", "error": null, "startedAt": null, "completedAt": null, "durationMs": null, "itemsView": "notLoaded"}}}),
        json!({"method": "item/agentMessage/delta", "params": {"threadId": "t", "turnId": "u", "itemId": "msg_1", "delta": "hi"}}),
        json!({"method": "turn/plan/updated", "params": {"threadId": "t", "turnId": "u", "explanation": null, "plan": [{"step": "one", "status": "pending"}]}}),
        json!({"method": "serverRequest/resolved", "params": {"threadId": "t", "requestId": 0}}),
    ];
    for sample in samples {
        book.validate("ServerNotification", &sample)
            .unwrap_or_else(|e| panic!("{sample}: {e}"));
        let parsed =
            parse_notification(sample["method"].as_str().unwrap(), sample["params"].clone());
        assert!(
            !matches!(
                parsed,
                Notification::Unknown { .. } | Notification::Malformed { .. }
            ),
            "{sample} -> {parsed:?}"
        );
    }
    let request = json!({"id": 0, "method": "item/fileChange/requestApproval", "params": {"threadId": "t", "turnId": "u", "itemId": "i", "startedAtMs": 1, "reason": null}});
    book.validate("ServerRequest", &request).unwrap();
    assert!(matches!(
        parse_server_request("item/fileChange/requestApproval", request["params"].clone()),
        ParsedRequest::Known(_)
    ));
}
