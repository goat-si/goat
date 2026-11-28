use crate::{ProviderCapabilities, ProviderInstanceId, ProviderProbeResult};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSetup {
    pub can_authenticate: bool,
    pub can_install: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub documentation_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ProviderAuthPhase {
    Idle,
    Starting,
    Waiting,
    Verifying,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ProviderAuthMethodType {
    Agent,
    Terminal,
    Credentials,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ProviderInstallPhase {
    Idle,
    Downloading,
    Extracting,
    Verifying,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ProviderInstallSource {
    Managed,
    Local,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum AcpRegistryDistribution {
    Binary,
    Npx,
    Uvx,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum AcpRegistryIntegrity {
    Sha256,
    Registry,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAuthMethod {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account_email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub can_remove: Option<bool>,
    pub name: String,
    pub description: Option<String>,
    pub r#type: ProviderAuthMethodType,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ProviderAuthInteraction {
    Browser {
        id: String,
        url: String,
        requires_consent: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        accepts_callback: Option<bool>,
    },
    DeviceCode {
        id: String,
        url: String,
        user_code: String,
    },
    Terminal {
        id: String,
        output: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        output_offset: Option<u32>,
    },
    Credentials {
        id: String,
        fields: Vec<ProviderCredentialField>,
    },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
pub struct ProviderCredentialField {
    pub name: String,
    pub label: String,
    pub secret: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum CredentialOwner {
    Provider,
    T3,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAuthState {
    pub instance_id: ProviderInstanceId,
    pub phase: ProviderAuthPhase,
    pub flow_id: Option<String>,
    pub authorization_url: Option<String>,
    pub expires_at: Option<String>,
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub methods: Option<Vec<ProviderAuthMethod>>,
    #[serde(
        default,
        deserialize_with = "crate::serde_util::present_nullable",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional)]
    #[schemars(with = "Option<ProviderAuthInteraction>")]
    pub interaction: Option<Option<ProviderAuthInteraction>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub credential_owner: Option<CredentialOwner>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInstallState {
    pub driver: String,
    pub operation_id: Option<String>,
    pub phase: ProviderInstallPhase,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub version: Option<String>,
    pub installed_version: Option<String>,
    #[serde(
        default,
        deserialize_with = "crate::serde_util::present_nullable",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional)]
    #[schemars(with = "Option<String>")]
    pub executable_path: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "crate::serde_util::present_nullable",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional)]
    #[schemars(with = "Option<ProviderInstallSource>")]
    pub source: Option<Option<ProviderInstallSource>>,
    pub can_remove: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AcpRegistrySearchResult {
    pub agents: Vec<AcpRegistrySearchAgent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AcpRegistryPrepareResult {
    pub agent_id: String,
    pub version: String,
    pub distribution: AcpRegistryDistribution,
    #[serde(
        deserialize_with = "deserialize_true",
        serialize_with = "serialize_true"
    )]
    #[ts(type = "true")]
    #[schemars(schema_with = "true_schema")]
    pub prepared: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ServerProviderEntry {
    pub instance_id: ProviderInstanceId,
    pub driver: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub display_name: Option<String>,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub acp_agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub setup: Option<ProviderSetup>,
    pub capabilities: ProviderCapabilities,
    pub probe: ProviderProbeResult,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub auth_flow: Option<ProviderAuthState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub install: Option<ProviderInstallState>,
}

fn deserialize_true<'de, D: serde::Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    use serde::de::Error;
    if bool::deserialize(d)? {
        Ok(true)
    } else {
        Err(D::Error::custom("prepared must be true"))
    }
}
fn serialize_true<S: serde::Serializer>(v: &bool, s: S) -> Result<S::Ok, S::Error> {
    use serde::ser::Error;
    if *v {
        s.serialize_bool(true)
    } else {
        Err(S::Error::custom("prepared must be true"))
    }
}
fn true_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({ "const": true })
}
