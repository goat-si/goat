//! Models and option descriptors from an ACP session's live configuration, lifted from GOAT v1
//! (goat-si/goat 916b5ccc1b2):
//! - `packages/provider-acp/src/server/sessionConfig.ts:6-150` (`acpProviderOptionDescriptors`,
//!   `isAcpThoughtLevelOption`, `flattenSelectChoices`)
//! - `packages/provider-acp-registry/src/server/probe.ts:66-142,209-299` (`advertisedReasoningEffort`,
//!   `normalizeModels`, `normalizeAcpRegistryLiveConfiguration`, `acpRegistryLiveCatalogKey`,
//!   `acpRegistryAdvertisesModelCatalog`)
//! - `packages/provider-acp-registry/src/server/discoveredModels.ts` (`modelsFromDiscovery`)
//! - `packages/provider-acp-registry/src/server/liveModelConfiguration.ts`
//!   (`applyAcpRegistryLiveConfiguration`)
//! - `packages/provider-acp-registry/src/server/learnedModelOptions.ts:205-246`
//!   (`acpRegistryCurrentModelOptions`, `withAcpRegistryLearnedModelOptions`)
//! - `packages/provider-acp-registry/src/server/enrichmentCache.ts:6-37` (probe TTLs)

use std::collections::{BTreeMap, HashSet};

use goat2_contracts::{
    ModelCapabilities, ProviderOptionChoice, ProviderOptionDescriptor, ProviderOptionRole,
    ProviderProbeResult, ServerProviderModel, ServerProviderState,
};
use serde_json::Value;

use crate::probe::support::{
    bounded_opaque_value, bounded_text, built_in_model, create_model_capabilities,
    empty_capabilities, provider_models_from_settings,
};
use crate::registry::settings::CustomModelSetting as CustomModel;
use crate::wire::{config_option_id, find_model_config_option};

/// v1 sessionConfig.ts:6.
pub const ACP_SESSION_MODE_OPTION_ID: &str = "_t3/session-mode";
/// v1 sessionConfig.ts:9: a valid empty ACP choice as a non-empty GOAT id.
pub const ACP_EMPTY_OPTION_VALUE: &str = "_t3/empty";
const MAX_OPTION_DESCRIPTORS: usize = 16;
const MAX_OPTION_CHOICES: usize = 64;
const MAX_TEXT_LENGTH: usize = 256;
const MAX_DESCRIPTION_LENGTH: usize = 1_024;

/// v1 probe.ts:67-68, probeHelpers.ts:9.
pub const MAX_MODELS: usize = 256;
pub const MAX_NAME_LENGTH: usize = 160;
pub const MAX_ID_LENGTH: usize = 128;

fn str_of<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn choice_id(value: &str) -> Option<String> {
    if value.is_empty() {
        Some(ACP_EMPTY_OPTION_VALUE.to_owned())
    } else {
        bounded_opaque_value(value, MAX_TEXT_LENGTH)
    }
}

/// v1 `isAcpThoughtLevelOption` (sessionConfig.ts:25-28): Mistral Vibe 3.1 sends its level under
/// `thinking`.
pub fn is_thought_level_option(option: &Value) -> bool {
    let category = str_of(option, "category");
    category == Some("thought_level")
        || (category == Some("thinking") && str_of(option, "type") == Some("select"))
}

/// One choice of a select config option.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectChoice {
    pub value: String,
    pub name: String,
    pub description: Option<String>,
}

fn choice_of(entry: &Value) -> Option<SelectChoice> {
    Some(SelectChoice {
        value: str_of(entry, "value")?.to_owned(),
        name: str_of(entry, "name").unwrap_or_default().to_owned(),
        description: str_of(entry, "description").map(str::to_owned),
    })
}

/// v1 `flattenSelectChoices` (sessionConfig.ts:30-34): groups contribute their options.
pub fn flatten_select_choices(option: &Value) -> Vec<SelectChoice> {
    let mut out = Vec::new();
    for entry in option
        .get("options")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if entry.get("value").is_some() {
            out.extend(choice_of(entry));
        } else if let Some(group) = entry.get("options").and_then(Value::as_array) {
            out.extend(group.iter().filter_map(choice_of));
        }
    }
    out
}

/// v1 `selectChoices` (sessionConfig.ts:36-58).
fn select_choices(candidates: &[SelectChoice]) -> Vec<ProviderOptionChoice> {
    let mut seen = HashSet::new();
    let mut choices = Vec::new();
    for candidate in candidates {
        let Some(id) = choice_id(&candidate.value) else {
            continue;
        };
        if !seen.insert(id.clone()) {
            continue;
        }
        let description = bounded_text(
            candidate.description.as_deref().unwrap_or_default(),
            MAX_DESCRIPTION_LENGTH,
        );
        let label = bounded_text(&candidate.name, MAX_TEXT_LENGTH);
        choices.push(ProviderOptionChoice {
            label: if label.is_empty() { id.clone() } else { label },
            id,
            description: (!description.is_empty()).then_some(description),
            is_default: None,
        });
        if choices.len() == MAX_OPTION_CHOICES {
            break;
        }
    }
    choices
}

/// v1 `AcpSessionModeState` with the mode descriptions the option descriptors show.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProbeModes {
    pub current_mode_id: String,
    /// (id, name, description)
    pub available: Vec<(String, String, Option<String>)>,
}

/// v1 `parseSessionModeState` on a session setup response (its `modes` field).
pub fn parse_probe_modes(setup: &Value) -> Option<ProbeModes> {
    let modes = setup.get("modes").filter(|v| !v.is_null())?;
    let current = str_of(modes, "currentModeId")?.to_owned();
    let available = modes
        .get("availableModes")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|mode| {
                    let id = str_of(mode, "id")?.to_owned();
                    let name = str_of(mode, "name").unwrap_or(&id).to_owned();
                    Some((id, name, str_of(mode, "description").map(str::to_owned)))
                })
                .collect()
        })
        .unwrap_or_default();
    Some(ProbeModes {
        current_mode_id: current,
        available,
    })
}

/// The id of a descriptor.
pub fn descriptor_id(descriptor: &ProviderOptionDescriptor) -> &str {
    match descriptor {
        ProviderOptionDescriptor::Select { id, .. }
        | ProviderOptionDescriptor::Boolean { id, .. } => id,
    }
}

fn is_reasoning_select(descriptor: &ProviderOptionDescriptor) -> bool {
    matches!(
        descriptor,
        ProviderOptionDescriptor::Select {
            role: Some(ProviderOptionRole::Reasoning),
            ..
        }
    )
}

/// v1 `acpProviderOptionDescriptors` (sessionConfig.ts:60-150).
pub fn acp_provider_option_descriptors(
    config_options: &[Value],
    mode_state: Option<&ProbeModes>,
) -> Vec<ProviderOptionDescriptor> {
    let mut descriptors = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut mirrored_mode_choice_sets: Vec<HashSet<String>> = Vec::new();
    let mut has_mode_category = false;

    for option in config_options {
        let category = str_of(option, "category");
        // Model and collaboration_mode choices use GOAT model and interaction controls.
        if matches!(category, Some("model") | Some("collaboration_mode")) {
            continue;
        }
        let Some(id) =
            config_option_id(option).and_then(|id| bounded_opaque_value(id, MAX_TEXT_LENGTH))
        else {
            continue;
        };
        if !seen.insert(id.clone()) {
            continue;
        }
        let description = bounded_text(
            str_of(option, "description").unwrap_or_default(),
            MAX_DESCRIPTION_LENGTH,
        );
        let description = (!description.is_empty()).then_some(description);
        let label = bounded_text(str_of(option, "name").unwrap_or_default(), MAX_TEXT_LENGTH);
        let label = if label.is_empty() { id.clone() } else { label };
        if str_of(option, "type") == Some("boolean") {
            if category == Some("mode") {
                has_mode_category = true;
            }
            descriptors.push(ProviderOptionDescriptor::Boolean {
                id,
                label,
                description,
                current_value: option.get("currentValue").and_then(Value::as_bool),
            });
            if descriptors.len() == MAX_OPTION_DESCRIPTORS {
                return descriptors;
            }
            continue;
        }
        let choices = select_choices(&flatten_select_choices(option));
        if choices.is_empty() {
            seen.remove(&id);
            continue;
        }
        if category == Some("mode") {
            has_mode_category = true;
        }
        let thought_level = is_thought_level_option(option);
        if thought_level {
            mirrored_mode_choice_sets.push(choices.iter().map(|c| c.id.clone()).collect());
        }
        let current_value = str_of(option, "currentValue")
            .and_then(choice_id)
            .filter(|current| choices.iter().any(|c| &c.id == current));
        descriptors.push(ProviderOptionDescriptor::Select {
            id,
            label,
            description,
            options: choices,
            current_value,
            prompt_injected_values: None,
            role: thought_level.then_some(ProviderOptionRole::Reasoning),
        });
        if descriptors.len() == MAX_OPTION_DESCRIPTORS {
            return descriptors;
        }
    }

    if let Some(modes) = mode_state
        && !has_mode_category
    {
        let choices = select_choices(
            &modes
                .available
                .iter()
                .map(|(id, name, description)| SelectChoice {
                    value: id.clone(),
                    name: name.clone(),
                    description: description.clone(),
                })
                .collect::<Vec<_>>(),
        );
        let current_value = choice_id(&modes.current_mode_id)
            .filter(|current| choices.iter().any(|c| &c.id == current));
        // Some agents duplicate modes in config options; show each control once.
        let duplicates = mirrored_mode_choice_sets.iter().any(|ids| {
            ids.len() == choices.len() && choices.iter().all(|choice| ids.contains(&choice.id))
        });
        if choices.len() > 1 && !duplicates && !seen.contains(ACP_SESSION_MODE_OPTION_ID) {
            descriptors.push(ProviderOptionDescriptor::Select {
                id: ACP_SESSION_MODE_OPTION_ID.to_owned(),
                label: "Mode".to_owned(),
                description: Some("Session mode advertised by the ACP agent.".to_owned()),
                options: choices,
                current_value,
                prompt_injected_values: None,
                role: None,
            });
        }
    }
    descriptors.truncate(MAX_OPTION_DESCRIPTORS);
    descriptors
}

/// v1 `AcpRegistryProbeModel`: one advertised model. `reasoning_effort` is v1's
/// `reasoningEffort`: None when unset, `Some(None)` for an explicit opt-out.
#[derive(Debug, Clone, PartialEq)]
pub struct ProbeModel {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub reasoning_effort: Option<Option<ProviderOptionDescriptor>>,
}

/// v1 `advertisedReasoningEffort` (probe.ts:79-108): the session's reasoning option with the levels
/// a model advertises in `_meta` (Grok's shape).
pub fn advertised_reasoning_effort(
    option: Option<&Value>,
    meta: Option<&Value>,
) -> Option<Option<ProviderOptionDescriptor>> {
    let meta = meta.filter(|m| !m.is_null())?;
    if meta.get("supportsReasoningEffort") == Some(&Value::Bool(false)) {
        return Some(None);
    }
    let option = option.filter(|o| str_of(o, "type") == Some("select"))?;
    let levels = meta.get("reasoningEfforts")?.as_array()?;
    let options: Vec<Value> = levels
        .iter()
        .filter_map(|level| {
            let value = level.get("value")?.as_str()?;
            let name = level.get("label").and_then(Value::as_str).unwrap_or(value);
            Some(serde_json::json!({"value": value, "name": name}))
        })
        .collect();
    let current = meta
        .get("reasoningEffort")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut merged = option.clone();
    if let Some(object) = merged.as_object_mut() {
        object.insert("options".into(), Value::Array(options));
        object.insert("currentValue".into(), Value::String(current.to_owned()));
    }
    acp_provider_option_descriptors(&[merged], None)
        .into_iter()
        .next()
        .map(Some)
}

fn normalized_model(id: String, candidate: &ProbeModel) -> ProbeModel {
    let name = bounded_text(&candidate.name, MAX_NAME_LENGTH);
    ProbeModel {
        name: if name.is_empty() { id.clone() } else { name },
        id,
        description: candidate
            .description
            .as_deref()
            .map(|d| bounded_text(d, MAX_DESCRIPTION_LENGTH))
            .filter(|d| !d.is_empty()),
        reasoning_effort: None,
    }
}

/// v1 `normalizeModels` (probe.ts:121-142).
pub fn normalize_models(
    candidates: &[ProbeModel],
    current_model_id: Option<&str>,
) -> Vec<ProbeModel> {
    let mut seen = HashSet::new();
    let mut models = Vec::new();
    for candidate in candidates {
        if models.len() == MAX_MODELS {
            break;
        }
        let Some(id) = bounded_opaque_value(&candidate.id, MAX_ID_LENGTH) else {
            continue;
        };
        if !seen.insert(id.clone()) {
            continue;
        }
        models.push(normalized_model(id, candidate));
    }
    // Keep the running model visible even when its advertised position exceeds the cap.
    if let Some(current) = current_model_id
        && models.len() == MAX_MODELS
        && !seen.contains(current)
        && let Some(candidate) = candidates.iter().find(|c| c.id == current)
    {
        models[MAX_MODELS - 1] = normalized_model(current.to_owned(), candidate);
    }
    models
}

/// v1 `AcpRegistryLiveConfiguration` (probe.ts:209-219).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LiveConfiguration {
    pub models: Vec<ProbeModel>,
    pub current_model_id: Option<String>,
    pub config_options: Vec<ProviderOptionDescriptor>,
    pub model_option_ids: Vec<String>,
    /// The environment of the session that reported it, when a session did.
    pub environment_key: Option<String>,
    /// A single model from an explicit select is the agent's deliberate catalog.
    pub models_from_model_select: bool,
}

/// v1 `acpRegistryLiveCatalogKey` (probe.ts:221-228).
pub fn live_catalog_key(configuration: &LiveConfiguration) -> String {
    if configuration.models.is_empty() {
        return String::new();
    }
    let models: Vec<String> = configuration
        .models
        .iter()
        .map(|m| format!("{}\0{}", m.id, m.name))
        .collect();
    format!(
        "{}:{}",
        if configuration.models_from_model_select {
            "select"
        } else {
            "list"
        },
        models.join("\u{1f}")
    )
}

fn session_models(model_state: Option<&Value>) -> Vec<&Value> {
    model_state
        .and_then(|state| state.get("availableModels"))
        .and_then(Value::as_array)
        .map(|list| list.iter().collect())
        .unwrap_or_default()
}

/// v1 `normalizeAcpRegistryLiveConfiguration` (probe.ts:230-283). `model_state` is the setup
/// response's `models` object (unstable ACP session models).
pub fn normalize_live_configuration(
    config_options: &[Value],
    mode_state: Option<&ProbeModes>,
    model_state: Option<&Value>,
    include_catalog: bool,
) -> LiveConfiguration {
    let model_state = model_state.filter(|v| !v.is_null());
    let model_option = find_model_config_option(config_options);
    let current = match model_option {
        Some(option) if str_of(option, "type") == Some("select") => {
            str_of(option, "currentValue").map(str::to_owned)
        }
        _ => model_state
            .and_then(|state| str_of(state, "currentModelId"))
            .map(str::to_owned),
    };
    let candidates: Vec<ProbeModel> = match model_option {
        None => session_models(model_state)
            .into_iter()
            .filter_map(|model| {
                Some(ProbeModel {
                    id: str_of(model, "modelId")?.to_owned(),
                    name: str_of(model, "name").unwrap_or_default().to_owned(),
                    description: str_of(model, "description").map(str::to_owned),
                    reasoning_effort: None,
                })
            })
            .collect(),
        Some(option) => flatten_select_choices(option)
            .into_iter()
            .map(|choice| ProbeModel {
                id: choice.value,
                name: choice.name,
                description: choice.description,
                reasoning_effort: None,
            })
            .collect(),
    };
    let bounded_current = current.and_then(|c| bounded_opaque_value(&c, MAX_ID_LENGTH));
    let effort_option = config_options
        .iter()
        .find(|o| str_of(o, "category") == Some("thought_level"))
        .or_else(|| config_options.iter().find(|o| is_thought_level_option(o)));
    let available = session_models(model_state);
    let models: Vec<ProbeModel> = normalize_models(&candidates, bounded_current.as_deref())
        .into_iter()
        .map(|mut model| {
            let meta = available
                .iter()
                .find(|info| str_of(info, "modelId") == Some(model.id.as_str()))
                .and_then(|info| info.get("_meta"));
            model.reasoning_effort = advertised_reasoning_effort(effort_option, meta);
            model
        })
        .collect();
    let descriptors = acp_provider_option_descriptors(config_options, mode_state);
    let model_option_ids: HashSet<&str> = config_options
        .iter()
        .filter(|o| is_thought_level_option(o) || str_of(o, "category") == Some("model_config"))
        .filter_map(config_option_id)
        .collect();
    let current_model_id = bounded_current.filter(|c| models.iter().any(|m| &m.id == c));
    LiveConfiguration {
        models: if include_catalog { models } else { Vec::new() },
        current_model_id,
        model_option_ids: descriptors
            .iter()
            .map(descriptor_id)
            .filter(|id| model_option_ids.contains(id))
            .map(str::to_owned)
            .collect(),
        config_options: descriptors,
        environment_key: None,
        models_from_model_select: include_catalog && model_option.is_some(),
    }
}

/// v1 `acpRegistryAdvertisesModelCatalog` (probe.ts:290-299).
pub fn advertises_model_catalog(config_options: &[Value], model_state: Option<&Value>) -> bool {
    find_model_config_option(config_options)
        .is_some_and(|option| flatten_select_choices(option).len() > 1)
        || session_models(model_state.filter(|v| !v.is_null())).len() > 1
}

/// v1 `modelsFromDiscovery` (discoveredModels.ts:9-75).
pub fn models_from_discovery(
    discovery: Option<&LiveConfiguration>,
    custom_models: &[CustomModel],
    previous_models: &[ServerProviderModel],
) -> Vec<ServerProviderModel> {
    let capabilities = match discovery {
        Some(d) if !d.config_options.is_empty() => {
            create_model_capabilities(d.config_options.clone())
        }
        _ => empty_capabilities(),
    };
    let model_option_ids: HashSet<&str> = discovery
        .map(|d| d.model_option_ids.iter().map(String::as_str).collect())
        .unwrap_or_default();
    let shared: Vec<ProviderOptionDescriptor> = discovery
        .map(|d| {
            d.config_options
                .iter()
                .filter(|desc| !model_option_ids.contains(descriptor_id(desc)))
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    let shared_ids: HashSet<&str> = shared.iter().map(descriptor_id).collect();
    let current = discovery.and_then(|d| d.current_model_id.as_deref());
    let capabilities_for = |model: &ProbeModel| -> ModelCapabilities {
        let is_current = Some(model.id.as_str()) == current;
        if is_current && model.reasoning_effort.is_none() {
            return capabilities.clone();
        }
        let inherited: Vec<ProviderOptionDescriptor> = if is_current {
            capabilities.option_descriptors.clone().unwrap_or_default()
        } else {
            let previous = previous_models
                .iter()
                .find(|m| m.slug == model.id)
                .and_then(|m| m.capabilities.as_ref())
                .and_then(|c| c.option_descriptors.clone())
                .unwrap_or_default();
            shared
                .iter()
                .cloned()
                .chain(
                    previous
                        .into_iter()
                        .filter(|d| !shared_ids.contains(descriptor_id(d))),
                )
                .collect()
        };
        let descriptors: Vec<ProviderOptionDescriptor> = match &model.reasoning_effort {
            None => inherited,
            Some(effort) => {
                let effort_id = effort.as_ref().map(descriptor_id);
                inherited
                    .into_iter()
                    .filter(|d| Some(descriptor_id(d)) != effort_id && !is_reasoning_select(d))
                    .chain(effort.clone())
                    .collect()
            }
        };
        if descriptors.is_empty() {
            empty_capabilities()
        } else {
            create_model_capabilities(descriptors)
        }
    };
    let discovered = discovery.map(|d| d.models.as_slice()).unwrap_or_default();
    let built_in: Vec<ServerProviderModel> = if discovered.is_empty() {
        let mut model = built_in_model("default", "Default");
        model.is_default = Some(true);
        model.capabilities = Some(capabilities.clone());
        vec![model]
    } else {
        discovered
            .iter()
            .map(|probe_model| {
                let mut model = built_in_model(probe_model.id.clone(), probe_model.name.clone());
                if Some(probe_model.id.as_str()) == current {
                    model.is_default = Some(true);
                }
                model.capabilities = Some(capabilities_for(probe_model));
                model
            })
            .collect()
    };
    provider_models_from_settings(built_in, custom_models, Some(capabilities))
}

/// v1 `applyAcpRegistryLiveConfiguration` (liveModelConfiguration.ts:6-52): what a live session
/// reported replaces the probed models; a lone non-select model does not replace a probed list.
pub fn apply_live_configuration(
    provider: &ProviderProbeResult,
    configuration: &LiveConfiguration,
    custom_models: &[CustomModel],
    previous_models: Option<&[ServerProviderModel]>,
) -> ProviderProbeResult {
    let previous_models = previous_models.unwrap_or(&provider.models);
    let probed: Vec<&ServerProviderModel> =
        provider.models.iter().filter(|m| !m.is_custom).collect();
    let provisional = configuration.models.len() == 1
        && !configuration.models_from_model_select
        && probed.len() > 1;
    let use_live =
        configuration.models.len() > 1 || (configuration.models.len() == 1 && !provisional);
    let selected = match &configuration.current_model_id {
        Some(current) if probed.iter().any(|m| &m.slug == current) => Some(current.clone()),
        _ => probed
            .iter()
            .find(|m| m.is_default == Some(true))
            .map(|m| m.slug.clone()),
    };
    let discovery = if use_live {
        configuration.clone()
    } else {
        LiveConfiguration {
            models: probed
                .iter()
                .map(|m| ProbeModel {
                    id: m.slug.clone(),
                    name: m.name.clone(),
                    description: None,
                    reasoning_effort: None,
                })
                .collect(),
            current_model_id: selected.clone(),
            ..configuration.clone()
        }
    };
    let mut next = provider.clone();
    next.message = None;
    if provider.status != ServerProviderState::Disabled {
        next.status = ServerProviderState::Ready;
    }
    next.models = if !use_live && configuration.config_options.is_empty() {
        with_default_model(&provider.models, selected.as_deref())
    } else {
        let previous: Vec<ServerProviderModel> = previous_models
            .iter()
            .filter(|m| !m.is_custom)
            .cloned()
            .collect();
        models_from_discovery(Some(&discovery), custom_models, &previous)
    };
    next
}

/// v1 `withAcpRegistryDefaultModel` (liveModelConfiguration.ts:54-69).
fn with_default_model(
    models: &[ServerProviderModel],
    current: Option<&str>,
) -> Vec<ServerProviderModel> {
    let Some(current) = current else {
        return models.to_vec();
    };
    models
        .iter()
        .map(|model| {
            if model.is_custom {
                return model.clone();
            }
            let is_default = model.slug == current;
            if model.is_default.unwrap_or(false) == is_default {
                return model.clone();
            }
            let mut next = model.clone();
            next.is_default = is_default.then_some(true);
            next
        })
        .collect()
}

/// v1 `acpRegistryCurrentModelOptions` (learnedModelOptions.ts:205-223): the model-specific
/// options a session reported for its current model.
pub fn current_model_options(
    configuration: &LiveConfiguration,
) -> Option<(String, Vec<ProviderOptionDescriptor>)> {
    let current = configuration.current_model_id.clone()?;
    // An empty report without a model select is a placeholder, not a statement about the model.
    if configuration.config_options.is_empty() && !configuration.models_from_model_select {
        return None;
    }
    let ids: HashSet<&str> = configuration
        .model_option_ids
        .iter()
        .map(String::as_str)
        .collect();
    Some((
        current,
        configuration
            .config_options
            .iter()
            .filter(|d| ids.contains(descriptor_id(d)))
            .cloned()
            .collect(),
    ))
}

/// v1 `withAcpRegistryLearnedModelOptions` (learnedModelOptions.ts:225-246): adds learned options
/// to models that are not the session's own and lack them.
pub fn with_learned_model_options(
    models: &[ServerProviderModel],
    learned: &BTreeMap<String, Vec<ProviderOptionDescriptor>>,
) -> Vec<ServerProviderModel> {
    models
        .iter()
        .map(|model| {
            let Some(options) = learned.get(&model.slug) else {
                return model.clone();
            };
            if model.is_custom || model.is_default == Some(true) {
                return model.clone();
            }
            let current = model
                .capabilities
                .as_ref()
                .and_then(|c| c.option_descriptors.clone())
                .unwrap_or_default();
            // Levels the model advertises itself (`_meta`) keep their place.
            let missing: Vec<ProviderOptionDescriptor> = options
                .iter()
                .filter(|o| !current.iter().any(|c| descriptor_id(c) == descriptor_id(o)))
                .cloned()
                .collect();
            if missing.is_empty() {
                return model.clone();
            }
            let mut next = model.clone();
            next.capabilities = Some(create_model_capabilities(
                current.into_iter().chain(missing).collect(),
            ));
            next
        })
        .collect()
}

/// v1 enrichmentCache.ts:7: successful authenticated probes are cached this long.
pub const PROBE_SUCCESS_TTL_MS: u64 = 15 * 60 * 1_000;
/// v1 enrichmentCache.ts:8.
pub const PROBE_PROVISIONAL_TTL_MS: u64 = 30 * 1_000;

/// v1 `acpRegistryProbeTtlMs` (enrichmentCache.ts:10-13): one discovered model or fewer is
/// provisional.
pub fn probe_ttl_ms(provider: &ProviderProbeResult) -> u64 {
    if provider.models.iter().filter(|m| !m.is_custom).count() <= 1 {
        PROBE_PROVISIONAL_TTL_MS
    } else {
        PROBE_SUCCESS_TTL_MS
    }
}

/// v1 `isAcpRegistryCacheValid` (enrichmentCache.ts:25-37).
pub fn is_cache_valid(
    cached: &ProviderProbeResult,
    expires_at: u64,
    cached_launch_identity: Option<&str>,
    inspected_version: Option<&str>,
    local: bool,
    now: u64,
    inspected_launch_identity: Option<&str>,
) -> bool {
    expires_at > now
        && ((local && inspected_version.is_none())
            || cached.version.as_deref() == inspected_version)
        && (inspected_launch_identity.is_none()
            || cached_launch_identity == inspected_launch_identity)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn select(id: &str, category: &str, values: &[&str], current: &str) -> Value {
        json!({
            "id": id, "name": id, "category": category, "type": "select", "currentValue": current,
            "options": values.iter().map(|v| json!({"value": v, "name": v.to_uppercase()})).collect::<Vec<_>>()
        })
    }

    #[test]
    fn descriptors_skip_model_options_and_mirror_modes_once() {
        let options = vec![
            select("model", "model", &["a", "b"], "a"),
            select("effort", "thought_level", &["low", "high"], "high"),
            json!({"id": "fast", "name": "Fast", "type": "boolean", "currentValue": true}),
            select("empty", "other", &[], ""),
        ];
        let modes = ProbeModes {
            current_mode_id: "ask".into(),
            available: vec![
                ("ask".into(), "Ask".into(), Some("Ask first".into())),
                ("code".into(), "Code".into(), None),
            ],
        };
        let descriptors = acp_provider_option_descriptors(&options, Some(&modes));
        let ids: Vec<&str> = descriptors.iter().map(descriptor_id).collect();
        assert_eq!(ids, ["effort", "fast", ACP_SESSION_MODE_OPTION_ID]);
        assert!(is_reasoning_select(&descriptors[0]));
        match &descriptors[2] {
            ProviderOptionDescriptor::Select {
                options,
                current_value,
                ..
            } => {
                assert_eq!(current_value.as_deref(), Some("ask"));
                assert_eq!(options[0].description.as_deref(), Some("Ask first"));
            }
            other => panic!("{other:?}"),
        }
        // A thought-level option with the same choices as the modes stands for them.
        let mirrored = vec![select("level", "thought_level", &["ask", "code"], "ask")];
        assert_eq!(
            acp_provider_option_descriptors(&mirrored, Some(&modes)).len(),
            1
        );
        // The empty ACP choice gets GOAT's placeholder id.
        let empty = vec![select("x", "other", &["", "y"], "")];
        match &acp_provider_option_descriptors(&empty, None)[0] {
            ProviderOptionDescriptor::Select { current_value, .. } => {
                assert_eq!(current_value.as_deref(), Some(ACP_EMPTY_OPTION_VALUE))
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn live_configuration_reads_select_and_session_models() {
        let options = vec![
            select("model", "model", &["a", "b"], "b"),
            select("effort", "thought_level", &["low", "high"], "low"),
        ];
        let live = normalize_live_configuration(&options, None, None, true);
        assert_eq!(live.models.len(), 2);
        assert_eq!(live.current_model_id.as_deref(), Some("b"));
        assert!(live.models_from_model_select);
        assert_eq!(live.model_option_ids, ["effort"]);
        assert_eq!(live_catalog_key(&live), "select:a\0A\u{1f}b\0B");

        let state = json!({"currentModelId": "m2", "availableModels": [
            {"modelId": "m1", "name": "One", "_meta": {"supportsReasoningEffort": false}},
            {"modelId": "m2", "name": "", "description": " Two ", "_meta": {"reasoningEfforts": [{"value": "low", "label": "Low"}, {"value": "max"}], "reasoningEffort": "max"}},
            {"modelId": "m2", "name": "dup"}
        ]});
        let live = normalize_live_configuration(&options[1..], None, Some(&state), true);
        assert!(!live.models_from_model_select);
        assert_eq!(live.models.len(), 2);
        assert_eq!(live.models[1].name, "m2");
        assert_eq!(live.models[1].description.as_deref(), Some("Two"));
        assert_eq!(live.models[0].reasoning_effort, Some(None));
        match live.models[1].reasoning_effort.clone().flatten().unwrap() {
            ProviderOptionDescriptor::Select {
                options,
                current_value,
                ..
            } => {
                assert_eq!(options.len(), 2);
                assert_eq!(current_value.as_deref(), Some("max"));
            }
            other => panic!("{other:?}"),
        }
        assert!(advertises_model_catalog(&[], Some(&state)));
        assert!(!advertises_model_catalog(
            &[select("model", "model", &["a"], "a")],
            None
        ));
        let without = normalize_live_configuration(&options, None, None, false);
        assert!(without.models.is_empty() && !without.models_from_model_select);
    }

    #[test]
    fn discovery_models_carry_shared_and_model_options() {
        let options = vec![
            select("model", "model", &["a", "b"], "a"),
            select("effort", "thought_level", &["low", "high"], "low"),
            select("style", "other", &["x", "y"], "x"),
        ];
        let live = normalize_live_configuration(&options, None, None, true);
        let models = models_from_discovery(Some(&live), &[CustomModel::Slug("c".into())], &[]);
        assert_eq!(models.len(), 3);
        assert_eq!(models[0].is_default, Some(true));
        let ids = |m: &ServerProviderModel| -> Vec<String> {
            m.capabilities
                .as_ref()
                .unwrap()
                .option_descriptors
                .as_ref()
                .unwrap()
                .iter()
                .map(|d| descriptor_id(d).to_owned())
                .collect()
        };
        // The current model has every option; others only the shared ones.
        assert_eq!(ids(&models[0]), ["effort", "style"]);
        assert_eq!(ids(&models[1]), ["style"]);
        assert!(models[2].is_custom);
        assert_eq!(ids(&models[2]), ["effort", "style"]);
        // Without a catalog: GOAT's Default model.
        let fallback = models_from_discovery(None, &[], &[]);
        assert_eq!(fallback[0].slug, "default");
        assert_eq!(fallback[0].capabilities, Some(empty_capabilities()));
    }

    #[test]
    fn live_configuration_application_keeps_probed_list_for_lone_fallback() {
        let mut a = built_in_model("a", "A");
        a.is_default = Some(true);
        let provider = ProviderProbeResult {
            installed: true,
            version: None,
            installed_version: None,
            cli: None,
            binary_path: None,
            status: ServerProviderState::Warning,
            auth: crate::probe::support::auth_status(
                goat2_contracts::ServerProviderAuthStatus::Unknown,
            ),
            models: vec![a, built_in_model("b", "B")],
            checked_at: "t".into(),
            message: Some("old".into()),
        };
        let lone = LiveConfiguration {
            models: vec![ProbeModel {
                id: "b".into(),
                name: "B".into(),
                description: None,
                reasoning_effort: None,
            }],
            current_model_id: Some("b".into()),
            ..Default::default()
        };
        let next = apply_live_configuration(&provider, &lone, &[], None);
        assert_eq!(next.status, ServerProviderState::Ready);
        assert_eq!(next.message, None);
        assert_eq!(next.models.len(), 2);
        assert_eq!(next.models[1].is_default, Some(true));
        assert_eq!(next.models[0].is_default, None);
        assert_eq!(probe_ttl_ms(&next), PROBE_SUCCESS_TTL_MS);

        let learned = BTreeMap::from([(
            "a".to_owned(),
            vec![ProviderOptionDescriptor::Boolean {
                id: "fast".into(),
                label: "Fast".into(),
                description: None,
                current_value: None,
            }],
        )]);
        let with = with_learned_model_options(&next.models, &learned);
        assert_eq!(
            with[0]
                .capabilities
                .as_ref()
                .unwrap()
                .option_descriptors
                .as_ref()
                .unwrap()
                .len(),
            1
        );
    }
}
