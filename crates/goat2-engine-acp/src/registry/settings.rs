//! ACP registry instance settings, from v1 `packages/provider-acp-registry/src/settings.ts` (all 113
//! lines) and `customModels.ts` (all 11 lines) at 916b5ccc1b2, with the custom model types from
//! `packages/contracts/src/model.ts:106-114`.
//!
//! [RegistrySettings::decode] applies v1's `withDecodingDefault` defaults, `TrimmedString`
//! trimming, the field type checks and the `customModelDetails` filter (`settings.ts:100-112`).
//! Unknown keys are ignored, as Effect's struct decode does.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

use super::contracts::{Contract, ModelCapabilities};
use super::schema::{Checked, SchemaError, field, trim_in_place, trimmed_non_empty, type_error};

/// v1 `settings.ts:29-41` `source`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    #[default]
    Registry,
    Local,
}

/// v1 `settings.ts:10-11` `AcpRegistryDistributionPreference`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DistributionPreference {
    #[default]
    Auto,
    Binary,
    Npx,
    Uvx,
}
impl DistributionPreference {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Binary => "binary",
            Self::Npx => "npx",
            Self::Uvx => "uvx",
        }
    }
}

/// v1 `model.ts:106-111` `CustomModelEntry`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CustomModelEntry {
    pub slug: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<ModelCapabilities>,
}
impl Contract for CustomModelEntry {
    fn normalize(&mut self) -> Checked<()> {
        field("slug", || trimmed_non_empty(&mut self.slug, None))?;
        field("name", || match &mut self.name {
            Some(name) => trimmed_non_empty(name, None),
            None => Ok(()),
        })?;
        field("capabilities", || match &mut self.capabilities {
            Some(c) => c.normalize(),
            None => Ok(()),
        })
    }
}
impl CustomModelEntry {
    fn decode(value: &Value) -> Checked<Self> {
        let object = value
            .as_object()
            .ok_or_else(|| type_error("object", value))?;
        let slug = field("slug", || match object.get("slug") {
            Some(Value::String(s)) => Ok(s.clone()),
            Some(other) => Err(type_error("string", other)),
            None => Err(SchemaError::new("Missing key")),
        })?;
        let name = field("name", || match object.get("name") {
            None => Ok(None),
            Some(Value::String(s)) => Ok(Some(s.clone())),
            Some(other) => Err(type_error("string", other)),
        })?;
        let capabilities = field("capabilities", || match object.get("capabilities") {
            None => Ok(None),
            Some(v) => serde_json::from_value(v.clone())
                .map(Some)
                .map_err(|e| SchemaError::new(e.to_string())),
        })?;
        let mut entry = Self {
            slug,
            name,
            capabilities,
        };
        entry.normalize()?;
        Ok(entry)
    }
}

/// v1 `model.ts:113` `CustomModelSetting = string | CustomModelEntry`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CustomModelSetting {
    Slug(String),
    Entry(CustomModelEntry),
}
impl CustomModelSetting {
    pub fn slug(&self) -> &str {
        match self {
            Self::Slug(s) => s,
            Self::Entry(e) => &e.slug,
        }
    }
    fn decode(value: &Value) -> Checked<Self> {
        match value {
            Value::String(s) => Ok(Self::Slug(s.clone())),
            Value::Object(_) => CustomModelEntry::decode(value).map(Self::Entry),
            other => Err(type_error("string | CustomModelEntry", other)),
        }
    }
}

/// One ACP registry provider instance's settings (v1 `settings.ts:27-113`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrySettings {
    pub source: Source,
    pub enabled: bool,
    /// "Agent identifier from the official ACP Registry, for example 'devin'."
    pub agent_id: String,
    /// Executable on this environment. For registry agents, this overrides the distribution
    /// executable while keeping its arguments and environment.
    pub command_path: String,
    pub command_args: Vec<String>,
    pub read_mini_max_code_quota: bool,
    /// Optional ACP authentication method ID; by default the first agent-managed method.
    pub auth_method_id: String,
    pub distribution: DistributionPreference,
    pub custom_models: Vec<CustomModelSetting>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_model_details: Option<Vec<CustomModelEntry>>,
}

impl Default for RegistrySettings {
    /// v1 defaults for every field (`settings.ts:30,43,47,55,64,68,77,86,90`).
    fn default() -> Self {
        Self {
            source: Source::Registry,
            enabled: true,
            agent_id: String::new(),
            command_path: String::new(),
            command_args: Vec::new(),
            read_mini_max_code_quota: false,
            auth_method_id: String::new(),
            distribution: DistributionPreference::Auto,
            custom_models: Vec::new(),
            custom_model_details: None,
        }
    }
}

/// v1 `settings.ts:98` form order.
pub const SETTINGS_FORM_ORDER: [&str; 5] = [
    "source",
    "agentId",
    "commandPath",
    "readMiniMaxCodeQuota",
    "authMethodId",
];

fn trimmed_string(object: &Map<String, Value>, key: &str) -> Checked<String> {
    field(key, || match object.get(key) {
        None => Ok(String::new()),
        Some(Value::String(s)) => {
            let mut s = s.clone();
            trim_in_place(&mut s);
            Ok(s)
        }
        Some(other) => Err(type_error("string", other)),
    })
}

fn boolean(object: &Map<String, Value>, key: &str, default: bool) -> Checked<bool> {
    field(key, || match object.get(key) {
        None => Ok(default),
        Some(Value::Bool(b)) => Ok(*b),
        Some(other) => Err(type_error("boolean", other)),
    })
}

fn array<'a>(object: &'a Map<String, Value>, key: &str) -> Checked<Option<&'a Vec<Value>>> {
    field(key, || match object.get(key) {
        None => Ok(None),
        Some(Value::Array(items)) => Ok(Some(items)),
        Some(other) => Err(type_error("array", other)),
    })
}

fn indexed<T>(items: &[Value], decode: impl Fn(&Value) -> Checked<T>) -> Checked<Vec<T>> {
    items
        .iter()
        .enumerate()
        .map(|(i, v)| decode(v).map_err(|e| e.at(i.to_string())))
        .collect()
}

impl RegistrySettings {
    /// Decode as v1's `Schema.decodeUnknownSync(AcpRegistrySettings)`.
    pub fn decode(value: &Value) -> Checked<Self> {
        let object = value
            .as_object()
            .ok_or_else(|| type_error("object", value))?;
        let source = field("source", || match object.get("source") {
            None => Ok(Source::Registry),
            Some(Value::String(s)) if s == "registry" => Ok(Source::Registry),
            Some(Value::String(s)) if s == "local" => Ok(Source::Local),
            Some(other) => Err(type_error("\"registry\" | \"local\"", other)),
        })?;
        let enabled = boolean(object, "enabled", true)?;
        let agent_id = trimmed_string(object, "agentId")?;
        let command_path = trimmed_string(object, "commandPath")?;
        let command_args = match array(object, "commandArgs")? {
            None => Vec::new(),
            Some(items) => field("commandArgs", || {
                indexed(items, |v| match v {
                    Value::String(s) => Ok(s.clone()),
                    other => Err(type_error("string", other)),
                })
            })?,
        };
        let read_mini_max_code_quota = boolean(object, "readMiniMaxCodeQuota", false)?;
        let auth_method_id = trimmed_string(object, "authMethodId")?;
        let distribution = field("distribution", || match object.get("distribution") {
            None => Ok(DistributionPreference::Auto),
            Some(v) => serde_json::from_value(v.clone())
                .map_err(|_| type_error("\"auto\" | \"binary\" | \"npx\" | \"uvx\"", v)),
        })?;
        let custom_models = match array(object, "customModels")? {
            None => Vec::new(),
            Some(items) => field("customModels", || {
                indexed(items, CustomModelSetting::decode)
            })?,
        };
        let custom_model_details = match array(object, "customModelDetails")? {
            None => None,
            Some(items) => Some(field("customModelDetails", || {
                indexed(items, CustomModelEntry::decode)
            })?),
        };
        let settings = Self {
            source,
            enabled,
            agent_id,
            command_path,
            command_args,
            read_mini_max_code_quota,
            auth_method_id,
            distribution,
            custom_models,
            custom_model_details,
        };
        if !settings.model_details_match() {
            return Err(SchemaError::new("Expected a valid value"));
        }
        Ok(settings)
    }

    /// v1 `settings.ts:100-112`: each detail names a configured custom model, at most once.
    pub fn model_details_match(&self) -> bool {
        let ids: std::collections::HashSet<&str> = self
            .custom_models
            .iter()
            .map(CustomModelSetting::slug)
            .collect();
        let mut seen = std::collections::HashSet::new();
        self.custom_model_details
            .as_deref()
            .unwrap_or_default()
            .iter()
            .all(|entry| ids.contains(entry.slug.as_str()) && seen.insert(entry.slug.as_str()))
    }

    /// v1 `settings.ts:13-25`: the direct MiniMax Code preset launch, not a wrapper.
    pub fn is_minimax_code(&self) -> bool {
        self.source == Source::Local
            && self.command_path.trim().rsplit('/').next() == Some("mcode")
            && self.command_args == ["acp"]
    }

    /// v1 `customModels.ts:4-11`: structured details replace the matching custom model.
    pub fn resolved_custom_models(&self) -> Vec<CustomModelSetting> {
        let details = self.custom_model_details.as_deref().unwrap_or_default();
        self.custom_models
            .iter()
            .map(|model| {
                details
                    .iter()
                    .rev()
                    .find(|entry| entry.slug == model.slug())
                    .cloned()
                    .map(CustomModelSetting::Entry)
                    .unwrap_or_else(|| model.clone())
            })
            .collect()
    }
}

/// v1 `settings.ts:14-25` on raw (undecoded) settings.
pub fn is_minimax_code_value(settings: &Value) -> bool {
    let Some(object) = settings.as_object() else {
        return false;
    };
    object.get("source").and_then(Value::as_str) == Some("local")
        && object
            .get("commandPath")
            .and_then(Value::as_str)
            .is_some_and(|p| p.trim().rsplit('/').next() == Some("mcode"))
        && object
            .get("commandArgs")
            .and_then(Value::as_array)
            .is_some_and(|a| a.len() == 1 && a[0].as_str() == Some("acp"))
}

impl<'de> Deserialize<'de> for RegistrySettings {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(d)?;
        Self::decode(&value).map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn defaults_match_v1() {
        let s = RegistrySettings::decode(&json!({})).unwrap();
        assert_eq!(s, RegistrySettings::default());
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            json!({"source": "registry", "enabled": true, "agentId": "", "commandPath": "",
                   "commandArgs": [], "readMiniMaxCodeQuota": false, "authMethodId": "",
                   "distribution": "auto", "customModels": []})
        );
    }

    #[test]
    fn trimmed_strings_are_trimmed_and_args_are_not() {
        let s = RegistrySettings::decode(&json!({
            "agentId": " devin ", "commandPath": "\t/bin/agent ", "authMethodId": " oauth ",
            "commandArgs": [" acp "], "ignored": 1
        }))
        .unwrap();
        assert_eq!(s.agent_id, "devin");
        assert_eq!(s.command_path, "/bin/agent");
        assert_eq!(s.auth_method_id, "oauth");
        assert_eq!(s.command_args, [" acp "]);
    }

    #[test]
    fn type_errors_name_the_field() {
        for (input, path, message) in [
            (
                json!({"source": "cloud"}),
                vec!["source"],
                "Expected \"registry\" | \"local\", got \"cloud\"",
            ),
            (
                json!({"enabled": "yes"}),
                vec!["enabled"],
                "Expected boolean, got \"yes\"",
            ),
            (
                json!({"agentId": 1}),
                vec!["agentId"],
                "Expected string, got 1",
            ),
            (
                json!({"commandArgs": ["a", 2]}),
                vec!["commandArgs", "1"],
                "Expected string, got 2",
            ),
            (
                json!({"commandArgs": "a"}),
                vec!["commandArgs"],
                "Expected array, got \"a\"",
            ),
            (
                json!({"distribution": "pip"}),
                vec!["distribution"],
                "Expected \"auto\" | \"binary\" | \"npx\" | \"uvx\", got \"pip\"",
            ),
            (
                json!({"readMiniMaxCodeQuota": null}),
                vec!["readMiniMaxCodeQuota"],
                "Expected boolean, got null",
            ),
        ] {
            let e = RegistrySettings::decode(&input).unwrap_err();
            assert_eq!(e.path, path, "{input}");
            assert_eq!(e.message, message, "{input}");
        }
        assert_eq!(
            RegistrySettings::decode(&json!([])).unwrap_err().message,
            "Expected object, got []"
        );
    }

    // v1 settings.test.ts:5-12.
    #[test]
    fn minimax_code_credential_use_is_opt_in() {
        let config =
            json!({"source": "local", "commandPath": "/installed/mcode", "commandArgs": ["acp"]});
        let before = RegistrySettings::decode(&config).unwrap();
        assert!(before.is_minimax_code());
        assert!(is_minimax_code_value(&config));
        assert!(!before.read_mini_max_code_quota);
        let mut opted = config.clone();
        opted["readMiniMaxCodeQuota"] = json!(true);
        assert!(
            RegistrySettings::decode(&opted)
                .unwrap()
                .read_mini_max_code_quota
        );
        let wrapper =
            json!({"source": "local", "commandPath": "node", "commandArgs": ["mcode", "acp"]});
        assert!(
            !RegistrySettings::decode(&wrapper)
                .unwrap()
                .is_minimax_code()
        );
        assert!(!is_minimax_code_value(
            &json!({"source": "registry", "commandPath": "mcode", "commandArgs": ["acp"]})
        ));
    }

    // v1 customModelSettings.test.ts:7-27.
    #[test]
    fn legacy_named_models_decode_and_malformed_details_are_rejected() {
        let legacy = RegistrySettings::decode(&json!({
            "agentId": "example", "customModels": [{"slug": "x", "name": "Friendly"}]
        }))
        .unwrap();
        assert_eq!(
            legacy.custom_models,
            [CustomModelSetting::Entry(CustomModelEntry {
                slug: "x".into(),
                name: Some("Friendly".into()),
                capabilities: None
            })]
        );
        let bad_name = RegistrySettings::decode(&json!({
            "agentId": "example", "customModels": ["x"], "customModelDetails": [{"slug": "x", "name": 42}]
        }))
        .unwrap_err();
        assert_eq!(bad_name.path, ["customModelDetails", "0", "name"]);
        let missing = RegistrySettings::decode(&json!({
            "agentId": "example", "customModels": ["x"], "customModelDetails": [{"slug": "missing"}]
        }))
        .unwrap_err();
        assert_eq!(missing.message, "Expected a valid value");
        let duplicate = RegistrySettings::decode(&json!({
            "customModels": ["x"], "customModelDetails": [{"slug": "x"}, {"slug": "x"}]
        }));
        assert!(duplicate.is_err());
        assert!(RegistrySettings::decode(&json!({"customModels": [{"slug": " "}]})).is_err());
        assert!(RegistrySettings::decode(&json!({"customModels": [3]})).is_err());
    }

    // v1 customModelSettings.test.ts:29-59 (the name and capabilities enrichment).
    #[test]
    fn details_enrich_custom_models() {
        let capabilities = json!({"optionDescriptors": [{"id": "effort", "label": "Reasoning", "type": "select",
            "options": [{"id": "high", "label": "High", "isDefault": true}]}]});
        let s = RegistrySettings::decode(&json!({
            "agentId": "example", "customModels": ["x", "y"],
            "customModelDetails": [{"slug": "x", "name": "Friendly", "capabilities": capabilities}]
        }))
        .unwrap();
        let resolved = s.resolved_custom_models();
        let CustomModelSetting::Entry(x) = &resolved[0] else {
            panic!("x not enriched")
        };
        assert_eq!(x.name.as_deref(), Some("Friendly"));
        assert_eq!(serde_json::to_value(&x.capabilities).unwrap(), capabilities);
        assert_eq!(resolved[1], CustomModelSetting::Slug("y".into()));
        let round_trip: RegistrySettings =
            serde_json::from_value(serde_json::to_value(&s).unwrap()).unwrap();
        assert_eq!(round_trip, s);
    }
}
