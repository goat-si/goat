//! OpenCode (`opencode`, `opencode-v2`, local `opencode`). v1
//! `packages/provider-acp-registry/src/server/opencodeAcp.ts@916b5ccc1b2`.

use std::collections::HashSet;
use std::sync::{Arc, OnceLock};

use goat2_contracts::UserInputQuestion;
use regex::Regex;
use serde_json::{Map, Value};

use super::forms::{
    accept, cancel, form_properties, non_blank, option, optional_str, split_attachments,
};
use crate::flavor::NativeElicitationForm;

const COMPANION_SUFFIX: &str = "_custom";

/// OpenCode 2.1 asks through ACP with a `qN` choice field plus a `qN_custom` companion.
/// Multi-select forms stay with the generic mapping (v1 `opencodeAcp.ts:54-136`).
pub fn extract_opencode_elicitation_form(params: &Value) -> Option<NativeElicitationForm> {
    static QUESTION_ID: OnceLock<Regex> = OnceLock::new();
    let question_id = QUESTION_ID.get_or_init(|| Regex::new(r"^q[0-9]+$").expect("regex"));
    let properties = form_properties(params)?;
    let mut questions: Vec<UserInputQuestion> = Vec::new();
    let mut with_companion = HashSet::new();
    let mut choices = 0;
    for (id, field) in properties {
        if !question_id.is_match(id) {
            let owner = id.strip_suffix(COMPANION_SUFFIX)?;
            if !question_id.is_match(owner) || !properties.contains_key(owner) {
                return None;
            }
            continue;
        }
        let companion = properties.get(&format!("{id}{COMPANION_SUFFIX}"));
        if let Some(companion) = companion {
            // The companion only carries a free-form answer, never a title we can show.
            let custom = companion.get("type").and_then(Value::as_str) == Some("string")
                && matches!(
                    companion.get("description").and_then(Value::as_str),
                    Some("Type your own answer" | "Add your own answer")
                );
            if !custom {
                return None;
            }
        }
        let field = field.as_object()?;
        if field.get("type").and_then(Value::as_str) != Some("string") {
            return None;
        }
        let title = non_blank(field.get("title"))?;
        let description = optional_str(field, "description").ok()?;
        let field_choices = field
            .get("oneOf")
            .and_then(Value::as_array)
            .and_then(|list| {
                list.iter()
                    .map(|choice| {
                        let choice = choice.as_object()?;
                        let value = choice.get("const")?.as_str()?;
                        let label = non_blank(choice.get("title"))?;
                        let detail = optional_str(choice, "description").ok()?;
                        Some((value, label, detail))
                    })
                    .collect::<Option<Vec<_>>>()
            });
        // Unsupported choice schemas belong to the generic mapping.
        if field_choices.is_none()
            && ["enum", "oneOf", "anyOf", "items"]
                .iter()
                .any(|key| field.contains_key(*key))
        {
            return None;
        }
        let options: Vec<_> = field_choices
            .unwrap_or_default()
            .into_iter()
            .map(|(value, label, detail)| {
                let detail = detail
                    .map(str::trim)
                    .filter(|d| !d.is_empty())
                    .unwrap_or(label);
                option(label, detail, value)
            })
            .collect();
        if !options.is_empty() {
            choices += 1;
        }
        if companion.is_some() {
            with_companion.insert(id.clone());
        }
        let allow_custom = companion.is_some() || options.is_empty();
        questions.push(UserInputQuestion {
            id: id.clone(),
            header: title.to_owned(),
            question: description
                .map(str::trim)
                .filter(|d| !d.is_empty())
                .unwrap_or(title)
                .to_owned(),
            options,
            multi_select: None,
            allow_custom_answer: Some(allow_custom),
            initial_answer: None,
            required: None,
        });
    }
    // Recognize only question forms with a choice; leave every other schema to the ACP fallback.
    if choices == 0 {
        return None;
    }
    let asked = questions.clone();
    Some(NativeElicitationForm {
        questions,
        respond: Arc::new(move |answers: &Map<String, Value>| {
            let mut content = Map::new();
            for question in &asked {
                let Some(answer) = answers.get(&question.id) else {
                    continue;
                };
                let Some(answer) = answer.as_str() else {
                    return cancel();
                };
                let companion = format!("{}{COMPANION_SUFFIX}", question.id);
                let find = |value: &str| {
                    question
                        .options
                        .iter()
                        .find(|o| o.value.as_deref() == Some(value))
                };
                if find(answer).is_some() {
                    content.insert(question.id.clone(), answer.into());
                    continue;
                }
                if answer.trim().is_empty() {
                    return cancel();
                }
                let split = split_attachments(answer);
                let attached =
                    split.and_then(|(prefix, suffix)| find(prefix).map(|o| (prefix, suffix, o)));
                if with_companion.contains(&question.id) {
                    match attached {
                        Some((prefix, suffix, choice)) => {
                            content.insert(question.id.clone(), prefix.into());
                            content.insert(companion, format!("{}{suffix}", choice.label).into());
                        }
                        None => {
                            content.insert(companion, answer.into());
                        }
                    }
                } else if question.options.is_empty() {
                    content.insert(question.id.clone(), answer.into());
                } else {
                    return cancel();
                }
            }
            accept(content)
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request() -> Value {
        json!({"mode": "form", "requestedSchema": {"properties": {
            "q1": {"type": "string", "title": "Pick", "description": "Which one?", "oneOf": [{"const": "a", "title": "A"}, {"const": "b", "title": "B", "description": "Bee"}]},
            "q1_custom": {"type": "string", "description": "Type your own answer"},
            "q2": {"type": "string", "title": "Why"}
        }}})
    }

    #[test]
    fn opencode_choice_and_text_questions() {
        let form = extract_opencode_elicitation_form(&request()).unwrap();
        assert_eq!(form.questions.len(), 2);
        assert_eq!(form.questions[0].question, "Which one?");
        assert_eq!(form.questions[0].allow_custom_answer, Some(true));
        assert_eq!(form.questions[1].question, "Why");
        assert_eq!(form.questions[1].allow_custom_answer, Some(true));
        let respond = |a: Value| (form.respond)(a.as_object().unwrap());
        assert_eq!(
            respond(json!({"q1": "a", "q2": "because"})),
            json!({"action": "accept", "content": {"q1": "a", "q2": "because"}})
        );
        assert_eq!(
            respond(json!({"q1": "mine"})),
            json!({"action": "accept", "content": {"q1_custom": "mine"}})
        );
        let attached = "b\n\nAttached file \"n.txt\": \"/tmp/n.txt\"";
        assert_eq!(
            respond(json!({"q1": attached}))["content"],
            json!({"q1": "b", "q1_custom": "B\n\nAttached file \"n.txt\": \"/tmp/n.txt\""})
        );
        assert_eq!(respond(json!({"q1": " "})), json!({"action": "cancel"}));
    }

    #[test]
    fn opencode_leaves_other_forms_to_the_generic_mapping() {
        let mut no_choice = request();
        no_choice["requestedSchema"]["properties"]["q1"]
            .as_object_mut()
            .unwrap()
            .remove("oneOf");
        assert!(extract_opencode_elicitation_form(&no_choice).is_none());
        let mut multi = request();
        multi["requestedSchema"]["properties"]["q2"]["items"] = json!({"type": "string"});
        assert!(extract_opencode_elicitation_form(&multi).is_none());
        let mut stray = request();
        stray["requestedSchema"]["properties"]["note"] = json!({"type": "string"});
        assert!(extract_opencode_elicitation_form(&stray).is_none());
        let mut strict = request();
        strict["requestedSchema"]["properties"]["q1"]["oneOf"] =
            json!([{"const": "a", "title": "A"}]);
        let form = extract_opencode_elicitation_form(&strict).unwrap();
        let mut no_companion = strict.clone();
        no_companion["requestedSchema"]["properties"]
            .as_object_mut()
            .unwrap()
            .remove("q1_custom");
        let form2 = extract_opencode_elicitation_form(&no_companion).unwrap();
        assert_eq!(form2.questions[0].allow_custom_answer, Some(false));
        assert_eq!(
            (form2.respond)(json!({"q1": "zz"}).as_object().unwrap()),
            json!({"action": "cancel"})
        );
        assert_eq!(form.questions.len(), 2);
    }
}
