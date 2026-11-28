//! v1 provider-pi/src/server/status.ts:118-158,193-215,295-315,472-510.
use super::session::{PiProfile, base_launch, spawn};
use goat2_contracts::{
    ModelCapabilities, ProviderOptionChoice, ProviderOptionDescriptor, ProviderProbeResult,
    ServerProviderAuth, ServerProviderAuthStatus, ServerProviderCli, ServerProviderModel,
    ServerProviderState,
};
use goat2_engine_api::EngineError;
use serde_json::{Value, json};
use std::{collections::HashSet, path::Path, time::Duration};

pub(super) async fn probe(
    binary: &Path,
    profile: PiProfile,
) -> Result<ProviderProbeResult, EngineError> {
    let checked_at = super::events::now();
    let mut command = tokio::process::Command::new(binary);
    command.arg("--version").kill_on_drop(true);
    for (key, _) in std::env::vars_os() {
        let key_text = key.to_string_lossy();
        if key_text.starts_with("GOAT_")
            || key_text.starts_with("T3CODE_")
            || key_text.starts_with("CODEX_")
        {
            command.env_remove(key);
        }
    }
    let output = tokio::time::timeout(Duration::from_secs(10), command.output())
        .await
        .map_err(|_| EngineError::Transport("Pi version probe timed out".into()))?;
    let auth_unknown = || ServerProviderAuth {
        status: ServerProviderAuthStatus::Unknown,
        auth_type: None,
        label: None,
        email: None,
        can_logout: None,
        subscription_sharing: None,
        profile_id: None,
        workspace_id: None,
        endpoint: None,
        action: None,
    };
    let output = match output {
        Ok(output) => output,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ProviderProbeResult {
                installed: false,
                version: None,
                installed_version: None,
                cli: Some(ServerProviderCli::Missing),
                binary_path: Some(binary.display().to_string()),
                status: ServerProviderState::Error,
                auth: auth_unknown(),
                models: vec![default_model(profile)],
                checked_at,
                message: Some(format!("{} executable not found", profile.binary())),
            });
        }
        Err(e) => return Err(EngineError::Unavailable(e.to_string())),
    };
    if !output.status.success() {
        return Err(EngineError::Unavailable(format!(
            "{} version command failed ({})",
            profile.binary(),
            output.status
        )));
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let mut launch = base_launch(binary.to_path_buf(), profile);
    launch.args.extend([
        "--mode".into(),
        "rpc".into(),
        "--no-session".into(),
        "--offline".into(),
    ]);
    let (mut child, client, _inbound) = spawn(&launch)?;
    let inventory = async {
        let state = client.call(json!({"type":"get_state"})).await?;
        let inventory = client.call(json!({"type":"get_available_models"})).await?;
        Ok::<_, crate::jsonl::CallError>((state, inventory))
    }
    .await;
    child.shutdown().await;
    let (state, inventory) = inventory.map_err(|e| EngineError::Transport(e.to_string()))?;
    let parsed = parse_models(&inventory, &state)?;
    let authenticated = !parsed.is_empty();
    let mut auth = auth_unknown();
    auth.status = if authenticated {
        ServerProviderAuthStatus::Authenticated
    } else {
        ServerProviderAuthStatus::Unauthenticated
    };
    let mut models = vec![default_model(profile)];
    models.extend(parsed);
    Ok(ProviderProbeResult {
        installed: true,
        version: Some(version),
        installed_version: None,
        cli: Some(ServerProviderCli::Present),
        binary_path: Some(binary.display().to_string()),
        status: if authenticated {
            ServerProviderState::Ready
        } else {
            ServerProviderState::Warning
        },
        auth,
        models,
        checked_at,
        message: None,
    })
}

fn default_model(profile: PiProfile) -> ServerProviderModel {
    ServerProviderModel {
        slug: "default".into(),
        name: match profile {
            PiProfile::Pi => "Pi default",
            PiProfile::Omo => "OmO default",
        }
        .into(),
        short_name: None,
        sub_provider: None,
        aliases: None,
        badge: None,
        is_custom: false,
        is_default: None,
        is_legacy: None,
        supports_text_generation: None,
        capabilities: Some(model_capabilities(&Value::Null, None)),
    }
}

fn parse_models(inventory: &Value, state: &Value) -> Result<Vec<ServerProviderModel>, EngineError> {
    let models = inventory
        .get("models")
        .and_then(Value::as_array)
        .ok_or_else(|| EngineError::Transport("invalid Pi model inventory".into()))?;
    let mut seen = HashSet::new();
    let mut parsed = Vec::new();
    for model in models {
        let provider = model
            .get("provider")
            .and_then(Value::as_str)
            .filter(|v| !v.trim().is_empty())
            .ok_or_else(|| EngineError::Transport("invalid Pi model provider".into()))?;
        let id = model
            .get("id")
            .and_then(Value::as_str)
            .filter(|v| !v.trim().is_empty())
            .ok_or_else(|| EngineError::Transport("invalid Pi model id".into()))?;
        let slug = format!("{provider}/{id}");
        if seen.insert(slug.clone()) {
            parsed.push(ServerProviderModel {
                name: model
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(&slug)
                    .into(),
                slug,
                short_name: None,
                sub_provider: Some(provider.into()),
                aliases: None,
                badge: None,
                is_custom: false,
                is_default: None,
                is_legacy: None,
                supports_text_generation: None,
                capabilities: Some(model_capabilities(
                    model,
                    if state
                        .get("model")
                        .and_then(|m| m.get("provider"))
                        .and_then(Value::as_str)
                        == Some(provider)
                        && state
                            .get("model")
                            .and_then(|m| m.get("id"))
                            .and_then(Value::as_str)
                            == Some(id)
                    {
                        state.get("thinkingLevel").and_then(Value::as_str)
                    } else {
                        None
                    },
                )),
            });
        }
    }
    Ok(parsed)
}

const THINKING_LEVELS: [(&str, &str); 7] = [
    ("off", "Off"),
    ("minimal", "Minimal"),
    ("low", "Low"),
    ("medium", "Medium"),
    ("high", "High"),
    ("xhigh", "Extra High"),
    ("max", "Max"),
];

fn select(
    id: &str,
    label: &str,
    options: Vec<ProviderOptionChoice>,
    current: Option<&str>,
) -> ProviderOptionDescriptor {
    ProviderOptionDescriptor::Select {
        id: id.into(),
        label: label.into(),
        description: None,
        options,
        current_value: current.map(str::to_owned),
        prompt_injected_values: None,
        role: None,
    }
}

fn choice(id: &str, label: &str, description: Option<&str>, default: bool) -> ProviderOptionChoice {
    ProviderOptionChoice {
        id: id.into(),
        label: label.into(),
        description: description.map(str::to_owned),
        is_default: default.then_some(true),
    }
}

fn model_capabilities(model: &Value, default_level: Option<&str>) -> ModelCapabilities {
    let advertised = model
        .get("supportedThinkingLevels")
        .and_then(Value::as_array);
    let map = model.get("thinkingLevelMap").and_then(Value::as_object);
    let levels: Vec<_> = THINKING_LEVELS
        .iter()
        .enumerate()
        .filter(|(_, (id, _))| {
            if let Some(advertised) = advertised {
                return advertised.iter().any(|value| value.as_str() == Some(id));
            }
            if model.get("reasoning").and_then(Value::as_bool) != Some(true) {
                return false;
            }
            let mapped = map.and_then(|map| map.get(*id));
            if mapped.is_some_and(Value::is_null) {
                return false;
            }
            !matches!(*id, "xhigh" | "max") || mapped.is_some()
        })
        .collect();
    let default_index = default_level
        .and_then(|level| THINKING_LEVELS.iter().position(|(id, _)| *id == level))
        .and_then(|requested| {
            levels
                .iter()
                .find(|(index, _)| *index >= requested)
                .or_else(|| levels.iter().rev().find(|(index, _)| *index < requested))
        })
        .map(|(index, _)| *index);
    let mut descriptors = Vec::new();
    if !levels.is_empty() {
        descriptors.push(select(
            "thinking",
            "Thinking",
            levels
                .iter()
                .map(|(index, (id, label))| choice(id, label, None, Some(*index) == default_index))
                .collect(),
            None,
        ));
    }
    if let Some(tiers) = model.get("serviceTiers").and_then(Value::as_array) {
        let mut seen = HashSet::from(["default"]);
        let mut options = vec![choice("default", "Standard", None, true)];
        for tier in tiers {
            if options.len() > 64 {
                break;
            }
            let Some(id) = tier
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
            else {
                continue;
            };
            if !seen.insert(id) {
                continue;
            }
            let label = tier
                .get("name")
                .and_then(Value::as_str)
                .filter(|name| !name.trim().is_empty())
                .unwrap_or(id);
            let description = tier
                .get("description")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty());
            options.push(choice(id, label, description, false));
        }
        if options.len() > 1 {
            descriptors.push(select(
                "serviceTier",
                "Service Tier",
                options,
                Some("default"),
            ));
        }
    }
    ModelCapabilities {
        option_descriptors: Some(descriptors),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_model_is_present_for_both_profiles() {
        for (profile, name) in [
            (PiProfile::Pi, "Pi default"),
            (PiProfile::Omo, "OmO default"),
        ] {
            let model = default_model(profile);
            assert_eq!(model.slug, "default");
            assert_eq!(model.name, name);
            assert_eq!(
                serde_json::to_value(model.capabilities).unwrap(),
                json!({"optionDescriptors":[]})
            );
        }
    }

    #[test]
    fn pi_model_capabilities_follow_inventory_and_active_state() {
        let models = parse_models(&json!({"models": [
            {"provider":"p", "id":"a", "reasoning":true, "thinkingLevelMap":{"low":null,"xhigh":"extra"}, "serviceTiers":[{"id":"fast","name":"Fast"}]},
            {"provider":"p", "id":"b", "supportedThinkingLevels":["high","low"]}
        ]}), &json!({"model":{"provider":"p","id":"a"},"thinkingLevel":"low"})).unwrap();
        assert_eq!(
            serde_json::to_value(&models[0].capabilities).unwrap(),
            json!({"optionDescriptors":[
                {"id":"thinking","label":"Thinking","type":"select","options":[{"id":"off","label":"Off"},{"id":"minimal","label":"Minimal"},{"id":"medium","label":"Medium","isDefault":true},{"id":"high","label":"High"},{"id":"xhigh","label":"Extra High"}]},
                {"id":"serviceTier","label":"Service Tier","type":"select","options":[{"id":"default","label":"Standard","isDefault":true},{"id":"fast","label":"Fast"}],"currentValue":"default"}
            ]})
        );
        assert_eq!(
            serde_json::to_value(&models[1].capabilities).unwrap(),
            json!({"optionDescriptors":[{"id":"thinking","label":"Thinking","type":"select","options":[{"id":"low","label":"Low"},{"id":"high","label":"High"}]}]})
        );
    }

    #[test]
    fn pi_capabilities_handle_empty_explicit_levels_and_tier_validation() {
        let tiers: Vec<_> = (0..70).map(|i| json!({"id":format!("tier-{i}")})).collect();
        let model = json!({"reasoning":true, "supportedThinkingLevels":[],
            "serviceTiers":[null, {"id":""}, {"id":"default"}, {"id":"fast", "name":" ", "description":"desc"}, {"id":"fast", "name":"duplicate"}]});
        assert_eq!(
            serde_json::to_value(model_capabilities(&model, Some("high"))).unwrap(),
            json!({"optionDescriptors":[
                {"id":"serviceTier","label":"Service Tier","type":"select","currentValue":"default", "options":[{"id":"default","label":"Standard","isDefault":true},{"id":"fast","label":"fast","description":"desc"}]}
            ]})
        );
        assert_eq!(
            serde_json::to_value(model_capabilities(&json!({}), None)).unwrap(),
            json!({"optionDescriptors":[]})
        );
        let caps = model_capabilities(&json!({"serviceTiers":tiers}), None);
        let ProviderOptionDescriptor::Select { options, .. } = &caps.option_descriptors.unwrap()[0]
        else {
            panic!("expected select")
        };
        assert_eq!(options.len(), 65);
        assert_eq!(options.last().unwrap().id, "tier-63");
    }

    #[test]
    fn pi_thinking_default_clamps_up_then_down_and_rejects_unknown() {
        let model = json!({"supportedThinkingLevels":["high","low", "invalid", "low"]});
        for (input, expected) in [
            ("medium", Some("high")),
            ("max", Some("high")),
            ("unknown", None),
        ] {
            let caps = model_capabilities(&model, Some(input));
            let ProviderOptionDescriptor::Select { options, .. } =
                &caps.option_descriptors.unwrap()[0]
            else {
                panic!("expected select")
            };
            assert_eq!(
                options
                    .iter()
                    .filter(|o| o.is_default == Some(true))
                    .map(|o| o.id.as_str())
                    .next(),
                expected
            );
            assert_eq!(options.len(), 2);
        }
    }
}
