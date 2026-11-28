//! An agent's own questions to the person (`goat_ask`, path `request.ask`): a decision among
//! options, or 1 to 4 questions with options shown in turn on one card (PRD part2/bot.md 3).
//!
//! The card is the same `user_input_request` item an engine question records (v1
//! `OrchestrationV2UserInputQuestion`, `channelNativeQuestionCards.ts` shape), so the UI draws
//! both one way. Lifted from GOAT v1 (goat origin/dev 916b5ccc1b2): the question/option shape
//! from `packages/contracts/src/orchestrationV2.ts`, distinct option labels and the exact-label
//! answer from `channels/channelDecisionChoices.ts` (matchingOption); the limits (1-4
//! questions, 2-4 options, header at most 12 characters) are Claude AskUserQuestion's, which v1
//! maps to the same item (`ClaudeAdapterV2.ts`).
//!
//! An agent's request id starts with `ask_`: it is answered by turning the answer into a new
//! input (the engine never holds it), so it stays open across runs and restarts.

use goat2_contracts::{
    ItemId, RequestId, RunId, ThreadId, TurnItem, TurnItemBody, TurnItemStatus, UserInputQuestion,
};
use serde_json::Value;

use crate::api::{AskKind, RequestAskArgs};
use crate::core::Host;

pub const MAX_QUESTIONS: usize = 4;
pub const MIN_OPTIONS: usize = 2;
pub const MAX_OPTIONS: usize = 4;
pub const HEADER_MAX_CHARS: usize = 12;

/// An agent's own request (answered as an input, kept across restarts).
pub fn is_agent_ask(id: &RequestId) -> bool {
    id.as_str().starts_with("ask_")
}

/// Check `goat_ask` arguments beyond the schema.
pub fn check(a: &RequestAskArgs) -> Result<(), String> {
    if let Some(rec) = &a.recommended {
        if a.kind != AskKind::Decision {
            return Err(
                "recommended is for a decision; mark a question's option label instead".into(),
            );
        }
        if !a.options.iter().any(|o| &o.id == rec) {
            return Err(format!("recommended {rec:?} is not one of the option ids"));
        }
    }
    let mut ids = std::collections::HashSet::new();
    for o in &a.options {
        if !ids.insert(o.id.as_str()) {
            return Err(format!("option id {:?} is used twice", o.id));
        }
    }
    if a.questions.is_empty() {
        return Ok(());
    }
    if a.kind != AskKind::Question {
        return Err("questions go with kind question".into());
    }
    if a.questions.len() > MAX_QUESTIONS {
        return Err(format!("at most {MAX_QUESTIONS} questions"));
    }
    let mut qids = std::collections::HashSet::new();
    for q in &a.questions {
        if q.id.trim().is_empty() || !qids.insert(q.id.as_str()) {
            return Err(format!("question id {:?} is empty or used twice", q.id));
        }
        if q.question.trim().is_empty() {
            return Err(format!("question {:?} has no text", q.id));
        }
        if q.header.chars().count() > HEADER_MAX_CHARS {
            return Err(format!(
                "question {:?}: header is longer than {HEADER_MAX_CHARS} characters",
                q.id
            ));
        }
        if !(MIN_OPTIONS..=MAX_OPTIONS).contains(&q.options.len()) {
            return Err(format!(
                "question {:?}: give {MIN_OPTIONS} to {MAX_OPTIONS} options",
                q.id
            ));
        }
        let mut labels = std::collections::HashSet::new();
        for o in &q.options {
            if o.label.trim().is_empty() || !labels.insert(loose(&o.label)) {
                return Err(format!(
                    "question {:?}: option labels must be distinct",
                    q.id
                ));
            }
        }
    }
    Ok(())
}

/// v1 matchingOption's comparison: case, surrounding space and Unicode form ignored.
fn loose(s: &str) -> String {
    s.trim().to_lowercase()
}

/// The waiting item for an agent's questions.
pub fn question_item(
    thread: &ThreadId,
    run: &RunId,
    request: &RequestId,
    questions: Vec<UserInputQuestion>,
) -> TurnItem {
    let now = crate::util::now_rfc3339();
    TurnItem {
        id: ItemId::new(format!("item_{}", request.as_str())),
        thread_id: thread.clone(),
        run_id: Some(run.clone()),
        provider_thread_id: None,
        provider_turn_id: None,
        native_item_ref: None,
        parent_item_id: None,
        ordinal: 0,
        status: TurnItemStatus::Completed,
        title: None,
        started_at: Some(now.clone()),
        completed_at: Some(now.clone()),
        updated_at: now,
        body: TurnItemBody::UserInputRequest {
            request_id: request.clone(),
            questions,
        },
    }
}

/// The questions of a request's waiting item, from the thread log.
pub fn questions_of(host: &Host, thread: &ThreadId, item: &ItemId) -> Vec<UserInputQuestion> {
    let Ok(lines) = host.store().read_after(thread, 0) else {
        return Vec::new();
    };
    lines
        .into_iter()
        .rev()
        .find_map(|l| match l.event {
            goat2_contracts::LogEvent::ItemCompleted(done) if &done.item.id == item => {
                match done.item.body {
                    TurnItemBody::UserInputRequest { questions, .. } => Some(questions),
                    _ => None,
                }
            }
            _ => None,
        })
        .unwrap_or_default()
}

fn answer_words(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Array(items) => {
            let words: Vec<String> = items.iter().filter_map(answer_words).collect();
            (!words.is_empty()).then(|| words.join(", "))
        }
        Value::Object(map) => map.get("answers").and_then(answer_words),
        _ => None,
    }
}

/// The answer input's text: one line per question, in the order asked.
pub fn answers_text(
    questions: &[UserInputQuestion],
    answers: &serde_json::Map<String, Value>,
    note: Option<&str>,
) -> String {
    let mut lines: Vec<String> = questions
        .iter()
        .map(|q| {
            let answer = answers
                .get(&q.id)
                .and_then(answer_words)
                .unwrap_or_else(|| "(no answer)".to_owned());
            format!("\n- {}: {}", q.question, answer)
        })
        .collect();
    if let Some(note) = note.filter(|n| !n.trim().is_empty()) {
        lines.push(format!("\n- note: {note}"));
    }
    lines.concat()
}

#[cfg(test)]
mod tests {
    use super::*;
    use goat2_contracts::UserInputOption;

    fn q(id: &str, labels: &[&str]) -> UserInputQuestion {
        UserInputQuestion {
            id: id.into(),
            header: "Pick".into(),
            question: format!("{id}?"),
            options: labels
                .iter()
                .map(|l| UserInputOption {
                    label: (*l).into(),
                    description: "d".into(),
                    value: None,
                    preview: None,
                })
                .collect(),
            multi_select: None,
            allow_custom_answer: None,
            initial_answer: None,
            required: None,
        }
    }

    fn ask(questions: Vec<UserInputQuestion>) -> RequestAskArgs {
        RequestAskArgs {
            kind: AskKind::Question,
            summary: "s".into(),
            detail: None,
            options: Vec::new(),
            recommended: None,
            questions,
            client_request_id: None,
        }
    }

    #[test]
    fn limits() {
        assert!(
            check(&ask(vec![
                q("a", &["x", "y"]),
                q("b", &["x", "y", "z", "w"])
            ]))
            .is_ok()
        );
        assert!(check(&ask(vec![q("a", &["x"])])).is_err());
        assert!(check(&ask(vec![q("a", &["x", "X "])])).is_err());
        assert!(check(&ask(vec![q("a", &["x", "y"]), q("a", &["x", "y"])])).is_err());
        assert!(
            check(&ask((0..5)
                .map(|i| q(&i.to_string(), &["x", "y"]))
                .collect()))
            .is_err()
        );
    }

    #[test]
    fn answers_in_question_order() {
        let qs = vec![q("scope", &["Unit", "E2E"]), q("pr", &["One", "Many"])];
        let mut answers = serde_json::Map::new();
        answers.insert("pr".into(), Value::Array(vec!["One".into()]));
        answers.insert("scope".into(), serde_json::json!({"answers": ["Unit"]}));
        assert_eq!(
            answers_text(&qs, &answers, None),
            "\n- scope?: Unit\n- pr?: One"
        );
    }
}
