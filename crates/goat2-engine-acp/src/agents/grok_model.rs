//! Grok model and reasoning effort writes.
//!
//! Ported from v1 (goat-si/goat 916b5ccc1b2):
//! - `packages/provider-grok/src/server/adapter.ts:250-345` (`GROK_REASONING_EFFORT_OPTION_ID`,
//!   `applyGrokSessionModelSelection`: protocol 1 sends the effort as `session/set_model` metadata and
//!   skips an effort the model does not offer or Grok refuses; newer protocols write the
//!   `thought_level` option after the model switch),
//! - `packages/provider-grok/src/server/acpSupport.ts:247-325` (`GROK_DEFAULT_MODEL_SLUG`,
//!   `resolveGrokAcpBaseModelId`, `isValidGrokReasoningEffortToken`, `applyGrokAcpModelSelection`),
//! - `packages/provider-grok/src/server/status.ts:134-206` (`grokReasoningOptionsFromModel`, the
//!   efforts a model offers).
//!
//! v1 logs a warning when it skips an effort; GOAT 2 has no log sink here, so the skip is silent.

use goat2_contracts::{ModelSelection, ProviderOptionSelectionValue};
use serde_json::{Map, Value, json};

use crate::flavor::{ModelWrite, default_model_write};
use crate::wire::{InitializeInfo, SessionSetup, find_model_config_option};

/// v1 `GROK_DEFAULT_MODEL_SLUG`: a product name that selects the session's current model.
pub const GROK_DEFAULT_MODEL_SLUG: &str = "grok-build";
/// v1 `GROK_REASONING_EFFORT_OPTION_ID`.
pub const GROK_REASONING_EFFORT_OPTION_ID: &str = "reasoningEffort";
/// v1 `GROK_EFFORT_RANK` (status.ts:134).
const GROK_EFFORT_RANK: [&str; 7] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/// v1 `resolveGrokAcpBaseModelId` (Grok has no model slug aliases).
pub fn resolve_base_model_id(model: &str) -> String {
    let trimmed = model.trim();
    if trimmed.is_empty() {
        GROK_DEFAULT_MODEL_SLUG.to_owned()
    } else {
        trimmed.to_owned()
    }
}

/// v1 `isValidGrokReasoningEffortToken`: `/^[a-z0-9][a-z0-9._-]{0,31}$/i`.
pub fn is_valid_effort_token(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 32
        && bytes[0].is_ascii_alphanumeric()
        && bytes[1..]
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// v1 `normalizeGrokReasoningEffort`.
fn normalize_effort(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|v| !v.is_empty() && is_valid_effort_token(v))
        .map(str::to_owned)
}

/// The requested effort (v1 `getModelSelectionStringOptionValue(selection, "reasoningEffort")`).
pub fn requested_effort(selection: &ModelSelection) -> Option<String> {
    selection
        .options
        .as_ref()?
        .iter()
        .find(|option| option.id == GROK_REASONING_EFFORT_OPTION_ID)
        .and_then(|option| match &option.value {
            ProviderOptionSelectionValue::Text(value) => Some(value.clone()),
            _ => None,
        })
}

fn non_empty(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// v1 `grokReasoningOptionsFromModel` option values, in v1 order (by effort rank when every
/// value is a known rank). `meta` is the model's `_meta`.
pub fn offered_efforts(meta: Option<&Value>) -> Vec<String> {
    let Some(meta) = meta.filter(|m| m.is_object()) else {
        return Vec::new();
    };
    if meta.get("supportsReasoningEffort") == Some(&Value::Bool(false)) {
        return Vec::new();
    }
    let mut values: Vec<String> = Vec::new();
    for entry in meta
        .get("reasoningEfforts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|e| e.is_object())
    {
        let raw_value = non_empty(entry.get("value")).filter(|v| is_valid_effort_token(v));
        let raw_id = non_empty(entry.get("id")).filter(|v| is_valid_effort_token(v));
        let Some(value) = raw_value.or(raw_id) else {
            continue;
        };
        if !values.contains(&value) {
            values.push(value);
        }
    }
    let rank = |v: &String| GROK_EFFORT_RANK.iter().position(|r| r == v);
    if values.iter().all(|v| rank(v).is_some()) {
        values.sort_by_key(|v| rank(v));
    }
    values
}

/// v1 `applyGrokAcpModelSelection` (acpSupport.ts:299-325) as a write. v1's adapter passes no current
/// effort, so any valid requested effort is sent.
fn set_session_model(
    current_model_id: Option<&str>,
    requested_model_id: &str,
    requested_effort: Option<&str>,
) -> ModelWrite {
    let requested = (requested_model_id != GROK_DEFAULT_MODEL_SLUG).then_some(requested_model_id);
    let model_changed = requested.is_some_and(|r| Some(r) != current_model_id);
    let effort = normalize_effort(requested_effort);
    let effort_changed = requested_effort.is_some() && effort.is_some();
    let Some(target) = requested.or(current_model_id) else {
        return ModelWrite::Keep;
    };
    if !model_changed && !effort_changed {
        return ModelWrite::Keep;
    }
    let meta = effort.map(|effort| {
        let mut meta = Map::new();
        meta.insert("reasoningEffort".into(), json!(effort));
        meta
    });
    ModelWrite::SetModel {
        model_id: target.to_owned(),
        meta,
    }
}

/// v1 `applyGrokSessionModelSelection` (adapter.ts:267-345).
pub fn grok_model_write(
    selection: &ModelSelection,
    setup: &SessionSetup,
    init: &InitializeInfo,
) -> ModelWrite {
    let requested_model = resolve_base_model_id(&selection.model);
    let requested_effort = requested_effort(selection);
    if init.protocol_version == 1 {
        let current = setup
            .models
            .as_ref()
            .map(|m| m.current_model_id.trim().to_owned())
            .filter(|id| !id.is_empty());
        let target = if requested_model == GROK_DEFAULT_MODEL_SLUG {
            current.clone()
        } else {
            Some(requested_model.clone())
        };
        let offered = setup
            .models
            .as_ref()
            .and_then(|models| {
                models
                    .available
                    .iter()
                    .find(|(id, _, _)| Some(id.trim()) == target.as_deref())
            })
            .map(|(_, _, meta)| offered_efforts(meta.as_ref()))
            .unwrap_or_default();
        let effort = requested_effort
            .clone()
            .filter(|e| offered.is_empty() || offered.contains(e));
        let without_effort = set_session_model(current.as_deref(), &requested_model, None);
        return match effort {
            None => without_effort,
            Some(effort) => ModelWrite::OrElse(
                Box::new(set_session_model(
                    current.as_deref(),
                    &requested_model,
                    Some(&effort),
                )),
                Box::new(without_effort),
            ),
        };
    }
    // Protocol 2+: the runtime's own model write, then the effort option of the new model.
    let current = find_model_config_option(&setup.config_options)
        .and_then(|option| option.get("currentValue"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let requested = (requested_model != GROK_DEFAULT_MODEL_SLUG).then_some(requested_model);
    let model_write = match requested {
        Some(model) if Some(model.as_str()) != current.as_deref() => default_model_write(
            &ModelSelection {
                model,
                ..selection.clone()
            },
            setup,
        ),
        _ => ModelWrite::Keep,
    };
    match requested_effort {
        None => model_write,
        Some(value) => ModelWrite::Sequence(vec![
            model_write,
            ModelWrite::OptionalConfigByCategory {
                category: "thought_level".into(),
                value,
            },
        ]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::ModelState;
    use goat2_contracts::ProviderOptionSelection;

    fn selection(model: &str, effort: Option<&str>) -> ModelSelection {
        ModelSelection {
            instance_id: "grok".into(),
            model: model.into(),
            options: effort.map(|e| {
                vec![ProviderOptionSelection {
                    id: "reasoningEffort".into(),
                    value: ProviderOptionSelectionValue::Text(e.into()),
                }]
            }),
        }
    }

    fn setup() -> SessionSetup {
        SessionSetup {
            session_id: "s".into(),
            models: Some(ModelState {
                current_model_id: "grok-4".into(),
                available: vec![
                    (
                        "grok-4".into(),
                        "Grok 4".into(),
                        Some(json!({"reasoningEffort": "low",
                        "reasoningEfforts": [{"value": "high"}, {"value": "low"}]})),
                    ),
                    (
                        "grok-fast".into(),
                        "Fast".into(),
                        Some(json!({"supportsReasoningEffort": false})),
                    ),
                ],
            }),
            ..Default::default()
        }
    }

    fn v1() -> InitializeInfo {
        InitializeInfo {
            protocol_version: 1,
            ..Default::default()
        }
    }

    #[test]
    fn protocol_one_sends_offered_effort_with_a_fallback() {
        let write = grok_model_write(&selection("grok-build", Some("high")), &setup(), &v1());
        let with = ModelWrite::SetModel {
            model_id: "grok-4".into(),
            meta: Some(
                json!({"reasoningEffort": "high"})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        };
        assert_eq!(
            write,
            ModelWrite::OrElse(Box::new(with), Box::new(ModelWrite::Keep))
        );
        // An effort the model does not offer is skipped before the write.
        assert_eq!(
            grok_model_write(&selection("grok-build", Some("max")), &setup(), &v1()),
            ModelWrite::Keep
        );
        // A model that offers no efforts takes whatever is requested.
        assert!(matches!(
            grok_model_write(&selection("grok-fast", Some("max")), &setup(), &v1()),
            ModelWrite::OrElse(_, fallback) if *fallback == ModelWrite::SetModel { model_id: "grok-fast".into(), meta: None }
        ));
        assert_eq!(
            grok_model_write(&selection("grok-4", None), &setup(), &v1()),
            ModelWrite::Keep
        );
    }

    #[test]
    fn newer_protocols_write_the_thought_level_option() {
        let init = InitializeInfo {
            protocol_version: 2,
            ..Default::default()
        };
        let setup = SessionSetup {
            config_options: vec![
                json!({"id": "model", "category": "model", "type": "select", "currentValue": "a",
                "options": [{"value": "a"}, {"value": "b"}]}),
            ],
            ..Default::default()
        };
        assert_eq!(
            grok_model_write(&selection("b", Some("high")), &setup, &init),
            ModelWrite::Sequence(vec![
                ModelWrite::ConfigOption {
                    config_id: "model".into(),
                    value: "b".into()
                },
                ModelWrite::OptionalConfigByCategory {
                    category: "thought_level".into(),
                    value: "high".into()
                },
            ])
        );
    }

    #[test]
    fn effort_options_follow_rank() {
        assert_eq!(
            offered_efforts(Some(
                &json!({"reasoningEfforts": [{"value": "high"}, {"id": "low"}, {"value": "bad value"}]})
            )),
            vec!["low".to_string(), "high".to_string()]
        );
        assert!(is_valid_effort_token("x.high-1") && !is_valid_effort_token("-x"));
    }
}
