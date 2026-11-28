//! ACP registry contract types, from v1 `packages/contracts/src/acpRegistry.ts` (all 362 lines) and
//! the provider option types it reuses from `packages/contracts/src/model.ts:7-114`, at 916b5ccc1b2.
//!
//! JSON field names are v1's. Each input or result type has `normalize`, which applies v1's
//! decode-time trimming and every v1 check with Effect's message (see [super::schema]). Use
//! [decode] to read one from JSON the way v1's `Schema.decodeUnknown` does.

use serde::de::{DeserializeOwned, Error as _};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::BTreeMap;

use super::schema::{
    Checked, SchemaError, each, field, max_items, max_len, min_len, pattern, trim_in_place,
    trimmed_non_empty,
};

/// v1 `acpRegistry.ts:50-51`.
pub const ACP_REGISTRY_MAX_AGENTS: usize = 512;
pub const ACP_REGISTRY_SEARCH_QUERY_MAX_LENGTH: usize = 120;
/// v1 `acpRegistry.ts:61` `AcpRegistryUrl`.
const URL_MAX: usize = 2_048;

/// A v1 contract that trims and checks itself after JSON decoding.
pub trait Contract {
    fn normalize(&mut self) -> Checked<()>;
}

/// Decode and check, as v1's `Schema.decodeUnknown(<schema>)`.
pub fn decode<T: DeserializeOwned + Contract>(value: serde_json::Value) -> Checked<T> {
    let mut decoded: T =
        serde_json::from_value(value).map_err(|e| SchemaError::new(e.to_string()))?;
    decoded.normalize()?;
    Ok(decoded)
}

/// `Schema.Literal(true)`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct True;
impl Serialize for True {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_bool(true)
    }
}
impl<'de> Deserialize<'de> for True {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        if bool::deserialize(d)? {
            Ok(True)
        } else {
            Err(D::Error::custom("Expected true, got false"))
        }
    }
}

/// `Schema.optionalKey(Schema.NullOr(..))`: absent, null, or a value.
fn double_option<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

// ---- shared field rules ----

/// v1 `acpRegistry.ts:8-11` `AcpRegistryAgentId`.
pub fn check_agent_id(value: &mut String) -> Checked<()> {
    trimmed_non_empty(value, Some(128))?;
    pattern(value, "^[a-z0-9][a-z0-9._-]*$", "^[a-z0-9][a-z0-9._-]*$")
}
/// v1 `providerInstance.ts:7-15,24` `ProviderInstanceId`.
pub fn check_instance_id(value: &mut String) -> Checked<()> {
    trimmed_non_empty(value, Some(64))?;
    pattern(
        value,
        "^[a-zA-Z][a-zA-Z0-9_-]*$",
        "^[a-zA-Z][a-zA-Z0-9_-]*$",
    )
}
/// v1 `baseSchemas.ts:294-300` `ThreadId` / `ProjectId`.
pub fn check_entity_id(value: &mut String) -> Checked<()> {
    trimmed_non_empty(value, None)
}
fn url(value: &str) -> Checked<()> {
    max_len(value, URL_MAX)
}
fn opt<T>(value: &mut Option<T>, check: impl FnOnce(&mut T) -> Checked<()>) -> Checked<()> {
    value.as_mut().map_or(Ok(()), check)
}
fn opt_opt<T>(
    value: &mut Option<Option<T>>,
    check: impl FnOnce(&mut T) -> Checked<()>,
) -> Checked<()> {
    value
        .as_mut()
        .and_then(Option::as_mut)
        .map_or(Ok(()), check)
}
/// v1 `acpRegistry.ts:109` `AcpRegistryProbeText`.
fn probe_text(value: &mut String) -> Checked<()> {
    trimmed_non_empty(value, Some(256))
}
/// v1 `acpRegistry.ts:110` `AcpRegistryProbeDescription`.
fn probe_description(value: &mut Option<String>) -> Checked<()> {
    opt(value, |s| max_len(s, 1_024))
}
/// v1 `acpRegistry.ts:143-144`.
fn session_id(value: &mut String) -> Checked<()> {
    trimmed_non_empty(value, Some(1_024))
}
fn session_path(value: &mut String) -> Checked<()> {
    trimmed_non_empty(value, Some(4_096))
}
/// v1 `acpRegistry.ts:157-161` `AcpRegistryContinuation` (not trimmed).
fn continuation(value: &str) -> Checked<()> {
    min_len(value, 16)?;
    max_len(value, 64)?;
    pattern(value, "^[A-Za-z0-9_-]+$", "^[A-Za-z0-9_-]+$")
}
/// v1 `acpRegistry.ts:211-212`.
fn provider_id(value: &mut String) -> Checked<()> {
    trimmed_non_empty(value, Some(256))
}
fn provider_protocol(value: &mut String) -> Checked<()> {
    trimmed_non_empty(value, Some(64))
}

// ---- model.ts provider options ----

/// v1 `model.ts:10-16`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderOptionChoice {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_default: Option<bool>,
}
impl Contract for ProviderOptionChoice {
    fn normalize(&mut self) -> Checked<()> {
        field("id", || trimmed_non_empty(&mut self.id, None))?;
        field("label", || trimmed_non_empty(&mut self.label, None))?;
        field("description", || {
            opt(&mut self.description, |s| trimmed_non_empty(s, None))
        })
    }
}

/// v1 `model.ts:27` `role: "reasoning"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderOptionRole {
    Reasoning,
}

/// v1 `model.ts:18-44` `ProviderOptionDescriptor` (select or boolean).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ProviderOptionDescriptor {
    Select {
        id: String,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        options: Vec<ProviderOptionChoice>,
        #[serde(
            default,
            rename = "currentValue",
            skip_serializing_if = "Option::is_none"
        )]
        current_value: Option<String>,
        #[serde(
            default,
            rename = "promptInjectedValues",
            skip_serializing_if = "Option::is_none"
        )]
        prompt_injected_values: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        role: Option<ProviderOptionRole>,
    },
    Boolean {
        id: String,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(
            default,
            rename = "currentValue",
            skip_serializing_if = "Option::is_none"
        )]
        current_value: Option<bool>,
    },
}
impl Contract for ProviderOptionDescriptor {
    fn normalize(&mut self) -> Checked<()> {
        let (id, label, description) = match self {
            Self::Select {
                id,
                label,
                description,
                ..
            }
            | Self::Boolean {
                id,
                label,
                description,
                ..
            } => (id, label, description),
        };
        field("id", || trimmed_non_empty(id, None))?;
        field("label", || trimmed_non_empty(label, None))?;
        field("description", || {
            opt(description, |s| trimmed_non_empty(s, None))
        })?;
        if let Self::Select {
            options,
            current_value,
            prompt_injected_values,
            ..
        } = self
        {
            field("options", || each(options, Contract::normalize))?;
            field("currentValue", || {
                opt(current_value, |s| trimmed_non_empty(s, None))
            })?;
            field("promptInjectedValues", || {
                opt(prompt_injected_values, |v| {
                    each(v, |s| trimmed_non_empty(s, None))
                })
            })?;
        }
        Ok(())
    }
}

/// v1 `model.ts:101-104`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCapabilities {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub option_descriptors: Option<Vec<ProviderOptionDescriptor>>,
}
impl Contract for ModelCapabilities {
    fn normalize(&mut self) -> Checked<()> {
        field("optionDescriptors", || {
            opt(&mut self.option_descriptors, |v| {
                each(v, Contract::normalize)
            })
        })
    }
}

// ---- acpRegistry.ts ----

/// v1 `acpRegistry.ts:44-45`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AcpRegistryDistribution {
    Binary,
    Npx,
    Uvx,
}
impl AcpRegistryDistribution {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Binary => "binary",
            Self::Npx => "npx",
            Self::Uvx => "uvx",
        }
    }
}

/// v1 `acpRegistry.ts:47-48`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AcpRegistryIntegrity {
    Sha256,
    Registry,
}

/// v1 `acpRegistry.ts:53-58`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AcpRegistrySearchInput {
    pub query: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<f64>,
}
impl Contract for AcpRegistrySearchInput {
    fn normalize(&mut self) -> Checked<()> {
        field("query", || {
            trim_in_place(&mut self.query);
            max_len(&self.query, ACP_REGISTRY_SEARCH_QUERY_MAX_LENGTH)
        })?;
        field("limit", || match self.limit {
            Some(n) if n.fract() != 0.0 || !n.is_finite() => {
                Err(SchemaError::new(format!("Expected an integer, got {n}")))
            }
            Some(n) if !(1.0..=ACP_REGISTRY_MAX_AGENTS as f64).contains(&n) => {
                Err(SchemaError::new(format!(
                    "Expected a value between 1 and {ACP_REGISTRY_MAX_AGENTS}, got {n}"
                )))
            }
            _ => Ok(()),
        })
    }
}
impl AcpRegistrySearchInput {
    pub fn limit(&self) -> Option<usize> {
        self.limit.map(|n| n as usize)
    }
}

/// v1 `acpRegistry.ts:63-76`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AcpRegistrySearchAgent {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub authors: Vec<String>,
    pub license: Option<String>,
    pub website: Option<String>,
    pub repository: Option<String>,
    pub icon: Option<String>,
    pub distribution: AcpRegistryDistribution,
    pub integrity: AcpRegistryIntegrity,
}
impl Contract for AcpRegistrySearchAgent {
    fn normalize(&mut self) -> Checked<()> {
        field("id", || check_agent_id(&mut self.id))?;
        field("name", || trimmed_non_empty(&mut self.name, Some(160)))?;
        field("version", || {
            trimmed_non_empty(&mut self.version, Some(128))
        })?;
        field("description", || max_len(&self.description, 1_024))?;
        field("authors", || {
            each(&mut self.authors, |s| max_len(s, 256))?;
            max_items(&self.authors, 16)
        })?;
        field("license", || opt(&mut self.license, |s| max_len(s, 128)))?;
        field("website", || opt(&mut self.website, |s| url(s)))?;
        field("repository", || opt(&mut self.repository, |s| url(s)))?;
        field("icon", || opt(&mut self.icon, |s| url(s)))
    }
}

/// v1 `acpRegistry.ts:78-81`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AcpRegistrySearchResult {
    pub agents: Vec<AcpRegistrySearchAgent>,
}
impl Contract for AcpRegistrySearchResult {
    fn normalize(&mut self) -> Checked<()> {
        field("agents", || {
            each(&mut self.agents, Contract::normalize)?;
            max_items(&self.agents, ACP_REGISTRY_MAX_AGENTS)
        })
    }
}

/// v1 `acpRegistry.ts:83-86`; also `AcpRegistryManagedBinaryUninstallInput` (`:96-98`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpRegistryPrepareInput {
    pub agent_id: String,
}
impl Contract for AcpRegistryPrepareInput {
    fn normalize(&mut self) -> Checked<()> {
        field("agentId", || check_agent_id(&mut self.agent_id))
    }
}
pub type AcpRegistryManagedBinaryUninstallInput = AcpRegistryPrepareInput;

/// v1 `acpRegistry.ts:88-93`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpRegistryPrepareResult {
    pub agent_id: String,
    pub version: String,
    pub distribution: AcpRegistryDistribution,
    pub prepared: True,
}
impl Contract for AcpRegistryPrepareResult {
    fn normalize(&mut self) -> Checked<()> {
        field("agentId", || check_agent_id(&mut self.agent_id))?;
        field("version", || {
            trimmed_non_empty(&mut self.version, Some(128))
        })
    }
}

/// v1 `acpRegistry.ts:102-105`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpRegistryManagedBinaryUninstallResult {
    pub agent_id: String,
    pub removed: bool,
}
impl Contract for AcpRegistryManagedBinaryUninstallResult {
    fn normalize(&mut self) -> Checked<()> {
        field("agentId", || check_agent_id(&mut self.agent_id))
    }
}

/// v1 `acpRegistry.ts:116`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AcpRegistryAuthMethodType {
    Agent,
    EnvVar,
    Terminal,
}

/// v1 `acpRegistry.ts:112-120`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpRegistryProbeAuthMethod {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    #[serde(rename = "type")]
    pub kind: AcpRegistryAuthMethodType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env_var_names: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
}
impl Contract for AcpRegistryProbeAuthMethod {
    fn normalize(&mut self) -> Checked<()> {
        field("id", || probe_text(&mut self.id))?;
        field("name", || probe_text(&mut self.name))?;
        field("description", || probe_description(&mut self.description))?;
        field("command", || opt(&mut self.command, |s| max_len(s, 2_048)))?;
        field("envVarNames", || {
            opt(&mut self.env_var_names, |v| {
                each(v, probe_text)?;
                max_items(v, 16)
            })
        })?;
        field("link", || opt(&mut self.link, |s| url(s)))
    }
}

/// v1 `acpRegistry.ts:123-129`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpRegistryUrlAuthAction {
    pub elicitation_id: String,
    pub url: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}
impl Contract for AcpRegistryUrlAuthAction {
    fn normalize(&mut self) -> Checked<()> {
        field("elicitationId", || probe_text(&mut self.elicitation_id))?;
        field("url", || url(&self.url))?;
        field("message", || max_len(&self.message, 1_024))?;
        field("createdAt", || {
            opt(&mut self.created_at, |s| max_len(s, 128))
        })?;
        field("expiresAt", || {
            opt(&mut self.expires_at, |s| max_len(s, 128))
        })
    }
}

/// v1 `acpRegistry.ts:132-135`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpRegistryAcceptUrlAuthInput {
    pub instance_id: String,
    pub elicitation_id: String,
}
impl Contract for AcpRegistryAcceptUrlAuthInput {
    fn normalize(&mut self) -> Checked<()> {
        field("instanceId", || check_instance_id(&mut self.instance_id))?;
        field("elicitationId", || probe_text(&mut self.elicitation_id))
    }
}

/// v1 `acpRegistry.ts:138-140`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct AcpRegistryAcceptUrlAuthResult {
    pub accepted: bool,
}

/// v1 `acpRegistry.ts:146-154`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpRegistrySession {
    pub session_id: String,
    pub cwd: String,
    pub additional_directories: Vec<String>,
    pub title: Option<String>,
    pub updated_at: Option<String>,
    pub imported_thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_history_pending: Option<bool>,
}
impl Contract for AcpRegistrySession {
    fn normalize(&mut self) -> Checked<()> {
        field("sessionId", || session_id(&mut self.session_id))?;
        field("cwd", || session_path(&mut self.cwd))?;
        field("additionalDirectories", || {
            each(&mut self.additional_directories, session_path)?;
            max_items(&self.additional_directories, 32)
        })?;
        field("title", || opt(&mut self.title, |s| max_len(s, 1_024)))?;
        field("updatedAt", || {
            opt(&mut self.updated_at, |s| max_len(s, 128))
        })?;
        field("importedThreadId", || {
            opt(&mut self.imported_thread_id, check_entity_id)
        })
    }
}

/// v1 `acpRegistry.ts:163-168`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpRegistryListSessionsInput {
    pub instance_id: String,
    pub project_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continuation: Option<String>,
}
impl Contract for AcpRegistryListSessionsInput {
    fn normalize(&mut self) -> Checked<()> {
        field("instanceId", || check_instance_id(&mut self.instance_id))?;
        field("projectId", || check_entity_id(&mut self.project_id))?;
        field("cursor", || opt(&mut self.cursor, |s| max_len(s, 2_048)))?;
        field("continuation", || {
            opt(&mut self.continuation, |s| continuation(s))
        })
    }
}

/// v1 `acpRegistry.ts:171-179`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpRegistryListSessionsResult {
    pub sessions: Vec<AcpRegistrySession>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    pub next_cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continuation: Option<String>,
    pub can_load: bool,
    pub can_resume: bool,
    pub can_delete: bool,
}
impl Contract for AcpRegistryListSessionsResult {
    fn normalize(&mut self) -> Checked<()> {
        field("sessions", || {
            each(&mut self.sessions, Contract::normalize)?;
            max_items(&self.sessions, 256)
        })?;
        field("nextCursor", || {
            opt(&mut self.next_cursor, |s| max_len(s, 2_048))
        })?;
        field("continuation", || {
            opt(&mut self.continuation, |s| continuation(s))
        })
    }
}

/// v1 `acpRegistry.ts:182-190`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpRegistryImportSessionInput {
    pub instance_id: String,
    pub project_id: String,
    pub session_id: String,
    #[serde(
        default,
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub title: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub updated_at: Option<Option<String>>,
}
impl Contract for AcpRegistryImportSessionInput {
    fn normalize(&mut self) -> Checked<()> {
        field("instanceId", || check_instance_id(&mut self.instance_id))?;
        field("projectId", || check_entity_id(&mut self.project_id))?;
        field("sessionId", || session_id(&mut self.session_id))?;
        field("title", || {
            opt_opt(&mut self.title, |s| trimmed_non_empty(s, Some(1_024)))
        })?;
        field("updatedAt", || {
            opt_opt(&mut self.updated_at, |s| trimmed_non_empty(s, Some(128)))
        })
    }
}

/// v1 `acpRegistry.ts:193-198`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpRegistryImportSessionResult {
    pub thread_id: String,
    pub imported: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_history_pending: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_history_error: Option<String>,
}
impl Contract for AcpRegistryImportSessionResult {
    fn normalize(&mut self) -> Checked<()> {
        field("threadId", || check_entity_id(&mut self.thread_id))?;
        field("nativeHistoryError", || {
            opt(&mut self.native_history_error, |s| max_len(s, 512))
        })
    }
}

/// v1 `acpRegistry.ts:201-205`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpRegistryDeleteSessionInput {
    pub instance_id: String,
    pub project_id: String,
    pub session_id: String,
}
impl Contract for AcpRegistryDeleteSessionInput {
    fn normalize(&mut self) -> Checked<()> {
        field("instanceId", || check_instance_id(&mut self.instance_id))?;
        field("projectId", || check_entity_id(&mut self.project_id))?;
        field("sessionId", || session_id(&mut self.session_id))
    }
}

/// v1 `acpRegistry.ts:208`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AcpRegistryDeleteSessionResult {
    pub deleted: True,
}

/// v1 `acpRegistry.ts:218-223`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpRegistryProviderEndpoint {
    pub api_type: String,
    pub base_url: String,
}

/// v1 `acpRegistry.ts:214-224`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpRegistryConfigurableProvider {
    pub provider_id: String,
    pub supported: Vec<String>,
    pub required: bool,
    pub current: Option<AcpRegistryProviderEndpoint>,
}
impl Contract for AcpRegistryConfigurableProvider {
    fn normalize(&mut self) -> Checked<()> {
        field("providerId", || provider_id(&mut self.provider_id))?;
        field("supported", || {
            each(&mut self.supported, provider_protocol)?;
            max_items(&self.supported, 16)
        })?;
        field("current", || {
            opt(&mut self.current, |c| {
                field("apiType", || provider_protocol(&mut c.api_type))?;
                field("baseUrl", || url(&c.base_url))
            })
        })
    }
}

/// v1 `acpRegistry.ts:227-230`; also `AcpRegistryListProvidersInput`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpRegistryListProvidersInput {
    pub instance_id: String,
    pub project_id: String,
}
impl Contract for AcpRegistryListProvidersInput {
    fn normalize(&mut self) -> Checked<()> {
        field("instanceId", || check_instance_id(&mut self.instance_id))?;
        field("projectId", || check_entity_id(&mut self.project_id))
    }
}

/// v1 `acpRegistry.ts:233-235`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AcpRegistryListProvidersResult {
    pub providers: Vec<AcpRegistryConfigurableProvider>,
}
impl Contract for AcpRegistryListProvidersResult {
    fn normalize(&mut self) -> Checked<()> {
        field("providers", || {
            each(&mut self.providers, Contract::normalize)?;
            max_items(&self.providers, 64)
        })
    }
}

/// v1 `acpRegistry.ts:238-251`. Headers are write-only secrets: never logged.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpRegistrySetProviderInput {
    pub instance_id: String,
    pub project_id: String,
    pub provider_id: String,
    pub api_type: String,
    pub base_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<BTreeMap<String, String>>,
}
impl std::fmt::Debug for AcpRegistrySetProviderInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AcpRegistrySetProviderInput")
            .field("instance_id", &self.instance_id)
            .field("project_id", &self.project_id)
            .field("provider_id", &self.provider_id)
            .field("api_type", &self.api_type)
            .field("base_url", &self.base_url)
            .field(
                "headers",
                &self.headers.as_ref().map(|h| h.keys().collect::<Vec<_>>()),
            )
            .finish()
    }
}
impl Contract for AcpRegistrySetProviderInput {
    fn normalize(&mut self) -> Checked<()> {
        field("instanceId", || check_instance_id(&mut self.instance_id))?;
        field("projectId", || check_entity_id(&mut self.project_id))?;
        field("providerId", || provider_id(&mut self.provider_id))?;
        field("apiType", || provider_protocol(&mut self.api_type))?;
        field("baseUrl", || url(&self.base_url))?;
        field("headers", || {
            let Some(headers) = self.headers.take() else {
                return Ok(());
            };
            let mut checked = BTreeMap::new();
            for (key, value) in headers {
                let mut name = key.clone();
                field(&key, || {
                    trimmed_non_empty(&mut name, Some(128))?;
                    max_len(&value, 8_192)
                })?;
                checked.insert(name, value);
            }
            self.headers = Some(checked);
            Ok(())
        })
    }
}

/// v1 `acpRegistry.ts:254`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AcpRegistrySetProviderResult {
    pub configured: True,
}

/// v1 `acpRegistry.ts:257-261`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpRegistryDisableProviderInput {
    pub instance_id: String,
    pub project_id: String,
    pub provider_id: String,
}
impl Contract for AcpRegistryDisableProviderInput {
    fn normalize(&mut self) -> Checked<()> {
        field("instanceId", || check_instance_id(&mut self.instance_id))?;
        field("projectId", || check_entity_id(&mut self.project_id))?;
        field("providerId", || provider_id(&mut self.provider_id))
    }
}

/// v1 `acpRegistry.ts:264`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AcpRegistryDisableProviderResult {
    pub disabled: True,
}

/// v1 `acpRegistry.ts:267-269`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpRegistryLogoutInput {
    pub instance_id: String,
}
impl Contract for AcpRegistryLogoutInput {
    fn normalize(&mut self) -> Checked<()> {
        field("instanceId", || check_instance_id(&mut self.instance_id))
    }
}

/// v1 `acpRegistry.ts:272-274`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpRegistryLogoutResult {
    pub logged_out: True,
}

/// v1 `acpRegistry.ts:277-283`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpRegistryProbeModel {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    #[serde(
        default,
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub reasoning_effort: Option<Option<ProviderOptionDescriptor>>,
}
impl Contract for AcpRegistryProbeModel {
    fn normalize(&mut self) -> Checked<()> {
        field("id", || probe_text(&mut self.id))?;
        field("name", || probe_text(&mut self.name))?;
        field("description", || probe_description(&mut self.description))?;
        field("reasoningEffort", || {
            opt_opt(&mut self.reasoning_effort, Contract::normalize)
        })
    }
}

/// v1 `acpRegistry.ts:300-318`; every flag defaults to false when absent.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpRegistrySessionManagement {
    pub can_list: bool,
    pub can_load: bool,
    pub can_resume: bool,
    pub can_logout: bool,
    pub can_delete: bool,
    pub can_configure_providers: bool,
}

/// v1 `acpRegistry.ts:286-319`. `ready` requires a disposable `session/new` probe.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpRegistryProbeResult {
    pub instance_id: String,
    pub ready: True,
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_version: Option<String>,
    pub auth_methods: Vec<AcpRegistryProbeAuthMethod>,
    pub models: Vec<AcpRegistryProbeModel>,
    pub current_model_id: Option<String>,
    pub config_options: Vec<ProviderOptionDescriptor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_option_ids: Option<Vec<String>>,
    #[serde(default)]
    pub session_management: AcpRegistrySessionManagement,
}
impl Contract for AcpRegistryProbeResult {
    fn normalize(&mut self) -> Checked<()> {
        field("instanceId", || check_instance_id(&mut self.instance_id))?;
        field("icon", || opt(&mut self.icon, |s| url(s)))?;
        field("agentVersion", || {
            opt(&mut self.agent_version, |s| trimmed_non_empty(s, Some(64)))
        })?;
        field("authMethods", || {
            each(&mut self.auth_methods, Contract::normalize)?;
            max_items(&self.auth_methods, 32)
        })?;
        field("models", || {
            each(&mut self.models, Contract::normalize)?;
            max_items(&self.models, 256)
        })?;
        field("currentModelId", || {
            opt(&mut self.current_model_id, probe_text)
        })?;
        field("configOptions", || {
            each(&mut self.config_options, Contract::normalize)?;
            max_items(&self.config_options, 16)
        })?;
        field("modelOptionIds", || {
            opt(&mut self.model_option_ids, |v| {
                each(v, probe_text)?;
                max_items(v, 16)
            })
        })
    }
}

/// v1 `acpRegistry.ts:322-349`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AcpRegistryOperationErrorReason {
    AgentNotConfigured,
    AgentNotFound,
    ArchiveInvalid,
    AuthenticationFailed,
    ChecksumMismatch,
    ContinuationUnavailable,
    DownloadFailed,
    InstallFailed,
    InstanceNotFound,
    LogoutUnsupported,
    LogoutFailed,
    ProbeFailed,
    ProjectNotFound,
    RegistryUnavailable,
    RunnerUnavailable,
    SessionImportFailed,
    SessionDeleteUnsupported,
    SessionDeleteFailed,
    SessionListUnsupported,
    SessionResumeUnsupported,
    ProvidersUnsupported,
    ProvidersListFailed,
    ProviderConfigurationFailed,
    UnsupportedDistribution,
    UnsupportedPlatform,
}
impl AcpRegistryOperationErrorReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AgentNotConfigured => "agent_not_configured",
            Self::AgentNotFound => "agent_not_found",
            Self::ArchiveInvalid => "archive_invalid",
            Self::AuthenticationFailed => "authentication_failed",
            Self::ChecksumMismatch => "checksum_mismatch",
            Self::ContinuationUnavailable => "continuation_unavailable",
            Self::DownloadFailed => "download_failed",
            Self::InstallFailed => "install_failed",
            Self::InstanceNotFound => "instance_not_found",
            Self::LogoutUnsupported => "logout_unsupported",
            Self::LogoutFailed => "logout_failed",
            Self::ProbeFailed => "probe_failed",
            Self::ProjectNotFound => "project_not_found",
            Self::RegistryUnavailable => "registry_unavailable",
            Self::RunnerUnavailable => "runner_unavailable",
            Self::SessionImportFailed => "session_import_failed",
            Self::SessionDeleteUnsupported => "session_delete_unsupported",
            Self::SessionDeleteFailed => "session_delete_failed",
            Self::SessionListUnsupported => "session_list_unsupported",
            Self::SessionResumeUnsupported => "session_resume_unsupported",
            Self::ProvidersUnsupported => "providers_unsupported",
            Self::ProvidersListFailed => "providers_list_failed",
            Self::ProviderConfigurationFailed => "provider_configuration_failed",
            Self::UnsupportedDistribution => "unsupported_distribution",
            Self::UnsupportedPlatform => "unsupported_platform",
        }
    }
}

/// v1 `acpRegistry.ts:351-362` (the `_tag` is `AcpRegistryOperationError`; `cause` stays server-side).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    rename_all = "camelCase",
    tag = "_tag",
    rename = "AcpRegistryOperationError"
)]
pub struct AcpRegistryOperationError {
    pub reason: AcpRegistryOperationErrorReason,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_methods: Option<Vec<AcpRegistryProbeAuthMethod>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_action: Option<AcpRegistryUrlAuthAction>,
}
impl Contract for AcpRegistryOperationError {
    fn normalize(&mut self) -> Checked<()> {
        field("authMethods", || {
            opt(&mut self.auth_methods, |v| {
                each(v, Contract::normalize)?;
                max_items(v, 32)
            })
        })?;
        field("authAction", || {
            opt(&mut self.auth_action, Contract::normalize)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn search_input_trims_and_bounds_limit() {
        let input: AcpRegistrySearchInput =
            decode(json!({"query": "  devin  ", "limit": 3})).unwrap();
        assert_eq!(input.query, "devin");
        assert_eq!(input.limit(), Some(3));
        let long = "x".repeat(121);
        assert_eq!(
            decode::<AcpRegistrySearchInput>(json!({"query": long}))
                .unwrap_err()
                .path,
            ["query"]
        );
        for (limit, message) in [
            (json!(0), "Expected a value between 1 and 512, got 0"),
            (json!(513), "Expected a value between 1 and 512, got 513"),
            (json!(1.5), "Expected an integer, got 1.5"),
        ] {
            let e =
                decode::<AcpRegistrySearchInput>(json!({"query": "", "limit": limit})).unwrap_err();
            assert_eq!(e.message, message);
            assert_eq!(e.path, ["limit"]);
        }
    }

    #[test]
    fn agent_and_instance_ids_follow_v1_patterns() {
        let ok: AcpRegistryPrepareInput = decode(json!({"agentId": " devin "})).unwrap();
        assert_eq!(ok.agent_id, "devin");
        let e = decode::<AcpRegistryPrepareInput>(json!({"agentId": "Devin"})).unwrap_err();
        assert_eq!(
            e.to_string(),
            "Expected a string matching the RegExp ^[a-z0-9][a-z0-9._-]*$, got \"Devin\"\n  at [\"agentId\"]"
        );
        assert_eq!(
            decode::<AcpRegistryPrepareInput>(json!({"agentId": "  "}))
                .unwrap_err()
                .message,
            "Expected a non-blank string, got \"\""
        );
        assert!(decode::<AcpRegistryLogoutInput>(json!({"instanceId": "acp-devin_1"})).is_ok());
        assert!(decode::<AcpRegistryLogoutInput>(json!({"instanceId": "1acp"})).is_err());
        assert!(decode::<AcpRegistryLogoutInput>(json!({"instanceId": "a".repeat(65)})).is_err());
    }

    #[test]
    fn continuation_and_session_rules() {
        let base = json!({"instanceId": "acp", "projectId": "p"});
        let mut short = base.clone();
        short["continuation"] = json!("abc");
        assert_eq!(
            decode::<AcpRegistryListSessionsInput>(short)
                .unwrap_err()
                .message,
            "Expected a value with a length of at least 16, got \"abc\""
        );
        let mut bad = base.clone();
        bad["continuation"] = json!("abcdefghijklmnop!");
        assert!(decode::<AcpRegistryListSessionsInput>(bad).is_err());
        let mut good = base;
        good["continuation"] = json!("abcdefghijklmnop");
        assert!(decode::<AcpRegistryListSessionsInput>(good).is_ok());
        let dirs: Vec<String> = (0..33).map(|i| format!("/d{i}")).collect();
        let session = json!({"sessionId": "s", "cwd": "/w", "additionalDirectories": dirs, "title": null, "updatedAt": null, "importedThreadId": null});
        assert_eq!(
            decode::<AcpRegistrySession>(session).unwrap_err().path,
            ["additionalDirectories"]
        );
    }

    #[test]
    fn import_title_distinguishes_absent_and_null() {
        let absent: AcpRegistryImportSessionInput =
            decode(json!({"instanceId": "a", "projectId": "p", "sessionId": "s"})).unwrap();
        assert_eq!(absent.title, None);
        let null: AcpRegistryImportSessionInput =
            decode(json!({"instanceId": "a", "projectId": "p", "sessionId": "s", "title": null}))
                .unwrap();
        assert_eq!(null.title, Some(None));
        assert!(
            decode::<AcpRegistryImportSessionInput>(
                json!({"instanceId": "a", "projectId": "p", "sessionId": "s", "title": " "})
            )
            .is_err()
        );
    }

    #[test]
    fn set_provider_headers_are_bounded_and_hidden_from_debug() {
        let input: AcpRegistrySetProviderInput = decode(json!({
            "instanceId": "a", "projectId": "p", "providerId": "openai", "apiType": "openai",
            "baseUrl": "https://api.example.test", "headers": {" Authorization ": "secret-token"}
        }))
        .unwrap();
        assert!(
            input
                .headers
                .as_ref()
                .unwrap()
                .contains_key("Authorization")
        );
        assert!(!format!("{input:?}").contains("secret-token"));
        let e = decode::<AcpRegistrySetProviderInput>(json!({
            "instanceId": "a", "projectId": "p", "providerId": "x", "apiType": "y",
            "baseUrl": "https://x.test", "headers": {"k": "v".repeat(8_193)}
        }))
        .unwrap_err();
        assert_eq!(e.path, ["headers", "k"]);
    }

    #[test]
    fn probe_result_defaults_session_management_and_checks_lists() {
        let result: AcpRegistryProbeResult = decode(json!({
            "instanceId": "acp", "ready": true, "icon": null, "authMethods": [],
            "models": [{"id": " m ", "name": "M", "description": null, "reasoningEffort": null}],
            "currentModelId": null, "configOptions": []
        }))
        .unwrap();
        assert_eq!(
            result.session_management,
            AcpRegistrySessionManagement::default()
        );
        assert_eq!(result.models[0].id, "m");
        assert_eq!(result.models[0].reasoning_effort, Some(None));
        assert!(
            decode::<AcpRegistryProbeResult>(json!({
                "instanceId": "acp", "ready": false, "icon": null, "authMethods": [],
                "models": [], "currentModelId": null, "configOptions": []
            }))
            .is_err()
        );
        let method = json!({"id": "a", "name": "A", "description": null, "type": "env_var", "envVarNames": vec!["K"; 17]});
        assert_eq!(
            decode::<AcpRegistryProbeAuthMethod>(method)
                .unwrap_err()
                .path,
            ["envVarNames"]
        );
    }

    #[test]
    fn error_reasons_round_trip_v1_names() {
        let e: AcpRegistryOperationError = decode(json!({
            "_tag": "AcpRegistryOperationError", "reason": "checksum_mismatch", "message": "m"
        }))
        .unwrap();
        assert_eq!(e.reason.as_str(), "checksum_mismatch");
        assert_eq!(
            serde_json::to_value(&e).unwrap()["_tag"],
            "AcpRegistryOperationError"
        );
        assert_eq!(
            serde_json::to_value(AcpRegistryOperationErrorReason::UnsupportedPlatform).unwrap(),
            "unsupported_platform"
        );
    }

    #[test]
    fn option_descriptors_trim_and_reject_blank() {
        let mut d: ProviderOptionDescriptor = serde_json::from_value(json!({
            "type": "select", "id": " effort ", "label": "Reasoning",
            "options": [{"id": "high", "label": "High", "isDefault": true}], "role": "reasoning"
        }))
        .unwrap();
        d.normalize().unwrap();
        assert!(matches!(&d, ProviderOptionDescriptor::Select { id, .. } if id == "effort"));
        let mut bad: ProviderOptionDescriptor = serde_json::from_value(json!({
            "type": "boolean", "id": "x", "label": " "
        }))
        .unwrap();
        assert_eq!(bad.normalize().unwrap_err().path, ["label"]);
    }
}
