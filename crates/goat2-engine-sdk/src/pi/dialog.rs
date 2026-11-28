//! Structured question recognition for the rpiv ask_user_question extension.
use goat2_contracts::{UserInputOption, UserInputQuestion};
use serde_json::Value;

#[derive(Clone)]
pub(super) struct Route {
    pub lines: Vec<String>,
    pub sentinel: String,
    pub prefix: String,
}

fn decoded(v: &Value) -> Value {
    v.as_str()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_else(|| v.clone())
}
fn field(v: &Value, key: &str) -> Option<String> {
    Some(
        v.get(key)?
            .as_str()?
            .replace("\r\n", "\n")
            .replace('\r', ""),
    )
}
fn line(v: &Value, index: usize) -> String {
    format!(
        "{}. {} — {}",
        index + 1,
        field(v, "label").as_deref().unwrap_or("undefined"),
        field(v, "description").as_deref().unwrap_or("undefined")
    )
}

pub(super) fn recognize(
    id: &str,
    event: &Value,
    args: &Value,
) -> Option<(UserInputQuestion, Route)> {
    if event.get("method")?.as_str()? != "select" {
        return None;
    }
    let lines = event.get("options")?.as_array()?;
    if lines.len() < 2 {
        return None;
    }
    let sentinel = format!("{}. Type something.", lines.len());
    if lines.last()?.as_str()? != sentinel {
        return None;
    }
    let questions = decoded(args.get("questions")?);
    for entry in questions.as_array()? {
        let q = decoded(entry);
        if q.get("multiSelect") == Some(&Value::Bool(true))
            || q.get("allowCustomAnswer") == Some(&Value::Bool(false))
            || q.get("custom") == Some(&Value::Bool(false))
        {
            continue;
        }
        let Some(text) = field(&q, "question").filter(|x| !x.trim().is_empty()) else {
            continue;
        };
        let header = field(&q, "header").unwrap_or_default();
        let prefix = if header.is_empty() {
            String::new()
        } else {
            format!("[{header}] ")
        };
        let Some(raw) = q.get("options") else {
            continue;
        };
        let options = decoded(raw);
        let Some(options) = options.as_array() else {
            continue;
        };
        if options.len() != lines.len() - 1 {
            continue;
        }
        let options: Vec<_> = options.iter().map(decoded).collect();
        let option_lines: Vec<_> = options
            .iter()
            .enumerate()
            .map(|(i, o)| line(o, i))
            .collect();
        if !option_lines
            .iter()
            .zip(lines)
            .all(|(a, b)| b.as_str() == Some(a))
        {
            continue;
        }
        let previews: Vec<_> = options
            .iter()
            .enumerate()
            .filter_map(|(i, o)| {
                let p = field(o, "preview")?;
                if p.is_empty() {
                    return None;
                }
                let preview: String = p.chars().take(600).collect();
                Some(format!(
                    "--- {}. {} preview ---\n{}",
                    i + 1,
                    field(o, "label").as_deref().unwrap_or("undefined"),
                    preview
                ))
            })
            .collect();
        let body = if previews.is_empty() {
            text.clone()
        } else {
            format!("{}\n\n{}", text, previews.join("\n\n"))
        };
        if event.get("title").and_then(Value::as_str) != Some(format!("{prefix}{body}").as_str()) {
            continue;
        }
        let mapped = options
            .iter()
            .enumerate()
            .map(|(i, o)| {
                let label = field(o, "label").unwrap_or_default();
                let label = if label.trim().is_empty() {
                    format!("Option {}", i + 1)
                } else {
                    label.trim().to_owned()
                };
                let description = field(o, "description").unwrap_or_default();
                UserInputOption {
                    description: if description.trim().is_empty() {
                        label.clone()
                    } else {
                        description.trim().to_owned()
                    },
                    label,
                    value: Some(option_lines[i].clone()),
                    preview: None,
                }
            })
            .collect();
        return Some((
            UserInputQuestion {
                id: id.into(),
                header: if header.trim().is_empty() {
                    "Question".into()
                } else {
                    header.trim().into()
                },
                question: body.trim().into(),
                options: mapped,
                multi_select: None,
                allow_custom_answer: None,
                initial_answer: None,
                required: None,
            },
            Route {
                prefix: format!("{prefix}{text}\n\n{}\n\n", option_lines.join("\n")),
                lines: option_lines,
                sentinel,
            },
        ));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn exact_question_and_option_matching() {
        let args = json!({"questions":[{"question":"Pick\r\nnow", "header":"H", "options":[{"label":"A","description":"Alpha","preview":"Example"}]}]});
        let mut event = json!({"id":"q", "method":"select", "title":"[H] Pick\nnow\n\n--- 1. A preview ---\nExample", "options":["1. A — Alpha", "2. Type something."]});
        let (question, route) = recognize("q", &event, &args).unwrap();
        assert_eq!(question.options[0].label, "A");
        assert_eq!(route.prefix, "[H] Pick\nnow\n\n1. A — Alpha\n\n");
        event["title"] = json!("[H] Pick\nnow");
        assert!(recognize("q", &event, &args).is_none());
        event["title"] = json!("[H] Pick\nnow\n\n--- 1. A preview ---\nExample");
        event["options"][0] = json!("1. A");
        assert!(recognize("q", &event, &args).is_none());
        event["options"][0] = json!("1. A — Alpha");
        let mut disabled = args.clone();
        disabled["questions"][0]["multiSelect"] = json!(true);
        assert!(recognize("q", &event, &disabled).is_none());
        disabled["questions"][0]["multiSelect"] = json!(false);
        disabled["questions"][0]["allowCustomAnswer"] = json!(false);
        assert!(recognize("q", &event, &disabled).is_none());
        event["method"] = json!("input");
        assert!(recognize("q", &event, &args).is_none());
    }
}
