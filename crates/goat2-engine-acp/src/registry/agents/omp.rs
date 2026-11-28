//! omp (Oh My Pi, local `omp acp`). v1 `packages/provider-acp-registry/src/server/ompAcp.ts@916b5ccc1b2`.

use std::sync::{Arc, OnceLock};

use goat2_contracts::UserInputQuestion;
use regex::Regex;
use serde_json::{Map, Value};

use super::forms::{accept, cancel, form_properties, non_blank, option, optional_str};
use crate::flavor::NativeElicitationForm;

/// OMP askDialog pairs `qN` choices with `qN__other` and puts the question in the title
/// (v1 `ompAcp.ts:25-66`).
pub fn extract_omp_elicitation_form(params: &Value) -> Option<NativeElicitationForm> {
    static QUESTION_ID: OnceLock<Regex> = OnceLock::new();
    let question_id = QUESTION_ID.get_or_init(|| Regex::new(r"^q\d+$").expect("regex"));
    let properties = form_properties(params)?;
    let mut questions: Vec<UserInputQuestion> = Vec::new();
    for (id, field) in properties {
        if !question_id.is_match(id) {
            continue;
        }
        let field = field.as_object()?;
        let title = non_blank(field.get("title"))?;
        let description = optional_str(field, "description").ok()?;
        if field.get("type").and_then(Value::as_str) != Some("string") {
            return None;
        }
        let mut options = Vec::new();
        for choice in field.get("oneOf")?.as_array()? {
            let choice = choice.as_object()?;
            let value = non_blank(choice.get("const"))?;
            let label = non_blank(choice.get("title"))?;
            let detail = optional_str(choice, "description")
                .ok()?
                .map(str::trim)
                .filter(|d| !d.is_empty())
                .unwrap_or(label);
            options.push(option(label, detail, value));
        }
        let companion = properties.get(&format!("{id}__other"))?;
        if companion.get("type").and_then(Value::as_str) != Some("string")
            || companion.get("title").and_then(Value::as_str) != Some("Other (type your own)")
        {
            return None;
        }
        if options.is_empty() {
            return None;
        }
        let header = description
            .map(str::trim)
            .filter(|d| !d.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("Question {}", questions.len() + 1));
        questions.push(UserInputQuestion {
            id: id.clone(),
            header,
            question: title.to_owned(),
            options,
            multi_select: None,
            allow_custom_answer: None,
            initial_answer: None,
            required: None,
        });
    }
    // Do not hide unknown fields or partially reinterpret a different form.
    if questions.is_empty() || properties.len() != questions.len() * 2 {
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
                let Some(answer) = answer.as_str().filter(|a| !a.trim().is_empty()) else {
                    return cancel();
                };
                if question
                    .options
                    .iter()
                    .any(|o| o.value.as_deref() == Some(answer))
                {
                    content.insert(question.id.clone(), answer.into());
                } else {
                    content.insert(format!("{}__other", question.id), answer.into());
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

    #[test]
    fn omp_question_form() {
        let request = json!({"mode": "form", "requestedSchema": {"properties": {
            "q1": {"type": "string", "title": "Which file?", "description": "Scope", "oneOf": [{"const": "a", "title": "A", "description": "First"}, {"const": "b", "title": "B"}]},
            "q1__other": {"type": "string", "title": "Other (type your own)"}
        }}});
        let form = extract_omp_elicitation_form(&request).unwrap();
        let question = &form.questions[0];
        assert_eq!(
            (question.header.as_str(), question.question.as_str()),
            ("Scope", "Which file?")
        );
        assert_eq!(question.options[0].description, "First");
        assert_eq!(question.options[1].description, "B");
        let respond = |a: Value| (form.respond)(a.as_object().unwrap());
        assert_eq!(
            respond(json!({"q1": "b"})),
            json!({"action": "accept", "content": {"q1": "b"}})
        );
        assert_eq!(
            respond(json!({"q1": "c"})),
            json!({"action": "accept", "content": {"q1__other": "c"}})
        );
        assert_eq!(
            respond(json!({})),
            json!({"action": "accept", "content": {}})
        );
        assert_eq!(respond(json!({"q1": ""})), json!({"action": "cancel"}));
        let mut wrong = request.clone();
        wrong["requestedSchema"]["properties"]["q1__other"]["title"] = json!("Other");
        assert!(extract_omp_elicitation_form(&wrong).is_none());
        let mut untitled = request;
        untitled["requestedSchema"]["properties"]["q1"]
            .as_object_mut()
            .unwrap()
            .remove("description");
        assert_eq!(
            extract_omp_elicitation_form(&untitled).unwrap().questions[0].header,
            "Question 1"
        );
    }
}
