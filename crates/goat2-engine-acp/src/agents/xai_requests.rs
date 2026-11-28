//! xAI reverse requests Grok sends to the client: `x.ai/ask_user_question` and `x.ai/exit_plan_mode`.
//!
//! v1 `packages/provider-grok/src/server/xaiAcpExtension.ts:880-1235` (schemas, question extraction,
//! answer normalization, plan capture) and `packages/provider-grok/src/server/adapter.ts:171-230`
//! (registration). Without `planContent` the plan is the one last captured in the turn (v1
//! `lastProposedPlanMarkdown`, which the plan file Grok writes feeds; see `grok_plan`), else the
//! empty-plan text.

use goat2_contracts::{UserInputOption, UserInputQuestion};
use serde_json::{Map, Value, json};

use crate::flavor::ExtRequest;

pub const ASK_USER_QUESTION: [&str; 2] = ["x.ai/ask_user_question", "_x.ai/ask_user_question"];
pub const EXIT_PLAN_MODE: [&str; 2] = ["x.ai/exit_plan_mode", "_x.ai/exit_plan_mode"];

/// v1 `XAI_EMPTY_PLAN_MARKDOWN`.
pub const EMPTY_PLAN_MARKDOWN: &str =
    "# No plan written yet\n\n(The agent exited plan mode without writing a plan.)";

fn trimmed(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// v1 accepts the params bare or wrapped as `{method, params}`.
fn unwrap(params: &Value) -> &Value {
    match params.get("params") {
        Some(inner) if params.get("method").is_some() => inner,
        _ => params,
    }
}

/// v1 `extractXAiExitPlanMarkdown` (xaiAcpExtension.ts:921-935): the request's plan; the driver falls
/// back to the turn's last captured plan, then [EMPTY_PLAN_MARKDOWN].
pub fn exit_plan_markdown(params: &Value) -> Option<String> {
    trimmed(unwrap(params).get("planContent"))
}

/// v1 `makeXAiExitPlanModeCapturedResponse`: abandon Grok's own plan gate so the turn goes on.
pub fn exit_plan_captured_response() -> Value {
    json!({
        "outcome": "abandoned",
        "feedback": "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.",
    })
}

fn raw_questions(params: &Value) -> Vec<Value> {
    unwrap(params)
        .get("questions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn question_text(question: &Value) -> String {
    question
        .get("question")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn question_key(question: &Value) -> String {
    question
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| question_text(question))
}

fn options_of(question: &Value) -> Vec<Value> {
    question
        .get("options")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn multi_select(question: &Value) -> bool {
    question.get("multiSelect").and_then(Value::as_bool) == Some(true)
}

/// v1 `extractXAiAskUserQuestions`.
pub fn ask_user_questions(params: &Value) -> Vec<UserInputQuestion> {
    raw_questions(params)
        .iter()
        .map(|question| {
            let options = options_of(question);
            UserInputQuestion {
                id: question_key(question),
                header: "Question".into(),
                question: question_text(question),
                options: if options.is_empty() {
                    vec![UserInputOption {
                        label: "OK".into(),
                        description: "Continue".into(),
                        value: None,
                        preview: None,
                    }]
                } else {
                    options
                        .iter()
                        .map(|option| {
                            let label = option
                                .get("label")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_owned();
                            UserInputOption {
                                description: option
                                    .get("description")
                                    .and_then(Value::as_str)
                                    .map(str::to_owned)
                                    .unwrap_or_else(|| label.clone()),
                                label,
                                value: None,
                                preview: None,
                            }
                        })
                        .collect()
                },
                multi_select: Some(multi_select(question)),
                allow_custom_answer: None,
                initial_answer: None,
                required: None,
            }
        })
        .collect()
}

/// v1 `answerValues`.
fn answer_values(answer: Option<&Value>) -> Vec<String> {
    match answer {
        Some(Value::Array(entries)) => entries.iter().filter_map(|e| trimmed(Some(e))).collect(),
        other => trimmed(other).into_iter().collect(),
    }
}

/// v1 `makeXAiAskUserQuestionResponse` (with `normalizeAnswerForXAi` and `findQuestionAnswer`).
pub fn ask_user_response(params: &Value, answers: &Map<String, Value>) -> Value {
    let mut out_answers = Map::new();
    let mut annotations = Map::new();
    for question in raw_questions(params) {
        let text = question_text(&question);
        let answer = answers
            .get(&question_key(&question))
            .or_else(|| answers.get(&text));
        let values = answer_values(answer);
        if values.is_empty() {
            if multi_select(&question) && matches!(answer, Some(Value::Array(_))) {
                out_answers.insert(text, json!([]));
            }
            continue;
        }
        let options = options_of(&question);
        let option_for = |value: &str| {
            options
                .iter()
                .find(|o| o.get("label").and_then(Value::as_str) == Some(value))
        };
        let selected: Vec<String> = values
            .iter()
            .filter(|v| option_for(v).is_some())
            .cloned()
            .collect();
        let notes: Vec<String> = values
            .iter()
            .filter(|v| option_for(v).is_none())
            .cloned()
            .collect();
        let preview = if multi_select(&question) {
            None
        } else {
            values
                .iter()
                .find_map(|v| option_for(v).and_then(|o| trimmed(o.get("preview"))))
        };
        let mut annotation = Map::new();
        if let Some(preview) = preview {
            annotation.insert("preview".into(), json!(preview));
        }
        if !notes.is_empty() {
            annotation.insert("notes".into(), json!(notes.join("\n")));
        }
        if !annotation.is_empty() {
            annotations.insert(text.clone(), Value::Object(annotation));
        }
        out_answers.insert(
            text,
            json!(if selected.is_empty() {
                vec!["Other".to_owned()]
            } else {
                selected
            }),
        );
    }
    let mut response = json!({"outcome": "accepted", "answers": out_answers});
    if !annotations.is_empty() {
        response["annotations"] = Value::Object(annotations);
    }
    response
}

/// v1 `makeXAiAskUserQuestionCancelledResponse`.
pub fn ask_user_cancelled() -> Value {
    json!({"outcome": "cancelled"})
}

/// The driver action for an xAI reverse request, or None when `method` is not one.
pub fn xai_request_action(method: &str, params: &Value) -> Option<ExtRequest> {
    if EXIT_PLAN_MODE.contains(&method) {
        return Some(ExtRequest::CapturePlan {
            markdown: exit_plan_markdown(params),
            fallback: EMPTY_PLAN_MARKDOWN.to_owned(),
            response: exit_plan_captured_response(),
        });
    }
    if !ASK_USER_QUESTION.contains(&method) {
        return None;
    }
    let inner = unwrap(params);
    // v1's schema (xaiAcpExtension.ts:875-880) requires `sessionId` and `toolCallId`; a request
    // without them is answered as cancelled, and the native id names the session too (v1
    // grok adapter.ts:214 `${sessionId}:xai-question:${toolCallId}`, round 7 part 4.3).
    let (Some(session_id), Some(tool_call_id)) = (
        inner.get("sessionId").and_then(Value::as_str),
        inner.get("toolCallId").and_then(Value::as_str),
    ) else {
        return Some(ExtRequest::Respond(ask_user_cancelled()));
    };
    let native_id = format!("{session_id}:xai-question:{tool_call_id}");
    let questions = ask_user_questions(params);
    let summary = questions
        .first()
        .map(|q| q.question.clone())
        .filter(|q| !q.is_empty())
        .unwrap_or_else(|| "Grok has a question".into());
    let params = params.clone();
    Some(ExtRequest::AskUser {
        native_id,
        summary,
        questions,
        answer: Box::new(move |answers| match answers {
            Some(answers) => ask_user_response(&params, answers),
            None => ask_user_cancelled(),
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ask() -> Value {
        json!({"sessionId": "s", "toolCallId": "tc1", "questions": [
            {"id": "color", "question": "Which color?", "options": [
                {"label": "Red", "preview": "warm"}, {"label": "Blue", "description": "cool"}]},
            {"question": "Which sizes?", "multiSelect": true, "options": [{"label": "S"}, {"label": "M"}]},
            {"question": "Anything else?", "options": []},
        ]})
    }

    #[test]
    fn questions_follow_v1_extraction() {
        let q = ask_user_questions(&json!({"method": "x.ai/ask_user_question", "params": ask()}));
        assert_eq!(q[0].id, "color");
        assert_eq!(q[0].options[0].description, "Red");
        assert_eq!(q[0].options[1].description, "cool");
        assert_eq!(q[1].id, "Which sizes?");
        assert_eq!(q[1].multi_select, Some(true));
        assert_eq!(q[2].options[0].label, "OK");
        assert_eq!(q[2].options[0].description, "Continue");
    }

    #[test]
    fn answers_follow_v1_normalization() {
        let answers =
            json!({"color": "Red", "Which sizes?": ["S", "XL"], "Anything else?": "no thanks"});
        let response = ask_user_response(&ask(), answers.as_object().unwrap());
        assert_eq!(
            response,
            json!({"outcome": "accepted",
                "answers": {"Which color?": ["Red"], "Which sizes?": ["S"], "Anything else?": ["Other"]},
                "annotations": {"Which color?": {"preview": "warm"}, "Which sizes?": {"notes": "XL"},
                    "Anything else?": {"notes": "no thanks"}}})
        );
        let empty = json!({"Which sizes?": []});
        assert_eq!(
            ask_user_response(&ask(), empty.as_object().unwrap()),
            json!({"outcome": "accepted", "answers": {"Which sizes?": []}})
        );
    }

    #[test]
    fn exit_plan_takes_content_or_the_empty_plan() {
        assert_eq!(
            exit_plan_markdown(&json!({"planContent": "  # Plan  "})).as_deref(),
            Some("# Plan")
        );
        assert_eq!(exit_plan_markdown(&json!({"planContent": null})), None);
        assert_eq!(exit_plan_markdown(&json!({"planContent": "  "})), None);
        assert_eq!(exit_plan_captured_response()["outcome"], "abandoned");
    }

    /// v1 xaiAcpExtension.ts:875-880 and grok adapter.ts:214: a question without its tool call id
    /// is cancelled, and the native id names the session (round 7 part 4.3).
    #[test]
    fn questions_need_their_identity() {
        let mut missing = ask();
        missing.as_object_mut().unwrap().remove("toolCallId");
        match xai_request_action("x.ai/ask_user_question", &missing) {
            Some(ExtRequest::Respond(response)) => assert_eq!(response, ask_user_cancelled()),
            _ => panic!("a question without toolCallId is answered as cancelled"),
        }
        match xai_request_action("x.ai/ask_user_question", &ask()) {
            Some(ExtRequest::AskUser { native_id, .. }) => {
                assert_eq!(native_id, "s:xai-question:tc1")
            }
            _ => panic!("a question is asked"),
        }
    }
}
