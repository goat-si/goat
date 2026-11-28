mod support;
use goat2_engine_codex::{
    approvals::*,
    contract::{
        ProviderRequestKind as K, RequestId, RequestOutcome as O, RuntimeMode as M, ThreadId,
        TurnItemBody,
    },
    protocol::server::{
        CommandApprovalParams, CommandDecision, FileChangeDecision, UserInputQuestion,
    },
};
use serde_json::{Value, json};
use support::schema::SchemaBook;
fn params(v: Value) -> CommandApprovalParams {
    let mut x = json!({"threadId":"t","turnId":"u","itemId":"i"});
    x.as_object_mut()
        .unwrap()
        .extend(v.as_object().unwrap().clone());
    serde_json::from_value(x).unwrap()
}
#[test]
fn prompts_and_allowance() {
    let p = params(json!({"command":"ls","cwd":"/tmp"}));
    assert_eq!(command_prompt(&p).as_deref(), Some("ls\ncwd /tmp"));
    assert!(full_access_accepts_command(M::FullAccess, &p));
    assert!(!full_access_accepts_command(M::Auto, &p));
    assert!(!full_access_accepts_command(
        M::FullAccess,
        &params(json!({"networkApprovalContext":{}}))
    ));
    assert!(!full_access_accepts_command(
        M::FullAccess,
        &params(json!({"proposedNetworkPolicyAmendments":[{}]}))
    ));
    assert_eq!(
        file_change_prompt(
            &[
                ("z".into(), json!({"type":"update","move_path":"b"})),
                ("a".into(), json!({"type":"add"}))
            ],
            Some(" /x ")
        )
        .unwrap(),
        "add a\nupdate z -> b\nwrite /x"
    );
    let p = json!({"fileSystem":{"read":["/a"],"entries":[{"access":"write","path":{"type":"special","value":{"kind":"root"}}}]},"network":{"enabled":true}});
    assert_eq!(
        permissions_prompt(&p).unwrap(),
        "read /a\nwrite / (entire filesystem)\nnetwork"
    );
    assert_eq!(request_kind_from_permissions(&p), K::FileChange);
    let mut a = SessionAllowance::default();
    a.kinds_for(M::Auto).insert(K::Command);
    assert!(a.kinds_for(M::Auto).contains(&K::Command));
    assert!(a.kinds_for(M::FullAccess).is_empty());
    assert!(records_session_allowance(O::AcceptAlways));
}
#[test]
fn decisions_and_schemas() {
    let mut b = SchemaBook::load();
    for o in [
        O::Accept,
        O::AcceptForSession,
        O::AcceptAlways,
        O::Decline,
        O::Cancel,
    ] {
        let c = command_decision(o).unwrap();
        let f = file_change_decision(o).unwrap();
        if o == O::AcceptAlways {
            assert_eq!(c, CommandDecision::AcceptForSession);
            assert_eq!(f, FileChangeDecision::AcceptForSession)
        }
        b.validate(
            "CommandExecutionRequestApprovalResponse",
            &json!({"decision":c}),
        )
        .unwrap();
        b.validate("FileChangeRequestApprovalResponse", &json!({"decision":f}))
            .unwrap();
        let p = permissions_response(o, &json!({"network":{"enabled":true}})).unwrap();
        assert_eq!(
            p["scope"],
            if o == O::AcceptForSession {
                "session"
            } else {
                "turn"
            }
        );
        if matches!(o, O::AcceptAlways | O::Decline | O::Cancel) {
            assert_eq!(p["permissions"], json!({}))
        }
        b.validate("PermissionsRequestApprovalResponse", &p)
            .unwrap();
    }
    assert!(command_decision(O::Answered).is_err());
}
#[test]
fn questions_round_trip() {
    let t = ThreadId::new("t");
    let r = RequestId::new("r");
    let ctx = WaitingCtx {
        thread_id: &t,
        turn_id: "turn",
        native_item_id: "native",
        request_id: &r,
        ordinal: 1,
        now_ms: 0,
    };
    let q: UserInputQuestion = serde_json::from_value(
        json!({"id":"","header":"","question":"","options":[{"label":"","description":""}]}),
    )
    .unwrap();
    let (item, ids) = user_input_item(&ctx, &[q]);
    if let TurnItemBody::UserInputRequest { questions, .. } = &item.body {
        assert_eq!(questions[0].header, "Question");
        assert_eq!(questions[0].options[0].label, "Option 1");
    } else {
        panic!()
    }
    assert_eq!(summary(&item), "Choose an answer.");
    let answers = json!({"question-1":["yes",42]});
    let result = user_input_answers(answers.as_object().unwrap(), &ids);
    assert_eq!(result, json!({"answers":{"":{"answers":["yes","42"]}}}));
    SchemaBook::load()
        .validate("ToolRequestUserInputResponse", &result)
        .unwrap();
    let a = approval_item(
        &ctx,
        K::Command,
        Some("abc".into()),
        Some(" reason "),
        None,
        None,
    );
    assert_eq!(summary(&a), "abc");
    assert_eq!(a.id.as_str(), "approval:r");
}
#[test]
fn elicitation_cases() {
    let browser = json!({"mode":"form","serverName":"browser","requestedSchema":{"type":"object","properties":{"approval":{"type":"string","enum":["once","always"]}},"required":["approval"]}});
    let safari = json!({"mode":"form","serverName":"Safari","requestedSchema":{"type":"object","properties":{"approval":{"type":"string","oneOf":[{"const":"once","title":"Allow once"},{"const":"session","title":"Allow for this session"},{"const":"always","title":"Always allow Safari"}]}},"required":["approval"]}});
    let empty = json!({"mode":"form","requestedSchema":{"type":"object","properties":{}}});
    assert_eq!(
        elicitation::auto_approve(&browser)["content"]["approval"],
        "once"
    );
    assert_eq!(
        elicitation::auto_approve(&safari)["content"]["approval"],
        "once"
    );
    assert_eq!(elicitation::auto_approve(&empty)["content"], json!({}));
    assert_eq!(
        elicitation::auto_approve(&json!({"mode":"form","requestedSchema":{}}))["action"],
        "cancel"
    );
    assert_eq!(
        elicitation::response(&json!({"mode":"url"}), O::Accept).unwrap()["action"],
        "decline"
    );
    assert_eq!(elicitation::response(&json!({"mode":"form","requestedSchema":{"properties":{"x":{"type":"string"}},"required":["x"]}}),O::Accept).unwrap()["action"],"decline");
    let (name, opts) = elicitation::describe(&safari);
    assert_eq!(name, "Safari");
    assert_eq!(opts.len(), 5);
    let mut b = SchemaBook::load();
    for raw in [&browser, &safari, &empty] {
        b.validate(
            "McpServerElicitationRequestResponse",
            &elicitation::auto_approve(raw),
        )
        .unwrap();
        for o in [
            O::Accept,
            O::AcceptForSession,
            O::AcceptAlways,
            O::Decline,
            O::Cancel,
        ] {
            let v = elicitation::response(raw, o).unwrap();
            if raw == &safari && o == O::AcceptForSession {
                assert_eq!(v["_meta"]["persist"], "session")
            }
            if raw == &safari && o == O::AcceptAlways {
                assert_eq!(v["_meta"]["persist"], "always")
            }
            b.validate("McpServerElicitationRequestResponse", &v)
                .unwrap();
        }
    }
}
