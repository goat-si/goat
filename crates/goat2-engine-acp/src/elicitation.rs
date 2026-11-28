//! ACP elicitation forms as GOAT questions, and answers back to typed form content.
//!
//! v1: `packages/provider-acp/src/server/elicitationForm.ts` (`parseElicitationForm`,
//! `withOptionalChoices`), same rules: unaskable forms are declined, answers are typed as the schema
//! declares them, `<id>__other` / `<id>_other` companions fold into their single choice.

use std::collections::{BTreeSet, HashMap};

use goat2_contracts::{UserInputOption, UserInputQuestion};
use serde_json::{Map, Number, Value};

#[derive(Debug, Clone)]
enum Field {
    Text,
    Number {
        integer: bool,
    },
    Boolean,
    Choice {
        values: BTreeSet<String>,
    },
    MultiChoice {
        values: BTreeSet<String>,
        min: u64,
        max: Option<u64>,
    },
}

/// A parsed form: the questions to ask and how answers become content.
#[derive(Debug, Clone)]
pub struct ElicitationForm {
    pub questions: Vec<UserInputQuestion>,
    fields: Vec<(String, Field)>,
    required: BTreeSet<String>,
    companions: HashMap<String, String>,
    folded: BTreeSet<String>,
    allow_other: bool,
}

fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn option(label: String, description: String, value: String) -> UserInputOption {
    UserInputOption {
        label,
        description,
        value: Some(value),
        preview: None,
    }
}

fn enum_options(entries: Option<&Value>) -> Option<Vec<UserInputOption>> {
    let entries = entries?.as_array()?;
    if entries.is_empty() || !entries.iter().all(Value::is_string) {
        return None;
    }
    let values: Vec<&str> = entries.iter().filter_map(Value::as_str).collect();
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for value in &values {
        *counts.entry(value.trim()).or_default() += 1;
    }
    let quoted = |v: &str| serde_json::to_string(v).unwrap_or_default();
    let mut options: Vec<UserInputOption> = values
        .iter()
        .map(|value| {
            let plain = value.trim();
            let label = if !plain.is_empty() && counts.get(plain) == Some(&1) {
                plain.to_owned()
            } else {
                quoted(value)
            };
            option(label.clone(), label, (*value).to_owned())
        })
        .collect();
    let labels: BTreeSet<&str> = options.iter().map(|o| o.label.as_str()).collect();
    if labels.len() != options.len() {
        for entry in &mut options {
            let label = quoted(entry.value.as_deref().unwrap_or_default());
            entry.label = label.clone();
            entry.description = label;
        }
    }
    Some(options)
}

fn titled_option(entry: &Value) -> Option<UserInputOption> {
    let value = entry.get("const")?.as_str()?;
    let label = text(entry.get("title")).or_else(|| text(entry.get("const")))?;
    let description = text(entry.get("description")).unwrap_or_else(|| label.clone());
    Some(option(label, description, value.to_owned()))
}

fn choice_options(entries: Option<&Value>) -> Option<Vec<UserInputOption>> {
    let entries = entries?.as_array()?;
    if entries.is_empty() {
        return None;
    }
    entries.iter().map(titled_option).collect()
}

fn option_value(option: &UserInputOption) -> String {
    option.value.clone().unwrap_or_else(|| option.label.clone())
}

fn parse_field(property: &Map<String, Value>) -> Option<(Field, Vec<UserInputOption>)> {
    match property.get("type").and_then(Value::as_str) {
        Some("string") => {
            let enum_ = property.get("enum").filter(|v| !v.is_null());
            let one_of = property.get("oneOf").filter(|v| !v.is_null());
            if enum_.is_none() && one_of.is_none() {
                return Some((Field::Text, vec![]));
            }
            let options = if one_of.is_some_and(Value::is_array) {
                choice_options(one_of)
            } else {
                enum_options(enum_)
            }?;
            let values = options.iter().map(option_value).collect();
            Some((Field::Choice { values }, options))
        }
        Some("array") => {
            let items = property.get("items").and_then(Value::as_object);
            let options = match items {
                Some(items) if items.get("type").and_then(Value::as_str) == Some("string") => {
                    enum_options(items.get("enum"))
                }
                Some(items) if items.get("type").is_none() => choice_options(items.get("anyOf")),
                _ => None,
            }?;
            let values: BTreeSet<String> = options.iter().map(option_value).collect();
            let min = property
                .get("minItems")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let max = property.get("maxItems").and_then(Value::as_u64);
            if max == Some(0) || max.is_some_and(|max| min > max) || min > values.len() as u64 {
                return None;
            }
            Some((Field::MultiChoice { values, min, max }, options))
        }
        Some("boolean") => Some((
            Field::Boolean,
            vec![
                option("true".into(), "Yes".into(), "true".into()),
                option("false".into(), "No".into(), "false".into()),
            ],
        )),
        Some(kind @ ("number" | "integer")) => Some((
            Field::Number {
                integer: kind == "integer",
            },
            vec![],
        )),
        _ => None,
    }
}

fn required_ids(schema: Option<&Map<String, Value>>) -> BTreeSet<String> {
    schema
        .and_then(|s| s.get("required"))
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn typed_answer(field: &Field, answer: &Value) -> Option<Value> {
    match field {
        Field::Text => answer.as_str().map(|s| Value::String(s.to_owned())),
        Field::Boolean => match answer {
            Value::Bool(b) => Some(Value::Bool(*b)),
            Value::String(s) if s == "true" => Some(Value::Bool(true)),
            Value::String(s) if s == "false" => Some(Value::Bool(false)),
            _ => None,
        },
        Field::Number { integer } => {
            let parsed = match answer {
                Value::Number(n) => n.as_f64(),
                Value::String(s) if !s.trim().is_empty() => s.trim().parse::<f64>().ok(),
                _ => None,
            }?;
            if !parsed.is_finite() || (*integer && parsed.fract() != 0.0) {
                return None;
            }
            if *integer {
                Some(Value::Number(Number::from(parsed as i64)))
            } else {
                Number::from_f64(parsed).map(Value::Number)
            }
        }
        Field::Choice { values } => answer
            .as_str()
            .filter(|s| values.contains(*s))
            .map(|s| Value::String(s.to_owned())),
        Field::MultiChoice { values, min, max } => {
            let list = answer.as_array()?;
            let mut selected: Vec<String> = Vec::new();
            for entry in list.iter().filter_map(Value::as_str) {
                if values.contains(entry) && !selected.iter().any(|s| s == entry) {
                    selected.push(entry.to_owned());
                }
            }
            if selected.is_empty() && !list.is_empty() {
                return None;
            }
            let count = selected.len() as u64;
            if count >= *min && max.is_none_or(|max| count <= max) {
                Some(Value::Array(
                    selected.into_iter().map(Value::String).collect(),
                ))
            } else {
                None
            }
        }
    }
}

/// v1 `parseElicitationForm` (elicitationForm.ts:222-309). None: the form cannot be asked.
pub fn parse_elicitation_form(
    requested_schema: &Value,
    message: &str,
    allow_other: bool,
) -> Option<ElicitationForm> {
    let schema = requested_schema.as_object();
    let required = required_ids(schema);
    let mut fields: Vec<(String, Field)> = Vec::new();
    let mut parsed: Vec<(String, Map<String, Value>, Vec<UserInputOption>)> = Vec::new();
    if let Some(properties) = schema
        .and_then(|s| s.get("properties"))
        .and_then(Value::as_object)
    {
        for (id, value) in properties {
            let property = value.as_object()?;
            let (field, options) = parse_field(property)?;
            // Question ids must survive the contract's trim to round-trip answers.
            if id.trim() != id || id.is_empty() {
                return None;
            }
            fields.push((id.clone(), field));
            parsed.push((id.clone(), property.clone(), options));
        }
    }
    let field_of = |id: &str| fields.iter().find(|(f, _)| f == id).map(|(_, f)| f);
    let mut companions = HashMap::new();
    for (id, field) in &fields {
        if !matches!(field, Field::Choice { .. }) || required.contains(id) {
            continue;
        }
        let companion = [format!("{id}__other"), format!("{id}_other")]
            .into_iter()
            .find(|candidate| {
                matches!(field_of(candidate), Some(Field::Text)) && !required.contains(candidate)
            });
        if let Some(companion) = companion {
            companions.insert(id.clone(), companion);
        }
    }
    let folded: BTreeSet<String> = companions.values().cloned().collect();
    let mut questions = Vec::new();
    for (id, property, options) in parsed {
        if folded.contains(&id) {
            continue;
        }
        let field = field_of(&id).cloned();
        let header = text(property.get("title"))
            .unwrap_or_else(|| format!("Question {}", questions.len() + 1));
        let question = text(property.get("description")).unwrap_or_else(|| message.to_owned());
        let free_text = matches!(field, Some(Field::Text | Field::Number { .. }))
            || companions.contains_key(&id)
            || (allow_other
                && matches!(field, Some(Field::Choice { .. }))
                && field_of(&format!("{id}__other")).is_none());
        let multi = matches!(field, Some(Field::MultiChoice { .. }));
        let required_flag = match &field {
            Some(Field::MultiChoice { min, .. }) if *min > 0 && required.contains(&id) => {
                Some(true)
            }
            Some(Field::MultiChoice { .. }) => None,
            _ if !required.contains(&id) => Some(false),
            _ => None,
        };
        questions.push(UserInputQuestion {
            id: id.clone(),
            header,
            question,
            options,
            multi_select: multi.then_some(true),
            allow_custom_answer: (!free_text).then_some(false),
            initial_answer: None,
            required: required_flag,
        });
    }
    Some(ElicitationForm {
        questions,
        fields,
        required,
        companions,
        folded,
        allow_other,
    })
}

impl ElicitationForm {
    /// v1 `content`: typed answers, or None when a required field has no valid answer.
    pub fn content(&self, answers: &Map<String, Value>) -> Option<Map<String, Value>> {
        let mut out = Map::new();
        for (id, field) in &self.fields {
            if self.folded.contains(id) {
                continue;
            }
            let answer = answers.get(id);
            let typed = answer.and_then(|a| typed_answer(field, a));
            let companion = self.companions.get(id);
            if let Some(typed) = typed {
                out.insert(id.clone(), typed);
            } else if let (Some(companion), Some(Value::String(text))) = (companion, answer) {
                out.insert(companion.clone(), Value::String(text.clone()));
            } else if self.allow_other
                && matches!(field, Field::Choice { .. })
                && !self
                    .fields
                    .iter()
                    .any(|(f, _)| *f == format!("{id}__other"))
                && answer
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.trim().is_empty())
            {
                out.insert(id.clone(), answer.cloned().unwrap_or(Value::Null));
            } else if self.required.contains(id) {
                return None;
            }
        }
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn choice_with_other_companion_folds() {
        let form = parse_elicitation_form(
            &json!({"type": "object", "properties": {
                "color": {"type": "string", "title": "Color", "enum": ["red", "blue"]},
                "color__other": {"type": "string"},
                "count": {"type": "integer"}
            }, "required": ["count"]}),
            "Pick",
            false,
        )
        .unwrap();
        assert_eq!(form.questions.len(), 2);
        assert_eq!(form.questions[0].header, "Color");
        assert_eq!(form.questions[0].required, Some(false));
        let content = form
            .content(json!({"color": "green", "count": "3"}).as_object().unwrap())
            .unwrap();
        assert_eq!(content.get("color__other"), Some(&json!("green")));
        assert_eq!(content.get("count"), Some(&json!(3)));
        assert!(
            form.content(json!({"color": "red"}).as_object().unwrap())
                .is_none()
        );
    }

    #[test]
    fn unaskable_form_is_declined() {
        assert!(
            parse_elicitation_form(
                &json!({"properties": {"x": {"type": "object"}}}),
                "m",
                false
            )
            .is_none()
        );
    }

    #[test]
    fn multi_select_respects_counts() {
        let form = parse_elicitation_form(
            &json!({"properties": {"tags": {"type": "array", "minItems": 1, "items": {"anyOf": [{"const": "a", "title": "A"}, {"const": "b", "title": "B"}]}}}, "required": ["tags"]}),
            "m",
            false,
        )
        .unwrap();
        assert_eq!(form.questions[0].multi_select, Some(true));
        assert_eq!(form.questions[0].required, Some(true));
        assert!(
            form.content(json!({"tags": []}).as_object().unwrap())
                .is_none()
        );
        assert_eq!(
            form.content(json!({"tags": ["b", "zz"]}).as_object().unwrap())
                .unwrap()["tags"],
            json!(["b"])
        );
    }
}
