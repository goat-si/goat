//! Lenient readers for what agents send back.
//!
//! Outgoing requests are built from `agent_client_protocol::v1::schema` types. Responses and
//! inbound messages are read from JSON here, field by field, the way v1 `effect-acp` tolerates
//! agents that are ahead of or behind the pinned schema (`packages/effect-acp/src/compat.ts`).

use serde_json::Value;

pub(crate) fn str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// A trimmed, non-empty string field.
pub(crate) fn text_field(value: &Value, key: &str) -> Option<String> {
    str_field(value, key)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn present(value: Option<&Value>) -> bool {
    matches!(value, Some(v) if !v.is_null())
}

/// One `authMethods` entry of `initialize`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AuthMethodInfo {
    pub id: String,
    pub name: Option<String>,
    pub description: Option<String>,
    /// ACP `type`: absent or `agent` means the agent signs in by itself.
    pub kind: Option<String>,
}

/// What `initialize` told us about the agent.
#[derive(Debug, Clone, Default)]
pub struct InitializeInfo {
    pub protocol_version: u64,
    pub agent_name: Option<String>,
    pub agent_title: Option<String>,
    pub agent_version: Option<String>,
    pub load_session: bool,
    pub session_resume: bool,
    pub session_fork: bool,
    /// `sessionCapabilities.delete`: the agent takes `session/delete` (v1 AcpSessionRuntime.ts:1902-1915).
    pub session_delete: bool,
    /// `sessionCapabilities.systemPrompt` (ACP 1.22): the agent takes `systemPrompt` on new/load/resume.
    pub system_prompt: bool,
    pub mcp_http: bool,
    /// `mcpCapabilities.acp`: the agent takes MCP servers served over the ACP connection.
    pub mcp_acp: bool,
    pub mcp_sse: bool,
    pub prompt_image: bool,
    pub prompt_audio: bool,
    pub prompt_embedded_context: bool,
    pub auth_methods: Vec<AuthMethodInfo>,
    /// `agentCapabilities._meta` (Antigravity advertises `antigravity.systemPrompt.append` here).
    pub capabilities_meta: Option<Value>,
    pub raw: Value,
}

impl InitializeInfo {
    pub fn from_value(value: &Value) -> Self {
        let caps = value
            .get("agentCapabilities")
            .cloned()
            .unwrap_or(Value::Null);
        let session = caps
            .get("sessionCapabilities")
            .cloned()
            .unwrap_or(Value::Null);
        let mcp = caps.get("mcpCapabilities").cloned().unwrap_or(Value::Null);
        let prompt = caps
            .get("promptCapabilities")
            .cloned()
            .unwrap_or(Value::Null);
        let info = value.get("agentInfo").cloned().unwrap_or(Value::Null);
        let auth_methods = value
            .get("authMethods")
            .and_then(Value::as_array)
            .map(|methods| {
                methods
                    .iter()
                    .filter_map(|method| {
                        Some(AuthMethodInfo {
                            id: text_field(method, "id")?,
                            name: text_field(method, "name"),
                            description: text_field(method, "description"),
                            kind: text_field(method, "type"),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        Self {
            protocol_version: value
                .get("protocolVersion")
                .and_then(Value::as_u64)
                .unwrap_or(1),
            agent_name: text_field(&info, "name"),
            agent_title: text_field(&info, "title"),
            agent_version: text_field(&info, "version"),
            load_session: caps.get("loadSession").and_then(Value::as_bool) == Some(true),
            session_resume: present(session.get("resume")),
            session_fork: present(session.get("fork")),
            session_delete: present(session.get("delete")),
            system_prompt: present(session.get("systemPrompt")),
            mcp_http: mcp.get("http").and_then(Value::as_bool) == Some(true),
            mcp_acp: mcp.get("acp").and_then(Value::as_bool) == Some(true),
            mcp_sse: mcp.get("sse").and_then(Value::as_bool) == Some(true),
            prompt_image: prompt.get("image").and_then(Value::as_bool) == Some(true),
            prompt_audio: prompt.get("audio").and_then(Value::as_bool) == Some(true),
            prompt_embedded_context: prompt.get("embeddedContext").and_then(Value::as_bool)
                == Some(true),
            auth_methods,
            capabilities_meta: caps.get("_meta").filter(|v| !v.is_null()).cloned(),
            raw: value.clone(),
        }
    }
}

/// v1 `AcpSessionMode` / `AcpSessionModeState` (runtimeModel.ts:38-48).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ModeState {
    pub current_mode_id: String,
    pub available: Vec<(String, String)>,
}

impl ModeState {
    pub fn has(&self, id: &str) -> bool {
        self.available.iter().any(|(mode, _)| mode == id)
    }
}

/// `models` of a session setup response (unstable ACP session models).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ModelState {
    pub current_model_id: String,
    /// (modelId, name, _meta)
    pub available: Vec<(String, String, Option<Value>)>,
}

/// What `session/new`, `session/load` or `session/resume` returned.
#[derive(Debug, Clone, Default)]
pub struct SessionSetup {
    pub session_id: String,
    pub modes: Option<ModeState>,
    pub models: Option<ModelState>,
    pub config_options: Vec<Value>,
    pub raw: Value,
}

/// v1 `parseSessionModeState` (runtimeModel.ts:478-517): the `modes` field, or else the
/// `category: "mode"` select option; a mode without an id or a name is skipped, and a state with
/// no usable mode is none.
pub fn parse_modes(value: &Value) -> Option<ModeState> {
    let (current, available): (String, Vec<(String, String)>) =
        match value.get("modes").filter(|v| !v.is_null()) {
            Some(modes) => (
                text_field(modes, "currentModeId")?,
                modes
                    .get("availableModes")
                    .and_then(Value::as_array)
                    .map(|list| {
                        list.iter()
                            .filter_map(|mode| {
                                Some((text_field(mode, "id")?, text_field(mode, "name")?))
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
            ),
            None => {
                let option = value
                    .get("configOptions")
                    .and_then(Value::as_array)?
                    .iter()
                    .find(|option| {
                        str_field(option, "category") == Some("mode")
                            && str_field(option, "type") == Some("select")
                    })?;
                (
                    text_field(option, "currentValue")?,
                    select_values(option)
                        .into_iter()
                        .filter_map(|(id, name)| {
                            let (id, name) = (id.trim(), name.trim());
                            (!id.is_empty() && !name.is_empty())
                                .then(|| (id.to_owned(), name.to_owned()))
                        })
                        .collect(),
                )
            }
        };
    if available.is_empty() {
        return None;
    }
    Some(ModeState {
        current_mode_id: current,
        available,
    })
}

pub fn parse_models(value: &Value) -> Option<ModelState> {
    let models = value.get("models").filter(|v| !v.is_null())?;
    Some(ModelState {
        current_model_id: text_field(models, "currentModelId").unwrap_or_default(),
        available: models
            .get("availableModels")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(|model| {
                        let id = text_field(model, "modelId")?;
                        let name = text_field(model, "name").unwrap_or_else(|| id.clone());
                        Some((id, name, model.get("_meta").cloned()))
                    })
                    .collect()
            })
            .unwrap_or_default(),
    })
}

impl SessionSetup {
    pub fn from_value(value: &Value, requested_session_id: Option<&str>) -> Option<Self> {
        let session_id =
            text_field(value, "sessionId").or_else(|| requested_session_id.map(str::to_owned))?;
        Some(Self {
            session_id,
            modes: parse_modes(value),
            models: parse_models(value),
            config_options: value
                .get("configOptions")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
            raw: value.clone(),
        })
    }
}

/// v1 `findModelConfigOption` (runtimeModel.ts:428-435): the first `category: "model"` select
/// option with a non-empty id.
pub fn find_model_config_option(options: &[Value]) -> Option<&Value> {
    options.iter().find(|option| {
        str_field(option, "category") == Some("model")
            && str_field(option, "type") == Some("select")
            && config_option_id(option).is_some_and(|id| !id.trim().is_empty())
    })
}

/// A config option's id (`id`; ACP v2 drafts and v1 effect-acp fixtures say `configId`).
pub fn config_option_id(option: &Value) -> Option<&str> {
    str_field(option, "id").or_else(|| str_field(option, "configId"))
}

/// Every selectable value of a select config option, flattening groups (v1 `flattenSelectChoices`).
pub fn select_values(option: &Value) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for entry in option
        .get("options")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(value) = text_field(entry, "value") {
            let name = text_field(entry, "name").unwrap_or_else(|| value.clone());
            out.push((value, name));
        } else if let Some(group) = entry.get("options").and_then(Value::as_array) {
            for choice in group {
                if let Some(value) = text_field(choice, "value") {
                    let name = text_field(choice, "name").unwrap_or_else(|| value.clone());
                    out.push((value, name));
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_initialize() {
        let info = InitializeInfo::from_value(&json!({
            "protocolVersion": 1,
            "agentInfo": {"name": "grok", "version": "1.2.3"},
            "agentCapabilities": {
                "loadSession": true,
                "promptCapabilities": {"image": true},
                "mcpCapabilities": {"http": true},
                "sessionCapabilities": {"resume": {}, "systemPrompt": {}}
            },
            "authMethods": [{"id": "cached_token", "name": "Cached"}]
        }));
        assert!(info.load_session && info.session_resume && info.system_prompt && info.mcp_http);
        assert!(info.prompt_image && !info.prompt_audio);
        assert_eq!(info.agent_version.as_deref(), Some("1.2.3"));
        assert_eq!(info.auth_methods[0].id, "cached_token");
    }

    #[test]
    fn reads_setup_and_model_option() {
        let setup = SessionSetup::from_value(
            &json!({
                "sessionId": "s1",
                "modes": {"currentModeId": "default", "availableModes": [{"id": "default", "name": "Default"}, {"id": "yolo", "name": "Yolo"}]},
                "configOptions": [{"id": "model", "category": "model", "type": "select", "currentValue": "a", "options": [{"value": "a", "name": "A"}, {"group": "g", "options": [{"value": "b", "name": "B"}]}]}]
            }),
            None,
        )
        .unwrap();
        assert!(setup.modes.as_ref().unwrap().has("yolo"));
        let option = find_model_config_option(&setup.config_options).unwrap();
        assert_eq!(select_values(option).len(), 2);
    }

    /// v1 runtimeModel.ts:428-435: only a `category: "model"` select option with an id is the
    /// model option (round 7 part 2.3).
    #[test]
    fn the_model_option_is_a_model_select_with_an_id() {
        let options = [
            json!({"id": "model", "type": "select", "options": []}),
            json!({"id": "m1", "category": "model", "type": "boolean"}),
            json!({"id": " ", "category": "model", "type": "select", "options": []}),
        ];
        assert!(find_model_config_option(&options).is_none());
        let options = [
            options[0].clone(),
            json!({"id": "m2", "category": "model", "type": "select", "options": []}),
        ];
        assert_eq!(
            find_model_config_option(&options).and_then(config_option_id),
            Some("m2")
        );
    }

    /// v1 runtimeModel.ts:478-517: a mode without a name is skipped, no usable mode is no state,
    /// and the mode select option stands in for a missing `modes` (round 7 part 2.3).
    #[test]
    fn modes_follow_v1() {
        let modes = parse_modes(&json!({"modes": {"currentModeId": "a", "availableModes": [
            {"id": "a", "name": "A"}, {"id": "b"}, {"id": "", "name": "C"}
        ]}}))
        .unwrap();
        assert_eq!(modes.available, vec![("a".to_owned(), "A".to_owned())]);
        assert!(
            parse_modes(&json!({"modes": {"currentModeId": "a", "availableModes": []}})).is_none()
        );
        let modes = parse_modes(&json!({"configOptions": [{"id": "mode", "category": "mode",
            "type": "select", "currentValue": "ask", "options": [{"value": "ask", "name": "Ask"},
            {"group": "g", "name": "G", "options": [{"value": "code", "name": "Code"}]}]}]}))
        .unwrap();
        assert_eq!(modes.current_mode_id, "ask");
        assert!(modes.has("code"));
    }
}
