//! Factory Droid (`factory-droid`, local `droid` / `factory-droid`). v1
//! `packages/provider-acp-registry/src/server/droidAcp.ts@916b5ccc1b2`.

use std::collections::BTreeSet;
use std::sync::{Arc, OnceLock};

use goat2_contracts::UserInputQuestion;
use regex::Regex;
use serde_json::{Map, Value};

use super::forms::{accept, cancel, form_properties, non_blank, option, split_attachments};
use crate::flavor::NativeElicitationForm;

fn pattern(cell: &'static OnceLock<Regex>, source: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(source).expect("regex"))
}

/// Droid pairs each choice with an optional `*_other` field. The client already offers custom
/// answers, so the companion is hidden and restored in the response (v1 `droidAcp.ts:27-84`).
pub fn extract_droid_elicitation_form(params: &Value) -> Option<NativeElicitationForm> {
    static QUESTION_ID: OnceLock<Regex> = OnceLock::new();
    static CHOICE_ID: OnceLock<Regex> = OnceLock::new();
    let properties = form_properties(params)?;
    let required: Vec<String> = params["requestedSchema"]
        .get("required")?
        .as_array()?
        .iter()
        .map(|id| id.as_str().map(str::to_owned))
        .collect::<Option<_>>()?;
    let mut questions = Vec::new();
    for (id, field) in properties {
        if !pattern(&QUESTION_ID, r"^question_[1-9]\d*$").is_match(id) {
            continue;
        }
        let field = field.as_object()?;
        if field.get("type").and_then(Value::as_str) != Some("string") {
            return None;
        }
        let header = non_blank(field.get("title"))?;
        let question = non_blank(field.get("description"))?;
        let mut choices = Vec::new();
        for choice in field.get("oneOf")?.as_array()? {
            let value = choice.get("const")?.as_str()?;
            if !pattern(&CHOICE_ID, r"^(?:option_\d+|other)$").is_match(value) {
                return None;
            }
            choices.push((value, non_blank(choice.get("title"))?));
        }
        let companion = properties.get(&format!("{id}_other"))?;
        if companion.get("type").and_then(Value::as_str) != Some("string") {
            return None;
        }
        let options: Vec<_> = choices
            .iter()
            .filter(|(value, _)| *value != "other")
            .map(|(value, title)| option(title, title, value))
            .collect();
        if options.is_empty() || !choices.iter().any(|(value, _)| *value == "other") {
            return None;
        }
        questions.push(UserInputQuestion {
            id: id.clone(),
            header: header.to_owned(),
            question: question.to_owned(),
            options,
            multi_select: None,
            allow_custom_answer: None,
            initial_answer: None,
            required: None,
        });
    }
    // Recognize only complete forms; leave every other schema to the ACP fallback.
    let required_ids: BTreeSet<&String> = required.iter().collect();
    if questions.is_empty()
        || properties.len() != questions.len() * 2
        || required_ids.len() != questions.len()
        || questions.iter().any(|q| !required_ids.contains(&q.id))
    {
        return None;
    }
    let asked = questions.clone();
    Some(NativeElicitationForm {
        questions,
        respond: Arc::new(move |answers: &Map<String, Value>| {
            let mut content = Map::new();
            for question in &asked {
                let Some(answer) = answers
                    .get(&question.id)
                    .and_then(Value::as_str)
                    .filter(|a| !a.trim().is_empty())
                else {
                    return cancel();
                };
                if question
                    .options
                    .iter()
                    .any(|o| o.value.as_deref() == Some(answer))
                {
                    content.insert(question.id.clone(), answer.into());
                    continue;
                }
                let selected = split_attachments(answer).and_then(|(prefix, suffix)| {
                    question
                        .options
                        .iter()
                        .find(|o| o.value.as_deref() == Some(prefix))
                        .map(|o| format!("{}{suffix}", o.label))
                });
                content.insert(question.id.clone(), "other".into());
                content.insert(
                    format!("{}_other", question.id),
                    selected.unwrap_or_else(|| answer.to_owned()).into(),
                );
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
        json!({"mode": "form", "message": "m", "requestedSchema": {"type": "object", "properties": {
            "question_1": {"type": "string", "title": "Color", "description": "Pick a color", "oneOf": [
                {"const": "option_1", "title": "Red"}, {"const": "option_2", "title": "Blue"}, {"const": "other", "title": "Other"}]},
            "question_1_other": {"type": "string"}
        }, "required": ["question_1"]}})
    }

    fn answers(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn droid_choice_form_hides_its_companion() {
        let form = extract_droid_elicitation_form(&request()).unwrap();
        assert_eq!(form.questions.len(), 1);
        assert_eq!(form.questions[0].header, "Color");
        assert_eq!(form.questions[0].options.len(), 2);
        let respond = |a| (form.respond)(&answers(a));
        assert_eq!(
            respond(json!({"question_1": "option_2"})),
            json!({"action": "accept", "content": {"question_1": "option_2"}})
        );
        assert_eq!(
            respond(json!({"question_1": "green"})),
            json!({"action": "accept", "content": {"question_1": "other", "question_1_other": "green"}})
        );
        let attached = "option_1\n\nAttached image \"a.png\": \"/tmp/a.png\"";
        assert_eq!(
            respond(json!({"question_1": attached}))["content"]["question_1_other"],
            "Red\n\nAttached image \"a.png\": \"/tmp/a.png\""
        );
        assert_eq!(
            respond(json!({"question_1": " "})),
            json!({"action": "cancel"})
        );
        assert_eq!(respond(json!({})), json!({"action": "cancel"}));
    }

    #[test]
    fn droid_rejects_other_shapes() {
        let mut extra = request();
        extra["requestedSchema"]["properties"]["note"] = json!({"type": "string"});
        assert!(extract_droid_elicitation_form(&extra).is_none());
        let mut no_other = request();
        no_other["requestedSchema"]["properties"]["question_1"]["oneOf"] =
            json!([{"const": "option_1", "title": "Red"}]);
        assert!(extract_droid_elicitation_form(&no_other).is_none());
        let mut optional = request();
        optional["requestedSchema"]["required"] = json!([]);
        assert!(extract_droid_elicitation_form(&optional).is_none());
        let mut url = request();
        url["mode"] = json!("url");
        assert!(extract_droid_elicitation_form(&url).is_none());
    }
}
